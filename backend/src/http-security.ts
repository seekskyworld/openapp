/** 浏览器写请求必须经过来源校验；无浏览器元数据的 CLI 仍走正常身份授权。 */
import type { IncomingMessage } from "node:http";
import { HttpError } from "./http-response.js";

export function assertWriteOrigin(request: IncomingMessage, allowed: (origin: string) => boolean): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) return;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (origin === "null" || !allowed(origin)) throw new HttpError(403, "origin_not_allowed");
    return;
  }
  const site = request.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") throw new HttpError(403, "origin_required");
}

/** 查询值不进入日志；含邮箱的资源路径也不暴露账户标识。 */
export function safeRequestPath(value: string | undefined): string {
  try {
    return new URL(value ?? "/", "http://request.invalid").pathname
      .split("/")
      .map((segment) => {
        try {
          return decodeURIComponent(segment).includes("@") ? "[account]" : segment;
        } catch {
          return "[invalid]";
        }
      })
      .join("/")
      .replace(/[\r\n]/g, "");
  } catch {
    return "[invalid]";
  }
}
