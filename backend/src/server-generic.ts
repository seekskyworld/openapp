import { pathToFileURL } from "node:url";
import { startManagedPortal } from "./server-lifecycle.js";
import { createPortalContextAsync } from "./portal-context-generic.js";

/**
 * 通用生产启动入口只装载中性组合根；legacy 启动分支由单独的 server.js
 * 保留在兼容发布面，避免通用镜像携带可执行的旧组合入口。
 */
export async function startGenericPortal() {
  const context = await createPortalContextAsync({ compatibilityMode: false });
  return startManagedPortal(context);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGenericPortal().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
