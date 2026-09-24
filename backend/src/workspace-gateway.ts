import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AppAuthHandoffCoordinator } from "./auth/app-auth-handoff.js";
import type { PortalAuth } from "./auth/portal-auth.js";
import type { ForwardingPolicyManager } from "./forwarding-policy.js";
import { HttpError } from "./http-response.js";
import type { InstanceActivityHandle, InstanceActivityKind, InstanceActivityMonitor } from "./instance-upgrade-activity.js";
import type { Container } from "./models.js";
import { ProxyError, proxyInstanceRequest, proxyInstanceUpgrade, type ProxyOptions } from "./proxy.js";
import type { AccessTargetResolver, WorkspaceLogicalService } from "./execution-provider.js";
import {
  assertAccessTargetEnvironment,
  resolveWorkspaceAccessTarget,
} from "./workspace-access-target.js";
import type { WorkspaceAuthorizationPort } from "./workspace-authorization.js";

const SANDBOX_ROUTE = /^\/instances\/([^/]+)(\/mcp-app-sandbox\/?|\/mcp-app-sandbox\.js|\/mcp-app-media\/[A-Za-z0-9_-]{20,})$/u;

interface WorkspaceAccessPort {
  acquire(id: string, intent: "proxy"): Promise<Container>;
}

interface WorkspaceReadPort {
  read(id: string, options?: { signal?: AbortSignal }): Promise<Container>;
}

interface WorkspaceUpgradeError {
  status: number;
  code: string;
}

export interface WorkspaceGatewayFailureContext {
  phase: "activity" | "upgrade";
  kind: InstanceActivityKind;
  instanceId: string | null;
  method: string;
  path: string;
  requestId?: string;
  status?: number;
}

export interface WorkspaceGatewayOptions {
  forwarding: Pick<ForwardingPolicyManager, "get" | "isInstanceOriginAllowed" | "isPortalOriginAllowed">;
  portalAuth: Pick<PortalAuth, "requireUser">;
  authorization: WorkspaceAuthorizationPort;
  access: WorkspaceAccessPort;
  reader: WorkspaceReadPort;
  targets: AccessTargetResolver;
  activity: InstanceActivityMonitor;
  appAuthHandoff: Pick<AppAuthHandoffCoordinator, "proxyOptionsAsync">;
  sandboxOrigin?: string;
  secureCookies: boolean;
  preparePortalResponse(request: IncomingMessage, response: ServerResponse): void;
  mapUpgradeError(error: unknown): WorkspaceUpgradeError;
  reportFailure(error: unknown, context: WorkspaceGatewayFailureContext): void;
}

interface WorkspaceProxyContext {
  endpoint: string;
  options: ProxyOptions;
}

/**
 * Workspace 用户流量的唯一服务端入口。它集中执行来源、身份、所有权、活动准入和就绪检查，
 * transport 只接收经过这些检查后解析出的私有 endpoint。
 */
export class WorkspaceGateway {
  readonly #forwarding: WorkspaceGatewayOptions["forwarding"];
  readonly #portalAuth: WorkspaceGatewayOptions["portalAuth"];
  readonly #authorization: WorkspaceGatewayOptions["authorization"];
  readonly #access: WorkspaceGatewayOptions["access"];
  readonly #reader: WorkspaceGatewayOptions["reader"];
  readonly #targets: WorkspaceGatewayOptions["targets"];
  readonly #activity: WorkspaceGatewayOptions["activity"];
  readonly #appAuthHandoff: WorkspaceGatewayOptions["appAuthHandoff"];
  readonly #sandboxHost: string | undefined;
  readonly #secureCookies: boolean;
  readonly #preparePortalResponse: WorkspaceGatewayOptions["preparePortalResponse"];
  readonly #mapUpgradeError: WorkspaceGatewayOptions["mapUpgradeError"];
  readonly #reportFailure: WorkspaceGatewayOptions["reportFailure"];

  constructor(options: WorkspaceGatewayOptions) {
    this.#forwarding = options.forwarding;
    this.#portalAuth = options.portalAuth;
    this.#authorization = options.authorization;
    this.#access = options.access;
    this.#reader = options.reader;
    this.#targets = options.targets;
    this.#activity = options.activity;
    this.#appAuthHandoff = options.appAuthHandoff;
    this.#sandboxHost = options.sandboxOrigin
      ? new URL(options.sandboxOrigin).host.toLowerCase()
      : undefined;
    this.#secureCookies = options.secureCookies;
    this.#preparePortalResponse = options.preparePortalResponse;
    this.#mapUpgradeError = options.mapUpgradeError;
    this.#reportFailure = options.reportFailure;
  }

