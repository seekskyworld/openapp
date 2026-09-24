#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { PortalClient, type CliIdentity } from "./cli-client.js";

interface CliOptions {
  url: string;
  identity: CliIdentity;
  token: string;
  cookieName?: string;
  json: boolean;
}

const HELP = `openappctl - OpenApp Portal administration client

Usage:
  openappctl [options] <command> [subcommand] [arguments]

Options:
  --url <url>             Portal URL (OPENAPP_PORTAL_URL, default http://127.0.0.1:4310)
  --identity admin|user   Credential class (default admin)
  --token <token>         Token (OPENAPP_ADMIN_CLI_TOKEN or OPENAPP_SESSION_TOKEN)
  --cookie-name <name>    Session cookie name when using a user token
  --json                  Print machine-readable JSON

Commands:
  status
  overview
  config show
  users list
  apps list
  apps create <app-id> <name>
  apps update <app-id> active|archived
  apps image update <app-id> <expected-revision> <slot=package-id> [slot=package-id...]
  apps image bind <app-id> <revision-id> <expected-revision>
  apps versions list <app-id>
  apps versions upload <app-id> <file> [file ...]  (Adapter schema order)
  apps versions image attach <app-id> <version-id> <image-reference>
  apps versions activate <app-id> <version-id>
  containers list
  containers start|stop|rebuild|delete <container-id>
  containers upgrade <container-id>
  build-packages list [strategy-id] [slot]
  build-packages upload <strategy-id> <slot> <package-path>
  build-packages delete <package-id>
  image-artifacts list
  image-artifacts delete <artifact-id>
  cleanup preview [keep-previous]
  cleanup run [keep-previous]
  images list
  images pull <image-reference>
  images load <archive-path> <image-reference>
  runtime status
  runtime check
  monitor instances [status]
  monitor metrics <container-id>
  health [target]
  audit
  operations list [status]
  operations get|wait|cancel|retry <operation-id>
  config-revisions instance-policy|forwarding list
  config-revisions instance-policy|forwarding rollback <revision>
  forwarding get
  forwarding test [target-url]
  forwarding set <target-url>
  forwarding enable|disable
  forwarding allow <origin> [origin...]
  policy get
  policy auto-create on|off
  policy auto-start on|off
  policy detect-network on|off
  policy detect-compute on|off
  policy idle-stop <minutes>
  policy max-instances <count>
  policy max-running <count>
  policy default-app <app-id>
  policy resources <memory> <cpus> <pids-limit>
  policy env <json-file>
  policy config-files <json-file>
  maintenance sweep
`;

function usageError(message: string): never {
  throw new Error(`${message}\n\n${HELP}`);
}

function parseOptions(args: string[]): { options: CliOptions; command: string[] } {
  const options: CliOptions = {
    url: process.env.OPENAPP_PORTAL_URL ?? "http://127.0.0.1:4310",
    identity: "admin",
    token: "",
    json: false,
  };
  const command: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = () => {
      const value = args[++index];
      if (!value) usageError(`${arg} requires a value`);
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    }
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--url") { options.url = next(); continue; }
    if (arg === "--identity") {
      const identity = next();
      if (identity !== "admin" && identity !== "user") usageError("--identity must be admin or user");
      options.identity = identity;
      continue;
    }
    if (arg === "--token") { options.token = next(); continue; }
    if (arg === "--cookie-name") { options.cookieName = next(); continue; }
    if (arg.startsWith("-")) usageError(`unknown option: ${arg}`);
    command.push(arg);
  }
  if (!options.token) {
    options.token = options.identity === "admin"
      ? (process.env.OPENAPP_ADMIN_CLI_TOKEN ?? "")
      : (process.env.OPENAPP_SESSION_TOKEN ?? "");
  }
  return { options, command };
}

function print(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read JSON file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function positiveInteger(value: string, name: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) usageError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  return parsed;
}

function packageReplacements(values: readonly string[]): Record<string, string> {
  if (values.length === 0) usageError("at least one slot=package-id replacement is required");
  const replacements: Record<string, string> = {};
  const keyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  for (const value of values) {
    const separator = value.indexOf("=");
    const key = separator > 0 ? value.slice(0, separator).trim().toLowerCase() : "";
    const packageId = separator > 0 ? value.slice(separator + 1).trim() : "";
    if (!keyPattern.test(key) || !idPattern.test(packageId)) {
      usageError(`invalid package replacement: ${value}`);
    }
    if (replacements[key]) usageError(`duplicate package slot: ${key}`);
    replacements[key] = packageId;
  }
  return replacements;
}

