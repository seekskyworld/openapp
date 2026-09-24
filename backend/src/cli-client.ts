import { createReadStream, openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { GENERIC_SESSION_COOKIE_NAME } from "./config-defaults.js";

export type CliIdentity = "admin" | "user";

export interface PortalClientOptions {
  baseUrl: string;
  identity: CliIdentity;
  token: string;
  cookieName?: string;
}

export class PortalClient {
  readonly #baseUrl: string;
  readonly #identity: CliIdentity;
  readonly #token: string;
  readonly #cookieName: string;

  constructor(options: PortalClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#identity = options.identity;
    this.#token = options.token;
    // CLI 默认走通用 Portal 会话；旧部署仍可通过 --cookie-name 明确指定历史名称。
    this.#cookieName = options.cookieName ?? GENERIC_SESSION_COOKIE_NAME;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...this.#authHeaders(), ...extraHeaders };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return this.#readResponse<T>(response);
  }

  async upload<T = unknown>(path: string, archivePath: string, reference: string): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-tar",
      "x-image-reference": reference,
      ...this.#authHeaders(),
    };
    const archive = await stat(archivePath);
    if (!archive.isFile()) throw new Error(`image archive is not a file: ${archivePath}`);
    if (archive.size > 512 * 1024 * 1024) throw new Error("image archive exceeds 512 MiB");
    const body = createReadStream(archivePath) as unknown as BodyInit;
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: { ...headers, "content-length": String(archive.size) },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return this.#readResponse<T>(response);
  }

  async uploadAppVersion<T = unknown>(appId: string, ...paths: string[]): Promise<T> {
    const route = `/api/admin/apps/${encodeURIComponent(appId.trim())}`;
    const schema = await this.request<{ requirements: Array<{ key: string; maxBytes?: number }> }>("GET", `${route}/upload-schema`);
    if (schema.requirements.length !== paths.length) throw new Error("upload file count does not match Adapter schema");
    const form = new FormData();
    for (const [index, requirement] of schema.requirements.entries()) {
      const path = paths[index]!;
      const info = await stat(path);
      if (!info.isFile() || info.size > (requirement.maxBytes ?? 512 * 1024 * 1024)) throw new Error("upload file exceeds slot limit");
      form.append(requirement.key, await openAsBlob(path), basename(path));
    }
    return this.#readResponse<T>(await fetch(`${this.#baseUrl}${route}/versions`, { method: "POST", headers: this.#authHeaders(), body: form }));
  }

  async uploadBuildPackage<T = unknown>(strategyId: string, key: string, packagePath: string): Promise<T> {
    const normalizedStrategyId = strategyId.trim().toLowerCase();
    const normalizedKey = key.trim().toLowerCase();
    const keyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
    if (!keyPattern.test(normalizedStrategyId)) throw new Error("strategy id is invalid");
    if (!keyPattern.test(normalizedKey)) throw new Error("package slot is invalid");
    const file = await stat(packagePath);
    if (!file.isFile()) throw new Error(`build package is not a file: ${packagePath}`);
    if (file.size <= 0) throw new Error(`build package is empty: ${packagePath}`);
    const boundary = `openapp-${randomBytes(16).toString("hex")}`;
    const filename = basename(packagePath).replace(/["\r\n]/gu, "_");
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${normalizedKey}"; filename="${filename}"\r\nContent-Type: application/gzip\r\n\r\n`,
    );
    const end = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Readable.from((async function* () {
      yield header;
      yield* createReadStream(packagePath);
      yield end;
    })());
    const query = new URLSearchParams({ strategyId: normalizedStrategyId, key: normalizedKey });
    const response = await fetch(`${this.#baseUrl}/api/admin/build-packages?${query}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(header.length + file.size + end.length),
        ...this.#authHeaders(),
      },
      body: body as unknown as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return this.#readResponse<T>(response);
  }

  #authHeaders(): Record<string, string> {
    if (!this.#token) return {};
    if (this.#identity === "admin") return { "x-openapp-admin-token": this.#token };
    return { cookie: `${this.#cookieName}=${encodeURIComponent(this.#token)}` };
  }

  async #readResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    let value: unknown = null;
    if (text) {
      try { value = JSON.parse(text); } catch { value = { raw: text }; }
    }
    if (!response.ok) {
      const detail = value && typeof value === "object" && "error" in value
        ? String((value as { error: unknown }).error)
        : `HTTP ${response.status}`;
      throw new Error(`${response.status} ${detail}`);
    }
    return value as T;
  }
}
