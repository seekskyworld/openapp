import type { ProviderOperationPhase, ProviderOperationError } from "./execution-provider.js";
import { ProviderOperationError as ProviderError } from "./execution-provider.js";
import type { ExecutionReconcileRequest } from "./execution-provider.js";
import type { ProviderDescriptor } from "./execution-provider-registry.js";

/** Provider 请求在产生副作用前必须满足的资源合同。 */
export interface ProviderRequestContract {
  readonly artifactKind?: string;
  readonly executionContract?: string;
  readonly storageClass?: string;
  readonly memoryBytes?: number;
  readonly cpuMillis?: number;
  readonly pidsLimit?: number;
}

/**
 * 在 Provider adapter 入口统一校验能力和资源边界。请求来自控制面时才会
 * 带入这些值；缺省字段表示旧兼容调用方尚未提供该维度，不会凭空拒绝它。
 */
export function assertProviderRequestSupported(
  descriptor: ProviderDescriptor,
  request: ProviderRequestContract,
  phase: ProviderOperationPhase = "reconcile",
): void {
  const artifactKind = normalizeDimension(request.artifactKind, "provider_artifact_invalid", phase, "oci-image");
  if (!descriptor.supportedArtifactKinds.includes(artifactKind)) {
    throw providerUnsupported("provider_artifact_unsupported", phase);
  }
  const executionContract = normalizeDimension(request.executionContract, "provider_execution_contract_invalid", phase);
  if (executionContract && !descriptor.supportedExecutionContracts.includes(executionContract)) {
    throw providerUnsupported("provider_execution_contract_unsupported", phase);
  }
  const storageClass = normalizeDimension(request.storageClass, "provider_storage_class_invalid", phase);
  if (storageClass && !descriptor.supportedStorageClasses.includes(storageClass)) {
    throw providerUnsupported("provider_storage_class_unsupported", phase);
  }
  const limits = descriptor.resourceLimits;
  if (request.memoryBytes !== undefined && (
    !Number.isSafeInteger(request.memoryBytes)
    || request.memoryBytes <= 0
    || (limits.minMemoryBytes !== undefined && request.memoryBytes < limits.minMemoryBytes)
    || (limits.maxMemoryBytes !== undefined && request.memoryBytes > limits.maxMemoryBytes)
  )) {
    throw providerUnsupported("provider_memory_limit_unsupported", phase);
  }
  if (request.cpuMillis !== undefined && (
    !Number.isSafeInteger(request.cpuMillis)
    || request.cpuMillis <= 0
    || (limits.minCpuMillis !== undefined && request.cpuMillis < limits.minCpuMillis)
    || (limits.maxCpuMillis !== undefined && request.cpuMillis > limits.maxCpuMillis)
  )) {
    throw providerUnsupported("provider_cpu_limit_unsupported", phase);
  }
  if (request.pidsLimit !== undefined && (
    !Number.isSafeInteger(request.pidsLimit)
    || request.pidsLimit <= 0
    || (limits.minPidsLimit !== undefined && request.pidsLimit < limits.minPidsLimit)
    || (limits.maxPidsLimit !== undefined && request.pidsLimit > limits.maxPidsLimit)
  )) {
    throw providerUnsupported("provider_pids_limit_unsupported", phase);
  }
}

/** 在解析或释放 Storage 前复用同一份 storage class 能力合同。 */
export function assertProviderStorageSupported(
  descriptor: ProviderDescriptor,
  storageClass: string,
  phase: ProviderOperationPhase = "resolve_storage",
): void {
  const normalized = normalizeDimension(storageClass, "provider_storage_class_invalid", phase);
  if (!descriptor.supportedStorageClasses.includes(normalized)) {
    throw providerUnsupported("provider_storage_class_unsupported", phase);
  }
}

/** 将控制面字符串资源限制转换成 Provider 合同使用的整数单位。 */
export function providerRequestFromReconcile(request: ExecutionReconcileRequest): ProviderRequestContract {
  const memoryValue = request.launchProfile.resources.memory;
  const cpuValue = request.launchProfile.resources.cpus;
  const memoryBytes = parseMemoryBytes(memoryValue);
  const cpuMillis = parseCpuMillis(cpuValue);
  if (typeof memoryValue !== "string" || !memoryValue.trim() || memoryBytes === undefined) {
    throw providerUnsupported("provider_memory_limit_invalid", "reconcile");
  }
  if (typeof cpuValue !== "string" || !cpuValue.trim() || cpuMillis === undefined) {
    throw providerUnsupported("provider_cpu_limit_invalid", "reconcile");
  }
  return {
    ...(request.artifactKind === undefined ? {} : { artifactKind: request.artifactKind }),
    ...(request.executionContract === undefined || request.executionContract === null
      ? {}
      : { executionContract: request.executionContract }),
    storageClass: request.storageClass,
    memoryBytes,
    cpuMillis,
    pidsLimit: request.launchProfile.resources.pidsLimit,
  };
}

export function parseMemoryBytes(value: string | undefined): number | undefined {
  const match = typeof value === "string" ? value.trim().match(/^(\d+(?:\.\d+)?)([bkmg]?)$/iu) : null;
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]?.toLowerCase() ?? ""];
  const bytes = amount * (multiplier ?? 1);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

export function parseCpuMillis(value: string | undefined): number | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return undefined;
  const cpus = Number(normalized);
  const millis = cpus * 1_000;
  return Number.isSafeInteger(millis) && millis > 0 ? millis : undefined;
}

/** 存储类别和执行合同是代码拥有的维度；空字符串不能被当作“未提供”。 */
function normalizeDimension(
  value: string | null | undefined,
  invalidCode: string,
  phase: ProviderOperationPhase,
  fallback?: string,
): string {
  if (value === undefined || value === null) return fallback ?? "";
  if (typeof value !== "string") throw providerUnsupported(invalidCode, phase);
  const normalized = value.trim();
  if (!normalized) throw providerUnsupported(invalidCode, phase);
  return normalized;
}

export function providerNotFound(code: string, phase: ProviderOperationPhase): ProviderOperationError {
  return new ProviderError(code, "permanent", phase);
}

export function providerUnsupported(code: string, phase: ProviderOperationPhase): ProviderOperationError {
  return new ProviderError(code, "permanent", phase);
}

export function providerUnavailable(
  code: string,
  phase: ProviderOperationPhase,
  retryAfterMs = 1_000,
  cause?: unknown,
): ProviderOperationError {
  return new ProviderError(code, "transient", phase, retryAfterMs, cause === undefined ? undefined : { cause });
}
