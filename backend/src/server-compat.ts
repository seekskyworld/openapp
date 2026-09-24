/**
 * 旧部署的显式启动入口。
 *
 * 该模块是显式加载外部兼容组合的启动边界；通用
 * `server.ts` 只在兼容开关打开时动态转交到这里。兼容实现由部署注入的
 * Adapter 提供，Core 只运行通用 Compatibility Host，不再构造内置产品插件。
 */
import { pathToFileURL } from "node:url";
import { startManagedPortal } from "./server-lifecycle.js";
import { createPortalContextAsync } from "./portal-context-generic.js";

export async function startLegacyPortal() {
  const context = await createPortalContextAsync({
    compatibilityMode: true,
    requireExternalAdapter: true,
  });
  return startManagedPortal(context);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLegacyPortal().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
