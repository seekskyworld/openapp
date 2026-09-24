import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const CONTROL_PLANE_HEADERS = new Set(["authorization", "x-openapp-admin-token"]);

export interface ProxyOptions {
  readonly upstreamHost?: string;
  /** Provider 私有 Header 在过滤浏览器 Header 后写入，只存在于本次上游请求。 */
  readonly upstreamHeaders?: Readonly<Record<string, string>>;
  readonly stripRequestCookies?: boolean;
  readonly stripCookieNames?: readonly string[];
  readonly stripResponseCookieNames?: readonly string[];
  readonly rootScopedCookieNames?: readonly string[];
  readonly httpOnlyRootScopedCookieNames?: readonly string[];
  readonly secureRootScopedCookies?: boolean;
  /** 只上报请求/响应活动，不把代理层耦合到升级状态机。 */
  readonly onActivity?: () => void;
  readonly signal?: AbortSignal;
}

type ProxyHeaders = Record<string, string | string[] | undefined>;

interface ResponseCookiePolicy {
  normalizedPrefix: string;
  rootScopedNames: ReadonlySet<string>;
  httpOnlyRootScopedNames: ReadonlySet<string>;
  strippedNames: ReadonlySet<string>;
  secureRootScopedCookies: boolean;
}

interface ProxySettlement {
  readonly settled: boolean;
  finish(error?: unknown): void;
  bindAbort(listener: () => void): boolean;
}

export class ProxyError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export function proxyInstanceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  endpoint: string,
  prefix: string,
  options: ProxyOptions = {},
): Promise<void> {
  const target = resolveProxyTarget(request, endpoint, prefix);
  if (!target.pathname.startsWith("/")) target.pathname = `/${target.pathname}`;
  if (options.signal?.aborted) {
    response.destroy();
    return Promise.resolve();
  }
  const headers = buildRequestHeaders(request, target, options, false);
  const cookiePolicy = responseCookiePolicy(prefix, options);
  return new Promise((resolve, reject) => {
    const settlement = createProxySettlement(resolve, reject, options.signal);
    request.on("data", options.onActivity ?? noop);
    const upstream = http.request(target, { method: request.method, headers }, (upstreamResponse) => {
      if (settlement.settled) {
        upstreamResponse.resume();
        upstreamResponse.once("error", () => undefined);
        return;
      }
      const responseHeaders = buildResponseHeaders(
        upstreamResponse.headers,
        target.href,
        endpoint,
        cookiePolicy,
      );
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.on("data", options.onActivity ?? noop);
      upstreamResponse.pipe(response);
      upstreamResponse.once("end", () => settlement.finish());
      upstreamResponse.once("aborted", () => {
        if (!response.writableEnded) response.destroy();
        settlement.finish();
      });
      upstreamResponse.once("close", () => {
        if (!response.writableEnded && !response.destroyed) response.destroy();
        settlement.finish();
      });
      upstreamResponse.once("error", (error) => {
        if (!response.writableEnded && !response.destroyed) response.destroy();
        settlement.finish(upstreamFailure(error));
      });
    });
    upstream.once("error", (error) => settlement.finish(upstreamFailure(error)));
    const abort = () => {
      upstream.destroy(options.signal?.reason instanceof Error ? options.signal.reason : undefined);
      response.destroy();
      settlement.finish();
    };
    if (!settlement.bindAbort(abort)) return;
    request.once("aborted", () => {
      upstream.destroy();
      response.destroy();
      settlement.finish();
    });
    response.once("close", () => {
      if (!response.writableEnded) upstream.destroy();
      settlement.finish();
    });
    request.pipe(upstream);
  });
}

export function proxyInstanceUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  endpoint: string,
  prefix: string,
  options: ProxyOptions = {},
): Promise<void> {
  const target = resolveProxyTarget(request, endpoint, prefix);
  if (options.signal?.aborted) {
    socket.destroy();
    return Promise.resolve();
  }
  const headers = buildRequestHeaders(request, target, options, true);
  const cookiePolicy = responseCookiePolicy(prefix, options);
  return new Promise((resolve, reject) => {
    const settlement = createProxySettlement(resolve, reject, options.signal);
    let proxiedSocket: Duplex | undefined;
    const upstream = http.request(target, { method: request.method, headers });
    const abort = () => {
      upstream.destroy(options.signal?.reason instanceof Error ? options.signal.reason : undefined);
      proxiedSocket?.destroy(options.signal?.reason instanceof Error ? options.signal.reason : undefined);
      socket.destroy();
      settlement.finish();
    };
    if (!settlement.bindAbort(abort)) return;
    upstream.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      proxiedSocket = upstreamSocket;
      if (settlement.settled || options.signal?.aborted || socket.destroyed) {
        upstreamSocket.once("error", () => undefined);
        upstreamSocket.destroy();
        return;
      }
      writeUpgradeResponse(socket, upstreamResponse, target.href, endpoint, cookiePolicy);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.on("data", options.onActivity ?? noop);
      upstreamSocket.on("data", options.onActivity ?? noop);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      upstreamSocket.once("close", () => settlement.finish());
      upstreamSocket.once("end", () => {
        upstreamSocket.destroy();
        settlement.finish();
      });
      upstreamSocket.once("error", (error) => {
        socket.destroy();
        settlement.finish(upstreamFailure(error));
      });
    });
    upstream.once("response", (response) => {
      response.resume();
      settlement.finish(new ProxyError("websocket_upgrade_rejected", response.statusCode ?? 502));
    });
    upstream.once("error", (error) => settlement.finish(upstreamFailure(error)));
    socket.once("close", () => {
      upstream.destroy();
      proxiedSocket?.destroy();
      settlement.finish();
    });
    socket.once("error", () => {
      upstream.destroy();
      proxiedSocket?.destroy();
      settlement.finish();
    });
    upstream.end();
  });
}

