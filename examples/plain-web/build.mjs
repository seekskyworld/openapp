/** 示例无第三方依赖；生成与组合导出器约定一致的生产入口。 */
import { mkdir, copyFile } from 'node:fs/promises';
const output = new URL('./dist/', import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(new URL('./index.mjs', import.meta.url), new URL('index.js', output));
await mkdir(new URL('runtime/', output), { recursive: true });
await copyFile(new URL('./runtime/profile.json', import.meta.url), new URL('runtime/profile.json', output));
