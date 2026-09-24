import type { ContainerStatus, ContainerStopReason } from "./models.js";

/** A validated point-in-time sample returned by the container runtime. */
export interface RuntimeSample {
  id: string;
  instanceId: string;
  sampledAt: string;
  state: ContainerStatus;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  cpuPercent: number | null;
  memoryWorkingSetBytes: number | null;
  pids: number | null;
  gpuUtilizationPercent: number | null;
  error: string | null;
  capabilityStatus?: "supported" | "unsupported" | "unavailable";
}

/** Resource values projected into the administrator instance list. */
export interface AdminResourceMetrics {
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  cpuPercent: number | null;
  memoryWorkingSetBytes: number | null;
  pids: number | null;
  gpuUtilizationPercent: number | null;
}

/** Public instance projection used by administrator monitoring endpoints. */
export interface AdminMonitorInstance {
  id: string;
  ownerId: string;
  appId: string;
  appVersionId: string | null;
  imageReference: string | null;
  status: ContainerStatus;
  stopReason: ContainerStopReason | null;
  runtimeId: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  metrics: AdminResourceMetrics | null;
  latestSampleAt: string | null;
  lastError: string | null;
  metricsCapabilityStatus: "supported" | "unsupported" | "unavailable" | null;
  stale: boolean;
}

/** Public instance projection returned with a single-instance metrics view. */
export interface AdminInstanceDetails {
  id: string;
  ownerId: string;
  appId: string;
  status: ContainerStatus;
  stopReason: ContainerStopReason | null;
  runtimeId: string;
  endpoint: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface AdminDashboardAlert {
  id: string;
  severity: "warning" | "critical";
  message: string;
  createdAt: string;
}

export interface AdminDashboard {
  generatedAt: string;
  freshness: {
    sampleIntervalMs: number;
    staleAfterMs: number;
    latestSampleAt: string | null;
    stale: boolean;
    persistenceDegraded: boolean;
  };
  users: { total: number };
  containers: { total: number; byStatus: Record<ContainerStatus, number> };
  capacity: {
    maxTotalInstances: number;
    maxRunningInstances: number;
    totalUsed: number;
    runningUsed: number;
    totalPercent: number;
    runningPercent: number;
  };
  resources: AdminResourceMetrics;
  alerts: AdminDashboardAlert[];
  runtime: HealthCheck;
  providerHealth: HealthCheck[];
  forwarding: {
    enabled: boolean;
    targetBaseUrl: string;
    updatedAt: string;
  } | null;
}

export interface AdminInstanceMetrics {
  instance: AdminInstanceDetails;
  latest: RuntimeSample | null;
  samples: RuntimeSample[];
  stale: boolean;
}

/** Result of a control-plane health probe. Targets are intentionally generic. */
export interface HealthCheck {
  id: string;
  target: string;
  checkedAt: string;
  healthy: boolean;
  latencyMs: number | null;
  error: string | null;
  capabilityStatus?: "supported" | "unsupported" | "unavailable";
}

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface AuditEventFilter {
  actorUserId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}
