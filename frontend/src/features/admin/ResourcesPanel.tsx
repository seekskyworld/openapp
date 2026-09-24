import { useMemo, useState } from 'react';
import { Activity, CircleArrowUp, KeyRound, LoaderCircle, Play, RefreshCw, Square, Trash2, UserPlus, X } from 'lucide-react';
import { adminApi, type AdminInstanceMetrics } from '../../admin-api';
import type { AdminContainerBatchAction, PortalContainer, PortalUser, UserRole } from '../../api';
import { canGovernUserRole, userRoleLabel } from '../../user-role';
import type { AdminTask, UserRoleUpdateResult } from './useAdminWorkspace';
import { EmptyRow, PaginationBar, Status, message, paginateItems, usePersistentPageSize } from './shared';

interface ResourcesPanelProps {
  currentUser: PortalUser;
  users: PortalUser[];
  containers: PortalContainer[];
  busy: Record<string, boolean>;
  error: string;
  onCreateUser: (email: string, password: string, role: UserRole) => Promise<boolean>;
  onRole: (user: PortalUser, role: UserRole, password?: string) => Promise<UserRoleUpdateResult>;
  onContainer: (container: PortalContainer, action: 'start' | 'stop' | 'rebuild' | 'rebuild-latest' | 'delete') => Promise<void>;
  onBatch: (ids: string[], action: AdminContainerBatchAction) => Promise<AdminTask | null>;
  onOpenOperations: () => void;
}

function CreateUserDialog({ busy, canChooseRole, serverError, onClose, onCreate }: {
  busy: boolean;
  canChooseRole: boolean;
  serverError: string;
  onClose: () => void;
  onCreate: ResourcesPanelProps['onCreateUser'];
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [validation, setValidation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const passwordLongEnough = Array.from(password).length >= 12;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizedEmail)) {
      setValidation('请输入有效的用户邮箱地址。');
      return;
    }
    if (!passwordLongEnough) {
      setValidation('初始密码至少需要 12 个字符。');
      return;
    }
    setValidation('');
    setSubmitted(true);
    if (await onCreate(normalizedEmail, password, role)) onClose();
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <section className="dialog create-user-dialog" role="dialog" aria-modal="true" aria-labelledby="create-user-title">
      <div className="dialog-heading"><div><p className="eyebrow">账号管理</p><h2 id="create-user-title">创建用户</h2></div><button type="button" className="icon-button" title="关闭" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      <form className="create-user-form" onSubmit={(event) => void submit(event)}>
        <label>邮箱地址<input type="email" value={email} onChange={(event) => { setEmail(event.target.value); setValidation(''); }} placeholder="name@example.com" autoComplete="email" disabled={busy} required /></label>
        <label>初始密码<input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setValidation(''); }} placeholder="至少 12 个字符" autoComplete="new-password" disabled={busy} required /></label>
        {canChooseRole
          ? <label>账号角色<select value={role} onChange={(event) => setRole(event.target.value as UserRole)} disabled={busy}><option value="user">成员</option><option value="admin">管理员</option><option value="super_admin">超级管理员</option></select></label>
          : <label>账号角色<strong className="fixed-role">成员</strong></label>}
        {(validation || (submitted && serverError)) && <div className="notice error" role="alert">{validation || serverError}</div>}
        <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy || !email.trim() || !passwordLongEnough}>{busy ? <LoaderCircle className="spin" size={16} /> : <UserPlus size={16} />}{busy ? '正在创建' : '创建用户'}</button></div>
      </form>
    </section>
  </div>;
}

