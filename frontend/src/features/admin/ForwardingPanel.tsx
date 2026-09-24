import { useCallback, useEffect, useRef, useState } from 'react';
import { History, LoaderCircle, Network, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { adminApi, type ConfigRevisionSnapshot, type ForwardingPolicy, type ForwardingSnapshot } from '../../admin-api';
import { PaginationBar, message, paginateItems, usePersistentPageSize } from './shared';

interface ForwardingPanelProps {
  forwarding: ForwardingPolicy;
  busy: boolean;
  onSaved: (value: ForwardingPolicy) => void;
  setBusy: (value: Record<string, boolean>) => void;
  setError: (value: string) => void;
  setNotice: (value: string) => void;
}

export default function ForwardingPanel({ forwarding, busy, onSaved, setBusy, setError, setNotice }: ForwardingPanelProps) {
  const formRevision = useRef(forwarding.revision?.revision);
  const [enabled, setEnabled] = useState(forwarding.enabled);
  const [targetBaseUrl, setTargetBaseUrl] = useState(forwarding.targetBaseUrl);
  const [hosts, setHosts] = useState(forwarding.allowedHosts.join('\n'));
  const [dirty, setDirty] = useState(false);
  const [remoteRevision, setRemoteRevision] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [history, setHistory] = useState<ConfigRevisionSnapshot<ForwardingSnapshot>[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = usePersistentPageSize('forwarding-history');
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [rollbackRevision, setRollbackRevision] = useState<number | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const historySequence = useRef(0);
  const filteredHistory = history.filter((item) => {
    const query = historyQuery.trim().toLowerCase();
    return !query || [String(item.revision), item.updatedBy, forwardingSnapshotSummary(item.payload)].some((value) => value.toLowerCase().includes(query));
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
      const result = await adminApi.forwardingHistory(50, controller.signal);
      if (!controller.signal.aborted && sequence === historySequence.current) setHistory(result.revisions);
    } catch (reason) {
      if (!controller.signal.aborted && sequence === historySequence.current) setHistoryError(message(reason, '转发策略历史加载失败'));
    } finally {
      if (sequence === historySequence.current) setHistoryLoading(false);
    }
  }, []);

  function loadForm(value: ForwardingPolicy, baselineRevision = value.revision?.revision): void {
    formRevision.current = baselineRevision;
    setEnabled(value.enabled);
    setTargetBaseUrl(value.targetBaseUrl);
    setHosts(value.allowedHosts.join('\n'));
    setDirty(false);
    setRemoteRevision(null);
  }

  useEffect(() => {
    void loadHistory();
    return () => historyRequest.current?.abort();
  }, [loadHistory, forwarding.revision?.revision]);
  useEffect(() => {
    if (formRevision.current === forwarding.revision?.revision) return;
    if (dirty) {
      setRemoteRevision(forwarding.revision?.revision ?? 0);
      return;
    }
    loadForm(forwarding, forwarding.revision?.revision);
  }, [dirty, forwarding, forwarding.revision?.revision]);

  async function save(): Promise<void> {
    setBusy({ forwarding: true });
    setError('');
    try {
      const allowedHosts = hosts.split(/\r?\n|,/u).map((item) => item.trim()).filter(Boolean);
      const { forwarding: updated } = await adminApi.updateForwarding({
        enabled,
        allowedHosts: [...new Set(allowedHosts)],
        targetBaseUrl: targetBaseUrl.trim(),
      }, formRevision.current);
      onSaved(updated);
      loadForm(updated, updated.revision?.revision);
      setNotice('转发策略已保存。');
    } catch (reason) {
      setError(message(reason, '转发策略保存失败'));
    } finally {
      setBusy({ forwarding: false });
    }
  }

  async function test(): Promise<void> {
    setTesting(true);
    setError('');
    try {
      const { check } = await adminApi.testForwarding(targetBaseUrl.trim());
      setNotice(`当前地址连通：HTTP ${check.status}，延迟 ${check.latencyMs} ms。`);
    } catch (reason) {
      setError(message(reason, '当前地址连通性测试失败'));
    } finally {
      setTesting(false);
    }
  }

  async function rollback(target: ConfigRevisionSnapshot<ForwardingSnapshot>): Promise<void> {
    const discard = dirty ? '当前未保存草稿会被放弃。' : '';
    if (!window.confirm(`恢复 v${target.revision} 的转发策略？${discard}系统会保留现有历史并创建一个新版本。`)) return;
    setRollbackRevision(target.revision);
    setError('');
    setNotice('');
    try {
      const result = await adminApi.rollbackForwarding(target.revision, forwarding.revision?.revision);
      const updated = { ...result.forwarding, revision: result.revision };
      onSaved(updated);
      loadForm(updated, result.revision.revision);
      setNotice(`已将 v${result.rolledBackFrom} 的转发策略恢复为 v${result.revision.revision}。`);
    } catch (reason) {
      setError(message(reason, '转发策略回滚失败'));
    } finally {
      setRollbackRevision(null);
    }
  }

  return <div className="admin-section forwarding-panel">
    <section>
      <div className="section-heading">
        <div><h2>实例请求转发</h2><p>关闭后，用户无法通过 Portal 进入实例页面。</p></div>
        <div className="effect-badges">
          <span>立即生效</span>
          {forwarding.revision && <span>v{forwarding.revision.revision}</span>}
          {dirty && <span className="warning">未保存</span>}
          <label className="toggle"><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); setDirty(true); }} /><span />{enabled ? '已启用' : '已关闭'}</label>
        </div>
      </div>
      <div className="policy-form">
        <label>公开入口地址<input type="url" value={targetBaseUrl} onChange={(event) => { setTargetBaseUrl(event.target.value); setDirty(true); }} placeholder="https://portal.example.com" /></label>
        <label>允许的浏览器来源<textarea value={hosts} onChange={(event) => { setHosts(event.target.value); setDirty(true); }} rows={8} placeholder={'每行一个来源或主机\nhttp://127.0.0.1:14313\n*.internal.example.com'} /></label>
        <p>实例代理只接受白名单中的浏览器 Origin；没有 Origin 的服务端探测请求仍可用。</p>
        {remoteRevision !== null && <div className="notice info draft-conflict" role="status"><span>服务端已有 v{remoteRevision}，当前未保存草稿已为你保留。</span><button className="secondary compact" onClick={() => loadForm(forwarding, forwarding.revision?.revision)}>放弃草稿并加载新版本</button></div>}
        <div className="forwarding-actions">
          <button className="primary" onClick={() => void save()} disabled={busy || !targetBaseUrl.trim() || !dirty || remoteRevision !== null}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}保存转发策略</button>
          <button className="secondary" onClick={() => void test()} disabled={testing || !targetBaseUrl.trim()}><Network size={16} />{testing ? '测试中' : '测试当前地址'}</button>
        </div>
      </div>
    </section>
    <section className="policy-history-section">
      <div className="section-heading"><div><h2 className="icon-heading"><History size={17} />转发配置历史</h2><p>恢复会创建新版本，不会覆盖已有记录。</p></div><div className="section-commands"><label>搜索<input value={historyQuery} onChange={(event) => { setHistoryQuery(event.target.value); setHistoryPage(1); }} placeholder="版本、修改人或地址" /></label><button className="icon-button" title="刷新转发历史" aria-label="刷新转发历史" disabled={historyLoading} onClick={() => void loadHistory()}><RefreshCw className={historyLoading ? 'spin' : ''} size={16} /></button></div></div>
      {historyError && <div className="notice error" role="alert">{historyError}</div>}
      {historyLoading && history.length === 0 ? <div className="policy-history-loading"><LoaderCircle className="spin" size={18} /><span>正在加载转发历史</span></div> : history.length === 0 ? <p className="policy-history-empty">尚无转发策略变更记录。</p> : <div className="policy-history-table"><table><thead><tr><th>版本</th><th>修改时间</th><th>策略摘要</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{visibleHistory.map((item) => <tr key={item.revision}><td><strong>v{item.revision}</strong><small>{item.updatedBy === 'system' ? '系统' : item.updatedBy.slice(0, 8)}</small></td><td>{new Date(item.updatedAt).toLocaleString('zh-CN')}</td><td className="policy-summary">{forwardingSnapshotSummary(item.payload)}</td><td className="revision-action">{item.revision === forwarding.revision?.revision ? <span className="current-revision">当前版本</span> : <button className="secondary compact" disabled={rollbackRevision !== null || busy} onClick={() => void rollback(item)}>{rollbackRevision === item.revision ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}恢复</button>}</td></tr>)}</tbody></table><PaginationBar page={historyPage} total={filteredHistory.length} pageSize={historyPageSize} onPage={setHistoryPage} onPageSize={(value) => { setHistoryPageSize(value); setHistoryPage(1); }} /></div>}
    </section>
  </div>;
}

function forwardingSnapshotSummary(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '无可用快照';
  const snapshot = value as Record<string, unknown>;
  const targetBaseUrl = typeof snapshot.targetBaseUrl === 'string' ? snapshot.targetBaseUrl : '-';
  const enabled = typeof snapshot.enabled === 'boolean' ? snapshot.enabled : false;
  const allowedHosts = Array.isArray(snapshot.allowedHosts)
    ? snapshot.allowedHosts.filter((item): item is string => typeof item === 'string')
    : [];
  return `${targetBaseUrl} · ${enabled ? '启用' : '关闭'} · ${allowedHosts.length} 个来源`;
}
