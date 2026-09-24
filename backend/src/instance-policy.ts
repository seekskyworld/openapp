import {
  isRuntimeReservedEnvironmentName,
  type ContainerLaunchProfile,
} from "@openapp/container-runtime";
import type { ConfigEffect } from "./models.js";
import { APP_ID_PATTERN } from "./app-id.js";

export const IMAGE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u;
const MEMORY_PATTERN = /^\d+(?:\.\d+)?[bkmg]?$/iu;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const POLICY_KEYS = new Set([
  "autoCreateOnFirstVisit",
  "defaultAppId",
  "autoStartOnEnter",
  "autoWakeOnRequest",
  "blockAutoWakeAfterManualStop",
  "idleStopMinutes",
  "detectNetworkActivity",
  "detectComputeActivity",
  "maxTotalInstances",
  "maxRunningInstances",
  "resources",
  "environment",
  "configFiles",
]);

export const CONFIG_FILES_MAX_BYTES = 256 * 1024;
export const ENVIRONMENT_MAX_BYTES = 64 * 1024;
const MAX_MEMORY_BYTES = 1024 ** 5;

export interface ProvisioningPolicy {
  autoCreateOnFirstVisit: boolean;
  defaultAppId: string;
  autoStartOnEnter: boolean;
  autoWakeOnRequest: boolean;
  blockAutoWakeAfterManualStop: boolean;
  idleStopMinutes: number;
  detectNetworkActivity: boolean;
  detectComputeActivity: boolean;
  maxTotalInstances: number;
  maxRunningInstances: number;
  resources: {
    memory: string;
    cpus: string;
    pidsLimit: number;
  };
  environment: Record<string, string>;
  configFiles: Record<string, string>;
}

export interface UpdateProvisioningPolicyOptions {
  /**
   * 由 Runtime profile 声明的额外保留键。Core 不解释这些键的产品含义，
   * 只在策略边界阻止请求覆盖运行时注入的值。
   */
  readonly additionalReservedEnvironment?: ReadonlySet<string>;
}

/** 插件初始化时可提供的策略增量；资源和映射字段允许逐项覆盖。 */
export type ProvisioningPolicyDefaults = Partial<Omit<ProvisioningPolicy, "resources" | "environment" | "configFiles">> & {
  resources?: Partial<ProvisioningPolicy["resources"]>;
  environment?: Record<string, string>;
  configFiles?: Record<string, string>;
};

export class InstancePolicyError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

/**
 * 构造不携带产品假设的策略快照。调用方必须明确提供 App ID；生产组合根
 * 应从已加载的 App Adapter 获取该值，避免 Core 猜测默认产品。
 */
export function genericProvisioningPolicy(
  defaultAppId: string,
  env: NodeJS.ProcessEnv = process.env,
): ProvisioningPolicy {
  const normalizedDefaultAppId = defaultAppId.trim().toLowerCase();
  if (!APP_ID_PATTERN.test(normalizedDefaultAppId)) {
    throw new InstancePolicyError("unsupported_default_app");
  }
  const pidsLimit = Number(firstConfigured(env.OPENAPP_CONTAINER_PIDS_LIMIT) ?? 512);
  const memory = firstConfigured(env.OPENAPP_CONTAINER_MEMORY) || "4g";
  const cpus = firstConfigured(env.OPENAPP_CONTAINER_CPUS) || "2";
  return {
    autoCreateOnFirstVisit: true,
    defaultAppId: normalizedDefaultAppId,
    autoStartOnEnter: true,
    autoWakeOnRequest: true,
    blockAutoWakeAfterManualStop: true,
    idleStopMinutes: 30,
    detectNetworkActivity: true,
    detectComputeActivity: false,
    maxTotalInstances: 100,
    maxRunningInstances: 20,
    resources: {
      memory: validMemory(memory) ? memory : "4g",
      cpus: Number.isFinite(Number(cpus)) && Number(cpus) > 0 && Number(cpus) <= 256 ? cpus : "2",
      pidsLimit: Number.isSafeInteger(pidsLimit) && pidsLimit >= 32 && pidsLimit <= 1_048_576
        ? pidsLimit
        : 512,
    },
    environment: {},
    configFiles: {},
  };
}