  async handleHttp(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (this.#isSandboxHost(request.headers.host)) {
      await this.#proxySandbox(request, response, url);
      return true;
    }
    const route = workspaceRoute(url.pathname);
    if (!route) return false;
    this.#preparePortalResponse(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(this.#forwarding.isPortalOriginAllowed(request.headers.origin) ? 204 : 403);
      response.end();
      return true;
    }
    await this.#proxyHttp(request, response, route);
    return true;
  }

  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let route: WorkspaceRoute | null = null;
    try {
      if (this.#isSandboxHost(request.headers.host)) throw new HttpError(404, "not_found");
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      route = workspaceRoute(url.pathname);
      if (!route) throw new HttpError(404, "not_found");
      await this.#proxyUpgrade(request, socket, head, route);
    } catch (error) {
      if (socket.destroyed) return;
      const mapped = this.#mapUpgradeError(error);
      this.#reportFailure(error, {
        phase: "upgrade",
        kind: "websocket",
        instanceId: route?.id ?? null,
        method: request.method ?? "GET",
        path: request.url ?? "/",
        requestId: requestId(request),
        status: mapped.status,
      });
      socket.end([
        `HTTP/1.1 ${mapped.status} ${upgradeStatusMessage(mapped.status)}`,
        "Connection: close",
        "Content-Type: application/json",
        "",
        JSON.stringify({ error: mapped.code }),
      ].join("\r\n"));
    }
  }

  async #proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    route: WorkspaceRoute,
  ): Promise<void> {
    await this.#withAuthorizedProxy(request, route, "http", async ({ endpoint, options }) => {
      if (request.destroyed) throw new ProxyError("request_aborted", 499);
      await proxyInstanceRequest(request, response, endpoint, route.prefix, options);
    });
  }

  async #proxyUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    route: WorkspaceRoute,
  ): Promise<void> {
    await this.#withAuthorizedProxy(request, route, "websocket", async ({ endpoint, options }) => {
      if (socket.destroyed) return;
      await proxyInstanceUpgrade(request, socket, head, endpoint, route.prefix, options);
    });
  }

  async #withAuthorizedProxy<T>(
    request: IncomingMessage,
    route: WorkspaceRoute,
    kind: InstanceActivityKind,
    operation: (context: WorkspaceProxyContext) => Promise<T>,
  ): Promise<T> {
    const record = await this.#authorize(request, route.id);
    return this.#activity.run(record.id, kind, async (lease) => {
      const current = await this.#access.acquire(record.id, "proxy");
      const target = await this.#resolveTarget(current, "workspace_ui", lease.signal);
      const handoff = await this.#appAuthHandoff.proxyOptionsAsync(record.appId, {
        instanceId: record.id,
        secureCookies: this.#secureCookies,
      });
      const options = {
        ...handoff,
        upstreamHost: target.authority ?? handoff.upstreamHost,
        upstreamHeaders: target.headers,
        onActivity: this.#activityReporter(request, record.id, kind, lease),
        signal: lease.signal,
      };
      return operation({ endpoint: target.url.href, options });
    });
  }

  async #proxySandbox(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const route = url.pathname.match(SANDBOX_ROUTE);
    if (!route) throw new HttpError(404, "not_found");
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new HttpError(405, "method_not_allowed");
    }
    const id = decodeURIComponent(route[1]!);
    const prefix = `/instances/${route[1]}`;
    // 先做无副作用的存在性校验，再打开 drain-aware 租约；沙箱资源不得自动唤醒 Workspace。
    await this.#authorization.requireExisting(id);
    await this.#activity.run(id, "http", async (lease) => {
      const current = await this.#reader.read(id, { signal: lease.signal });
      if (current.status !== "running") {
        throw new HttpError(409, "container_not_running");
      }
      const target = await this.#resolveTarget(current, "mcp_sandbox_asset", lease.signal);
      if (request.destroyed) throw new ProxyError("request_aborted", 499);
      await proxyInstanceRequest(request, response, target.url.href, prefix, {
        upstreamHost: target.authority ?? this.#sandboxHost,
        upstreamHeaders: target.headers,
        stripRequestCookies: true,
        onActivity: this.#activityReporter(request, id, "http", lease),
        signal: lease.signal,
      });
    });
  }

  async #authorize(request: IncomingMessage, id: string): Promise<Container> {
    const policy = await this.#forwarding.get();
    if (!policy.enabled) throw new HttpError(503, "forwarding_disabled");
    if (!this.#forwarding.isInstanceOriginAllowed(request.headers.origin, policy)) {
      throw new HttpError(403, "forwarding_origin_not_allowed");
    }
    const user = await this.#portalAuth.requireUser(request);
    return this.#authorization.requireOwned(id, user.id);
  }

  async #resolveTarget(
    current: Container,
    logicalService: WorkspaceLogicalService,
    signal: AbortSignal,
  ) {
    const target = await resolveWorkspaceAccessTarget(this.#targets, {
      workspaceId: current.id,
      expectedOwnerId: current.userId,
      logicalService,
      signal,
    });
    assertAccessTargetEnvironment(target, current.runtimeId);
    return target;
  }

  #activityReporter(
    request: IncomingMessage,
    instanceId: string,
    kind: InstanceActivityKind,
    lease: InstanceActivityHandle,
  ): () => void {
    return () => {
      void lease.touch().catch((error: unknown) => this.#reportFailure(error, {
        phase: "activity",
        kind,
        instanceId,
        method: request.method ?? "GET",
        path: request.url ?? "/",
        requestId: requestId(request),
      }));
    };
  }

  #isSandboxHost(host: string | undefined): boolean {
    return Boolean(this.#sandboxHost && host?.trim().toLowerCase() === this.#sandboxHost);
  }
}

interface WorkspaceRoute {
  id: string;
  prefix: string;
}

function workspaceRoute(pathname: string): WorkspaceRoute | null {
  const match = pathname.match(/^\/instances\/([^/]+)(?:\/|$)/u);
  return match ? {
    id: decodeURIComponent(match[1]!),
    prefix: `/instances/${match[1]}`,
  } : null;
}

function upgradeStatusMessage(status: number): string {
  if (status === 404) return "Not Found";
  if (status === 409) return "Conflict";
  if (status === 401) return "Unauthorized";
  return "Service Unavailable";
}

function requestId(request: IncomingMessage): string | undefined {
  const value = request.headers["x-request-id"];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}
