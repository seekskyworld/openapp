import { useCallback, useEffect, useRef, useState } from 'react';
import { Ban, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { adminApi, type AdminConfig, type AdminOperation, type AdminOperationStatus, type AuditEvent } from '../../admin-api';
import type { PortalUser } from '../../api';
import { EmptyRow, PaginationBar, message, paginateItems, usePersistentPageSize } from './shared';
import UpgradeRolloutsSection from './UpgradeRolloutsSection';
import { useUpgradeRollouts } from './useUpgradeRollouts';

const isGenericFrontendBuild = typeof __OPENAPP_FRONTEND_BUILD_TARGET__ === 'string'
  && __OPENAPP_FRONTEND_BUILD_TARGET__ === 'generic';

const STATUS_LABELS: Record<AdminOperationStatus, string> = {
  queued: '等待中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const OPERATION_LIMIT = 100;

function mergeOperations(current: AdminOperation[], incoming: AdminOperation[]): AdminOperation[] {
  const byId = new Map(current.map((operation) => [operation.id, operation]));
  incoming.forEach((operation) => byId.set(operation.id, operation));
  return [...byId.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, OPERATION_LIMIT);
}

interface BatchResultItem {
  id: string;
  ok: boolean;
  error?: string;
}

function batchResultItems(result: unknown): BatchResultItem[] {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { results?: unknown }).results)) return [];
  return (result as { results: unknown[] }).results.filter((item): item is BatchResultItem => (
    Boolean(item)
    && typeof item === 'object'
    && typeof (item as { id?: unknown }).id === 'string'
    && typeof (item as { ok?: unknown }).ok === 'boolean'
    && ((item as { error?: unknown }).error === undefined || typeof (item as { error?: unknown }).error === 'string')
  ));
}

function resultSummary(result: unknown): string {
  if (!result || typeof result !== 'object') return '-';
  const candidate = result as { succeeded?: unknown; failed?: unknown; requested?: unknown; cancelled?: unknown };
  if (typeof candidate.succeeded === 'number' && typeof candidate.failed === 'number') {
    return `成功 ${candidate.succeeded} · 失败 ${candidate.failed}${candidate.cancelled ? ' · 已取消' : ''}`;
  }
  return '-';
}

