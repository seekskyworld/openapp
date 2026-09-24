import type {
  ProviderCapabilityResult,
  ProviderHealthPort,
  ProviderMetricsPort,
} from "./execution-provider.js";
import { ProviderOperationError } from "./execution-provider.js";
import type { ContainerActivityMetrics } from "./runtime.js";

export interface ProviderHealthStatus {
  providerId: string;
  available: boolean;
  capabilityStatus: "supported" | "unsupported" | "unavailable";
  version?: string;
  host?: string;
  platform?: string;
  architecture?: string;
  error?: string;
}

export async function readProviderMetrics(
  metrics: ProviderMetricsPort,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<ProviderCapabilityResult<ContainerActivityMetrics>> {
  try {
    return await metrics.readMetrics(workspaceId, signal);
  } catch (error) {
    return {
      status: "unavailable",
      error: normalizeThrownCapabilityError(error, "provider_metrics_unavailable"),
    };
  }
}

/** Compatibility helper for legacy callers that cannot represent capability states. */
export async function requireProviderMetrics(
  metrics: ProviderMetricsPort,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<ContainerActivityMetrics> {
  const result = await readProviderMetrics(metrics, workspaceId, signal);
  if (result.status === "supported") return result.value;
  if (result.status === "unavailable") throw result.error;
  throw new ProviderCapabilityUnsupportedError("provider_metrics_unsupported");
}

export async function readProviderHealthStatus(
  health: ProviderHealthPort,
  providerId: string,
): Promise<ProviderHealthStatus> {
  try {
    const result = await health.readProviderHealth(providerId);
    if (result.status === "supported") {
      if (result.value.providerId !== providerId) {
        return {
          providerId,
          available: false,
          capabilityStatus: "unavailable",
          error: "provider_health_identity_mismatch",
        };
      }
      return { ...result.value, capabilityStatus: "supported" };
    }
    if (result.status === "unsupported") {
      return {
        providerId,
        available: false,
        capabilityStatus: "unsupported",
        error: "provider_health_unsupported",
      };
    }
    return {
      providerId,
      available: false,
      capabilityStatus: "unavailable",
      error: result.error.code,
    };
  } catch (error) {
    const normalized = normalizeThrownCapabilityError(error, "provider_health_unavailable");
    return {
      providerId,
      available: false,
      capabilityStatus: "unavailable",
      error: normalized.code,
    };
  }
}

export class ProviderCapabilityUnsupportedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function normalizeThrownCapabilityError(error: unknown, code: string): ProviderOperationError {
  return error instanceof ProviderOperationError
    ? error
    : new ProviderOperationError(code, "transient", "diagnose", 1_000, { cause: error });
}
