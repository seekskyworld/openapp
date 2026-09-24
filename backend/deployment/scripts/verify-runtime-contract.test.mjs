import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
// 模拟 Docker 的进程退出码，确保验收不会把工具故障当成隔离成功。
for (const { mode, mask } of [
  ...Array.from({ length: 8 }, (_, mask) => ({ mode: 'isolated', mask })),
  { mode: 'connected', mask: 0 }, { mode: 'broken', mask: 0 },
]) {
  test(`runtime verifier distinguishes ${mode} probes with optional fields ${mask}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "openapp-probe-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const log = join(root, "calls.jsonl");
    const profile = join(root, "profile.json");
    await writeFile(profile, JSON.stringify({ containerPort: 8080, healthPath: "/health", providerEnvironment: {
      ...(mask & 1 ? { authProviderKey: 'APP_AUTH_URL', defaultAuthProviderBaseUrl: 'https://identity.example.test' } : {}),
      ...(mask & 2 ? { allowedOriginsKey: 'APP_ALLOWED_ORIGINS' } : {}),
      ...(mask & 4 ? { mcpAppSandboxOriginKey: 'APP_SANDBOX_ORIGIN' } : {}),
    } }));
    await writeFile(join(root, "docker"), `#!${process.execPath}
const fs=require('node:fs'); const a=process.argv.slice(2);
fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify(a)+'\\n');
if(a[0]==='image') console.log('linux/amd64');
else if(a[0]==='inspect') console.log(a.join(' ').includes('.Mounts')?'/data':'10.0.0.2');
else if(a[0]==='run' && a.includes('node')) {
  if(a.at(-2)==='127.0.0.1') process.exit(0);
  process.exit(process.env.PROBE_MODE==='isolated'?42:process.env.PROBE_MODE==='connected'?0:127);
}
`, { mode: 0o700 });
    const operation = exec("bash", [resolve("deployment/scripts/verify-runtime-contract.sh")], {
      env: { PATH: `${root}:${process.env.PATH}`, PROBE_LOG: log, PROBE_MODE: mode,
        OPENAPP_RUNTIME_IMAGE: "sample-runtime:test", OPENAPP_RUNTIME_PROBE_IMAGE: "node:24-bookworm-slim",
        OPENAPP_RUNTIME_PROFILE: profile,
        OPENAPP_MCP_APP_SANDBOX_ORIGIN: 'https://sandbox.example.test',
        TARGET_PLATFORM: "linux/amd64", OPENAPP_RUNTIME_VERIFY_ID: `test-${mode}` },
    });
    if (mode === "isolated") assert.match((await operation).stdout, /Runtime contract verified/);
    else await assert.rejects(operation, mode === "connected" ? /isolation failed/ : /probe failed.*127/);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.some(a => a[0] === "run" && a.includes("container:openapp-user-verify-a-test-" + mode)));
    assert.equal(calls.some(a => a[0] === "exec" && a[1].startsWith("openapp-user-")), false);
    assert.ok(calls.some(a => a[0] === "exec" && a.slice(-2).join(" ") === "8080 /health"));
    const create = calls.find(a => a[0] === 'create');
    const injected = create.filter((_, i) => create[i - 1] === '--env');
    assert.deepEqual(injected, [
      ...(mask & 1 ? ['APP_AUTH_URL=https://identity.example.test'] : []),
      ...(mask & 2 ? [`APP_ALLOWED_ORIGINS=http://openapp-portal-probe-test-${mode}`] : []),
      ...(mask & 4 ? ['APP_SANDBOX_ORIGIN=https://sandbox.example.test'] : []),
    ]);
  });
}
