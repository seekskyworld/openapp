/** 静态资源协议独立于 API 路由，保证直接托管与反向代理的缓存语义一致。 */
import type { ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { HttpError } from "./http-response.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export async function servePortalStatic(
  directory: string,
  pathname: string,
  response: ServerResponse,
  head = false,
): Promise<boolean> {
  const root = resolve(directory);
  let target = resolve(root, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new HttpError(403, "static_path_forbidden");
  try {
    if (!(await stat(target)).isFile()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // 缺失模块或清单必须返回 404，不能伪装成成功的 HTML。
    if (extname(pathname) || pathname.startsWith("/adapter-assets/")) return false;
    target = resolve(root, "index.html");
    try {
      if (!(await stat(target)).isFile()) return false;
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw fallbackError;
    }
  }
  const actualRoot = await realpath(root);
  const actualTarget = await realpath(target);
  if (!actualTarget.startsWith(`${actualRoot}${sep}`)) throw new HttpError(403, "static_path_forbidden");
  const bytes = await readFile(actualTarget);
  const extension = extname(target);
  response.writeHead(200, {
    "content-type": MIME[extension] ?? "application/octet-stream",
    "content-length": String(bytes.length),
    "x-content-type-options": "nosniff",
    "cache-control": extension === ".html" || pathname === "/auth-adapters.json" ? "no-store" : "no-cache",
  });
  response.end(head ? undefined : bytes);
  return true;
}
