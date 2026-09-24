import {
  ApiError,
  api,
  type PortalContainer,
  type PortalEntryManifest,
  type PortalEntryErrorCatalog,
  type RecoveryPending,
  type RecoveryState,
} from '../../api';

const isGenericFrontendBuild = typeof __OPENAPP_FRONTEND_BUILD_TARGET__ === 'string'
  && __OPENAPP_FRONTEND_BUILD_TARGET__ === 'generic';

export type PortalRouteMode = 'entry' | 'control' | 'instance' | 'redirect';

export interface PortalRoute {
  mode: PortalRouteMode;
  url?: string;
}

export function resolvePortalRoute(pathname: string, search: string): PortalRoute {
  if (pathname === '/control' || pathname === '/control/') return { mode: 'control' };
  if (pathname.startsWith('/instances/')) return { mode: 'instance' };
  const params = new URLSearchParams(search);
  if (params.get('view') === 'admin' || params.has('admin')) {
    return { mode: 'redirect', url: `/control${search || ''}` };
  }
  return { mode: 'entry' };
}

export type WorkspaceEntryStage = 'checking' | 'creating' | 'entering' | 'recovering';

export interface WorkspaceEntryGateway {
  entryManifest?(): Promise<PortalEntryManifest>;
  containers(): Promise<{ containers: PortalContainer[] }>;
  createContainer(appId: string): Promise<{ container: PortalContainer; created: boolean }>;
  enter(id: string): Promise<{ url: string } | RecoveryPending>;
  recovery(id: string): Promise<RecoveryState>;
}

export class WorkspaceEntryError extends Error {
  readonly instanceId?: string;
  readonly containerIds: string[];
  readonly containerStatus?: PortalContainer['status'];
  readonly requestId?: string;
  readonly code?: string;
  readonly stage?: WorkspaceEntryStage;

  constructor(message: string, details: {
    instanceId?: string;
    containerIds?: string[];
    containerStatus?: PortalContainer['status'];
    requestId?: string;
    code?: string;
    stage?: WorkspaceEntryStage;
  } = {}) {
    super(message);
    this.name = 'WorkspaceEntryError';
    this.instanceId = details.instanceId;
    this.containerIds = details.containerIds ?? (details.instanceId ? [details.instanceId] : []);
    this.containerStatus = details.containerStatus;
    this.requestId = details.requestId;
    this.code = details.code;
    this.stage = details.stage;
  }
}

export interface PrepareUserWorkspaceOptions {
  gateway?: WorkspaceEntryGateway;
  onStage?: (stage: WorkspaceEntryStage) => void;
  onManifest?: (manifest: PortalEntryManifest) => void;
  /** 旧 Gateway 未实现 manifest 时使用的显式兼容投影。 */
  fallbackManifest?: PortalEntryManifest;
  /** 只有旧 Gateway 才应显式开启；新入口默认使用通用 manifest。 */
  legacyCompatibility?: boolean;
  wait?: (milliseconds: number) => Promise<void>;
  maxRecoveryPolls?: number;
}

export interface PreparedUserWorkspace {
  instanceId: string;
  url: string;
}

const defaultWait = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

/** 新 App 没有入口 manifest 时的产品无关安全回退。 */
export const DEFAULT_ENTRY_MANIFEST: PortalEntryManifest = {
  appId: 'openapp',
  appName: 'OpenApp',
  compatibilityMode: false,
  entry: {
    id: 'generic-workspace',
    label: 'OpenApp',
    logoUrl: '/openapp-logo.png',
    challenge: 'email_code',
    defaultWorkspace: 'personal',
  },
  capabilities: {
    downstreamSession: false,
    emailCodeEntry: true,
    websocket: true,
  },
};