function ManagementPasswordDialog({ user, role, busy, serverError, onCancel, onComplete, onSubmit }: {
  user: PortalUser;
  role: 'admin' | 'super_admin';
  busy: boolean;
  serverError: string;
  onCancel: () => void;
  onComplete: () => void;
  onSubmit: (password: string) => Promise<UserRoleUpdateResult>;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [validation, setValidation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const passwordLongEnough = Array.from(password).length >= 12;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!passwordLongEnough) {
      setValidation('初始密码至少需要 12 个字符。');
      return;
    }
    if (password !== confirmation) {
      setValidation('两次输入的密码不一致。');
      return;
    }
    setValidation('');
    setSubmitted(true);
    if (await onSubmit(password) === 'updated') onComplete();
  }

  function changePassword(value: string, confirm = false): void {
    if (confirm) setConfirmation(value);
    else setPassword(value);
    setValidation('');
    setSubmitted(false);
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
    <section className="dialog create-user-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-password-title" aria-describedby="admin-password-description">
      <div className="dialog-heading"><div><p className="eyebrow">账号管理</p><h2 id="admin-password-title">设置管理账号密码</h2></div><button type="button" className="icon-button" title="取消设置" disabled={busy} onClick={onCancel}><X size={18} /></button></div>
      <p id="admin-password-description">{user.email} 尚未设置本地密码。设置后将立即提升为{userRoleLabel(role)}。</p>
      <form className="create-user-form" onSubmit={(event) => void submit(event)}>
        <label>初始密码<input type="password" value={password} onChange={(event) => changePassword(event.target.value)} placeholder="至少 12 个字符" autoComplete="new-password" disabled={busy} required autoFocus /></label>
        <label>确认密码<input type="password" value={confirmation} onChange={(event) => changePassword(event.target.value, true)} placeholder="再次输入密码" autoComplete="new-password" disabled={busy} required /></label>
        {(validation || (submitted && serverError)) && <div className="notice error" role="alert">{validation || serverError}</div>}
        <div className="dialog-actions"><button type="button" className="secondary" onClick={onCancel} disabled={busy}>取消</button><button className="primary" disabled={busy || !password || !confirmation}>{busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}{busy ? '正在设置' : `设置并设为${userRoleLabel(role)}`}</button></div>
      </form>
    </section>
  </div>;
}

export default function ResourcesPanel({ currentUser, users, containers, busy, error, onCreateUser, onRole, onContainer, onBatch, onOpenOperations }: ResourcesPanelProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingRoleChange, setPendingRoleChange] = useState<{ user: PortalUser; role: 'admin' | 'super_admin' } | null>(null);
  const [roleNotice, setRoleNotice] = useState('');
  const [userQuery, setUserQuery] = useState('');
  const [userPage, setUserPage] = useState(1);
  const [userPageSize, setUserPageSize] = usePersistentPageSize('users');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | PortalContainer['status']>('all');
  const [containerPage, setContainerPage] = useState(1);
  const [containerPageSize, setContainerPageSize] = usePersistentPageSize('containers');
  const [metrics, setMetrics] = useState<AdminInstanceMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submittedBatch, setSubmittedBatch] = useState<{ count: number; taskIds: string[] } | null>(null);
  const userById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const filteredUsers = useMemo(() => {
    const normalized = userQuery.trim().toLowerCase();
    return normalized ? users.filter((user) => [user.id, user.email, user.name].filter(Boolean).some((value) => value!.toLowerCase().includes(normalized))) : users;
  }, [userQuery, users]);
  const visibleUsers = paginateItems(filteredUsers, userPage, userPageSize);
  const filteredContainers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return containers.filter((container) => {
      if (statusFilter !== 'all' && container.status !== statusFilter) return false;
      if (!normalized) return true;
      const owner = userById.get(container.ownerId);
      return [container.id, container.appId, container.ownerId, owner?.email, owner?.name]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(normalized));
    });
  }, [containers, query, statusFilter, userById]);
  const visibleContainers = paginateItems(filteredContainers, containerPage, containerPageSize);
  const selectedVisible = visibleContainers.filter((container) => selectedIds.has(container.id));
  const allVisibleSelected = visibleContainers.length > 0 && selectedVisible.length === visibleContainers.length;
  function toggleSelected(id: string): void {
    setSelectedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  async function batch(action: AdminContainerBatchAction): Promise<void> {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const taskCount = Math.ceil(ids.length / 100);
    const question = action === 'rebuild-latest'
      ? `将已选的 ${ids.length} 个实例升级到各自 App 当前镜像并重建？`
      : action === 'rebuild'
        ? `按原有镜像和当前资源策略重建已选的 ${ids.length} 个实例？`
        : `${action === 'start' ? '启动' : '停止'}已选的 ${ids.length} 个实例？`;
    const impact = action === 'rebuild' || action === 'rebuild-latest'
      ? '实例会短暂中断，持久数据卷（Volume）会保留。'
      : '';
    if (!window.confirm(`${question}${impact}${taskCount > 1 ? `系统会拆分为 ${taskCount} 个后台任务。` : ''}`)) return;
    const submittedIds: string[] = [];
    const taskIds: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      const task = await onBatch(chunk, action);
      if (!task) {
        setSelectedIds((current) => {
          const next = new Set(current);
          submittedIds.forEach((id) => next.delete(id));
          return next;
        });
        if (taskIds.length > 0) setSubmittedBatch({ count: submittedIds.length, taskIds });
        return;
      }
      submittedIds.push(...chunk);
      taskIds.push(task.id);
    }
    setSelectedIds(new Set());
    setSubmittedBatch({ count: submittedIds.length, taskIds });
  }
  async function inspect(container: PortalContainer): Promise<void> {
    setMetricsLoading(true); setMetricsError('');
    try { setMetrics(await adminApi.instanceMetrics(container.id)); }
    catch (reason) { setMetricsError(message(reason, '实例监测加载失败')); }
    finally { setMetricsLoading(false); }
  }
  async function changeRole(user: PortalUser, role: UserRole): Promise<void> {
    setRoleNotice('');
    if (await onRole(user, role) === 'local_credential_setup_required' && role !== 'user') {
      setPendingRoleChange({ user, role });
    }
  }
  function cancelRolePassword(): void {
    setPendingRoleChange(null);
    setRoleNotice('未设置密码，管理角色调整未完成。');
  }
  return <div className="admin-section admin-stack">
    <section>
      <div className="section-heading"><div><h2>用户</h2><p>{currentUser.role === 'super_admin' ? '创建本地账号并管理账号角色。' : '创建本地成员账号并查看账号角色。'}</p></div><div className="section-commands"><span>{users.length} 个账号</span><button className="primary" onClick={() => setCreateOpen(true)}><UserPlus size={16} />创建用户</button></div></div>
      {roleNotice && <div className="notice info" role="status">{roleNotice}</div>}
      <div className="resource-filters"><label>搜索<input value={userQuery} onChange={(event) => { setUserQuery(event.target.value); setUserPage(1); }} placeholder="邮箱、名称、用户 ID" /></label></div>
      <div className="table-wrap"><table><thead><tr><th>账号</th><th>角色</th><th>创建时间</th></tr></thead><tbody>{visibleUsers.length === 0 ? <EmptyRow columns={3} text={users.length === 0 ? '暂无用户' : '没有匹配的用户'} /> : visibleUsers.map((user) => <tr key={user.id}><td><strong>{user.name ?? user.email}</strong><small>{user.email}</small></td><td>{canGovernUserRole(currentUser, user) ? <select value={user.role} disabled={Boolean(busy[`user:${user.id}`])} onChange={(event) => void changeRole(user, event.target.value as UserRole)}><option value="user">成员</option><option value="admin">管理员</option><option value="super_admin">超级管理员</option></select> : <span className={`role-badge ${user.role}`}>{userRoleLabel(user.role)}</span>}</td><td>{user.createdAt ? new Date(user.createdAt).toLocaleString('zh-CN') : '-'}</td></tr>)}</tbody></table></div>
      <PaginationBar page={userPage} total={filteredUsers.length} pageSize={userPageSize} onPage={setUserPage} onPageSize={(value) => { setUserPageSize(value); setUserPage(1); }} />
    </section>
    <section>
      <div className="section-heading"><div><h2>实例</h2><p>查看所有用户实例并执行启停、镜像升级或删除操作。</p></div><div className="section-commands"><span>{selectedIds.size ? `已选 ${selectedIds.size}` : `${filteredContainers.length}/${containers.length} 个实例`}</span>{selectedIds.size > 0 && <><button className="secondary compact" disabled={Boolean(busy.batch)} onClick={() => void batch('start')}><Play size={14} />批量启动</button><button className="secondary compact" disabled={Boolean(busy.batch)} onClick={() => void batch('stop')}><Square size={14} />批量停止</button><button className="secondary compact" disabled={Boolean(busy.batch)} onClick={() => void batch('rebuild')}><RefreshCw size={14} />批量重建</button><button className="secondary compact" disabled={Boolean(busy.batch)} onClick={() => void batch('rebuild-latest')}><CircleArrowUp size={14} />批量升级到当前镜像</button></>}</div></div>
      {submittedBatch && <div className="notice info batch-operation-notice" role="status"><span>已提交 {submittedBatch.count} 个实例，共 {submittedBatch.taskIds.length} 个后台任务。</span><button className="secondary compact" onClick={onOpenOperations}>查看进度</button></div>}
      <div className="resource-filters"><label>搜索<input value={query} onChange={(event) => { setQuery(event.target.value); setContainerPage(1); }} placeholder="邮箱、实例 ID、App" /></label><label>状态<select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as typeof statusFilter); setContainerPage(1); }}><option value="all">全部状态</option><option value="running">运行中</option><option value="stopped">已停止</option><option value="creating">创建中</option><option value="failed">异常</option></select></label></div>
      <div className="table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="选择当前列表中的全部实例" checked={allVisibleSelected} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (allVisibleSelected) visibleContainers.forEach((item) => next.delete(item.id)); else visibleContainers.forEach((item) => next.add(item.id)); return next; })} /></th><th>所有者</th><th>实例 ID</th><th>App / 版本</th><th>状态</th><th>最近活动</th><th>监测</th><th>最近更新</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{visibleContainers.length === 0 ? <EmptyRow columns={9} text={containers.length === 0 ? '暂无实例' : '没有匹配的实例'} /> : visibleContainers.map((container) => <tr key={container.id}><td><input type="checkbox" aria-label={`选择实例 ${container.id}`} checked={selectedIds.has(container.id)} onChange={() => toggleSelected(container.id)} /></td><td><strong>{userById.get(container.ownerId)?.name ?? userById.get(container.ownerId)?.email ?? container.ownerId}</strong><small>{userById.get(container.ownerId)?.email}</small></td><td className="mono"><button className="link-button" onClick={() => void inspect(container)} title="查看实例监测">{container.id}</button></td><td><strong>{container.appId}</strong><small className="mono">{container.appVersionId ?? '兼容快照'}</small></td><td><Status status={container.status} /></td><td>{container.lastActivityAt ? new Date(container.lastActivityAt).toLocaleString('zh-CN') : '-'}</td><td>{container.status !== 'running' ? <span className="monitor-stopped">未运行</span> : container.metricsCapabilityStatus === 'unsupported' ? <span className="monitor-stopped">不支持指标</span> : container.lastError ? <span className="monitor-error" title={container.lastError}>采样失败</span> : container.stale ? <span className="monitor-stale">数据过期</span> : <span className="monitor-ok">正常</span>}</td><td>{new Date(container.updatedAt).toLocaleString('zh-CN')}</td><td className="row-actions"><div>{container.status === 'running' ? <button className="secondary compact" disabled={Boolean(busy[`container:${container.id}`])} onClick={() => void onContainer(container, 'stop')}><Square size={14} />停止</button> : <button className="secondary compact" disabled={Boolean(busy[`container:${container.id}`]) || ['creating', 'starting', 'stopping'].includes(container.status)} onClick={() => void onContainer(container, 'start')}><Play size={14} />启动</button>}<button className="icon-button compact" title="按原有镜像重建" aria-label="按原有镜像重建" disabled={Boolean(busy[`container:${container.id}`])} onClick={() => void onContainer(container, 'rebuild')}><RefreshCw size={14} /></button><button className="secondary compact" title="升级到 App 当前镜像" disabled={Boolean(busy[`container:${container.id}`])} onClick={() => void onContainer(container, 'rebuild-latest')}><CircleArrowUp size={14} />升级到当前镜像</button><button className="danger-icon" title="删除实例" aria-label="删除实例" disabled={Boolean(busy[`container:${container.id}`])} onClick={() => void onContainer(container, 'delete')}><Trash2 size={14} /></button></div></td></tr>)}</tbody></table></div>
      <PaginationBar page={containerPage} total={filteredContainers.length} pageSize={containerPageSize} onPage={setContainerPage} onPageSize={(value) => { setContainerPageSize(value); setContainerPage(1); }} />
    </section>
    {createOpen && <CreateUserDialog busy={Boolean(busy.createUser)} canChooseRole={currentUser.role === 'super_admin'} serverError={error} onClose={() => setCreateOpen(false)} onCreate={onCreateUser} />}
    {pendingRoleChange && <ManagementPasswordDialog
      user={pendingRoleChange.user}
      role={pendingRoleChange.role}
      busy={Boolean(busy[`user:${pendingRoleChange.user.id}`])}
      serverError={error}
      onCancel={cancelRolePassword}
      onComplete={() => { setPendingRoleChange(null); setRoleNotice(''); }}
      onSubmit={(password) => onRole(pendingRoleChange.user, pendingRoleChange.role, password)}
    />}
    {metrics && <MetricsDialog metrics={metrics} loading={metricsLoading} error={metricsError} onClose={() => setMetrics(null)} />}
    {!metrics && metricsError && <div className="notice error" role="alert">{metricsError}</div>}
    {!metrics && metricsLoading && <div className="dialog-backdrop"><section className="dialog center-state metrics-loading"><LoaderCircle className="spin" /><p>正在加载实例监测</p></section></div>}
  </div>;
}