export default function OperationsPanel({ users = [] }: { users?: PortalUser[] }) {
  const [operations, setOperations] = useState<AdminOperation[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [legacyProviderConfigured, setLegacyProviderConfigured] = useState<boolean | undefined>();
  const [status, setStatus] = useState<'all' | AdminOperationStatus>('all');
  const [operationQuery, setOperationQuery] = useState('');
  const [auditQuery, setAuditQuery] = useState('');
  const [operationPage, setOperationPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [operationPageSize, setOperationPageSize] = usePersistentPageSize('operations');
  const [auditPageSize, setAuditPageSize] = usePersistentPageSize('audit');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState(false);
  const [busyOperationIds, setBusyOperationIds] = useState<Set<string>>(() => new Set());
  const statusRef = useRef(status);
  const loadSequenceRef = useRef(0);
  const busyOperationIdsRef = useRef(new Set<string>());
  const loadControllerRef = useRef<AbortController | null>(null);
  const upgradeRollouts = useUpgradeRollouts(setError);
  statusRef.current = status;
  const filteredOperations = operations.filter((operation) => {
    const query = operationQuery.trim().toLowerCase();
    return !query || [operation.id, operation.type, operation.resourceType, operation.resourceId, operation.actorUserId, operation.stage, operation.error].some((value) => value?.toLowerCase().includes(query));
  });
  const filteredEvents = events.filter((event) => {
    const query = auditQuery.trim().toLowerCase();
    return !query || [event.id, event.actorUserId, event.action, event.resourceType, event.resourceId].some((value) => value?.toLowerCase().includes(query));
  });
  const visibleOperations = paginateItems(filteredOperations, operationPage, operationPageSize);
  const visibleEvents = paginateItems(filteredEvents, auditPage, auditPageSize);

  const load = useCallback(async (showRefresh = false) => {
    const requestedStatus = status;
    const sequence = ++loadSequenceRef.current;
    loadControllerRef.current?.abort(new DOMException('Superseded admin operation load', 'AbortError'));
    const controller = new AbortController();
    loadControllerRef.current = controller;
    if (showRefresh) setRefreshing(true);
    const query = requestedStatus === 'all' ? `?limit=${OPERATION_LIMIT}` : `?status=${requestedStatus}&limit=${OPERATION_LIMIT}`;
    try {
      const results = await Promise.allSettled([
        adminApi.operations(query, controller.signal),
        adminApi.audit('?limit=100', controller.signal),
        adminApi.config(controller.signal),
        upgradeRollouts.load(OPERATION_LIMIT, controller.signal),
      ]);
      let legacyConfigValue: boolean | undefined;
      const configResult = results[2];
      if (!isGenericFrontendBuild
        && configResult.status === 'fulfilled'
        && configResult.value.config.authProviderConfigured === undefined) {
        try {
          const { loadLegacyAuthCompatibility } = await import('../auth/compat/load');
          const compatibility = await loadLegacyAuthCompatibility(undefined);
          legacyConfigValue = compatibility.legacyAuthProviderConfigured?.(configResult.value.config);
        } catch {
          // 兼容 chunk 加载失败时仍显示通用的“未配置”，不阻断其他诊断项。
        }
      }
      if (sequence !== loadSequenceRef.current || requestedStatus !== statusRef.current || controller.signal.aborted) return;
      if (results[0].status === 'fulfilled') setOperations(results[0].value.operations);
      if (results[1].status === 'fulfilled') setEvents(results[1].value.events);
      if (configResult.status === 'fulfilled') {
        setConfig(configResult.value.config);
        setLegacyProviderConfigured(legacyConfigValue);
      }
      const failed = results.filter((result) => result.status === 'rejected');
      setError(failed.length ? '部分操作记录加载失败，请稍后重试。' : '');
    } finally {
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [status, upgradeRollouts.load]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      window.clearInterval(timer);
      loadSequenceRef.current += 1;
      loadControllerRef.current?.abort(new DOMException('Operations panel unmounted', 'AbortError'));
      loadControllerRef.current = null;
    };
  }, [load]);

  useEffect(() => {
    const stream = new EventSource('/api/admin/events', { withCredentials: true });
    stream.addEventListener('snapshot', (event) => {
      setLive(true);
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { operations?: AdminOperation[] };
        if (statusRef.current === 'all' && payload.operations) {
          setOperations((current) => mergeOperations(current, payload.operations ?? []));
        }
      } catch { /* the periodic REST refresh remains authoritative */ }
    });
    stream.onerror = () => setLive(false);
    return () => stream.close();
  }, []);

  async function action(operation: AdminOperation, kind: 'cancel' | 'retry') {
    if (busyOperationIdsRef.current.has(operation.id)) return;
    busyOperationIdsRef.current.add(operation.id);
    setBusyOperationIds(new Set(busyOperationIdsRef.current));
    setError('');
    try {
      await (kind === 'cancel' ? adminApi.cancelOperation(operation.id) : adminApi.retryOperation(operation.id));
      await load();
    } catch (reason) {
      setError(message(reason, kind === 'cancel' ? '取消任务失败' : '重试任务失败'));
    } finally {
      busyOperationIdsRef.current.delete(operation.id);
      setBusyOperationIds(new Set(busyOperationIdsRef.current));
    }
  }

  const runtimeStatus = config?.provider ?? config?.runtime;
  const runtimeName = config?.provider?.providerId ?? config?.runtime?.runtime ?? 'Provider';

  return <div className="admin-section admin-stack">
    {config && <section className="diagnostics-panel"><div className="section-heading"><div><h2>系统诊断</h2><p>只读显示当前有效配置；敏感凭证只显示是否已配置。</p></div></div><div className="diagnostic-grid"><span>数据库 <b className={config.databaseConfigured ? 'ok' : 'warn'}>{config.databaseConfigured ? 'PostgreSQL' : '内存模式'}</b></span><span>{config.authProviderLabel || config.authProvider || '认证 Provider'} <b className={(config.authProviderConfigured ?? legacyProviderConfigured) ? 'ok' : 'warn'}>{(config.authProviderConfigured ?? legacyProviderConfigured) ? '已配置' : '未配置'}</b></span><span>运行时 <b className={runtimeStatus?.available ? 'ok' : 'warn'}>{runtimeStatus?.available ? `${runtimeName} ${runtimeStatus.version ?? ''}` : '不可用'}</b></span><span>管理员 CLI <b className={config.adminCliTokenConfigured ? 'ok' : 'warn'}>{config.adminCliTokenConfigured ? '已配置' : '未配置'}</b></span></div><p className="diagnostic-note">以下配置修改需要重启：{config.restartRequiredFor?.join('、') ?? '-'}</p></section>}
    <UpgradeRolloutsSection
      users={users}
      rollouts={upgradeRollouts.rollouts}
      details={upgradeRollouts.details}
      expandedRolloutId={upgradeRollouts.expandedRolloutId}
      busyItemKeys={upgradeRollouts.busyItemKeys}
      loading={loading}
      onToggle={upgradeRollouts.toggle}
      onAction={upgradeRollouts.action}
    />
    <section>
      <div className="section-heading"><div><h2>后台操作</h2><p>镜像、发布和批量实例操作在这里持续执行，刷新页面不会丢失状态。</p></div><div className="section-commands"><span className={`live-badge${live ? ' connected' : ''}`}>{live ? '实时' : '轮询'}</span><button className="icon-button" title={refreshing ? '正在刷新操作' : '刷新操作'} aria-label={refreshing ? '正在刷新操作' : '刷新操作'} disabled={refreshing} onClick={() => void load(true)}><RefreshCw className={refreshing ? 'spin' : ''} size={16} /></button></div></div>
      <div className="operation-filters"><label>状态<select value={status} onChange={(event) => {
        loadSequenceRef.current += 1;
        setOperations([]);
        setLoading(true);
        setStatus(event.target.value as typeof status);
      }}><option value="all">全部状态</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>搜索<input value={operationQuery} onChange={(event) => { setOperationQuery(event.target.value); setOperationPage(1); }} placeholder="任务、资源、操作者或错误" /></label></div>
      {error && <div className="notice error">{error}</div>}
      <div className="table-wrap"><table><thead><tr><th>任务</th><th>资源</th><th>状态</th><th>进度</th><th>发起时间</th><th>结果</th><th>错误</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>
        {visibleOperations.length === 0 ? <EmptyRow columns={8} text={loading ? '正在加载' : '暂无后台操作'} /> : visibleOperations.map((operation) => {
          const actionBusy = busyOperationIds.has(operation.id);
          const items = batchResultItems(operation.result);
          return <tr key={operation.id}><td><strong>{operation.type}</strong><small className="mono">{operation.id}</small></td><td>{operation.resourceId ?? operation.resourceType}</td><td><span className={`operation-status ${operation.status}`}>{STATUS_LABELS[operation.status]}</span></td><td><div className="table-progress"><i style={{ width: `${operation.progress}%` }} /></div><small>{operation.stage === 'cancelling' ? '取消中' : operation.stage} · {operation.progress}%</small></td><td>{new Date(operation.createdAt).toLocaleString('zh-CN')}</td><td className="operation-result">{resultSummary(operation.result)}{items.length > 0 && <details><summary>查看明细</summary><ul>{items.map((item) => <li key={item.id} className={item.ok ? 'ok' : 'error'}>{item.id}：{item.ok ? '成功' : item.error ?? '失败'}</li>)}</ul></details>}</td><td className="operation-error">{operation.error ?? '-'}</td><td className="row-actions"><div>{((operation.status === 'queued' || operation.status === 'running') && operation.cancellable && operation.stage !== 'cancelling') && <button className="danger-icon" title={actionBusy ? '正在取消任务' : '取消任务'} aria-label={actionBusy ? '正在取消任务' : '取消任务'} disabled={actionBusy} onClick={() => void action(operation, 'cancel')}>{actionBusy ? <LoaderCircle className="spin" size={14} /> : <Ban size={14} />}</button>}{(operation.status === 'failed' || operation.status === 'cancelled') && operation.retryable && <button className="secondary compact" disabled={actionBusy} onClick={() => void action(operation, 'retry')}>{actionBusy ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}{actionBusy ? '重试中' : '重试'}</button>}</div></td></tr>;
        })}
      </tbody></table></div>
      <PaginationBar page={operationPage} total={filteredOperations.length} pageSize={operationPageSize} onPage={setOperationPage} onPageSize={(value) => { setOperationPageSize(value); setOperationPage(1); }} />
    </section>
    <section>
      <div className="section-heading"><div><h2>审计记录</h2><p>查看管理员和系统对账号、实例、镜像、发布及策略执行的操作。</p></div><div className="section-commands"><label>搜索<input value={auditQuery} onChange={(event) => { setAuditQuery(event.target.value); setAuditPage(1); }} placeholder="动作、资源或操作者" /></label><span>{filteredEvents.length} 条</span></div></div>
      <div className="table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>资源</th><th>资源 ID</th></tr></thead><tbody>
        {visibleEvents.length === 0 ? <EmptyRow columns={5} text="暂无审计记录" /> : visibleEvents.map((event) => <tr key={event.id}><td>{new Date(event.createdAt).toLocaleString('zh-CN')}</td><td className="mono">{event.actorUserId ?? 'system'}</td><td><strong>{event.action}</strong></td><td>{event.resourceType}</td><td className="mono">{event.resourceId ?? '-'}</td></tr>)}
      </tbody></table></div>
      <PaginationBar page={auditPage} total={filteredEvents.length} pageSize={auditPageSize} onPage={setAuditPage} onPageSize={(value) => { setAuditPageSize(value); setAuditPage(1); }} />
    </section>
  </div>;
}