function resolveProxyTarget(request: IncomingMessage, endpoint: string, prefix: string): URL {
  const endpointUrl = new URL(endpoint);
  const rawPath = request.url?.slice(prefix.length) || "/";
  const requestUrl = new URL(rawPath, "http://openapp-request.invalid");
  if (requestUrl.origin !== "http://openapp-request.invalid" || requestUrl.username || requestUrl.password) {
    throw new ProxyError("proxy_target_origin_mismatch");
  }
  const target = new URL(endpointUrl);
  const basePath = endpointUrl.pathname === "/" ? "" : endpointUrl.pathname.replace(/\/+$/u, "");
  target.pathname = `${basePath}/${requestUrl.pathname.replace(/^\/+/u, "")}`;
  for (const [name, value] of requestUrl.searchParams) {
    if (target.searchParams.has(name)) throw new ProxyError("proxy_target_query_conflict");
    target.searchParams.append(name, value);
  }
  return target;
}

function buildRequestHeaders(
  request: IncomingMessage,
  target: URL,
  options: ProxyOptions,
  upgrade: boolean,
): ProxyHeaders {
  const headers: ProxyHeaders = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP.has(lowerKey) && !CONTROL_PLANE_HEADERS.has(lowerKey) && value !== undefined) {
      headers[key] = value;
    }
  }
  filterRequestCookies(headers, options);
  for (const [name, value] of Object.entries(options.upstreamHeaders ?? {})) {
    setHeader(headers, name, value);
  }
  headers.host = options.upstreamHost ?? target.host;
  headers["x-forwarded-host"] = request.headers.host;
  headers["x-forwarded-proto"] = request.headers["x-forwarded-proto"] ?? "http";
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = request.headers.upgrade ?? "websocket";
  }
  return headers;
}

function setHeader(headers: ProxyHeaders, name: string, value: string): void {
  const normalized = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === normalized) delete headers[existing];
  }
  headers[normalized] = value;
}

function filterRequestCookies(headers: ProxyHeaders, options: ProxyOptions): void {
  if (options.stripRequestCookies) {
    delete headers.cookie;
    return;
  }
  if (!headers.cookie || !options.stripCookieNames?.length) return;
  const cookie = filterCookieHeader(String(headers.cookie), options.stripCookieNames);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
}

function responseCookiePolicy(prefix: string, options: ProxyOptions): ResponseCookiePolicy {
  return {
    normalizedPrefix: `/${prefix.replace(/^\/+|\/+$/gu, "")}`,
    rootScopedNames: normalizedNameSet(options.rootScopedCookieNames),
    httpOnlyRootScopedNames: normalizedNameSet(options.httpOnlyRootScopedCookieNames),
    strippedNames: normalizedNameSet(options.stripResponseCookieNames),
    secureRootScopedCookies: options.secureRootScopedCookies === true,
  };
}

function normalizedNameSet(names: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(names?.map((name) => name.trim().toLowerCase()).filter(Boolean));
}

function buildResponseHeaders(
  upstreamHeaders: IncomingMessage["headers"],
  requestTarget: string,
  endpoint: string,
  policy: ResponseCookiePolicy,
  preserveUpgradeHeaders = false,
): ProxyHeaders {
  const headers: ProxyHeaders = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    const lowerKey = key.toLowerCase();
    if ((!preserveUpgradeHeaders && HOP_BY_HOP.has(lowerKey)) || value === undefined) continue;
    if (lowerKey === "set-cookie") {
      const cookies = rewriteResponseCookies(value, policy);
      if (cookies.length) headers[key] = cookies;
    } else if (lowerKey === "location") {
      headers[key] = rewriteLocation(String(value), requestTarget, endpoint, policy.normalizedPrefix);
    } else {
      headers[key] = value;
    }
  }
  return headers;
}

function rewriteResponseCookies(value: string | string[], policy: ResponseCookiePolicy): string[] {
  return (Array.isArray(value) ? value : [value])
    .filter((cookie) => !policy.strippedNames.has(cookieName(cookie)))
    .map((cookie) =>
      rewriteSetCookie(
        cookie,
        policy.normalizedPrefix,
        policy.rootScopedNames,
        policy.httpOnlyRootScopedNames,
        policy.secureRootScopedCookies,
      ),
    );
}

