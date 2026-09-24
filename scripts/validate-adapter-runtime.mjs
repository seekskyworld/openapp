#!/usr/bin/env node
// 通用发布边界校验由 contracts 提供，Core 与 Adapter 使用同一实现。
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const sdkPath = ['../packages/contracts/dist/runtime-context.mjs', '../../../packages/contracts/dist/runtime-context.mjs']
  .map(path => new URL(path, import.meta.url)).find(path => existsSync(path));
const { runRuntimeValidationCli, validateAdapterRuntime } = await import(sdkPath?.href ?? '@openapp/contracts/runtime-context');
export { validateAdapterRuntime };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runRuntimeValidationCli();
