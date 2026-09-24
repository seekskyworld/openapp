export type UserRole = 'user' | 'admin' | 'super_admin';
export type AuthMethod = string;

export interface PortalUser {
  id: string;
  email: string;
  name?: string;
  role: UserRole;
  authMethod?: AuthMethod;
  passwordSetupRequired?: boolean;
  linkedProviders?: string[];
  createdAt?: string;
}

export type ContainerStatus = 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
export type ContainerStopReason = 'idle' | 'manual_user' | 'manual_admin' | 'failure';

export interface PortalContainer {
  id: string;
  ownerId: string;
  appId: string;
  appName?: string | null;
  appVersion?: string | null;
  appRevision?: number | null;
  status: ContainerStatus;
  stopReason: ContainerStopReason | null;
  endpoint?: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  runtimeId?: string;
  latestSampleAt?: string | null;
  lastError?: string | null;
  metricsCapabilityStatus?: 'supported' | 'unsupported' | 'unavailable' | null;
  stale?: boolean;
  metrics?: { cpuPercent: number | null; memoryWorkingSetBytes: number | null; networkRxBytes: number | null; networkTxBytes: number | null; pids: number | null; gpuUtilizationPercent?: number | null } | null;
  appVersionId?: string | null;
  /** Only returned by administrator monitor projections. */
  imageReference?: string | null;
}

export interface RecoveryState {
  recovery: true;
  rolloutId: string;
  status: string;
  itemStatus: string;
}

/** 服务端 Adapter 提供的安全错误文案；不包含凭据、Cookie 或可执行内容。 */
export type PortalEntryErrorCatalog = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface PortalEntryManifest {
  appId: string;
  appName: string;
  /** 服务端按 App manifest 选择的认证 Provider；缺省时使用平台默认 Provider。 */
  authProviderId?: string;
  /** 仅旧部署返回 true；通用 Product Shell 不应依赖产品名判断兼容性。 */
  compatibilityMode?: boolean;
  entry: {
    id: string;
    label: string;
    logoUrl: string;
    challenge: 'email_code' | 'none';
    defaultWorkspace: 'personal';
    /** Optional visual hints supplied by the registered App plugin. */
    wordmark?: string;
    theme?: 'default' | 'light' | 'dark';
    /** Adapter-owned fields for a generic email-code entry shell. */
    fields?: readonly {
      id: string;
      kind: 'email' | 'verification_code' | 'text' | (string & {});
      label: string;
      placeholder?: string;
      required?: boolean;
      secret?: boolean;
      maxLength?: number;
    }[];
  };
  capabilities: Record<string, boolean>;
  errorCatalog?: PortalEntryErrorCatalog;
}

export interface RecoveryPending extends RecoveryState {}

export type PortalAppStatus = 'active' | 'archived';
export type PortalAppVersionStatus = 'legacy' | 'uploaded' | 'image_ready' | 'active' | 'archived';

export interface PortalApp {
  id: string;
  name: string;
  description: string;
  authAdapterId?: string;
  status: PortalAppStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PortalAppVersion {
  id: string;
  appId: string;
  revision?: number | null;
  version: string;
  buildId?: string;
  imageReference?: string | null;
  status: PortalAppVersionStatus;
  createdAt: string;
  activatedAt: string | null;
}

export interface PortalAppCatalogItem {
  app: PortalApp;
  versions: PortalAppVersion[];
  activeVersion?: PortalAppVersion;
}

export interface EnsureDefaultResult {
  container?: PortalContainer | null;
  created: boolean;
  reason?: string;
}

export type AdminContainerBatchAction = 'start' | 'stop' | 'rebuild' | 'rebuild-latest';

export interface AdminContainerBatchRequest {
  ids: string[];
  action: 'start' | 'stop' | 'rebuild';
  useLatestVersion?: boolean;
}

export function adminContainerBatchRequest(
  ids: readonly string[],
  action: AdminContainerBatchAction,
): AdminContainerBatchRequest {
  if (action === 'rebuild-latest') {
    return { ids: [...ids], action: 'rebuild', useLatestVersion: true };
  }
  if (action === 'rebuild') {
    return { ids: [...ids], action, useLatestVersion: false };
  }
  return { ids: [...ids], action };
}

export function adminResourceCleanupRequest(keepPrevious: number, signal?: AbortSignal): { path: string; init: RequestInit } {
  return {
    path: '/api/admin/resource-cleanup',
    init: {
      method: 'POST',
      body: JSON.stringify({ keepPrevious }),
      signal,
    },
  };
}

interface ApiErrorBody { error?: string; message?: string }

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, requestId?: string) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: { ...(init?.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    });
  } catch {
    throw new ApiError(0, 'network_unavailable');
  }
  if (!response.ok) {
    let body: ApiErrorBody = {};
    try { body = await response.json() as ApiErrorBody; } catch { /* non-JSON upstream error */ }
    throw new ApiError(response.status, body.error ?? body.message ?? 'request_failed', response.headers.get('x-request-id') ?? undefined);
  }
  try {
    return await response.json() as T;
  } catch {
    throw new ApiError(response.status, 'invalid_server_response');
  }
}

export const api = {
  entryManifest: (signal?: AbortSignal) => request<PortalEntryManifest>('/api/entry/manifest', { signal }),
  apps: (signal?: AbortSignal) => request<{ apps: PortalAppCatalogItem[] }>('/api/apps', { signal }),
  containers: (signal?: AbortSignal) => request<{ containers: PortalContainer[] }>('/api/containers', { signal }),
  ensureDefaultContainer: () => request<EnsureDefaultResult>('/api/containers/ensure-default', { method: 'POST', body: '{}' }),
  createContainer: (appId: string) => request<{ container: PortalContainer; created: boolean }>('/api/containers', { method: 'POST', body: JSON.stringify({ appId }) }),
  containerAction: (id: string, action: 'start' | 'stop') => request<{ container: PortalContainer } | RecoveryPending>(`/api/containers/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' }),
  deleteContainer: (id: string) => request<{ ok: boolean }>(`/api/containers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  enter: (id: string) => request<{ url: string } | RecoveryPending>(`/api/containers/${encodeURIComponent(id)}/enter`, { method: 'POST', body: '{}' }),
  recovery: (id: string) => request<RecoveryState>(`/api/containers/${encodeURIComponent(id)}/recovery`),
  adminContainerAction: (id: string, action: 'start' | 'stop' | 'rebuild') => request<{ container: PortalContainer }>(`/api/admin/containers/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' }),
  adminContainerRebuildLatest: (id: string) => request<{ container: PortalContainer }>(`/api/admin/containers/${encodeURIComponent(id)}/rebuild`, { method: 'POST', body: JSON.stringify({ useLatestVersion: true }) }),
  adminDeleteContainer: (id: string) => request<{ ok: boolean }>(`/api/admin/containers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
