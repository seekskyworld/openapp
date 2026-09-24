/** 在新目录生成带校验和的 SDK；不依赖公共 registry 已存在该版本。 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "../..");
const output = process.argv[2];
if (!output) throw Error("usage: node scripts/release/contracts-package.mjs <new-directory>");
mkdirSync(resolve(output));
const result = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", resolve(output)], {
    cwd: join(root, "packages/contracts"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
const name = result[0].filename;
const digest = createHash("sha256")
  .update(readFileSync(join(resolve(output), name)))
  .digest("hex");
writeFileSync(join(resolve(output), "SHA256SUMS"), `${digest}  ${name}\n`);
console.log(`SDK ready: ${join(resolve(output), name)}`);
