/** 子进程接收真实 SIGTERM，避免测试改变当前测试进程或现有服务。 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
test("managed server exits cleanly after SIGTERM", { timeout: 10_000 }, async () => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {createPortalContextAsync} from './dist/portal-context-core.js';
    import {loadGenericConfig} from './dist/config-core.js';
    import {startManagedPortal} from './dist/server-lifecycle.js';
    const environment={OPENAPP_CONTROL_PLANE_ONLY:'true',AUTH_PROVIDER:'none'};
    const context=await createPortalContextAsync({environment,config:{...loadGenericConfig(environment),host:'127.0.0.1',port:0}});
    const close=context.stores.close;context.stores.close=async()=>{await close?.();console.log('persistence-closed');};
    await startManagedPortal(context);console.log('ready-for-signal');
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const exited = once(child, "exit");
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(Error("server exited before readiness")));
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("ready-for-signal")) resolve();
      });
    });
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.match(output, /persistence-closed/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