function MetricsDialog({ metrics, loading, error, onClose }: { metrics: AdminInstanceMetrics; loading: boolean; error: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistentPageSize('instance-metrics-history');
  const latest = metrics.latest;
  const bytes = (value: number | null | undefined) => value === null || value === undefined ? '-' : `${(value / 1024 ** 2).toFixed(2)} MB`;
  const visibleSamples = paginateItems(metrics.samples, page, pageSize);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog metrics-dialog" role="dialog" aria-modal="true"><div className="dialog-heading"><div><p className="eyebrow">实例监测</p><h2><Activity size={18} />{metrics.instance.id}</h2></div><button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></div>{error && <div className="notice error">{error}</div>}<div className="metrics-cards"><span>CPU <b>{latest?.cpuPercent == null ? '-' : `${latest.cpuPercent.toFixed(1)}%`}</b></span><span>内存 <b>{bytes(latest?.memoryWorkingSetBytes)}</b></span><span>网络 <b>{bytes(latest?.networkRxBytes)} / {bytes(latest?.networkTxBytes)}</b></span><span>进程 <b>{latest?.pids ?? '-'}</b></span><span>GPU <b>{latest?.gpuUtilizationPercent == null ? '-' : `${latest.gpuUtilizationPercent.toFixed(1)}%`}</b></span></div><p className="metrics-freshness">{metrics.instance.status !== 'running' ? '实例未运行' : metrics.stale ? '监测数据已过期' : `最近采样 ${latest ? new Date(latest.sampledAt).toLocaleString('zh-CN') : '-'}`}{loading ? ' · 更新中' : ''}</p><div className="table-wrap metrics-history"><table><thead><tr><th>采样时间</th><th>状态</th><th>CPU</th><th>内存</th></tr></thead><tbody>{visibleSamples.map((sample) => <tr key={sample.sampledAt}><td>{new Date(sample.sampledAt).toLocaleTimeString('zh-CN')}</td><td>{sample.state}</td><td>{sample.cpuPercent == null ? '-' : `${sample.cpuPercent.toFixed(1)}%`}</td><td>{bytes(sample.memoryWorkingSetBytes)}</td></tr>)}</tbody></table></div><PaginationBar page={page} total={metrics.samples.length} pageSize={pageSize} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} /></section></div>;
}
