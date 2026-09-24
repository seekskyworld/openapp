import { adminContainerBatchRequest, adminResourceCleanupRequest, request, type AdminContainerBatchAction, type PortalContainer, type PortalUser, type UserRole } from './api.ts';

export interface AdminOverview {
  users: number;
  containers: number;
  authProvider: string;
  generatedAt?: string;
  staleAfterMs?: number;
  persistenceDegraded?: boolean;
  states?: Partial<Record<PortalContainer['status'], number>>;
  capacity?: {
    totalLimit: number;
    totalUsed: number;
    runningLimit: number;
    runningUsed: number;
  };
  activity?: {
    cpuPercent: number | null;
    memoryWorkingSetBytes: number | null;
    networkRxBytes: number | null;
    networkTxBytes: number | null;
    pids: number | null;
    gpuUtilizationPercent: number | null;
  };
  health?: {
    status: 'ok' | 'degraded' | 'down';
    checkedAt?: string;
    components?: Record<string, { status: 'ok' | 'degraded' | 'down'; latencyMs?: number; error?: string }>;
  };
  providerHealth?: Array<{
    providerId: string;
    status: 'ok' | 'degraded' | 'down';
    checkedAt: string;
    error?: string;
  }>;
  recentErrors?: Array<{ action: string; resourceId?: string | null; message: string; createdAt: string }>;
  alerts?: Array<{ id: string; severity: 'warning' | 'critical'; message: string; createdAt: string }>;
}

export interface PaginationMeta {
  page: number;
  pageSize: number | 'all';
  total: number;
  totalPages: number;
  hasNext: boolean;
}

/** Status values currently emitted by the control-plane monitoring API. */
export type AdminMonitorStatus = Extract<PortalContainer['status'], 'creating' | 'running' | 'stopped' | 'failed'>;

interface DashboardResponse {
  dashboard: {
    generatedAt: string;
    freshness: {
      sampleIntervalMs: number;
      staleAfterMs: number;
      latestSampleAt: string | null;
      stale: boolean;
      persistenceDegraded: boolean;
    };
    users: { total: number };
    containers: { total: number; byStatus: Partial<Record<AdminMonitorStatus, number>> };
    capacity: { maxTotalInstances: number; maxRunningInstances: number; totalUsed: number; runningUsed: number; totalPercent: number; runningPercent: number };
    resources: { cpuPercent: number | null; memoryWorkingSetBytes: number | null; networkRxBytes: number | null; networkTxBytes: number | null; pids: number | null; gpuUtilizationPercent: number | null };
    runtime: ProviderHealthCheck;
    providerHealth?: ProviderHealthCheck[];
    forwarding: { enabled: boolean; targetBaseUrl: string; updatedAt: string } | null;
    alerts: Array<{ id: string; severity: 'warning' | 'critical'; message: string; createdAt: string }>;
  };
}

interface ProviderHealthCheck {
  id: string;
  target: string;
  checkedAt: string;
  healthy: boolean;
  latencyMs: number | null;
  error: string | null;
  capabilityStatus?: ProviderCapabilityStatus;
}

export interface RuntimeInfo {
  runtime: string;
  available: boolean;
  version?: string;
  host?: string;
  platform?: string;
  architecture?: string;
  checkedAt?: string;
  latencyMs?: number;
  error?: string;
  capabilityStatus?: ProviderCapabilityStatus;
}

export type ProviderCapabilityStatus = 'supported' | 'unsupported' | 'unavailable';

export interface RuntimeImage {
  id?: string;
  reference: string;
  size?: string;
}

export type AppStatus = 'active' | 'archived';
export type AppVersionStatus = 'legacy' | 'uploaded' | 'image_ready' | 'active' | 'archived';