/** 将 Adapter 提供的部分默认值补全为可持久化的策略快照。 */
export function provisioningPolicyFromDefaults(
  defaults: ProvisioningPolicyDefaults,
  env: NodeJS.ProcessEnv = process.env,
): ProvisioningPolicy {
  const defaultAppId = typeof defaults.defaultAppId === "string" ? defaults.defaultAppId : "";
  if (!defaultAppId.trim()) throw new InstancePolicyError("provisioning_policy_default_app_required", 500);
  return updateProvisioningPolicy(genericProvisioningPolicy(defaultAppId, env), defaults);
}

function firstConfigured(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "")?.trim();
}

/** 通用测试/监控使用的中性基线；生产启动必须由 Adapter/数据库显式提供 App ID。 */
export const DEFAULT_GENERIC_PROVISIONING_POLICY = genericProvisioningPolicy("openapp");

export function updateProvisioningPolicy(
  current: ProvisioningPolicy,
  input: unknown,
  options: UpdateProvisioningPolicyOptions = {},
): ProvisioningPolicy {
  const patch = record(input, "invalid_instance_policy");
  for (const key of Object.keys(patch)) {
    if (!POLICY_KEYS.has(key)) throw new InstancePolicyError(`unknown_instance_policy_field:${key}`);
  }

  const resourcesPatch = patch.resources === undefined
    ? {}
    : record(patch.resources, "invalid_instance_resources");
  for (const key of Object.keys(resourcesPatch)) {
    if (key !== "memory" && key !== "cpus" && key !== "pidsLimit") {
      throw new InstancePolicyError(`unknown_instance_resource_field:${key}`);
    }
  }

  const policy: ProvisioningPolicy = {
    autoCreateOnFirstVisit: booleanValue(patch.autoCreateOnFirstVisit, current.autoCreateOnFirstVisit, "invalid_auto_create_policy"),
    defaultAppId: stringValue(patch.defaultAppId, current.defaultAppId, "invalid_default_app").trim().toLowerCase(),
    autoStartOnEnter: booleanValue(patch.autoStartOnEnter, current.autoStartOnEnter, "invalid_auto_start_policy"),
    autoWakeOnRequest: booleanValue(patch.autoWakeOnRequest, current.autoWakeOnRequest, "invalid_auto_wake_policy"),
    blockAutoWakeAfterManualStop: booleanValue(patch.blockAutoWakeAfterManualStop, current.blockAutoWakeAfterManualStop, "invalid_manual_stop_wake_policy"),
    idleStopMinutes: integerValue(patch.idleStopMinutes, current.idleStopMinutes, 0, 10_080, "invalid_idle_stop_minutes"),
    detectNetworkActivity: booleanValue(patch.detectNetworkActivity, current.detectNetworkActivity, "invalid_network_activity_detection"),
    detectComputeActivity: booleanValue(patch.detectComputeActivity, current.detectComputeActivity, "invalid_compute_activity_detection"),
    maxTotalInstances: integerValue(patch.maxTotalInstances, current.maxTotalInstances, 1, 10_000, "invalid_total_instance_limit"),
    maxRunningInstances: integerValue(patch.maxRunningInstances, current.maxRunningInstances, 1, 10_000, "invalid_running_instance_limit"),
    resources: {
      memory: stringValue(resourcesPatch.memory, current.resources.memory, "invalid_memory_limit").trim(),
      cpus: stringValue(resourcesPatch.cpus, current.resources.cpus, "invalid_cpu_limit").trim(),
      pidsLimit: integerValue(resourcesPatch.pidsLimit, current.resources.pidsLimit, 32, 1_048_576, "invalid_pids_limit"),
    },
    environment: patch.environment === undefined
      ? { ...current.environment }
      : validateEnvironment(patch.environment, options),
    configFiles: patch.configFiles === undefined
      ? { ...current.configFiles }
      : validateConfigFiles(patch.configFiles),
  };

  if (!APP_ID_PATTERN.test(policy.defaultAppId)) {
    throw new InstancePolicyError("unsupported_default_app");
  }
  if (policy.maxRunningInstances > policy.maxTotalInstances) {
    throw new InstancePolicyError("running_limit_exceeds_total_limit");
  }
  if (!validMemory(policy.resources.memory)) {
    throw new InstancePolicyError("invalid_memory_limit");
  }
  const cpus = Number(policy.resources.cpus);
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 256) {
    throw new InstancePolicyError("invalid_cpu_limit");
  }
  return policy;
}

export function normalizeProvisioningPolicy(value: unknown): ProvisioningPolicy {
  return normalizeProvisioningPolicyWithFallback(value, DEFAULT_GENERIC_PROVISIONING_POLICY);
}

