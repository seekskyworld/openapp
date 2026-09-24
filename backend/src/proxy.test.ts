import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { ProxyError, proxyInstanceRequest, proxyInstanceUpgrade } from "./proxy.js";

test("instance proxy scopes downstream cookies and does not forward Portal session", async (t) => {
  const upstream = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, {
        location: "/ui/",
        "set-cookie": [
          "sample-app_auth_access=access; Path=/api; Domain=upstream.internal; Max-Age=3600; SameSite=None",
          "sample-app_auth_refresh=refresh; Path=/api; Domain=upstream.internal; Max-Age=86400; SameSite=None",
          "sample-app_auth_session=session; Domain=upstream.internal; SameSite=None; HttpOnly",
          "sample-app_theme=dark; Path=/; Domain=upstream.internal; SameSite=Lax",
          "sample-app_portal_session=shadow; Path=/; HttpOnly",
        ],
      });
      response.end();
      return;
    }
    if (request.url === "/headers") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ authorization: request.headers.authorization ?? null, adminToken: request.headers["x-openapp-admin-token"] ?? null }));
      return;
    }
    if (request.url === "/delete") {
      response.writeHead(200, {
        "set-cookie": "sample-app_auth_access=; Path=/api; Max-Age=-1; SameSite=None",
      }).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(request.headers.cookie ?? "");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;

  const portal = http.createServer((request, response) => {
    void proxyInstanceRequest(request, response, endpoint, "/instances/test", {
      stripCookieNames: ["sample-app_portal_session"],
      stripResponseCookieNames: ["sample-app_portal_session"],
      rootScopedCookieNames: ["sample-app_auth_access", "sample-app_auth_refresh", "sample-app_auth_session"],
      httpOnlyRootScopedCookieNames: ["sample-app_auth_access", "sample-app_auth_refresh"],
      secureRootScopedCookies: true,
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  t.after(() => portal.close());
  const portalAddress = portal.address();
  assert.ok(portalAddress && typeof portalAddress !== "string");
  const base = `http://127.0.0.1:${portalAddress.port}`;

  const redirect = await fetch(`${base}/instances/test/redirect`, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/instances/test/ui/");
  assert.deepEqual(redirect.headers.getSetCookie(), [
    "sample-app_auth_access=access; Path=/; Max-Age=3600; SameSite=Lax; HttpOnly; Secure",
    "sample-app_auth_refresh=refresh; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly; Secure",
    "sample-app_auth_session=session; Path=/; SameSite=Lax; Secure",
    "sample-app_theme=dark; Path=/instances/test/; SameSite=Lax",
  ]);

  const cookieEcho = await fetch(`${base}/instances/test/api/health`, {
    headers: {
      authorization: "Bearer portal-token",
      "x-openapp-admin-token": "admin-token",
      cookie: "sample-app_portal_session=portal; sample-app_auth_access=access",
    },
  });
  assert.equal(await cookieEcho.text(), "sample-app_auth_access=access");

  const headers = await fetch(`${base}/instances/test/headers`, {
    headers: { authorization: "Bearer portal-token", "x-openapp-admin-token": "admin-token" },
  });
  assert.deepEqual(await headers.json(), { authorization: null, adminToken: null });

  const deletion = await fetch(`${base}/instances/test/delete`);
  assert.deepEqual(deletion.headers.getSetCookie(), [
    "sample-app_auth_access=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure",
  ]);
});

test("instance proxy rejects an origin-changing path before forwarding cookies", async (t) => {
  let attackerRequests = 0;
  const attacker = http.createServer((_request, response) => {
    attackerRequests += 1;
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => attacker.listen(0, "127.0.0.1", resolve));
  t.after(() => attacker.close());
  const attackerAddress = attacker.address();
  assert.ok(attackerAddress && typeof attackerAddress !== "string");

  const upstream = http.createServer((_request, response) => response.writeHead(200).end());
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const endpoint = `http://127.0.0.1:${upstreamAddress.port}`;

  const portal = http.createServer((request, response) => {
    void (async () => {
      try {
        await proxyInstanceRequest(request, response, endpoint, "/instances/test", {
          stripCookieNames: ["sample-app_portal_session"],
        });
      } catch (error) {
        response.writeHead(error instanceof ProxyError ? error.status : 500).end();
      }
    })();
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  t.after(() => portal.close());
  const portalAddress = portal.address();
  assert.ok(portalAddress && typeof portalAddress !== "string");

  const response = await new Promise<{ status: number }>((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: portalAddress.port,
      path: `/instances/test//127.0.0.1:${attackerAddress.port}/collect`,
      headers: { cookie: "sample-app_auth_refresh=secret" },
    }, (upstreamResponse) => {
      upstreamResponse.resume();
      upstreamResponse.once("end", () => resolve({ status: upstreamResponse.statusCode ?? 0 }));
    });
    request.once("error", reject);
    request.end();
  });

  assert.equal(response.status, 400);
  assert.equal(attackerRequests, 0);
});

test("instance proxy preserves private base routing without exposing signed query data", async (t) => {
  const requests: Array<{
    path: string;
    authorization: string | undefined;
    providerToken: string | undefined;
    host: string | undefined;
  }> = [];
  const upstream = http.createServer((request, response) => {
    requests.push({
      path: request.url ?? "/",
      authorization: request.headers.authorization,
      providerToken: request.headers["x-provider-token"] as string | undefined,
      host: request.headers.host,
    });
    if (request.url?.startsWith("/private/base/redirect?")) {
      response.writeHead(302, {
        location: "ui/?signature=provider-secret&route=stable&next=1#ready",
      }).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(requests.at(-1)));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;
  const endpoint = `${upstreamOrigin}/private/base?signature=provider-secret&route=stable`;

  const portal = http.createServer((request, response) => {
    void (async () => {
      try {
        await proxyInstanceRequest(request, response, endpoint, "/instances/test", {
          upstreamHost: "workspace.provider.internal",
          upstreamHeaders: {
            authorization: "Bearer provider-secret",
            "x-provider-token": "provider-secret",
          },
        });
      } catch (error) {
        if (!response.headersSent) response.writeHead(error instanceof ProxyError ? error.status : 500).end();
      }
    })();
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  t.after(() => portal.close());
  const portalAddress = portal.address();
  assert.ok(portalAddress && typeof portalAddress !== "string");
  const base = `http://127.0.0.1:${portalAddress.port}`;

  const forwarded = await fetch(`${base}/instances/test/api/items?view=browser`, {
    headers: {
      authorization: "Bearer browser-token",
      "x-provider-token": "browser-token",
    },
  });
  assert.equal(forwarded.status, 200);
  assert.deepEqual(await forwarded.json(), {
    path: "/private/base/api/items?signature=provider-secret&route=stable&view=browser",
    authorization: "Bearer provider-secret",
    providerToken: "provider-secret",
    host: "workspace.provider.internal",
  });

  const redirect = await fetch(`${base}/instances/test/redirect`, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/instances/test/ui/?next=1#ready");
  assert.equal(redirect.headers.get("location")?.includes("provider-secret"), false);

  const beforeConflict = requests.length;
  const conflict = await fetch(`${base}/instances/test/api?signature=browser-value`);
  assert.equal(conflict.status, 400);
  assert.equal(requests.length, beforeConflict);
});

test("instance proxy converts upstream network details to a stable error", async (t) => {
  const unavailable = http.createServer();
  await new Promise<void>((resolve) => unavailable.listen(0, "127.0.0.1", resolve));
  const address = unavailable.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => unavailable.close((error) => error ? reject(error) : resolve()));
  const privateEndpoint = `http://127.0.0.1:${address.port}/private`;

  const portal = http.createServer((request, response) => {
    void proxyInstanceRequest(request, response, privateEndpoint, "/instances/test")
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        response.writeHead(error instanceof ProxyError ? error.status : 500, {
          "content-type": "text/plain",
        }).end(message);
      });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  t.after(() => portal.close());
  const portalAddress = portal.address();
  assert.ok(portalAddress && typeof portalAddress !== "string");

  const response = await fetch(`http://127.0.0.1:${portalAddress.port}/instances/test/inspect`);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "workspace_upstream_unavailable");
});

test("instance proxy forwards one POST body exactly once", async (t) => {
  let requests = 0;
  const upstream = http.createServer((request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`${request.method}:${Buffer.concat(chunks).toString("utf8")}`);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");

  const portal = http.createServer((request, response) => {
    void proxyInstanceRequest(
      request,
      response,
      `http://127.0.0.1:${upstreamAddress.port}`,
      "/instances/test",
    );
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  t.after(() => portal.close());
  const portalAddress = portal.address();
  assert.ok(portalAddress && typeof portalAddress !== "string");

  const response = await fetch(`http://127.0.0.1:${portalAddress.port}/instances/test/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"message":"hello"}',
  });

  assert.equal(await response.text(), 'POST:{"message":"hello"}');
  assert.equal(requests, 1);
});

test("instance proxy secures a WebSocket upgrade and its response cookies", async (t) => {
  let authorization: string | undefined;
  let adminToken: string | undefined;
  let cookie: string | undefined;
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket, head) => {
    authorization = request.headers.authorization;
    adminToken = request.headers["x-openapp-admin-token"] as string | undefined;
    cookie = request.headers.cookie;
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Set-Cookie: sample-app_portal_session=must-strip; Path=/",
      "Set-Cookie: sample-app_theme=dark; Path=/",
      "",
      "",
    ].join("\r\n"));
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");

  const portal = http.createServer();
  portal.on("upgrade", (request, socket, head) => {
    void proxyInstanceUpgrade(
      request,
      socket,
      head,
      `http://127.0.0.1:${upstreamAddress.port}`,
      "/instances/test",
      {
        stripCookieNames: ["sample-app_portal_session"],
        stripResponseCookieNames: ["sample-app_portal_session"],
      },
    );
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  t.after(() => portal.close());
  const portalAddress = portal.address();
  assert.ok(portalAddress && typeof portalAddress !== "string");

  const result = await new Promise<string>((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: portalAddress.port,
      path: "/instances/test/socket",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        authorization: "Bearer portal-token",
        "x-openapp-admin-token": "admin-token",
        cookie: "sample-app_portal_session=portal; sample-app_auth_access=app",
      },
    });
    request.once("upgrade", (response, socket) => {
      assert.deepEqual(response.headers["set-cookie"], ["sample-app_theme=dark; Path=/instances/test/"]);
      socket.end();
      resolve("upgraded");
    });
    request.once("response", (response) => reject(new Error(`unexpected response ${response.statusCode}`)));
    request.once("error", reject);
    request.end();
  });

  assert.equal(result, "upgraded");
  assert.equal(authorization, undefined);
  assert.equal(adminToken, undefined);
  assert.equal(cookie, "sample-app_auth_access=app");
});

test("instance proxy honors an already-aborted activity signal before opening upstream sockets", async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer(() => {
    upstreamRequests += 1;
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const controller = new AbortController();
  controller.abort(new Error("instance_draining"));
  let responseDestroyed = false;
  const request = { url: "/instances/test/health", method: "GET", headers: {} } as unknown as IncomingMessage;
  const response = {
    destroy: () => { responseDestroyed = true; },
  } as unknown as ServerResponse;
  await proxyInstanceRequest(request, response, `http://127.0.0.1:${address.port}`, "/instances/test", {
    signal: controller.signal,
  });

  let socketDestroyed = false;
  const socket = {
    destroy: () => { socketDestroyed = true; },
  } as unknown as Duplex;
  await proxyInstanceUpgrade(
    request,
    socket,
    Buffer.alloc(0),
    `http://127.0.0.1:${address.port}`,
    "/instances/test",
    { signal: controller.signal },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(upstreamRequests, 0);
  assert.equal(responseDestroyed, true);
  assert.equal(socketDestroyed, true);
  await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
});
