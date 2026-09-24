import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, History, LoaderCircle, RefreshCw, RotateCcw, Settings2 } from 'lucide-react';
import { adminApi, type ConfigEffect, type ConfigRevision, type ConfigRevisionSnapshot, type InstancePolicy } from '../../admin-api';
import { PaginationBar, message, paginateItems, usePersistentPageSize } from './shared';

const TOTAL_INSTANCE_RECOMMENDATIONS = [10, 20, 50, 100, 200];
const RUNNING_INSTANCE_RECOMMENDATIONS = [5, 10, 20, 50, 100];
const MEMORY_RECOMMENDATIONS = [1, 2, 4, 8, 16, 32];
const CPU_RECOMMENDATIONS = [0.5, 1, 2, 4, 8, 16];
const PID_RECOMMENDATIONS = [128, 256, 512, 1024, 2048];

interface PolicyPanelProps {
  policy: InstancePolicy;
  apps: string[];
  revision: ConfigRevision | null;
  containerCount: number;
  busy: boolean;
  onSaved: (value: InstancePolicy, revision?: ConfigRevision | null) => void;
  setBusy: (value: Record<string, boolean>) => void;
  setError: (value: string) => void;
  setNotice: (value: string) => void;
}

interface RecommendationInputProps {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  suffix?: string;
}