export async function prepareUserWorkspace({
  gateway = api,
  onStage,
  onManifest,
  fallbackManifest,
  legacyCompatibility = false,
  wait = defaultWait,
  maxRecoveryPolls = 45,
}: PrepareUserWorkspaceOptions = {}): Promise<PreparedUserWorkspace> {
  const resolvedFallbackManifest = fallbackManifest
    ?? (!isGenericFrontendBuild && legacyCompatibility ? await loadLegacyEntryManifest() : DEFAULT_ENTRY_MANIFEST);
  const entryManifest = await resolveEntryManifest(gateway, resolvedFallbackManifest);
  onManifest?.(entryManifest);
  onStage?.('checking');
  let containersResult: { containers: PortalContainer[] };
  try {
    containersResult = await gateway.containers();
  } catch (reason) {
    throw toWorkspaceEntryError(reason, undefined, { stage: 'checking' });
  }

  const containerIds = containersResult.containers.map((container) => container.id);
  let instance: PortalContainer | undefined = containersResult.containers[0];
  if (!instance) {
    onStage?.('creating');
    try {
      instance = (await gateway.createContainer(entryManifest.appId)).container;
    } catch (reason) {
      throw toWorkspaceEntryError(reason, undefined, { stage: 'creating', containerIds });
    }
  }

  const enter = async (): Promise<{ url: string } | RecoveryPending> => {
    onStage?.('entering');
    try {
      return await gateway.enter(instance!.id);
    } catch (reason) {
      throw toWorkspaceEntryError(reason, instance!.id, {
        stage: 'entering',
        containerIds: [instance!.id],
        containerStatus: instance!.status,
      });
    }
  };

  let result = await enter();
  if ('url' in result) return { instanceId: instance.id, url: result.url };
  if (result.status === 'needs_attention' || result.itemStatus === 'needs_attention') {
    throw new WorkspaceEntryError('自动恢复多次失败，需要管理员排查。', {
      instanceId: instance.id,
      containerStatus: instance.status,
      stage: 'recovering',
    });
  }

  onStage?.('recovering');
  let recovered = false;
  for (let attempt = 0; attempt < maxRecoveryPolls; attempt += 1) {
    await wait(2_000);
    let recovery: RecoveryState;
    try {
      recovery = await gateway.recovery(instance.id);
    } catch {
      continue;
    }
    if (isRecoveryFailure(recovery)) {
      throw new WorkspaceEntryError('自动恢复多次失败，需要管理员排查。', {
        instanceId: instance.id,
        containerStatus: instance.status,
        stage: 'recovering',
      });
    }
    if (recovery.itemStatus === 'succeeded' || recovery.itemStatus === 'superseded' || recovery.status === 'succeeded') {
      recovered = true;
      break;
    }
  }
  if (!recovered) {
    throw new WorkspaceEntryError('实例仍在准备中，请稍后重试。', {
      instanceId: instance.id,
      containerStatus: instance.status,
      stage: 'recovering',
    });
  }

  result = await enter();
  if ('url' in result) return { instanceId: instance.id, url: result.url };
  if (result.status === 'needs_attention' || result.itemStatus === 'needs_attention') {
    throw new WorkspaceEntryError('自动恢复多次失败，需要管理员排查。', {
      instanceId: instance.id,
      containerStatus: instance.status,
      stage: 'recovering',
    });
  }
  throw new WorkspaceEntryError('实例已恢复，正在等待入口刷新，请稍后重试。', {
    instanceId: instance.id,
    containerStatus: instance.status,
    stage: 'recovering',
  });
}

/** 兼容 manifest 只在旧 Gateway 回退时进入浏览器依赖图。 */
async function loadLegacyEntryManifest(): Promise<PortalEntryManifest> {
  const { loadLegacyAuthCompatibility } = await import('../auth/compat/load');
  const adapter = await loadLegacyAuthCompatibility(undefined);
  return adapter.legacyEntryManifest ?? DEFAULT_ENTRY_MANIFEST;
}

async function resolveEntryManifest(
  gateway: WorkspaceEntryGateway,
  fallbackManifest: PortalEntryManifest,
): Promise<PortalEntryManifest> {
  if (!gateway.entryManifest) return fallbackManifest;
  try {
    const manifest = await gateway.entryManifest();
    return isEntryManifest(manifest) ? manifest : fallbackManifest;
  } catch {
    // 旧 Gateway 可显式传入兼容 manifest；新 API 回退到产品无关入口。
    return fallbackManifest;
  }
}

