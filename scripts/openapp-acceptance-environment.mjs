const APPLICATION_ENVIRONMENT_NAMES = new Set([
  "AUTH_PROVIDER",
  "CONTAINER_RUNTIME",
  "CONTAINER_RUNTIME_ENDPOINT_MODE",
  "DATABASE_URL",
  "DOCKER_CONTEXT",
  "DOCKER_GID",
  "DOCKER_HOST",
  "HOST",
  "MCP_APP_SANDBOX_ORIGIN",
  "NODE_ENV",
  "PORT",
  "PUBLIC_ORIGIN",
  "SESSION_COOKIE_SECURE",
  "TARGET_PLATFORM",
]);

const APPLICATION_ENVIRONMENT_PREFIXES = [
  "OPENAPP_",
  "PORTAL_",
  "POSTGRES_",
];

// 测试子进程只继承运行工具必需的系统环境，避免遗漏新的产品密钥前缀。
const SYSTEM_ENVIRONMENT_NAMES = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "SHELL"]);

export function isolatedAcceptanceEnvironment(environment) {
  const isolated = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (APPLICATION_ENVIRONMENT_NAMES.has(key)) continue;
    if (APPLICATION_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (!SYSTEM_ENVIRONMENT_NAMES.has(key)) continue;
    isolated[key] = value;
  }
  return isolated;
}

export function postgresAcceptanceEnvironment(environment) {
  const postgresTestUrl = environment.POSTGRES_TEST_URL?.trim();
  if (!postgresTestUrl) {
    throw new Error("POSTGRES_TEST_URL is required for --postgres; DATABASE_URL is never used for acceptance");
  }
  return { POSTGRES_TEST_URL: postgresTestUrl };
}

export function dockerAcceptanceEnvironment(environment) {
  const controlled = {};
  for (const name of ["DOCKER_CONTEXT", "DOCKER_HOST"]) {
    const value = environment[name]?.trim();
    if (value) controlled[name] = value;
  }
  return controlled;
}

/**
 * 仅把显式指定的身份 Provider 地址传给 Docker 集成门禁；其余宿主机
 * 配置（尤其是数据库和部署密钥）仍由 acceptance isolation 过滤。
 */
export function authProviderAcceptanceEnvironment(environment, options = {}) {
  const controlled = {};
  const names = ["OPENAPP_AUTH_PROVIDER_BASE_URL", "AUTH_PROVIDER_BASE_URL"];
  names.push(...(options.providerEnvironmentNames ?? []));
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) controlled[name] = value;
  }
  return controlled;
}
