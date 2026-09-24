/**
 * 统一拼接下游工作负载的健康检查地址。
 *
 * Portal 自身的 `/api/health` 是控制面合同；工作负载的健康路径由
 * RuntimeProfile 声明。两者必须分开，避免新 App 因复用旧路径而被误判为
 * 启动失败。
 */

export const DEFAULT_WORKSPACE_HEALTH_PATH = "/api/health";

export interface WorkspaceHealthProfile {
  readonly healthPath?: string;
}

/**
 * 返回部署 profile 声明的健康路径，并在组合根处拒绝危险或含糊的路径。
 * profile 通常已由 Runtime/Adapter 合同校验；这里再次校验是为了保护直接
 * 注入测试替身和旧调用方，避免把未校验值拼进服务端请求。
 */
export function resolveWorkspaceHealthPath(profile?: WorkspaceHealthProfile): string {
  const path = profile?.healthPath?.trim() || DEFAULT_WORKSPACE_HEALTH_PATH;
  if (!isValidWorkspaceHealthPath(path)) throw new Error("workspace_health_path_invalid");
  return normalizeWorkspaceHealthPath(path);
}

/**
 * 在工作负载 endpoint 上追加健康路径，保留 endpoint 的基础路径和查询参数。
 * 传入 URL 而不是字符串拼接，避免自定义 endpoint 末尾斜杠导致双斜杠。
 */
export function workspaceHealthUrl(base: string | URL, healthPath: string): URL {
  if (!isValidWorkspaceHealthPath(healthPath)) throw new Error("workspace_health_path_invalid");
  const url = typeof base === "string" ? new URL(base) : new URL(base.href);
  const basePath = url.pathname.replace(/\/+$/u, "");
  const normalizedPath = normalizeWorkspaceHealthPath(healthPath);
  url.pathname = `${basePath}/${normalizedPath.slice(1)}`;
  return url;
}

function isValidWorkspaceHealthPath(path: string): boolean {
  return path.startsWith("/")
    && !path.includes("\0")
    && !path.includes("?")
    && !path.includes("#")
    && !path.split("/").some((segment) => segment === ".." || segment === ".");
}

function normalizeWorkspaceHealthPath(path: string): string {
  const normalized = path.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "");
  return normalized || "/";
}