function isEntryManifest(value: unknown): value is PortalEntryManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PortalEntryManifest>;
  const entry = candidate.entry;
  return typeof candidate.appId === 'string'
    && candidate.appId.length > 0
    && typeof candidate.appName === 'string'
    && Boolean(entry)
    && typeof entry?.id === 'string'
    && typeof entry.label === 'string'
    && typeof entry.logoUrl === 'string'
    && (entry.challenge === 'email_code' || entry.challenge === 'none')
    && entry.defaultWorkspace === 'personal'
    && Boolean(candidate.capabilities)
    && typeof candidate.capabilities === 'object'
    && (candidate.errorCatalog === undefined || isSafeErrorCatalog(candidate.errorCatalog));
}

function isSafeErrorCatalog(value: unknown): value is PortalEntryErrorCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const locales = Object.entries(value as Record<string, unknown>);
  if (locales.length > 16) return false;
  for (const [locale, rawMessages] of locales) {
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,3}$/u.test(locale)) return false;
    if (!rawMessages || typeof rawMessages !== 'object' || Array.isArray(rawMessages)) return false;
    const messages = Object.entries(rawMessages as Record<string, unknown>);
    if (messages.length > 128) return false;
    for (const [key, message] of messages) {
      if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(key)
        || /(?:access|authorization|cookie|credential|password|private|refresh|secret|session|token)/iu.test(key)
        || typeof message !== 'string'
        || message.length === 0
        || message.length > 512
        || /[<>\u0000-\u001f\u007f]/u.test(message)) {
        return false;
      }
    }
  }
  return true;
}

function isRecoveryFailure(recovery: RecoveryState): boolean {
  return ['needs_attention', 'failed', 'cancelled', 'partial_failed'].includes(recovery.itemStatus)
    || ['needs_attention', 'failed', 'cancelled', 'partial_failed'].includes(recovery.status);
}

function toWorkspaceEntryError(
  reason: unknown,
  instanceId?: string,
  details: Partial<Pick<WorkspaceEntryError, 'containerIds' | 'containerStatus' | 'stage'>> = {},
): WorkspaceEntryError {
  if (reason instanceof WorkspaceEntryError) return reason;
  if (reason instanceof ApiError) {
    return new WorkspaceEntryError(apiErrorMessage(reason), {
      instanceId,
      ...details,
      requestId: reason.requestId,
      code: reason.code,
    });
  }
  return new WorkspaceEntryError('暂时无法准备你的工作区，请稍后重试。', { instanceId, ...details });
}

function apiErrorMessage(reason: ApiError): string {
  const messages: Record<string, string> = {
    network_unavailable: '暂时无法连接服务，请检查网络后重试。',
    unauthorized: '登录状态已失效，请重新登录。',
    session_expired: '登录状态已失效，请重新登录。',
    instance_start_failed: '工作区启动失败，请稍后重试。',
    container_not_ready: '工作区正在准备中，请稍后重试。',
    instance_recovery_failed: '工作区自动恢复失败，需要管理员排查。',
    app_not_available: '工作区暂时不可用，请联系管理员。',
    unsupported_app_auth: '工作区授权暂不可用，请联系管理员。',
    app_auth_reauthentication_required: '需要重新验证身份，请重新登录。',
    internal_error: '工作区服务暂时异常，请稍后重试。',
    instance_maintenance_busy: '工作区正在维护，请稍后重试。',
    instance_upgrade_in_progress: '工作区正在升级，请稍后重试。',
    auto_create_disabled: '管理员暂未开放工作区创建。',
    one_app_instance_limit: '已有工作区正在同步，请稍后重试。',
    instance_limit_reached: '当前工作区数量已达上限，请联系管理员。',
    total_limit_reached: '当前工作区容量已满，请稍后重试。',
    running_limit_reached: '当前运行容量已满，请稍后重试。',
  };
  return messages[reason.code] ?? '暂时无法准备你的工作区，请稍后重试。';
}
