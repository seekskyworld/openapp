/** 全新安装只使用 SDK tarball，验证第三方不需要 Core 私有源码或已发布 registry 包。 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test("packed SDK supports independent backend and browser contract consumers", () => {
  const root = resolve(import.meta.dirname, "../..");
  const temporary = mkdtempSync(join(tmpdir(), "openapp-sdk-install-"));
  try {
    execFileSync(
      process.execPath,
      [join(root, "scripts/release/contracts-package.mjs"), join(temporary, "sdk")],
      { stdio: "pipe" },
    );
    const version = JSON.parse(readFileSync(join(root, "packages/contracts/package.json"))).version;
    const tarball = join(temporary, "sdk", `openapp-contracts-${version}.tgz`);
    writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
      cwd: temporary,
      stdio: "pipe",
    });
    writeFileSync(
      join(temporary, "check.ts"),
      `import type { OpenAppAdapterFactory } from '@openapp/contracts';
import { AUTH_UI_API_VERSION, type AuthUiFactory, type AuthUiLoginProps } from '@openapp/contracts/ui';
type View = (props: AuthUiLoginProps) => null;
const ui: AuthUiFactory<{ marker: string }, View> = host => ({views:{workspace: props => { props.onLogin({id:'id',email:'member@example.test',role:'user'}); return null; },control: () => null}});
const version: 1 = AUTH_UI_API_VERSION;
export {ui, version}; export type {OpenAppAdapterFactory};\n`,
    );
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "false",
        "--module",
        "NodeNext",
        "--target",
        "ES2022",
        "check.ts",
      ],
      { cwd: temporary, stdio: "pipe" },
    );
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {AUTH_UI_API_VERSION} from '@openapp/contracts/ui'; import '@openapp/contracts/runtime-context'; console.log(AUTH_UI_API_VERSION)",
      ],
      { cwd: temporary, encoding: "utf8" },
    );
    assert.equal(result.trim(), "1");
    cpSync(join(root, "examples/adapter-template/src"), join(temporary, "src"), { recursive: true });
    cpSync(join(root, "examples/adapter-template/tsconfig.json"), join(temporary, "tsconfig.json"));
    execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
      cwd: temporary,
      stdio: "pipe",
    });
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import factory from './dist/index.js'; import {validateAdapterManifest} from '@openapp/contracts'; validateAdapterManifest(factory({environment:{},releaseInspector:{}}).manifest)",
      ],
      { cwd: temporary, stdio: "pipe" },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
