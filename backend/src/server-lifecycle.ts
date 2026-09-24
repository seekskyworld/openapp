/** 进程入口统一排空 HTTP/维护任务并关闭连接池；不用于测试创建的普通服务器。 */
import type { Socket } from "node:net";
import type { PortalContext } from "./portal-context-core.js";
import { createPortalApp } from "./portal-app.js";

export async function startManagedPortal(context: PortalContext) {
  const app = createPortalApp(context);
  try {
    await app.start();
  } catch (error) {
    await app.stopMaintenance();
    await context.stores.close?.();
    throw error;
  }
  const sockets = new Set<Socket>();
  app.server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // 升级/WebSocket 连接也必须受截止时间约束，避免部署无限等待。
    const deadline = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      process.exit(1);
    }, 15_000);
    void (async () => {
      const maintenance = app.stopMaintenance();
      const drained = new Promise<void>((resolve, reject) =>
        app.server.close((error) => (error ? reject(error) : resolve())),
      );
      app.server.closeIdleConnections();
      await Promise.all([maintenance, drained]);
      await context.stores.close?.();
      clearTimeout(deadline);
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    })().catch(() => {
      console.error("OpenApp shutdown failed");
      process.exitCode = 1;
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return app.server;
}