async function waitForOperation(client: PortalClient, id: string): Promise<unknown> {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const result = await client.request<{ operation: { status: string } }>("GET", `/api/admin/operations/${encodeURIComponent(id)}`);
    if (["succeeded", "failed", "cancelled"].includes(result.operation.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`operation wait timed out: ${id}`);
}

async function patchConfig(client: PortalClient, path: string, body: unknown): Promise<unknown> {
  const current = await client.request<{ revision?: { revision?: number } | null }>("GET", path);
  const revision = current.revision?.revision ?? 0;
  return client.request("PATCH", path, body, { "if-match": String(revision) });
}

export async function runCli(args: string[]): Promise<void> {
  const { options, command } = parseOptions(args);
  const [group, action, argument, extra] = command;
  if (!group) usageError("a command is required");
  if (group === "status") {
    if (action || argument || extra) usageError("status does not take arguments");
    const client = new PortalClient({ baseUrl: options.url, identity: options.identity, cookieName: options.cookieName, token: options.token || "anonymous" });
    print(await client.request("GET", "/api/health"), options.json);
    return;
  }
  if (!options.token) usageError("a token is required; set OPENAPP_ADMIN_CLI_TOKEN or OPENAPP_SESSION_TOKEN");
  const client = new PortalClient({ baseUrl: options.url, identity: options.identity, cookieName: options.cookieName, token: options.token });

  if (["overview", "config", "users", "apps", "images", "image-artifacts", "build-packages", "cleanup", "forwarding", "runtime", "policy", "maintenance", "monitor", "health", "audit", "operations", "config-revisions"].includes(group) && options.identity !== "admin") {
    usageError(`${group} requires --identity admin`);
  }

  if (group === "overview" && !action && !argument && !extra) {
    print(await client.request("GET", "/api/admin/overview"), options.json);
    return;
  }

  if (group === "config" && action === "show" && !argument) {
    print(await client.request("GET", "/api/admin/config"), options.json);
    return;
  }
  if (group === "runtime" && action === "status" && !argument) {
    print(await client.request("GET", "/api/admin/runtime"), options.json);
    return;
  }
  if (group === "runtime" && action === "check" && !argument) {
    print(await client.request("POST", "/api/admin/runtime/check", {}), options.json);
    return;
  }
  if (group === "users" && action === "list" && !argument) {
    print(await client.request("GET", "/api/admin/users"), options.json);
    return;
  }
  if (group === "apps" && action === "list" && !argument) {
    print(await client.request("GET", "/api/admin/apps"), options.json);
    return;
  }
  if (group === "apps" && action === "create" && argument && extra && !command[4]) {
    print(await client.request("POST", "/api/admin/apps", {
      id: argument,
      name: extra,
    }), options.json);
    return;
  }
  if (group === "apps" && action === "update" && argument && (extra === "active" || extra === "archived") && !command[4]) {
    print(await client.request("PATCH", `/api/admin/apps/${encodeURIComponent(argument)}`, { status: extra }), options.json);
    return;
  }
  if (group === "apps" && action === "image" && argument === "update" && extra && command[4] && command[5]) {
    print(await client.request("POST", `/api/admin/apps/${encodeURIComponent(extra)}/image-updates`, {
      expectedRevision: positiveInteger(command[4]!, "expected-revision", true),
      replacementPackageIds: packageReplacements(command.slice(5)),
    }), options.json);
    return;
  }
  if (group === "apps" && action === "image" && argument === "bind" && extra && command[4] && command[5] && !command[6]) {
    print(await client.request(
      "POST",
      `/api/admin/apps/${encodeURIComponent(extra)}/image-updates/${encodeURIComponent(command[4]!)}/bind`,
      { expectedRevision: positiveInteger(command[5]!, "expected-revision", true) },
    ), options.json);
    return;
  }
  if (group === "apps" && action === "versions" && argument === "list" && extra && !command[4]) {
    print(await client.request("GET", `/api/admin/apps/${encodeURIComponent(extra)}/versions`), options.json);
    return;
  }
  if (group === "apps" && action === "versions" && argument === "upload" && extra && command[4]) {
    print(await client.uploadAppVersion(extra, ...command.slice(4)), options.json);
    return;
  }
  if (group === "apps" && action === "versions" && argument === "image" && extra === "attach" && command[4] && command[5] && command[6] && !command[7]) {
    print(await client.request("POST", `/api/admin/apps/${encodeURIComponent(command[4])}/versions/${encodeURIComponent(command[5])}/image`, { reference: command[6] }), options.json);
    return;
  }
  if (group === "apps" && action === "versions" && argument === "activate" && extra && command[4] && !command[5]) {
    print(await client.request("POST", `/api/admin/apps/${encodeURIComponent(extra)}/versions/${encodeURIComponent(command[4])}/activate`, {}), options.json);
    return;
  }
  if (group === "containers" && action === "list" && !argument) {
    print(await client.request("GET", options.identity === "admin" ? "/api/admin/containers" : "/api/containers"), options.json);
    return;
  }
  if (group === "containers" && action === "upgrade" && argument && !extra) {
    if (options.identity !== "admin") usageError("containers upgrade requires --identity admin");
    print(await client.request(
      "POST",
      `/api/admin/containers/${encodeURIComponent(argument)}/rebuild`,
      { useLatestVersion: true },
    ), options.json);
    return;
  }
  if (group === "containers" && (action === "start" || action === "stop" || action === "rebuild" || action === "delete") && argument && !extra) {
    if (action === "rebuild" && options.identity !== "admin") usageError("containers rebuild requires --identity admin");
    const method = action === "delete" ? "DELETE" : "POST";
    const prefix = options.identity === "admin" ? "/api/admin/containers" : "/api/containers";
    print(await client.request(method, `${prefix}/${encodeURIComponent(argument)}${method === "POST" ? `/${action}` : ""}`), options.json);
    return;
  }
  if (group === "images" && action === "list" && !argument) {
    print(await client.request("GET", "/api/admin/images"), options.json);
    return;
  }
  if (group === "images" && action === "pull" && argument && !extra) {
    print(await client.request("POST", "/api/admin/images/pull", { reference: argument }), options.json);
    return;
  }
  if (group === "images" && action === "load" && argument && extra && !command[4]) {
    print(await client.upload("/api/admin/images/load", argument, extra), options.json);
    return;
  }
  if (group === "build-packages" && action === "list" && !command[4]) {
    const query = new URLSearchParams();
    if (argument) query.set("strategyId", argument.trim().toLowerCase());
    if (extra) query.set("key", extra.trim().toLowerCase());
    const suffix = query.size > 0 ? `?${query}` : "";
    print(await client.request("GET", `/api/admin/build-packages${suffix}`), options.json);
    return;
  }
  if (group === "build-packages" && action === "upload" && argument && extra && command[4] && !command[5]) {
    print(await client.uploadBuildPackage(argument, extra, command[4]), options.json);
    return;
  }
  if (group === "build-packages" && action === "delete" && argument && !extra) {
    print(await client.request("DELETE", `/api/admin/build-packages/${encodeURIComponent(argument)}`), options.json);
    return;
  }
  if (group === "image-artifacts" && action === "list" && !argument) {
    print(await client.request("GET", "/api/admin/image-artifacts"), options.json);
    return;
  }
  if (group === "image-artifacts" && action === "delete" && argument && !extra) {
    print(await client.request("DELETE", `/api/admin/image-artifacts/${encodeURIComponent(argument)}`), options.json);
    return;
  }
  if (group === "cleanup" && action === "preview" && !extra) {
    const keepPrevious = argument ? positiveInteger(argument, "keep-previous") : 1;
    print(await client.request("GET", `/api/admin/resource-cleanup?keepPrevious=${keepPrevious}`), options.json);
    return;
  }
  if (group === "cleanup" && action === "run" && !extra) {
    const keepPrevious = argument ? positiveInteger(argument, "keep-previous") : 1;
    print(await client.request("POST", "/api/admin/resource-cleanup", { keepPrevious }), options.json);
    return;
  }
  if (group === "forwarding" && action === "get" && !argument) {
    print(await client.request("GET", "/api/admin/forwarding"), options.json);
    return;
  }
  if (group === "forwarding" && action === "test" && !extra) {
    print(await client.request("POST", "/api/admin/forwarding/test", argument ? { targetBaseUrl: argument } : {}), options.json);
    return;
  }
  if (group === "forwarding" && action === "set" && argument && !extra) {
    print(await patchConfig(client, "/api/admin/forwarding", { targetBaseUrl: argument }), options.json);
    return;
  }
  if (group === "forwarding" && (action === "enable" || action === "disable") && !argument) {
    print(await patchConfig(client, "/api/admin/forwarding", { enabled: action === "enable" }), options.json);
    return;
  }
  if (group === "forwarding" && action === "allow" && argument) {
    print(await patchConfig(client, "/api/admin/forwarding", { allowedHosts: command.slice(2) }), options.json);
    return;
  }
  if (group === "policy" && action === "get" && !argument) {
    print(await client.request("GET", "/api/admin/instance-policy"), options.json);
    return;
  }
  if (group === "policy" && (action === "auto-create" || action === "auto-start") && (argument === "on" || argument === "off") && !extra) {
    const key = action === "auto-create" ? "autoCreateOnFirstVisit" : "autoStartOnEnter";
    print(await patchConfig(client, "/api/admin/instance-policy", { [key]: argument === "on" }), options.json);
    return;
  }
  if (group === "policy" && (action === "detect-network" || action === "detect-compute") && (argument === "on" || argument === "off") && !extra) {
    const key = action === "detect-network" ? "detectNetworkActivity" : "detectComputeActivity";
    print(await patchConfig(client, "/api/admin/instance-policy", { [key]: argument === "on" }), options.json);
    return;
  }
  if (group === "policy" && action === "idle-stop" && argument && !extra) {
    print(await patchConfig(client, "/api/admin/instance-policy", { idleStopMinutes: positiveInteger(argument, "minutes", true) }), options.json);
    return;
  }
  if (group === "policy" && (action === "max-instances" || action === "max-running") && argument && !extra) {
    const key = action === "max-instances" ? "maxTotalInstances" : "maxRunningInstances";
    print(await patchConfig(client, "/api/admin/instance-policy", { [key]: positiveInteger(argument, "count") }), options.json);
    return;
  }
  if (group === "policy" && action === "default-app" && argument && !extra) {
    print(await patchConfig(client, "/api/admin/instance-policy", { defaultAppId: argument }), options.json);
    return;
  }
  if (group === "policy" && action === "resources" && argument && extra && command[4] && !command[5]) {
    print(await patchConfig(client, "/api/admin/instance-policy", {
      resources: { memory: argument, cpus: extra, pidsLimit: positiveInteger(command[4]!, "pids-limit") },
    }), options.json);
    return;
  }
  if (group === "policy" && action === "env" && argument && !extra) {
    const environment = await readJsonFile(argument);
    if (!environment || typeof environment !== "object" || Array.isArray(environment) || Object.values(environment).some((value) => typeof value !== "string")) {
      usageError("policy env JSON must be an object whose values are strings");
    }
    print(await patchConfig(client, "/api/admin/instance-policy", { environment }), options.json);
    return;
  }
  if (group === "policy" && action === "config-files" && argument && !extra) {
    const configFiles = await readJsonFile(argument);
    if (!configFiles || typeof configFiles !== "object" || Array.isArray(configFiles) || Object.values(configFiles).some((content) => typeof content !== "string")) {
      usageError("policy config-files JSON must be an object mapping relative paths to string contents");
    }
    print(await patchConfig(client, "/api/admin/instance-policy", { configFiles }), options.json);
    return;
  }
  if (group === "maintenance" && action === "sweep" && !argument) {
    print(await client.request("POST", "/api/admin/maintenance/sweep", {}), options.json);
    return;
  }
  if (group === "monitor" && action === "instances" && !extra) {
    const query = argument ? `?status=${encodeURIComponent(argument)}` : "";
    print(await client.request("GET", `/api/admin/monitor/instances${query}`), options.json);
    return;
  }
  if (group === "monitor" && action === "metrics" && argument && !extra) {
    print(await client.request("GET", `/api/admin/monitor/instances/${encodeURIComponent(argument)}/metrics`), options.json);
    return;
  }
  if (group === "health" && (!action || (action && !argument)) && !extra) {
    const query = action ? `?target=${encodeURIComponent(action)}` : "";
    print(await client.request("GET", `/api/admin/monitor/health${query}`), options.json);
    return;
  }
  if (group === "audit" && !action && !argument && !extra) {
    print(await client.request("GET", "/api/admin/audit"), options.json);
    return;
  }
  if (group === "operations" && action === "list" && !extra) {
    const query = argument ? `?status=${encodeURIComponent(argument)}` : "";
    print(await client.request("GET", `/api/admin/operations${query}`), options.json);
    return;
  }
  if (group === "operations" && action === "wait" && argument && !extra) {
    print(await waitForOperation(client, argument), options.json);
    return;
  }
  if (group === "operations" && (action === "get" || action === "cancel" || action === "retry") && argument && !extra) {
    const method = action === "get" ? "GET" : "POST";
    print(await client.request(method, `/api/admin/operations/${encodeURIComponent(argument)}${method === "POST" ? `/${action}` : ""}`, method === "POST" ? {} : undefined), options.json);
    return;
  }
  if (group === "config-revisions" && (action === "instance-policy" || action === "forwarding") && argument === "list" && !extra) {
    print(await client.request("GET", `/api/admin/config-revisions/${action}`), options.json);
    return;
  }
  if (group === "config-revisions" && (action === "instance-policy" || action === "forwarding") && argument === "rollback" && extra && !command[4]) {
    const history = await client.request<{ current?: { revision?: number } | null }>("GET", `/api/admin/config-revisions/${action}`);
    const currentRevision = history.current?.revision ?? 0;
    print(await client.request(
      "POST",
      `/api/admin/config-revisions/${action}/${encodeURIComponent(String(positiveInteger(command[3]!, "revision")))}/rollback`,
      {},
      { "if-match": String(currentRevision) },
    ), options.json);
    return;
  }
  usageError(`unknown command: ${command.join(" ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
