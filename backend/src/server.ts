import { pathToFileURL } from "node:url";
import { startManagedPortal } from "./server-lifecycle.js";
import { createPortalContextAsync } from "./portal-context-generic.js";

export async function startPortal() {
  // 兼容模式通过独立入口加载；通用启动图本身不导入任何产品实现。
  const compatibilityMode =
    process.env.OPENAPP_COMPATIBILITY_MODE === "true" || process.env.OPENAPP_COMPATIBILITY_MODE === "1";
  if (compatibilityMode) {
    const { startLegacyPortal } = await import("./server-compat.js");
    return startLegacyPortal();
  }
  const context = await createPortalContextAsync();
  return startManagedPortal(context);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPortal().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