function RecommendationInput({ label, value, options, onChange, suffix }: RecommendationInputProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        input.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="recommendation-field" ref={root}>
      <label htmlFor={`${id}-input`}>{label}</label>
      <div className={`recommendation-control${open ? ' open' : ''}`}>
        <input
          id={`${id}-input`}
          ref={input}
          type="text"
          inputMode="decimal"
          value={value}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="none"
          aria-controls={`${id}-options`}
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen(true)}
          onKeyDown={(event) => { if (event.key === 'ArrowDown') setOpen(true); }}
          onChange={(event) => { onChange(event.target.value); setOpen(true); }}
        />
        <button type="button" title="选择推荐值" aria-label={`选择${label}推荐值`} aria-expanded={open} onClick={() => { setOpen((current) => !current); input.current?.focus(); }}>
          <ChevronDown size={18} />
        </button>
        {open && (
          <div className="recommendation-menu" id={`${id}-options`} role="listbox">
            {options.length > 0 ? options.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option === value}
                className={option === value ? 'selected' : ''}
                key={option}
                onClick={() => { onChange(option); setOpen(false); input.current?.focus(); }}
              >
                <span>{option}{suffix ? <small>{suffix}</small> : null}</span>
                {option === value ? <Check size={16} /> : null}
              </button>
            )) : <p>暂无可用推荐值</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function memoryGigabytes(value: string): string {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([bkmg]?)$/iu);
  if (!match) return value;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? '';
  const bytes = amount * ({ '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[unit] ?? 1);
  return String(Number((bytes / 1024 ** 3).toFixed(3)));
}

export default function PolicyPanel({ policy, apps, revision, containerCount, busy, onSaved, setBusy, setError, setNotice }: PolicyPanelProps) {
  const formRevision = useRef(revision?.revision);
  const [draft, setDraft] = useState(policy);
  const [maxTotalInstances, setMaxTotalInstances] = useState(String(policy.maxTotalInstances));
  const [maxRunningInstances, setMaxRunningInstances] = useState(String(policy.maxRunningInstances));
  const [memory, setMemory] = useState(memoryGigabytes(policy.resources.memory));
  const [pidsLimit, setPidsLimit] = useState(String(policy.resources.pidsLimit));
  const [environmentJson, setEnvironmentJson] = useState(JSON.stringify(policy.environment, null, 2));
  const [configFilesJson, setConfigFilesJson] = useState(JSON.stringify(policy.configFiles, null, 2));
  const [validation, setValidation] = useState('');
  const [history, setHistory] = useState<ConfigRevisionSnapshot<InstancePolicy>[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = usePersistentPageSize('instance-policy-history');
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [rollbackRevision, setRollbackRevision] = useState<number | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [remoteRevision, setRemoteRevision] = useState<number | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const historySequence = useRef(0);
  const filteredHistory = history.filter((item) => {
    const query = historyQuery.trim().toLowerCase();
    return !query || [String(item.revision), item.updatedBy, item.effect, policySnapshotSummary(item.payload)].some((value) => value.toLowerCase().includes(query));
  });
  const visibleHistory = paginateItems(filteredHistory, historyPage, historyPageSize);
  const loadHistory = useCallback(async () => {
    const sequence = ++historySequence.current;
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const result = await adminApi.instancePolicyHistory(50, controller.signal);
      if (!controller.signal.aborted && sequence === historySequence.current) setHistory(result.revisions);
    } catch (reason) {
      if (!controller.signal.aborted && sequence === historySequence.current) setHistoryError(message(reason, '策略历史加载失败'));
    } finally {
      if (sequence === historySequence.current) setHistoryLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadHistory();
    return () => historyRequest.current?.abort();
  }, [loadHistory, revision?.revision]);

  function loadPolicyIntoForm(value: InstancePolicy, baselineRevision = revision?.revision): void {
    formRevision.current = baselineRevision;
    setDraft(value);
    setMaxTotalInstances(String(value.maxTotalInstances));
    setMaxRunningInstances(String(value.maxRunningInstances));
    setMemory(memoryGigabytes(value.resources.memory));
    setPidsLimit(String(value.resources.pidsLimit));
    setEnvironmentJson(JSON.stringify(value.environment, null, 2));
    setConfigFilesJson(JSON.stringify(value.configFiles, null, 2));
    setDirty(false);
    setRemoteRevision(null);
  }
  useEffect(() => {
    if (formRevision.current === revision?.revision) return;
    if (dirty) {
      setRemoteRevision(revision?.revision ?? 0);
      return;
    }
    loadPolicyIntoForm(policy, revision?.revision);
  }, [dirty, policy, revision?.revision]);
  function parseStringMap(value: string, label: string): Record<string, string> { let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error(`${label}不是有效 JSON。`); } if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((item) => typeof item !== 'string')) throw new Error(`${label}必须是键和值均为字符串的 JSON 对象。`); return parsed as Record<string, string>; }
  async function save() {
    setValidation(''); setError(''); setNotice('');
    try {
      const totalInstances = Number(maxTotalInstances);
      const runningInstances = Number(maxRunningInstances);
      const processes = Number(pidsLimit);
      if (!draft.defaultAppId.trim()) throw new Error('默认 App 不能为空。');
      if (!Number.isInteger(totalInstances) || totalInstances < 1) throw new Error('总实例上限必须是大于 0 的整数。');
      if (!Number.isInteger(runningInstances) || runningInstances < 1 || runningInstances > totalInstances) throw new Error('运行上限必须是大于 0 且不超过总实例上限的整数。');
      if (!Number.isInteger(draft.idleStopMinutes) || draft.idleStopMinutes < 0) throw new Error('空闲停止分钟必须是非负整数。');
      if (!Number.isFinite(Number(memory)) || Number(memory) <= 0) throw new Error('内存限制必须是大于 0 的 GB 数字。');
      if (!Number.isFinite(Number(draft.resources.cpus)) || Number(draft.resources.cpus) <= 0) throw new Error('CPU 限制必须大于 0。');
      if (!Number.isInteger(processes) || processes < 32) throw new Error('进程数上限必须是至少 32 的整数。');
      const next = { ...draft, maxTotalInstances: totalInstances, maxRunningInstances: runningInstances, defaultAppId: draft.defaultAppId.trim(), resources: { ...draft.resources, memory: `${Number(memory)}g`, pidsLimit: processes }, environment: parseStringMap(environmentJson, '环境变量'), configFiles: parseStringMap(configFilesJson, '启动配置文件') };
      setBusy({ policy: true }); const { policy: updated, revision: updatedRevision, effect } = await adminApi.updateInstancePolicy(next, formRevision.current); onSaved(updated, updatedRevision); loadPolicyIntoForm(updated, updatedRevision?.revision); setNotice(`实例策略已保存（${effectLabel(effect)}）。`);
    } catch (reason) { setValidation(message(reason, '实例策略保存失败')); } finally { setBusy({ policy: false }); }
  }
  async function rollback(target: ConfigRevisionSnapshot<InstancePolicy>): Promise<void> {
    const discard = dirty ? '当前未保存草稿会被放弃。' : '';
    if (!window.confirm(`恢复 v${target.revision} 的策略内容？${discard}系统会保留现有历史并创建一个新版本。`)) return;
    setRollbackRevision(target.revision); setError(''); setNotice(''); setValidation('');
    try {
      const result = await adminApi.rollbackInstancePolicy(target.revision, revision?.revision);
      loadPolicyIntoForm(result.policy, result.revision.revision);
      onSaved(result.policy, result.revision);
      setNotice(`已将 v${result.rolledBackFrom} 的策略内容恢复为 v${result.revision.revision}（${effectLabel(result.effect)}）。`);
    } catch (reason) {
      setError(message(reason, '实例策略回滚失败'));
    } finally {
      setRollbackRevision(null);
    }
  }
  async function rebuildExisting(): Promise<void> {
    if (containerCount === 0) return;
    setRebuilding(true); setError(''); setNotice('');
    try {
      const { containers } = await adminApi.allContainers();
      if (containers.length === 0) {
        setNotice('当前没有需要重建的实例。');
        return;
      }
      if (!window.confirm(`创建应用资源策略任务批次，处理全部 ${containers.length} 个实例？已绑定的 App 版本和镜像会保留，任务会等待实例空闲，持久数据卷会保留。`)) return;
      const detail = await adminApi.createTaskBatch(
        containers.map((container) => container.id),
        'apply_resource_policy',
      );
      setNotice(`已创建 ${containers.length} 个实例的资源策略任务批次（${detail.rollout.id.slice(0, 8)}），可在“操作与审计”查看进度。`);
    } catch (reason) {
      setError(message(reason, '资源策略任务批次提交失败'));
    } finally {
      setRebuilding(false);
    }
  }
  return (
    <div className="admin-section policy-panel">
      <section>
        <div className="section-heading">
          <div><h2>创建与进入</h2><p>策略由服务端执行，前端不能绕过容量或运行限制。</p></div><div className="effect-badges"><span>立即生效</span>{revision && <span>v{revision.revision}</span>}{dirty && <span className="warning">未保存</span>}</div>
        </div>
        <div className="policy-grid">
          <label className="setting-toggle">
            <span><strong>首次进入自动创建</strong><small>无实例用户打开控制台时创建默认 App。</small></span>
            <span className="toggle"><input type="checkbox" checked={draft.autoCreateOnFirstVisit} onChange={(event) => { setDraft((current) => ({ ...current, autoCreateOnFirstVisit: event.target.checked })); setDirty(true); }} /><span /></span>
          </label>
          <label className="setting-toggle">
            <span><strong>进入时自动启动</strong><small>进入已停止实例前由服务端先启动。</small></span>
            <span className="toggle"><input type="checkbox" checked={draft.autoStartOnEnter} onChange={(event) => { setDraft((current) => ({ ...current, autoStartOnEnter: event.target.checked })); setDirty(true); }} /><span /></span>
          </label>
          <label className="setting-toggle">
            <span><strong>访问时自动唤醒</strong><small>空闲停止后，收到应用请求时自动恢复运行。</small></span>
            <span className="toggle"><input type="checkbox" checked={draft.autoWakeOnRequest} onChange={(event) => { setDraft((current) => ({ ...current, autoWakeOnRequest: event.target.checked })); setDirty(true); }} /><span /></span>
          </label>
          <label className="setting-toggle">
            <span><strong>手动停止后禁止自动唤醒</strong><small>用户或管理员主动停止后，只能明确点击启动。</small></span>
            <span className="toggle"><input type="checkbox" checked={draft.blockAutoWakeAfterManualStop} onChange={(event) => { setDraft((current) => ({ ...current, blockAutoWakeAfterManualStop: event.target.checked })); setDirty(true); }} /><span /></span>
          </label>
          <label>默认 App<select value={draft.defaultAppId} onChange={(event) => { setDraft((current) => ({ ...current, defaultAppId: event.target.value })); setDirty(true); }}>{apps.map((appId) => <option value={appId} key={appId}>{appId}</option>)}</select></label>
          <label>空闲停止（分钟）<input type="number" min={0} step={1} value={draft.idleStopMinutes} onChange={(event) => { setDraft((current) => ({ ...current, idleStopMinutes: Number(event.target.value) })); setDirty(true); }} /><small>填 0 表示不自动停止。</small></label>
          <label className="setting-toggle">
            <span><strong>检测网络活动</strong><small>容器产生明显收发流量时刷新空闲计时。</small></span>
            <span className="toggle"><input type="checkbox" checked={draft.detectNetworkActivity} onChange={(event) => { setDraft((current) => ({ ...current, detectNetworkActivity: event.target.checked })); setDirty(true); }} /><span /></span>
          </label>
          <label className="setting-toggle">
            <span><strong>检测计算资源活动</strong><small>CPU、内存工作集或进程数明显变化时刷新空闲计时。</small></span>
            <span className="toggle"><input type="checkbox" checked={draft.detectComputeActivity} onChange={(event) => { setDraft((current) => ({ ...current, detectComputeActivity: event.target.checked })); setDirty(true); }} /><span /></span>
          </label>
        </div>
      </section>
      <section>
        <div className="section-heading"><div><h2>总量限制</h2><p>控制整个 OpenApp 可创建和可同时运行的实例数量。</p></div><div className="effect-badges"><span>立即生效</span></div></div>
        <div className="policy-grid capacity-grid">
          <RecommendationInput label="总实例上限" value={maxTotalInstances} options={TOTAL_INSTANCE_RECOMMENDATIONS.map(String)} onChange={(value) => { setMaxTotalInstances(value); setDirty(true); }} />
          <RecommendationInput label="同时运行上限" value={maxRunningInstances} options={RUNNING_INSTANCE_RECOMMENDATIONS.filter((value) => value <= (Number(maxTotalInstances) || 0)).map(String)} onChange={(value) => { setMaxRunningInstances(value); setDirty(true); }} />
        </div>
      </section>
      <section>
        <div className="section-heading"><div><h2>单实例资源限制</h2><p>下列资源应用于每个实例；修改后需重建已有实例。</p></div><div className="effect-badges"><span className="warning">修改后需重建</span></div></div>
        <div className="policy-grid resource-limit-grid">
          <RecommendationInput label="内存（GB）" value={memory} options={MEMORY_RECOMMENDATIONS.map(String)} suffix=" GB" onChange={(value) => { setMemory(value); setDirty(true); }} />
          <RecommendationInput label="CPU" value={draft.resources.cpus} options={CPU_RECOMMENDATIONS.map(String)} onChange={(cpus) => { setDraft((current) => ({ ...current, resources: { ...current.resources, cpus } })); setDirty(true); }} />
          <RecommendationInput label="进程数上限" value={pidsLimit} options={PID_RECOMMENDATIONS.map(String)} onChange={(value) => { setPidsLimit(value); setDirty(true); }} />
        </div>
      </section>
      <section>
        <div className="section-heading"><div><h2>运行配置</h2><p>仅接受字符串映射；保存前会进行 JSON 结构校验。</p></div><div className="effect-badges"><span>仅新实例</span></div></div>
        <div className="json-grid">
          <label>环境变量 JSON<textarea rows={10} spellCheck={false} value={environmentJson} onChange={(event) => { setEnvironmentJson(event.target.value); setDirty(true); }} /></label>
          <label>启动配置文件 JSON<textarea rows={10} spellCheck={false} value={configFilesJson} onChange={(event) => { setConfigFilesJson(event.target.value); setDirty(true); }} /></label>
        </div>
      </section>
      {remoteRevision !== null && <div className="notice info draft-conflict" role="status"><span>服务端已有 v{remoteRevision}，当前未保存草稿已为你保留。</span><button className="secondary compact" onClick={() => loadPolicyIntoForm(policy, revision?.revision)}>放弃草稿并加载新版本</button></div>}
      {validation && <div className="notice error" role="alert">{validation}</div>}
      <div className="policy-save"><button className="primary" disabled={busy || rollbackRevision !== null || remoteRevision !== null || !dirty} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Settings2 size={16} />}保存实例策略</button></div>
      <section className="policy-apply-section">
        <div className="section-heading">
          <div><h2>应用到已有实例</h2><p>镜像版本、环境变量和启动配置只用于新实例；已有实例重建时保留其绑定的 App 版本和镜像，仅应用当前 CPU、内存和进程数限制。</p></div>
          <span>{containerCount} 个实例</span>
        </div>
        <div className="policy-apply-actions">
          <p>重建沿用每个用户的持久数据卷，并按当前 CPU、内存和进程数限制重新创建运行环境；已绑定的 App 版本、镜像和卷内启动配置不会改变。</p>
          <button className="secondary" disabled={rebuilding || busy || rollbackRevision !== null || containerCount === 0 || dirty || remoteRevision !== null} onClick={() => void rebuildExisting()}>
            {rebuilding ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
            {rebuilding ? '正在提交' : '按当前资源策略重建全部'}
          </button>
        </div>
      </section>
      <section className="policy-history-section">
        <div className="section-heading">
          <div><h2 className="icon-heading"><History size={17} />配置历史</h2><p>回滚会复制所选版本的内容并创建新版本，历史版本不会被覆盖。</p></div>
          <div className="section-commands"><label>搜索<input value={historyQuery} onChange={(event) => { setHistoryQuery(event.target.value); setHistoryPage(1); }} placeholder="版本、修改人或生效方式" /></label><button className="icon-button" title="刷新配置历史" aria-label="刷新配置历史" disabled={historyLoading} onClick={() => void loadHistory()}><RefreshCw className={historyLoading ? 'spin' : ''} size={16} /></button></div>
        </div>
        {historyError && <div className="notice error policy-history-error" role="alert">{historyError}</div>}
        {historyLoading && history.length === 0 ? (
          <div className="policy-history-loading"><LoaderCircle className="spin" size={18} /><span>正在加载配置历史</span></div>
        ) : history.length === 0 ? (
          <p className="policy-history-empty">尚无策略变更记录。</p>
        ) : (
          <div className="policy-history-table">
            <table>
              <thead><tr><th>版本</th><th>修改时间</th><th>生效方式</th><th>配置摘要</th><th><span className="sr-only">操作</span></th></tr></thead>
              <tbody>{visibleHistory.map((item) => {
                const current = item.revision === revision?.revision;
                return <tr key={item.revision}>
                  <td><strong>v{item.revision}</strong><small title={item.updatedBy}>{item.updatedBy === 'system' ? '系统' : item.updatedBy.slice(0, 8)}</small></td>
                  <td>{new Date(item.updatedAt).toLocaleString('zh-CN')}</td>
                  <td><span className={`revision-effect ${item.effect}`}>{effectLabel(item.effect)}</span></td>
                  <td className="policy-summary">{policySnapshotSummary(item.payload)}</td>
                  <td className="revision-action">{current ? <span className="current-revision">当前版本</span> : <button className="secondary compact" disabled={rollbackRevision !== null || busy} onClick={() => void rollback(item)}>{rollbackRevision === item.revision ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}恢复</button>}</td>
                </tr>;
              })}</tbody>
            </table>
            <PaginationBar page={historyPage} total={filteredHistory.length} pageSize={historyPageSize} onPage={setHistoryPage} onPageSize={(value) => { setHistoryPageSize(value); setHistoryPage(1); }} />
          </div>
        )}
      </section>
    </div>
  );
}

function effectLabel(effect: ConfigEffect | undefined): string {
  if (effect === 'rebuild') return '已有实例需重建';
  if (effect === 'new_instances') return '仅新实例生效';
  if (effect === 'restart') return '需要重启';
  return '立即生效';
}

function policySnapshotSummary(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '无可用快照';
  const snapshot = value as Record<string, unknown>;
  const resources = snapshot.resources && typeof snapshot.resources === 'object' && !Array.isArray(snapshot.resources)
    ? snapshot.resources as Record<string, unknown>
    : {};
  const app = typeof snapshot.defaultAppId === 'string' ? snapshot.defaultAppId : '-';
  const memory = typeof resources.memory === 'string' ? resources.memory : '-';
  const cpus = typeof resources.cpus === 'string' ? resources.cpus : '-';
  return `${app} · ${memory} / ${cpus} CPU`;
}
