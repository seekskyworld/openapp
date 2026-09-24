/** 针对教程标记的新组合环境验收真实 HTTP、隔离与持久性，不接受任意线上 URL。 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const release = resolve(process.argv[2] ?? "");
const lab = dirname(release);
const state = JSON.parse(await readFile(join(lab, "tutorial-state.json"), "utf8"));
if (
  !/^openapp-tutorial-[a-f0-9]{12}$/.test(state.project) ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(state.origin)
)
  throw Error("not a local tutorial environment");
const configuration = await readFile(join(release, "core/.env"), "utf8");
if (!configuration.includes(`COMPOSE_PROJECT_NAME=${state.project}\n`))
  throw Error("tutorial project mismatch");
const credentialsPath = join(lab, "tutorial-accounts.json");
try {
  await readFile(credentialsPath);
  throw Error("verification already ran; use the recorded accounts or a new lab");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const accounts = ["alice", "bob"].map((name) => ({
  email: `${name}@example.test`,
  password: randomBytes(20).toString("hex"),
}));
const request = async (path, { cookie, method = "GET", body } = {}) => {
  const response = await fetch(`${state.origin}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      Origin: state.origin,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000),
    redirect: "manual",
  });
  return response;
};
const json = async (path, options, expected = 200) => {
  const response = await request(path, options);
  const body = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(body)}`);
  return body;
};
const results = [];
const passed = (name) => {
  results.push(name);
  console.log(`PASS ${name}`);
};
assert.equal((await request("/api/ready")).status, 200);
assert.equal((await request("/control")).status, 200);
const methods = await json("/api/auth/methods");
assert.deepEqual(methods.external, []);
passed("composed portal ready; local authentication without SSO");
const users = [];
await writeFile(credentialsPath, JSON.stringify(accounts, null, 2) + "\n", { flag: "wx", mode: 0o600 });
for (const account of accounts) {
  const registered = await request("/api/auth/local/register", { method: "POST", body: account });
  assert.equal(registered.status, 201, await registered.text());
  const login = await request("/api/auth/local/login", { method: "POST", body: account });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.role, "user");
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  const { container } = await json(
    "/api/containers",
    { cookie, method: "POST", body: { appId: "notes-demo" } },
    201,
  );
  const { url } = await json(`/api/containers/${container.id}/enter`, { cookie, method: "POST" });
  const entry = new URL(url);
  assert.equal(entry.origin, state.origin);
  users.push({ ...account, cookie, id: container.id, path: entry.pathname });
}
assert.notEqual(users[0].id, users[1].id);
passed("two real user workspaces created from the independently built application image");
for (const [index, user] of users.entries()) {
  const page = await request(user.path, user);
  const html = await page.text();
  assert.equal(page.status, 200, `application entry ${user.path}: ${html}`);
  assert.match(html, /我的独立笔记/);
  for (const asset of ["app.js", "style.css"])
    assert.equal((await request(`${user.path}${asset}`, user)).status, 200);
  assert.equal((await json(`${user.path}api/note`, user)).note, "");
  await json(`${user.path}api/note`, { ...user, method: "PUT", body: { note: `private note ${index}` } });
}
for (const [index, user] of users.entries()) {
  assert.equal((await json(`${user.path}api/note`, user)).note, `private note ${index}`);
  const list = await json("/api/containers", user);
  assert.deepEqual(
    list.containers.map((item) => item.id),
    [user.id],
  );
  assert.equal((await request("/api/admin/users", user)).status, 403);
  const other = users[1 - index];
  assert.equal((await request(`${other.path}api/note`, user)).status, 404);
  assert.equal((await request(`/api/containers/${other.id}/start`, { ...user, method: "POST" })).status, 404);
}
assert.notEqual((await request(`${users[0].path}api/note`)).status, 200);
passed("frontend assets and business API work; each user sees only their own data and instances");
for (const user of users) {
  await json(`/api/containers/${user.id}/stop`, { ...user, method: "POST" });
  await json(`/api/containers/${user.id}/start`, { ...user, method: "POST" });
  await json(`/api/containers/${user.id}/enter`, { ...user, method: "POST" });
}
for (const [index, user] of users.entries())
  assert.equal((await json(`${user.path}api/note`, user)).note, `private note ${index}`);
passed("application stop/start preserves both user volumes");
const compose = (args) =>
  execFileSync(
    "docker",
    [
      "compose",
      "--project-directory",
      join(release, "core"),
      "--env-file",
      join(release, "core/.env"),
      "-f",
      join(release, "core/docker-compose.yml"),
      ...args,
    ],
    { stdio: "pipe" },
  );
compose(["restart", "portal-backend"]);
compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "120", "portal-backend", "frontend"]);
for (const [index, user] of users.entries()) {
  const login = await request("/api/auth/local/login", {
    method: "POST",
    body: { email: user.email, password: user.password },
  });
  assert.equal(login.status, 200);
  user.cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.equal((await json(`${user.path}api/note`, user)).note, `private note ${index}`);
}
passed("control-plane restart preserves accounts, routing and notes");
await writeFile(
  join(lab, "tutorial-acceptance.json"),
  JSON.stringify(
    {
      passed: results,
      origin: state.origin,
      accountsFile: "tutorial-accounts.json",
      date: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Acceptance complete. Credentials are private in ${credentialsPath}; no passwords printed.`);