function writeUpgradeResponse(
  socket: Duplex,
  upstreamResponse: IncomingMessage,
  requestTarget: string,
  endpoint: string,
  policy: ResponseCookiePolicy,
): void {
  const status = upstreamResponse.statusCode ?? 101;
  const message = upstreamResponse.statusMessage ?? "Switching Protocols";
  socket.write(`HTTP/1.1 ${status} ${message}\r\n`);
  const headers = buildResponseHeaders(upstreamResponse.headers, requestTarget, endpoint, policy, true);
  for (const [key, value] of Object.entries(headers)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry !== undefined) socket.write(`${key}: ${entry}\r\n`);
    }
  }
  socket.write("\r\n");
}

function createProxySettlement(
  resolve: () => void,
  reject: (error: unknown) => void,
  signal: AbortSignal | undefined,
): ProxySettlement {
  let settled = false;
  let abortListener: (() => void) | undefined;
  return {
    get settled() {
      return settled;
    },
    finish(error?: unknown) {
      if (settled) return;
      settled = true;
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      if (error) reject(error);
      else resolve();
    },
    bindAbort(listener: () => void) {
      if (!signal) return true;
      abortListener = listener;
      if (signal.aborted) {
        listener();
        return false;
      }
      signal.addEventListener("abort", listener, { once: true });
      if (!signal.aborted) return true;
      signal.removeEventListener("abort", listener);
      listener();
      return false;
    },
  };
}

function noop(): void {}

function filterCookieHeader(value: string, names: readonly string[]): string {
  const excluded = new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean));
  return value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf("=");
      return separator > 0 && !excluded.has(part.slice(0, separator).trim().toLowerCase());
    })
    .join("; ");
}

function rewriteSetCookie(
  value: string,
  prefix: string,
  rootScopedCookieNames: ReadonlySet<string>,
  httpOnlyRootScopedCookieNames: ReadonlySet<string>,
  secureRootScopedCookies: boolean,
): string {
  const name = cookieName(value);
  const hostOnlyCookie = value.replace(/;\s*domain=[^;]*/giu, "");
  if (rootScopedCookieNames.has(name)) {
    return rewriteRootScopedCookie(
      hostOnlyCookie,
      httpOnlyRootScopedCookieNames.has(name),
      secureRootScopedCookies,
    );
  }
  const path = hostOnlyCookie.match(/;\s*path=([^;]*)/iu)?.[1]?.trim();
  const scopedPath = `${prefix}${path && path.startsWith("/") ? path : `/${path || ""}`}`.replace(
    /\/{2,}/gu,
    "/",
  );
  if (/;\s*path=/iu.test(hostOnlyCookie))
    return hostOnlyCookie.replace(/(;\s*path=)[^;]*/iu, `$1${scopedPath}`);
  return `${hostOnlyCookie}; Path=${scopedPath}`;
}

function rewriteRootScopedCookie(value: string, httpOnly: boolean, secure: boolean): string {
  const [pair = "", ...attributes] = value.split(";").map((part) => part.trim());
  const maxAge = attributes.find((attribute) => /^max-age=/iu.test(attribute));
  const maxAgeValue = maxAge?.slice(maxAge.indexOf("=") + 1).trim();
  const parsedMaxAge = maxAgeValue && /^-?\d+$/u.test(maxAgeValue) ? Number(maxAgeValue) : undefined;
  const validMaxAge =
    parsedMaxAge !== undefined && Number.isSafeInteger(parsedMaxAge)
      ? `Max-Age=${Math.max(0, parsedMaxAge)}`
      : undefined;
  const expires = validMaxAge
    ? undefined
    : attributes.find((attribute) => {
        if (!/^expires=/iu.test(attribute)) return false;
        return Number.isFinite(Date.parse(attribute.slice(attribute.indexOf("=") + 1).trim()));
      });
  return [
    pair,
    "Path=/",
    validMaxAge,
    expires,
    "SameSite=Lax",
    httpOnly ? "HttpOnly" : undefined,
    secure ? "Secure" : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

function cookieName(value: string): string {
  const separator = value.indexOf("=");
  return separator > 0 ? value.slice(0, separator).trim().toLowerCase() : "";
}

function rewriteLocation(value: string, requestTarget: string, endpoint: string, prefix: string): string {
  try {
    const target = new URL(value, requestTarget);
    const upstream = new URL(endpoint);
    if (target.origin !== upstream.origin) return value;
    for (const name of upstream.searchParams.keys()) target.searchParams.delete(name);
    const upstreamBasePath = upstream.pathname === "/" ? "" : upstream.pathname.replace(/\/+$/u, "");
    const publicPath =
      upstreamBasePath &&
      (target.pathname === upstreamBasePath || target.pathname.startsWith(`${upstreamBasePath}/`))
        ? target.pathname.slice(upstreamBasePath.length) || "/"
        : target.pathname;
    return `${prefix}${publicPath}${target.search}${target.hash}`;
  } catch {
    return value;
  }
}

function upstreamFailure(error: unknown): ProxyError {
  // Node 网络错误会包含 Provider 内部主机和端口，跨访问平面时只传播稳定诊断码。
  return new ProxyError("workspace_upstream_unavailable", 502, { cause: error });
}
