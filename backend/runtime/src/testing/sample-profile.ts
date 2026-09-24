/**
 * 仅供 Runtime 单元/集成测试使用的历史 profile fixture。
 * 生产 profile 由外部 App Adapter 发布，不从 Runtime 包导出；该目录明确
 * 表示旧产品兼容测试，不得被 generic 构建入口引用。
 */
import type { RuntimeProfile } from "../runtime-profile.js";

export const SAMPLE_APP_RUNTIME_CONTRACT_FIXTURE = "sample-app-v1";

export const LEGACY_RUNTIME_PROFILE_FIXTURE: RuntimeProfile = Object.freeze({
  id: "sample-app-legacy",
  contract: SAMPLE_APP_RUNTIME_CONTRACT_FIXTURE,
  environmentPrefix: "SAMPLE_APP",
  defaultImage: "sample-app-runtime:0.5.7",
  defaultNetworkPrefix: "sample-app-net-",
  defaultContainerPrefix: "sample-app-user-",
  defaultVolumePrefix: "sample-app-data-",
  labelPrefix: "io.sample-app.portal",
  storageClass: "workspace-data",
  storageMountPath: "/var/lib/sample-app",
  containerPort: 37371,
  containerUser: "sample-app",
  entrypoint: "/opt/sample-app/start.sh",
  command: Object.freeze(["web", "--host", "0.0.0.0", "--port", "37371"]),
  recoveryCommand: ["node", "/opt/sample-app/recover-state-locks.mjs"],
  configEnvironmentKey: "SAMPLE_APP_CONFIG_FILES_JSON",
  lockRecoveryEnvironment: Object.freeze({
    containers: "SAMPLE_APP_STATE_LOCK_RECOVER_CONTAINERS",
    hosts: "SAMPLE_APP_STATE_LOCK_RECOVER_HOSTS",
    recoveryId: "SAMPLE_APP_STATE_LOCK_RECOVERY_ID",
  }),
  reservedEnvironment: Object.freeze([
    "SAMPLE_APP_CONFIG_FILES_JSON",
    "SAMPLE_APP_DATA_DIR",
    "SAMPLE_APP_STATE_PATH",
    "SAMPLE_APP_STATE_LOCK_RECOVER_CONTAINERS",
    "SAMPLE_APP_STATE_LOCK_RECOVER_HOSTS",
    "SAMPLE_APP_STATE_LOCK_RECOVER_CONTAINER_HOSTS",
    "SAMPLE_APP_STATE_LOCK_RECOVERY_ID",
    "SAMPLE_APP_BRIDGE_SETTINGS_PATH",
    "SAMPLE_APP_AUTH_BASE_URL",
    "SAMPLE_APP_BRIDGE_ALLOWED_ORIGINS",
    "SAMPLE_APP_MCP_APP_SANDBOX_ORIGIN",
  ]),
  healthPath: "/api/health",
  providerEnvironment: Object.freeze({
    authProviderKey: "SAMPLE_APP_AUTH_BASE_URL",
    allowedOriginsKey: "SAMPLE_APP_BRIDGE_ALLOWED_ORIGINS",
    mcpAppSandboxOriginKey: "SAMPLE_APP_MCP_APP_SANDBOX_ORIGIN",
    defaultAuthProviderBaseUrl: "https://identity.example.test",
  }),
  legacyResourcePrefixes: Object.freeze({
    network: Object.freeze(["sample-app-net-"]),
    container: Object.freeze(["sample-app-user-"]),
    volume: Object.freeze(["sample-app-data-"]),
    label: Object.freeze(["io.openapp.portal"]),
  }),
});

export const LEGACY_LABEL_PREFIXES_FIXTURE = ["io.sample-app.portal"] as const;
export const LEGACY_NETWORK_PREFIXES_FIXTURE = ["sample-app-net-"] as const;
export const LEGACY_CONTAINER_PREFIXES_FIXTURE = ["sample-app-user-"] as const;
export const LEGACY_VOLUME_PREFIXES_FIXTURE = ["sample-app-data-"] as const;
