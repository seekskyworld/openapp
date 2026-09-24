/** 中性应用通过计数器展示每实例独立的持久数据；认证由控制面代理负责。 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
const counterPath = '/data/counter.json';
let count = 0;
try { count = JSON.parse(readFileSync(counterPath, 'utf8')).count; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!Number.isSafeInteger(count) || count < 0) throw Error('invalid persisted counter');
createServer((request, response) => {
  if (request.url === '/health') return response.writeHead(200).end('ok');
  if (request.url === '/counter' && ['GET', 'POST'].includes(request.method)) {
    if (request.method === 'POST') {
      const next = count + 1;
      try {
        writeFileSync(`${counterPath}.tmp`, JSON.stringify({ count: next }));
        renameSync(`${counterPath}.tmp`, counterPath);
        count = next;
      } catch { return response.writeHead(500).end('storage write failed'); }
    }
    return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ count }));
  }
  if (request.url === '/' && request.method === 'GET') {
    return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Plain Web</title><h1>Plain Web</h1><p>A persistent counter for this workspace.</p><button id="add">Increment</button><pre id="value"></pre><script>async function update(method="GET"){const r=await fetch("counter",{method});document.getElementById("value").textContent=await r.text()}document.getElementById("add").onclick=()=>update("POST");update()</script>');
  }
  response.writeHead(404).end('not found');
}).listen(8080, '0.0.0.0');
