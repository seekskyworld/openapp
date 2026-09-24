/** 单人笔记应用；不依赖 OpenApp、不处理平台账号，由反向代理保护访问。 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const dataFile = join(process.env.DATA_DIR ?? "/data", "note.json");
// 部署路径是普通 Web 配置；直接运行默认在根路径，镜像可配置为 /ui。
const basePath = (process.env.BASE_PATH ?? "").replace(/\/$/, "");
if (basePath && !/^\/[a-zA-Z0-9/_-]+$/.test(basePath)) throw Error("invalid BASE_PATH");
let note = "";
try {
  note = JSON.parse(readFileSync(dataFile, "utf8")).note;
  if (typeof note !== "string") throw Error("invalid note file");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const json = (status, data) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
  try {
    if (request.method === "GET" && path === "/health") return json(200, { ok: true });
    if (request.method === "GET" && path === `${basePath}/api/note`) return json(200, { note });
    if (request.method === "PUT" && path === `${basePath}/api/note`) {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16_384) return json(413, { error: "note_too_large" });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof body.note !== "string" || body.note.length > 4_000)
        return json(400, { error: "invalid_note" });
      writeFileSync(`${dataFile}.tmp`, JSON.stringify({ note: body.note }));
      renameSync(`${dataFile}.tmp`, dataFile);
      note = body.note;
      return json(200, { note });
    }
    const asset = path.startsWith(`${basePath}/`) ? assets.get(path.slice(basePath.length)) : undefined;
    if (request.method === "GET" && asset) {
      const bytes = readFileSync(new URL(`../frontend/${asset[0]}`, import.meta.url));
      return response.writeHead(200, { "content-type": asset[1], "cache-control": "no-store" }).end(bytes);
    }
    return json(404, { error: "not_found" });
  } catch (error) {
    return json(error instanceof SyntaxError ? 400 : 500, {
      error: error instanceof SyntaxError ? "invalid_json" : "storage_error",
    });
  }
}).listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
