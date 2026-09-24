import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Container, Info, LoaderCircle, Play, Server, Square, Trash2, X } from 'lucide-react';
import { ApiError, api, type PortalAppCatalogItem, type PortalContainer, type RecoveryPending } from '../../api';

function ErrorNotice({ message }: { message: string }) {
  return <div className="notice error"><AlertCircle size={17} /><span>{message}</span></div>;
}

function InfoNotice({ message }: { message: string }) {
  return <div className="notice info"><Info size={17} /><span>{message}</span></div>;
}

function normalizeEnsureReason(reason: string): string {
  if (reason === 'limit' || reason === 'instance_limit_reached') return 'total_limit_reached';
  if (reason === 'running_instance_limit_reached') return 'running_limit_reached';
  return reason;
}

function isCapacityReason(reason: string): boolean {
  return reason === 'total_limit_reached' || reason === 'running_limit_reached';
}

function Status({ status }: { status: PortalContainer['status'] }) {
  const labels: Record<PortalContainer['status'], string> = { creating: '创建中', starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', failed: '异常' };
  return <span className={`status ${status}`}><i />{labels[status]}</span>;
}

function stopReasonLabel(container: PortalContainer): string | null {
  if (container.status === 'failed' || container.stopReason === 'failure') return '异常停止，请检查后重新启动';
  if (container.status !== 'stopped') return null;
  if (container.stopReason === 'idle') return '空闲后已暂停，下次访问会自动恢复';
  if (container.stopReason === 'manual_admin') return '管理员已停止，需要明确启动';
  if (container.stopReason === 'manual_user') return '已手动停止，需要明确启动';
  return '已停止';
}

function ContainerActions({ container, busy, onAction, onEnter, onDelete }: { container: PortalContainer; busy: string | null; onAction: (action: 'start' | 'stop') => void; onEnter: () => void; onDelete: () => void }) {
  const transitional = ['creating', 'starting', 'stopping'].includes(container.status);
  const canEnter = container.status === 'running' || container.status === 'stopped' || container.status === 'failed';
  return <div className="actions">
    {container.status === 'running' ? <button className="secondary" onClick={() => onAction('stop')} disabled={Boolean(busy) || transitional}>{busy === 'stop' ? <LoaderCircle className="spin" size={16} /> : <Square size={15} />}停止</button> : <button className="secondary" onClick={() => onAction('start')} disabled={Boolean(busy) || transitional}>{busy === 'start' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}启动</button>}
    <button className="primary" onClick={onEnter} disabled={!canEnter || Boolean(busy)}>{busy === 'enter' ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}进入</button>
    <button className="danger" title="删除容器" aria-label="删除容器" onClick={onDelete} disabled={Boolean(busy)}>{busy === 'delete' ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}</button>
  </div>;
}

function AppIcon({ logoUrl, size = 34 }: { logoUrl?: string | null; size?: number }) {
  return logoUrl
    ? <img src={logoUrl} alt="" width={size} height={size} />
    : <Server size={size} strokeWidth={1.6} />;
}

function CreateAppDialog({ apps, appLogos, selectedAppId, busy, onSelect, onCancel, onConfirm }: { apps: PortalAppCatalogItem[]; appLogos: Readonly<Record<string, string>>; selectedAppId: string; busy: boolean; onSelect: (appId: string) => void; onCancel: () => void; onConfirm: () => void }) {
  const selected = apps.find((item) => item.app.id === selectedAppId) ?? apps[0];
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="create-app-title">
      <div className="dialog-heading"><h2 id="create-app-title">选择应用</h2><button className="icon-button" title="关闭" aria-label="关闭" onClick={onCancel} disabled={busy}><X size={18} /></button></div>
      <div className="app-picker" role="radiogroup" aria-label="可创建的应用">
        {apps.map((item) => {
          const selectedItem = item.app.id === selected?.app.id;
          return <button type="button" role="radio" aria-checked={selectedItem} className={`app-picker-item${selectedItem ? ' selected' : ''}`} onClick={() => onSelect(item.app.id)} disabled={busy} key={item.app.id}>
            <span className="app-picker-icon"><AppIcon logoUrl={appLogos[item.app.id]} /></span>
            <strong>{item.app.name}</strong>
          </button>;
        })}
      </div>
      <div className="dialog-actions"><button className="secondary" onClick={onCancel} disabled={busy}>取消</button><button className="primary" onClick={onConfirm} disabled={busy || !selected}>{busy ? <LoaderCircle className="spin" size={17} /> : <Container size={17} />}创建</button></div>
    </section>
  </div>;
}

function catalogError(reason: unknown): string {
  if (!(reason instanceof ApiError)) return reason instanceof Error ? reason.message : '请求失败';
  if (reason.code === 'runtime_image_contract_unsupported') return '当前运行环境不支持已有 App 的运行契约，可能未加载对应的应用适配器（Adapter）。请联系管理员检查适配器配置；已有实例记录仍保留。';
  if (reason.code === 'control_plane_only_operation_unavailable') return '当前为仅控制面模式，暂不支持创建、启动、停止或进入 App。请联系管理员加载对应的应用适配器并启用应用运行功能。';
  if (reason.code === 'app_version_not_ready' || reason.code === 'app_not_available') return '该 App 当前没有可启动镜像，请联系管理员。';
  if (reason.code === 'unsupported_app_auth') return '该 App 的登录适配器尚未配置。';
  if (reason.code === 'app_auth_reauthentication_required') return '当前 SSO 会话不属于该 App，请退出后重新登录再创建。';
  return reason.code;
}

export default function UserDashboard() {
  const [catalog, setCatalog] = useState<PortalAppCatalogItem[]>([]);
  const [containers, setContainers] = useState<PortalContainer[]>([]);
  const [appLogos, setAppLogos] = useState<Record<string, string>>({});
  const [selectedAppId, setSelectedAppId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [ensureReason, setEnsureReason] = useState('');
  const initialLoadStarted = useRef(false);
  const selectedApp = useMemo(() => catalog.find((item) => item.app.id === selectedAppId) ?? catalog[0] ?? null, [catalog, selectedAppId]);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setEnsureReason('');
    const [catalogResult, containersResult, manifestResult] = await Promise.allSettled([api.apps(), api.containers(), api.entryManifest()]);
    if (manifestResult.status === 'fulfilled') {
      setAppLogos((current) => ({ ...current, [manifestResult.value.appId]: manifestResult.value.entry.logoUrl }));
    }
    if (catalogResult.status === 'fulfilled') {
      const nextCatalog = catalogResult.value.apps.filter((item) => item.versions.length > 0);
      setCatalog(nextCatalog);
      setSelectedAppId((current) => nextCatalog.some((item) => item.app.id === current) ? current : nextCatalog[0]?.app.id ?? '');
    } else {
      setCatalog([]);
      setError(catalogError(catalogResult.reason));
    }
    try {
      if (containersResult.status === 'rejected') throw containersResult.reason;
      const current = containersResult.value.containers;
      if (current.length > 0) { setContainers(current); return; }
      try {
        const ensured = await api.ensureDefaultContainer();
        if (ensured.container) setContainers([ensured.container]);
        else { setContainers([]); setEnsureReason(normalizeEnsureReason(ensured.reason ?? '')); }
      } catch (reason) {
        if (reason instanceof ApiError && ['disabled', 'already_initialized', 'limit', 'auto_create_disabled', 'total_limit_reached', 'running_limit_reached', 'instance_limit_reached', 'running_instance_limit_reached'].includes(reason.code)) { setContainers([]); setEnsureReason(normalizeEnsureReason(reason.code)); }
        else throw reason;
      }
    } catch (reason) {
      setError(catalogError(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (initialLoadStarted.current) return; initialLoadStarted.current = true; void load(); }, [load]);

  async function create(): Promise<void> {
    if (!selectedApp) return;
    setBusy({ create: 'create' }); setError('');
    try {
      const { container } = await api.createContainer(selectedApp.app.id);
      setContainers((current) => [container, ...current.filter((item) => item.id !== container.id)]);
      setCreateOpen(false);
    } catch (reason) {
      if (reason instanceof ApiError && isCapacityReason(normalizeEnsureReason(reason.code))) setEnsureReason(normalizeEnsureReason(reason.code));
      else setError(catalogError(reason));
    } finally { setBusy({}); }
  }

  async function action(container: PortalContainer, value: 'start' | 'stop'): Promise<void> {
    setBusy({ [container.id]: value }); setError('');
    try {
      const result = await api.containerAction(container.id, value);
      if ('container' in result) {
        setContainers((current) => current.map((item) => item.id === result.container.id ? result.container : item));
      } else {
        if (result.status === 'needs_attention' || result.itemStatus === 'needs_attention') {
          setError(recoveryMessage(result));
          return;
        }
        setError(recoveryMessage(result));
        if (await waitForRecovery(container.id)) setError('');
        else setError('实例恢复仍未完成，请稍后重试或联系管理员。');
      }
    }
    catch (reason) { setError(catalogError(reason)); }
    finally { setBusy({}); }
  }

  async function enter(container: PortalContainer): Promise<void> {
    setBusy({ [container.id]: 'enter' }); setError('');
    try {
      const result = await api.enter(container.id);
      if ('url' in result) {
        window.location.assign(result.url);
        return;
      }
      if (result.status === 'needs_attention' || result.itemStatus === 'needs_attention') {
        setError('实例恢复已达到自动重试上限，请联系管理员排查。');
        return;
      }
      setError('实例异常，已提交后台恢复任务；恢复完成后可再次进入。');
      const recovered = await waitForRecovery(container.id);
      if (!recovered) {
        setError('实例恢复仍未完成，请稍后重试或联系管理员。');
        return;
      }
      const ready = await api.enter(container.id);
      if ('url' in ready) window.location.assign(ready.url);
      else setError('实例已恢复，正在等待入口刷新，请稍后重试。');
    }
    catch (reason) { setError(catalogError(reason)); }
    finally { setBusy({}); }
  }

  async function waitForRecovery(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < 45; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      try {
        const recovery = await api.recovery(id);
        if (['needs_attention', 'failed', 'cancelled'].includes(recovery.itemStatus)
          || ['partial_failed', 'cancelled', 'needs_attention'].includes(recovery.status)) return false;
        const result = await api.containers();
        setContainers(result.containers);
        const current = result.containers.find((item) => item.id === id);
        if (current?.status === 'running' || recovery.itemStatus === 'succeeded') return true;
      } catch {
        // A transient refresh failure should not cancel the durable recovery task.
      }
    }
    return false;
  }

  async function remove(container: PortalContainer): Promise<void> {
    if (!window.confirm('确定删除这个容器吗？历史记录、已安装 App 和工作文件都会永久删除。')) return;
    setBusy({ [container.id]: 'delete' }); setError('');
    try { await api.deleteContainer(container.id); setContainers((current) => current.filter((item) => item.id !== container.id)); setEnsureReason('already_initialized'); }
    catch (reason) { setError(catalogError(reason)); }
    finally { setBusy({}); }
  }

  const creationBlocked = isCapacityReason(ensureReason);
  const ensureMessage = ensureReason === 'disabled' || ensureReason === 'auto_create_disabled' ? '管理员已关闭首次进入自动创建，你仍可手动创建 App。' : ensureReason === 'already_initialized' ? '此账号已完成过首次初始化；删除 App 后不会自动重建，你仍可手动创建。' : creationBlocked ? '当前实例容量已达到管理员设置的上限，请稍后重试或联系管理员。' : '';
  const canCreate = catalog.length > 0 && containers.length === 0 && !creationBlocked;

  return <section className="page"><div className="page-title"><div><p className="eyebrow">我的 App</p><h1>OpenApp</h1><p>管理属于你的独立 App 运行环境。</p></div><button className="primary" onClick={() => setCreateOpen(true)} disabled={!canCreate}><Container size={17} />{containers.length > 0 ? '已创建 App' : creationBlocked ? '容量已满' : catalog.length === 0 ? '暂无可用 App' : '创建 App'}</button></div>{error && <ErrorNotice message={error} />}{!loading && ensureMessage && (creationBlocked ? <ErrorNotice message={ensureMessage} /> : <InfoNotice message={ensureMessage} />)}{!loading && containers.length > 0 && <InfoNotice message="每个账号只能创建一个 App；停止后可以重新启动原环境。" />}{loading ? <div className="center-state"><LoaderCircle className="spin" /><p>正在检查可用 App</p></div> : containers.length === 0 ? <div className="empty"><div className="empty-icon"><Server /></div><h2>{creationBlocked ? '暂时无法创建 App' : catalog.length === 0 ? '暂无可用 App' : '还没有 App'}</h2><p>{creationBlocked ? '管理员设置的实例容量已满。' : catalog.length === 0 ? '管理员尚未设置可用镜像。' : '从 App 目录选择并创建你的第一个独立环境。'}</p>{canCreate && <button className="primary" onClick={() => setCreateOpen(true)}><Container size={17} />创建 App</button>}</div> : <div className="container-grid">{containers.map((container) => { const fallbackApp = catalog.find((item) => item.app.id === container.appId); const stoppedMessage = stopReasonLabel(container); return <article className="container-card" key={container.id}><div className="card-top"><div className="server-icon app-logo"><AppIcon logoUrl={appLogos[container.appId]} size={20} /></div><Status status={container.status} /></div><h2>{container.appName ?? fallbackApp?.app.name ?? container.appId}</h2><p className="mono">{container.id}</p><p className="container-version">{container.appRevision ? `镜像修订 #${container.appRevision}` : '兼容实例 · 镜像快照已固定'}</p>{stoppedMessage && <p className="container-stop-reason">{stoppedMessage}</p>}<dl><div><dt>创建时间</dt><dd>{new Date(container.createdAt).toLocaleString('zh-CN')}</dd></div><div><dt>最近更新</dt><dd>{new Date(container.updatedAt).toLocaleString('zh-CN')}</dd></div></dl><ContainerActions container={container} busy={busy[container.id] ?? null} onAction={(value) => void action(container, value)} onEnter={() => void enter(container)} onDelete={() => void remove(container)} /></article>; })}</div>}{createOpen && <CreateAppDialog apps={catalog} appLogos={appLogos} selectedAppId={selectedApp?.app.id ?? ''} busy={busy.create === 'create'} onSelect={setSelectedAppId} onCancel={() => setCreateOpen(false)} onConfirm={() => void create()} />}</section>;
}

function recoveryMessage(result: RecoveryPending): string {
  return result.status === 'needs_attention' || result.itemStatus === 'needs_attention'
    ? '实例恢复已达到自动重试上限，请联系管理员排查。'
    : '实例异常，已提交后台恢复任务；恢复完成后可再次启动。';
}