/** 将持久化策略叠加到调用方提供的中性基线，不会隐式引入产品默认值。 */
export function normalizeProvisioningPolicyWithFallback(
  value: unknown,
  fallback: ProvisioningPolicy,
): ProvisioningPolicy {
  return updateProvisioningPolicy(fallback, value);
}

/**
 * Classifies the operational impact of a provisioning-policy change.
 *
 * This is deliberately based on the resulting snapshots rather than the
 * request shape so callers can use it for PATCH, import and rollback alike.
 */
export function provisioningPolicyEffect(
  previous: ProvisioningPolicy,
  next: ProvisioningPolicy,
): ConfigEffect {
  if (
    previous.resources.memory !== next.resources.memory
    || previous.resources.cpus !== next.resources.cpus
    || previous.resources.pidsLimit !== next.resources.pidsLimit
  ) {
    return "rebuild";
  }
  if (
    previous.defaultAppId !== next.defaultAppId
    || !sameStringMap(previous.environment, next.environment)
    || !sameStringMap(previous.configFiles, next.configFiles)
  ) {
    return "new_instances";
  }
  return "immediate";
}

export function toLaunchProfile(policy: ProvisioningPolicy, imageReference: string): ContainerLaunchProfile {
  return {
    imageReference,
    resources: { ...policy.resources },
    environment: { ...policy.environment },
    configFiles: Object.entries(policy.configFiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => ({ path, content })),
  };
}

function validateEnvironment(
  value: unknown,
  options: UpdateProvisioningPolicyOptions = {},
): Record<string, string> {
  const environment = stringMap(value, "invalid_environment");
  if (Object.keys(environment).length > 128) throw new InstancePolicyError("environment_too_large", 413);
  let bytes = 0;
  for (const [key, content] of Object.entries(environment)) {
    // 应用保留键由当前 Adapter 精确声明，避免误拦其他应用的普通环境变量。
    if (!ENVIRONMENT_NAME_PATTERN.test(key) || isRuntimeReservedEnvironmentName(key, {
      additionalReserved: options.additionalReservedEnvironment,
    })) {
      throw new InstancePolicyError(`invalid_environment_key:${key}`);
    }
    if (content.includes("\0")) throw new InstancePolicyError(`invalid_environment_value:${key}`);
    bytes += Buffer.byteLength(key) + Buffer.byteLength(content);
  }
  if (bytes > ENVIRONMENT_MAX_BYTES) throw new InstancePolicyError("environment_too_large", 413);
  return environment;
}

function validateConfigFiles(value: unknown): Record<string, string> {
  const configFiles = stringMap(value, "invalid_config_files");
  if (Object.keys(configFiles).length > 128) throw new InstancePolicyError("config_files_too_large", 413);
  let bytes = 0;
  for (const [path, content] of Object.entries(configFiles)) {
    const parts = path.split("/");
    if (
      !path
      || path.startsWith("/")
      || path.includes("\\")
      || path.includes("\0")
      || parts.some((part) => !part || part === "." || part === "..")
      || content.includes("\0")
    ) {
      throw new InstancePolicyError(`invalid_config_file:${path}`);
    }
    bytes += Buffer.byteLength(path) + Buffer.byteLength(content);
  }
  if (bytes > CONFIG_FILES_MAX_BYTES) throw new InstancePolicyError("config_files_too_large", 413);
  return configFiles;
}

function validMemory(value: string): boolean {
  if (!MEMORY_PATTERN.test(value)) return false;
  const match = value.match(/^(\d+(?:\.\d+)?)([bkmg]?)$/iu);
  if (!match) return false;
  const amount = Number(match[1]);
  const multiplier = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  const bytes = amount * multiplier;
  return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_MEMORY_BYTES;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InstancePolicyError(code);
  return value as Record<string, unknown>;
}

function stringMap(value: unknown, code: string): Record<string, string> {
  const candidate = record(value, code);
  if (Object.values(candidate).some((item) => typeof item !== "string")) {
    throw new InstancePolicyError(code);
  }
  return { ...candidate } as Record<string, string>;
}

function booleanValue(value: unknown, fallback: boolean, code: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new InstancePolicyError(code);
  return value;
}

function stringValue(value: unknown, fallback: string, code: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new InstancePolicyError(code);
  return value;
}

function integerValue(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new InstancePolicyError(code);
  }
  return value as number;
}

function sameStringMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}
