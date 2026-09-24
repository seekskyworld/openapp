import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "release-manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1 || manifest.kind !== "openapp-control-plane") {
  throw new Error("unsupported release manifest");
}
if (createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') !== manifest.sourceFingerprint) {
  throw new Error('release fingerprint does not match file manifest');
}
const actual = {};
async function walk(path = "") {
  for (const name of await readdir(join(root, path))) {
    const relative = path ? `${path}/${name}` : name;
    if (relative === "release-manifest.json") continue;
    if (name === ".DS_Store") continue;
    const info = await lstat(join(root, relative));
    if (info.isSymbolicLink()) throw new Error(`unexpected symlink: ${relative}`);
    if (relative === "core/.env" && manifest.kind === "openapp-control-plane" && info.isFile()) continue;
    if (info.isDirectory()) await walk(relative);
    else if (info.isFile()) actual[relative] = createHash("sha256").update(await readFile(join(root, relative))).digest("hex");
    else throw new Error(`unexpected file type: ${relative}`);
  }
}
await walk();
if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(manifest.files).sort())) {
  throw new Error("release files are missing, modified or unexpected");
}
console.log(`${manifest.kind} verified`);