export interface AppDefinition {
  canImportImage?: boolean;
  id: string;
  name: string;
  description: string;
  authAdapterId: string;
  status: AppStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AppArtifact {
  file: string;
  sha256: string;
  size: number;
}

export interface AppVersion {
  sourceKind?: 'packages' | 'image';
  id: string;
  appId: string;
  /** Server-assigned immutable App revision; compatibility version fields are not user-managed. */
  revision?: number;
  version: string;
  buildId: string;
  imageReference: string | null;
  status: AppVersionStatus;
  createdAt: string;
  activatedAt: string | null;
  imageArtifactId?: string | null;
  packages?: ImageBuildPackage[];
  runtimeContract?: string | null;
}

export interface BuildPackageRequirement {
  key: string;
  required: boolean;
  acceptedExtensions: string[];
  maxBytes?: number;
}

export interface BuildStrategy {
  appIds?: string[];
  executable?: boolean;
  unavailableReason?: 'control_plane_only' | 'strategy_archived' | 'adapter_version_mismatch' | 'adapter_not_loaded' | null;
  id: string;
  revision: number;
  name: string;
  description: string;
  runtimeContract: string;
  packageRequirements: BuildPackageRequirement[];
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export type ImageBuildStatus = 'queued' | 'building' | 'succeeded' | 'failed' | 'cancelled';
export interface ImageBuildPackage { key: string; artifact: AppArtifact; packageId?: string }
export interface BuildPackage {
  id: string;
  strategyId: string;
  key: string;
  artifact: AppArtifact;
  originalName: string;
  uploadedBy: string;
  sourceVersion?: string | null;
  sourceBuildId?: string | null;
  inspectedAt?: string | null;
  createdAt: string;
}
export interface ImageBuild {
  id: string;
  strategyId: string;
  strategySnapshot: BuildStrategy;
  operationId: string | null;
  sourceAppVersionId: string | null;
  requestedBy: string;
  packages: ImageBuildPackage[];
  status: ImageBuildStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ImageArtifact {
  id: string;
  buildId: string;
  imageReference: string;
  imageId: string;
  runtimeContract: string;
  createdAt: string;
}

export type ResourceCleanupKind = 'build_package' | 'image_artifact';
export interface ResourceCleanupBlocker {
  type: 'active_app_revision' | 'retained_rollback_revision' | 'app_revision' | 'image_build' | 'container';
  id: string;
  appId?: string;
  revision?: number;
  status?: string;
}
export type ResourceCleanupItem = {
  kind: 'build_package';
  id: string;
  blockers: ResourceCleanupBlocker[];
  metadata: {
    strategyId: string;
    key: string;
    originalName: string;
    sourceVersion: string | null;
    size: number;
  };
} | {
  kind: 'image_artifact';
  id: string;
  blockers: ResourceCleanupBlocker[];
  metadata: {
    buildId: string;
    imageReference: string;
    imageId: string;
    runtimeContract: string;
  };
};
export interface ResourceCleanupPreview {
  retention: { previousRevisions: number };
  buildPackages: ResourceCleanupItem[];
  imageArtifacts: ResourceCleanupItem[];
  candidates: Array<{ kind: ResourceCleanupKind; id: string }>;
}
export interface ResourceCleanupRun {
  retention: { previousRevisions: number };
  retiredRevisionIds: string[];
  releasedBuildIds: string[];
  deletedBuildPackageIds: string[];
  deletedImageArtifactIds: string[];
  storageCleanupFailedIds: string[];
}

export interface ForwardingPolicy {
  enabled: boolean;
  allowedHosts: string[];
  targetBaseUrl: string;
  updatedAt?: string;
  revision?: ConfigRevision | null;
}

export interface InstancePolicy {
  autoCreateOnFirstVisit: boolean;
  defaultAppId: string;
  maxTotalInstances: number;
  maxRunningInstances: number;
  autoStartOnEnter: boolean;
  autoWakeOnRequest: boolean;
  blockAutoWakeAfterManualStop: boolean;
  idleStopMinutes: number;
  detectNetworkActivity: boolean;
  detectComputeActivity: boolean;
  resources: {
    memory: string;
    cpus: string;
    pidsLimit: number;
  };
  environment: Record<string, string>;
  configFiles: Record<string, string>;
}

function providerHealthState(check: ProviderHealthCheck): 'ok' | 'degraded' | 'down' {
  if (check.healthy) return 'ok';
  return check.capabilityStatus === 'unsupported' ? 'degraded' : 'down';
}

function aggregateProviderHealth(checks: readonly ProviderHealthCheck[]): 'ok' | 'degraded' | 'down' {
  const states = checks.map(providerHealthState);
  if (states.includes('down')) return 'down';
  if (states.includes('degraded')) return 'degraded';
  return 'ok';
}

export const adminApi = {
  async overview(): Promise<AdminOverview> {
    const response = await request<DashboardResponse>('/api/admin/dashboard');
    const dashboard = response.dashboard;
    const runtime = dashboard.runtime;
    const providerHealth = dashboard.providerHealth ?? (runtime ? [runtime] : []);
    const healthComponents = Object.fromEntries(providerHealth.map((check) => [
      check.target,
      {
        status: providerHealthState(check),
        latencyMs: check.latencyMs ?? undefined,
        error: check.error ?? undefined,
      },
    ]));
    return {
      users: dashboard.users.total,
      containers: dashboard.containers.total,
      authProvider: 'local + SSO',
      generatedAt: dashboard.generatedAt,
      staleAfterMs: dashboard.freshness?.staleAfterMs,
      persistenceDegraded: dashboard.freshness?.persistenceDegraded,
      states: dashboard.containers.byStatus,
      capacity: dashboard.capacity ? {
        totalLimit: dashboard.capacity.maxTotalInstances,
        totalUsed: dashboard.capacity.totalUsed,
        runningLimit: dashboard.capacity.maxRunningInstances,
        runningUsed: dashboard.capacity.runningUsed,
      } : undefined,
      activity: dashboard.resources,
      health: runtime ? {
        status: aggregateProviderHealth(providerHealth),
        checkedAt: runtime.checkedAt,
        components: healthComponents,
      } : undefined,
      providerHealth: providerHealth.map((check) => ({
        providerId: check.target.replace(/^provider:/u, '') || 'unknown',
        status: providerHealthState(check),
        checkedAt: check.checkedAt,
        error: check.error ?? undefined,
      })),
      alerts: dashboard.alerts,
    };
  },
  users: () => request<{ users: PortalUser[]; pagination?: PaginationMeta }>('/api/admin/users'),
  apps: (signal?: AbortSignal) => request<{ apps: string[]; items?: AppDefinition[]; pagination?: PaginationMeta }>('/api/admin/apps', { signal }),
  createApp: (input: { id: string; name: string; description?: string }) => request<{ app: AppDefinition }>('/api/admin/apps', { method: 'POST', body: JSON.stringify(input) }),
  updateApp: (appId: string, input: { status?: AppStatus; name?: string; description?: string }) => request<{ app: AppDefinition }>(`/api/admin/apps/${encodeURIComponent(appId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  appVersions: (appId: string, signal?: AbortSignal) => request<{ versions: AppVersion[]; pagination?: PaginationMeta }>(`/api/admin/apps/${encodeURIComponent(appId)}/versions`, { signal }),
  importAppImage: (appId: string, imageReference: string, signal?: AbortSignal, idempotencyKey = newIdempotencyKey()) => request<{ operationId: string; operation: AdminOperation }>(`/api/admin/apps/${encodeURIComponent(appId)}/image-imports`, { method: 'POST', body: JSON.stringify({ imageReference }), signal, headers: { 'idempotency-key': idempotencyKey } }),
  buildStrategies: (signal?: AbortSignal) => request<{ strategies: BuildStrategy[] }>('/api/admin/build-strategies', { signal }),
  buildPackages: (strategyId?: string, key?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    query.set('limit', '500');
    if (strategyId) query.set('strategyId', strategyId);
    if (key) query.set('key', key);
    return request<{ packages: BuildPackage[]; pagination?: PaginationMeta }>(`/api/admin/build-packages?${query}`, { signal });
  },
  uploadBuildPackage: (strategyId: string, key: string, file: File, signal?: AbortSignal) => {
    const body = new FormData();
    body.append(key, file);
    return request<{ package: BuildPackage }>(`/api/admin/build-packages?strategyId=${encodeURIComponent(strategyId)}&key=${encodeURIComponent(key)}`, {
      method: 'POST',
      body,
      signal,
    });
  },
  imageBuilds: (strategyId?: string, signal?: AbortSignal) => request<{ builds: ImageBuild[]; pagination?: PaginationMeta }>(`/api/admin/image-builds?limit=500${strategyId ? `&strategyId=${encodeURIComponent(strategyId)}` : ''}`, { signal }),
  imageArtifacts: (signal?: AbortSignal) => request<{ artifacts: ImageArtifact[]; pagination?: PaginationMeta }>('/api/admin/image-artifacts?limit=500', { signal }),
  resourceCleanupPreview: (keepPrevious = 1, signal?: AbortSignal) => request<{ preview: ResourceCleanupPreview }>(
    `/api/admin/resource-cleanup?keepPrevious=${encodeURIComponent(String(keepPrevious))}`,
    { signal },
  ),
  runResourceCleanup: (keepPrevious = 1, signal?: AbortSignal) => {
    const requestOptions = adminResourceCleanupRequest(keepPrevious, signal);
    return request<{ result: ResourceCleanupRun; preview: ResourceCleanupPreview }>(requestOptions.path, requestOptions.init);
  },
  deleteBuildPackage: (id: string) => request<{ deleted: { id: string; storageRemoved: boolean } }>(
    `/api/admin/build-packages/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  ),
  deleteImageArtifact: (id: string) => request<{ deleted: { id: string; runtimeImageRemoved: boolean } }>(
    `/api/admin/image-artifacts/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  ),
  uploadImageBuild: (strategyId: string, packages: Record<string, File>, signal?: AbortSignal, idempotencyKey = newIdempotencyKey()) => {
    const body = new FormData();
    for (const [key, file] of Object.entries(packages)) body.append(key, file);
    return request<{ operationId: string; operation: AdminOperation }>(`/api/admin/image-builds?strategyId=${encodeURIComponent(strategyId)}`, {
      method: 'POST',
      body,
      signal,
      headers: { 'idempotency-key': idempotencyKey },
    });
  },
  createImageBuildFromPackages: (strategyId: string, packageIds: string[], signal?: AbortSignal, idempotencyKey = newIdempotencyKey()) => request<{ operationId: string; operation: AdminOperation }>('/api/admin/image-builds', {
    method: 'POST',
    body: JSON.stringify({ strategyId, packageIds }),
    signal,
    headers: { 'idempotency-key': idempotencyKey },
  }),
  createAppVersionFromPackages: (appId: string, strategyId: string, packageIds: string[], signal?: AbortSignal, idempotencyKey = newIdempotencyKey()) => request<{ operationId: string; operation: AdminOperation }>(`/api/admin/apps/${encodeURIComponent(appId)}/versions`, {
    method: 'POST',
    body: JSON.stringify({ strategyId, packageIds }),
    signal,
    headers: { 'idempotency-key': idempotencyKey },
  }),
  createAppImageUpdate: (
    appId: string,
    input: { strategyId: string; expectedRevision: number; replacementPackageIds: Record<string, string | null> },
    signal?: AbortSignal,
    idempotencyKey = newIdempotencyKey(),
  ) => request<{ operationId: string; operation: AdminOperation }>(`/api/admin/apps/${encodeURIComponent(appId)}/image-updates`, {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
    headers: { 'idempotency-key': idempotencyKey },
  }),
  bindAppImageUpdate: (appId: string, revisionId: string, expectedRevision: number) => request<{ revision: AppVersion }>(
    `/api/admin/apps/${encodeURIComponent(appId)}/image-updates/${encodeURIComponent(revisionId)}/bind`,
    { method: 'POST', body: JSON.stringify({ expectedRevision }) },
  ),
  createAppVersionBuild: (appId: string, versionId: string, strategyId?: string, signal?: AbortSignal, idempotencyKey = newIdempotencyKey()) => request<{ operationId: string; operation: AdminOperation }>(`/api/admin/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}/builds`, {
    method: 'POST',
    body: JSON.stringify(strategyId?.trim() ? { strategyId: strategyId.trim() } : {}),
    signal,
    headers: { 'idempotency-key': idempotencyKey },
  }),
  bindAppVersionArtifact: (appId: string, versionId: string, artifactId: string) => request<{ version: AppVersion }>(`/api/admin/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}/artifact`, { method: 'POST', body: JSON.stringify({ artifactId }) }),
  attachAppVersionImage: (appId: string, versionId: string, reference: string) => request<{ version: AppVersion }>(`/api/admin/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}/image`, { method: 'POST', body: JSON.stringify({ reference }) }),
  activateAppVersion: (appId: string, versionId: string) => request<{ version: AppVersion }>(`/api/admin/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}/activate`, { method: 'POST', body: '{}' }),
  createUser: (email: string, password: string, role: UserRole) => request<{ user: PortalUser }>('/api/admin/users', { method: 'POST', body: JSON.stringify({ email, password, role }) }),
  async containers() {
    const response = await request<{ instances: AdminMonitorInstance[]; pagination?: PaginationMeta }>('/api/admin/monitor/instances?limit=10000');
    return { containers: response.instances.map((instance): PortalContainer => ({
      id: instance.id,
      ownerId: instance.ownerId,
      appId: instance.appId,
      appVersionId: instance.appVersionId,
      imageReference: instance.imageReference,
      status: instance.status,
      stopReason: instance.stopReason,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      lastActivityAt: instance.lastActivityAt,
      runtimeId: instance.runtimeId,
      latestSampleAt: instance.latestSampleAt,
      lastError: instance.lastError,
      metricsCapabilityStatus: instance.metricsCapabilityStatus,
      stale: instance.stale,
      metrics: instance.metrics,
    })) };
  },
  allContainers: () => request<{ containers: PortalContainer[] }>('/api/admin/containers'),
  updateUserRole: (userId: string, expectedRole: UserRole, role: UserRole, password?: string) => request<{ user: PortalUser }>(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ expectedRole, role, ...(password === undefined ? {} : { password }) }),
  }),
  runtime: () => request<{ status: RuntimeInfo }>('/api/admin/runtime'),
  images: (signal?: AbortSignal) => request<{ images: RuntimeImage[]; pagination?: PaginationMeta }>('/api/admin/images', { signal }),
  pullImage: (reference: string, signal?: AbortSignal, idempotencyKey = newIdempotencyKey()) => request<{ ok: true; reference: string; operationId: string; operation: AdminOperation }>('/api/admin/images/pull', { method: 'POST', body: JSON.stringify({ reference }), signal, headers: { 'idempotency-key': idempotencyKey } }),
  loadImage: (file: File, reference: string, signal?: AbortSignal, idempotencyKey = newIdempotencyKey()) => request<{ ok: true; reference: string; bytes: number; operationId: string; operation: AdminOperation }>('/api/admin/images/load', {
    method: 'POST',
    body: file,
    headers: { 'content-type': 'application/x-tar', 'x-image-reference': reference, 'idempotency-key': idempotencyKey },
    signal,
  }),
  async forwarding() {
    const response = await request<{ forwarding: Omit<ForwardingPolicy, 'allowedHosts' | 'revision'> & { allowedHosts?: string[] }; revision?: ConfigRevision | null }>('/api/admin/forwarding');
    return { forwarding: { ...response.forwarding, allowedHosts: response.forwarding.allowedHosts ?? [], revision: response.revision ?? null } };
  },
  async updateForwarding(forwarding: Pick<ForwardingPolicy, 'enabled' | 'allowedHosts' | 'targetBaseUrl'>, revision?: number) {
    const response = await request<{ forwarding: Omit<ForwardingPolicy, 'allowedHosts' | 'revision'> & { allowedHosts?: string[] }; revision?: ConfigRevision | null }>('/api/admin/forwarding', { method: 'PATCH', body: JSON.stringify(forwarding), headers: revision === undefined ? undefined : { 'if-match': String(revision) } });
    return { forwarding: { ...response.forwarding, allowedHosts: response.forwarding.allowedHosts ?? [], revision: response.revision ?? null } };
  },
  forwardingHistory: (limit = 50, signal?: AbortSignal) => request<{
    key: string;
    current: ConfigRevision | null;
    revisions: ConfigRevisionSnapshot<ForwardingSnapshot>[];
  }>(`/api/admin/config-revisions/forwarding?limit=${encodeURIComponent(String(limit))}`, { signal }),
  rollbackForwarding: (targetRevision: number, currentRevision?: number) => request<{
    forwarding: ForwardingPolicy;
    revision: ConfigRevision;
    effect: ConfigEffect;
    rolledBackFrom: number;
  }>(`/api/admin/config-revisions/forwarding/${encodeURIComponent(String(targetRevision))}/rollback`, {
    method: 'POST',
    body: '{}',
    headers: currentRevision === undefined ? undefined : { 'if-match': String(currentRevision) },
  }),
  testForwarding: (targetBaseUrl?: string) => request<{ check: { ok: boolean; status: number; latencyMs: number; error: string | null; targetBaseUrl: string } }>('/api/admin/forwarding/test', { method: 'POST', body: JSON.stringify(targetBaseUrl === undefined ? {} : { targetBaseUrl }) }),
  instancePolicy: () => request<{ policy: InstancePolicy; revision?: ConfigRevision | null }>('/api/admin/instance-policy'),
  updateInstancePolicy: (policy: InstancePolicy, revision?: number) => request<{ policy: InstancePolicy; revision?: ConfigRevision; effect?: ConfigEffect }>('/api/admin/instance-policy', { method: 'PATCH', body: JSON.stringify(policy), headers: revision === undefined ? undefined : { 'if-match': String(revision) } }),
  instancePolicyHistory: (limit = 50, signal?: AbortSignal) => request<{
    key: string;
    current: ConfigRevision | null;
    revisions: ConfigRevisionSnapshot<InstancePolicy>[];
  }>(`/api/admin/config-revisions/instance-policy?limit=${encodeURIComponent(String(limit))}`, { signal }),
  rollbackInstancePolicy: (targetRevision: number, currentRevision?: number) => request<{
    policy: InstancePolicy;
    revision: ConfigRevision;
    effect: ConfigEffect;
    rolledBackFrom: number;
  }>(`/api/admin/config-revisions/instance-policy/${encodeURIComponent(String(targetRevision))}/rollback`, {
    method: 'POST',
    body: '{}',
    headers: currentRevision === undefined ? undefined : { 'if-match': String(currentRevision) },
  }),
  monitorInstances: (query = '') => request<{ instances: AdminMonitorInstance[]; pagination?: PaginationMeta }>(`/api/admin/monitor/instances${query}`),
  instanceMetrics: (id: string, limit = 60) => request<AdminInstanceMetrics>(`/api/admin/monitor/instances/${encodeURIComponent(id)}/metrics?limit=${limit}`),
  audit: (query = '', signal?: AbortSignal) => request<{ events: AuditEvent[]; pagination?: PaginationMeta }>(`/api/admin/audit${query}`, { signal }),
  config: (signal?: AbortSignal) => request<{ config: AdminConfig }>('/api/admin/config', { signal }),
  operations: (query = '', signal?: AbortSignal) => request<{ operations: AdminOperation[]; pagination?: PaginationMeta }>(`/api/admin/operations${query}`, { signal }),
  operation: (id: string, signal?: AbortSignal) => request<{ operation: AdminOperation }>(`/api/admin/operations/${encodeURIComponent(id)}`, { signal }),
  cancelOperation: (id: string) => request<{ operation: AdminOperation }>(`/api/admin/operations/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  retryOperation: (id: string) => request<{ operation: AdminOperation }>(`/api/admin/operations/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' }),
  createTaskBatch: (instanceIds: string[], taskKind: UpgradeRolloutTaskKind, idempotencyKey = newIdempotencyKey()) => request<UpgradeRolloutDetail>('/api/admin/upgrade-rollouts', {
    method: 'POST',
    body: JSON.stringify({ instanceIds, taskKind }),
    headers: { 'idempotency-key': idempotencyKey },
  }),
  createUpgradeRollout: (instanceIds: string[], idempotencyKey = newIdempotencyKey()) => (
    adminApi.createTaskBatch(instanceIds, 'image_upgrade', idempotencyKey)
  ),
  upgradeRollouts: (limit = 100, signal?: AbortSignal) => request<{ rollouts: UpgradeRollout[]; pagination?: PaginationMeta }>(`/api/admin/upgrade-rollouts?limit=${encodeURIComponent(String(limit))}`, { signal }),
  upgradeRollout: (id: string, signal?: AbortSignal, query = '') => request<UpgradeRolloutDetail & { pagination?: PaginationMeta }>(`/api/admin/upgrade-rollouts/${encodeURIComponent(id)}${query}`, { signal }),
  upgradeRolloutItem: (rolloutId: string, instanceId: string, signal?: AbortSignal) => request<{ item: UpgradeRolloutItem }>(
    `/api/admin/upgrade-rollouts/${encodeURIComponent(rolloutId)}/items/${encodeURIComponent(instanceId)}`,
    { signal },
  ),
  upgradeRolloutItemAction: (rolloutId: string, instanceId: string, action: 'force' | 'continue' | 'revalidate' | 'cancel') => request<UpgradeRolloutDetail>(
    `/api/admin/upgrade-rollouts/${encodeURIComponent(rolloutId)}/items/${encodeURIComponent(instanceId)}/${action}`,
    { method: 'POST', body: '{}' },
  ),
  batchContainers: (ids: string[], action: AdminContainerBatchAction, idempotencyKey = newIdempotencyKey()) => request<{ operationId: string; operation: AdminOperation }>('/api/admin/containers/actions', { method: 'POST', body: JSON.stringify(adminContainerBatchRequest(ids, action)), headers: { 'idempotency-key': idempotencyKey } }),
};

export function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `openapp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export type ConfigEffect = 'immediate' | 'new_instances' | 'restart' | 'rebuild';
export interface ConfigRevision { key: string; revision: number; updatedBy: string; updatedAt: string; effect: ConfigEffect; effectiveAt: string | null }
export interface ConfigRevisionSnapshot<TPayload = unknown> extends ConfigRevision { payload: TPayload }
export interface ForwardingSnapshot { targetBaseUrl: string; allowedHosts: string[]; enabled: boolean }
export interface AdminMonitorInstance {
  id: string;
  ownerId: string;
  appId: string;
  appVersionId: string | null;
  imageReference: string | null;
  status: AdminMonitorStatus;
  stopReason: PortalContainer['stopReason'];
  runtimeId: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  metrics: { networkRxBytes: number | null; networkTxBytes: number | null; cpuPercent: number | null; memoryWorkingSetBytes: number | null; pids: number | null; gpuUtilizationPercent: number | null } | null;
  latestSampleAt: string | null;
  lastError: string | null;
  metricsCapabilityStatus?: ProviderCapabilityStatus | null;
  stale: boolean;
}
export interface AdminInstanceMetrics {
  instance: AdminInstanceDetails;
  latest: { sampledAt: string; state: AdminMonitorStatus; networkRxBytes: number | null; networkTxBytes: number | null; cpuPercent: number | null; memoryWorkingSetBytes: number | null; pids: number | null; gpuUtilizationPercent: number | null; error: string | null } | null;
  samples: Array<{ sampledAt: string; state: AdminMonitorStatus; networkRxBytes: number | null; networkTxBytes: number | null; cpuPercent: number | null; memoryWorkingSetBytes: number | null; pids: number | null; gpuUtilizationPercent: number | null; error: string | null }>;
  stale: boolean;
}
export interface AdminInstanceDetails {
  id: string;
  ownerId: string;
  appId: string;
  status: AdminMonitorStatus;
  stopReason: PortalContainer['stopReason'];
  runtimeId: string;
  endpoint: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}
export interface AuditEvent { id: string; actorUserId: string | null; action: string; resourceType: string; resourceId: string | null; metadata: unknown; createdAt: string }
export interface AdminConfig {
  authProvider: string;
  /** 通用 Provider 的展示名称和配置状态。 */
  authProviderLabel?: string;
  authProviderConfigured?: boolean;
  databaseConfigured: boolean;
  cookieSecure: boolean;
  runtimeImageConfigured: boolean;
  adminCliTokenConfigured: boolean;
  publicBaseUrl?: string;
  staticDir?: string;
  releaseDir?: string;
  provider?: Omit<RuntimeInfo, 'runtime'> & { providerId: string };
  runtime?: RuntimeInfo;
  revisions?: { instancePolicy?: ConfigRevision | null; forwarding?: ConfigRevision | null };
  restartRequiredFor?: string[];
}
export type AdminOperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface AdminOperation {
  id: string;
  revision: number;
  type: string;
  status: AdminOperationStatus;
  progress: number;
  stage: string;
  actorUserId: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string;
  retryOf: string | null;
  cancellable: boolean;
  retryable: boolean;
  result: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
}

export type UpgradeRolloutStatus = 'running' | 'succeeded' | 'partial_failed' | 'cancelled' | 'needs_attention';
export type UpgradeRolloutTaskKind = 'image_upgrade' | 'rebuild_same_image' | 'apply_resource_policy' | 'instance_recovery';
export type UpgradeRolloutItemStatus = 'queued' | 'assessing' | 'waiting_for_idle' | 'draining' | 'rebuilding' | 'verifying' | 'awaiting_first_start' | 'succeeded' | 'superseded' | 'failed' | 'cancelled' | 'needs_attention';
export interface UpgradeRollout {
  id: string;
  status: UpgradeRolloutStatus;
  taskKind?: UpgradeRolloutTaskKind;
  useLatestVersion: boolean;
  requested: number;
  completed: number;
  succeeded: number;
  superseded?: number;
  failed: number;
  waiting: number;
  upgrading: number;
  needsAttention: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}
export interface UpgradeRolloutItem {
  rolloutId: string;
  instanceId: string;
  position: number;
  userId: string;
  appId: string;
  sourceStatus: PortalContainer['status'];
  desiredState: 'running' | 'stopped';
  sourceAppVersionId: string | null;
  targetAppVersionId: string | null;
  targetResources?: { memory: string; cpus: string; pidsLimit: number };
  status: UpgradeRolloutItemStatus;
  blocker: string | null;
  error: string | null;
  recovery?: boolean;
  diagnostics?: {
    capturedAt: string;
    error: string | null;
    capabilityStatus?: ProviderCapabilityStatus;
    containerRole?: 'canonical' | 'rollback' | 'candidate' | 'previous';
    exitCode?: number | null;
    oomKilled?: boolean | null;
    health?: string | null;
    memoryLimit?: string | null;
    memorySwapLimit?: string | null;
    cpus?: string | null;
    pidsLimit?: number | null;
    logTail?: string | null;
  } | null;
  forceRequested: boolean;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastCheckedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface UpgradeRolloutDetail { rollout: UpgradeRollout; items: UpgradeRolloutItem[] }
