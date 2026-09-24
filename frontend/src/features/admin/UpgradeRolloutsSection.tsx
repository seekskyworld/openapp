import { Fragment, useState } from 'react';
import { Ban, FastForward, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import type { UpgradeRollout, UpgradeRolloutDetail, UpgradeRolloutItem } from '../../admin-api';
import type { PortalUser } from '../../api';
import { EmptyRow, PaginationBar, paginateItems, usePersistentPageSize } from './shared';
import {
  blockerLabel,
  canCancelRolloutItem,
  canContinueRolloutItem,
  canForceRolloutItem,
  canRevalidateRolloutItem,
  rolloutItemStatusLabel,
  rolloutProgress,
  rolloutStatusLabel,
} from './upgrade-rollout-state';
import type { UpgradeRolloutItemAction } from './useUpgradeRollouts';

interface UpgradeRolloutsSectionProps {
  users: PortalUser[];
  rollouts: UpgradeRollout[];
  details: Record<string, UpgradeRolloutDetail>;
  expandedRolloutId: string | null;
  busyItemKeys: ReadonlySet<string>;
  loading: boolean;
  onToggle(rolloutId: string): void | Promise<void>;
  onAction(item: UpgradeRolloutItem, action: UpgradeRolloutItemAction): void | Promise<void>;
}

export default function UpgradeRolloutsSection({
  users,
  rollouts,
  details,
  expandedRolloutId,
  busyItemKeys,
  loading,
  onToggle,
  onAction,
}: UpgradeRolloutsSectionProps) {
  const userById = new Map(users.map((user) => [user.id, user]));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistentPageSize('upgrade-rollouts');
  const [query, setQuery] = useState('');
  const filteredRollouts = rollouts.filter((rollout) => {
    const value = query.trim().toLowerCase();
    return !value || [rollout.id, rollout.status].some((item) => item.toLowerCase().includes(value));
  });
  const visibleRollouts = paginateItems(filteredRollouts, page, pageSize);
  return <section>
    <div className="section-heading">
      <div>
        <h2>任务批次</h2>
        <p>批量任务在后台持续执行；繁忙实例等待安全窗口，不会阻塞当前页面。</p>
      </div>
      <div className="section-commands"><label>搜索<input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="批次 ID 或状态" /></label><span>{filteredRollouts.length} 个批次</span></div>
    </div>
    <div className="table-wrap">
      <table>
        <thead><tr><th>批次</th><th>状态</th><th>进度</th><th>单项统计</th><th>创建时间</th><th><span className="sr-only">操作</span></th></tr></thead>
        <tbody>
          {visibleRollouts.length === 0
            ? <EmptyRow columns={6} text={loading ? '正在加载' : '暂无任务批次'} />
            : visibleRollouts.map((rollout) => {
              const expanded = expandedRolloutId === rollout.id;
              return <Fragment key={rollout.id}>
                <RolloutSummaryRow rollout={rollout} expanded={expanded} onToggle={onToggle} />
                {expanded && details[rollout.id] && (
                  <RolloutDetailRow
                    detail={details[rollout.id]}
                    userById={userById}
                    busyItemKeys={busyItemKeys}
                    onAction={onAction}
                  />
                )}
              </Fragment>;
            })}
        </tbody>
      </table>
    </div>
    <PaginationBar page={page} total={filteredRollouts.length} pageSize={pageSize} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} />
  </section>;
}

function RolloutSummaryRow({
  rollout,
  expanded,
  onToggle,
}: {
  rollout: UpgradeRollout;
  expanded: boolean;
  onToggle(rolloutId: string): void | Promise<void>;
}) {
  const progress = rolloutProgress(rollout);
  return <tr>
    <td><strong>{taskKindLabel(rollout.taskKind)}</strong><small className="mono">{rollout.id}</small></td>
    <td><span className={`operation-status ${rollout.status}`}>{rolloutStatusLabel(rollout.status)}</span></td>
    <td>
      <div className="table-progress"><i style={{ width: `${progress}%` }} /></div>
      <small>{rollout.completed}/{rollout.requested} · {progress}%</small>
    </td>
    <td><small>完成 {rollout.completed} · 等待 {rollout.waiting}<br />成功 {rollout.succeeded} · 已替代 {rollout.superseded ?? 0} · 执行中 {rollout.upgrading} · 失败 {rollout.failed} · 需处理 {rollout.needsAttention}</small></td>
    <td>{formatTimestamp(rollout.createdAt)}</td>
    <td className="row-actions">
      <button className="secondary compact" onClick={() => void onToggle(rollout.id)}>
        {expanded ? '收起明细' : '查看明细'}
      </button>
    </td>
  </tr>;
}

function RolloutDetailRow({
  detail,
  userById,
  busyItemKeys,
  onAction,
}: {
  detail: UpgradeRolloutDetail;
  userById: ReadonlyMap<string, PortalUser>;
  busyItemKeys: ReadonlySet<string>;
  onAction(item: UpgradeRolloutItem, action: UpgradeRolloutItemAction): void | Promise<void>;
}) {
  const [selectedItemKeys, setSelectedItemKeys] = useState<Set<string>>(() => new Set());
  const [batchAction, setBatchAction] = useState<UpgradeRolloutItemAction | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistentPageSize(`upgrade-rollout-items:${detail.rollout.id}`);
  const filteredItems = detail.items.filter((item) => {
    const value = query.trim().toLowerCase();
    return !value || [item.instanceId, item.userId, item.appId, item.targetAppVersionId, item.status, item.blocker].filter(Boolean).some((entry) => entry!.toLowerCase().includes(value));
  });
  const visibleItems = paginateItems(filteredItems, page, pageSize);
  const taskKind = detail.rollout.taskKind ?? 'image_upgrade';
  const selectableItems = visibleItems.filter((item) => canSelectRolloutItem(item, taskKind));
  const selectedItems = selectableItems.filter((item) => selectedItemKeys.has(itemKey(item)));
  const allSelectableSelected = selectableItems.length > 0
    && selectableItems.every((item) => selectedItemKeys.has(itemKey(item)));

  function toggleItem(item: UpgradeRolloutItem): void {
    if (!canSelectRolloutItem(item, taskKind) || batchAction) return;
    setSelectedItemKeys((current) => {
      const next = new Set(current);
      const key = itemKey(item);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll(): void {
    if (batchAction) return;
    setSelectedItemKeys(allSelectableSelected
      ? new Set()
      : new Set(selectableItems.map((item) => itemKey(item))));
  }

  async function runBatch(action: UpgradeRolloutItemAction): Promise<void> {
    const targets = selectedItems.filter((item) => {
      if (busyItemKeys.has(itemKey(item))) return false;
      if (action === 'force') return canForceRolloutItem(item, taskKind);
      if (action === 'continue') return canContinueRolloutItem(item, taskKind);
      if (action === 'revalidate') return canRevalidateRolloutItem(item, taskKind);
      return canCancelRolloutItem(item);
    });
    if (targets.length === 0 || batchAction) return;
    setBatchAction(action);
    try {
      for (const item of targets) await onAction(item, action);
    } finally {
      setBatchAction(null);
      setSelectedItemKeys(new Set());
    }
  }

  const selectedForceCount = selectedItems.filter((item) => canForceRolloutItem(item, taskKind) && !busyItemKeys.has(itemKey(item))).length;
  const selectedContinueCount = selectedItems.filter((item) => canContinueRolloutItem(item, taskKind) && !busyItemKeys.has(itemKey(item))).length;
  const selectedRevalidateCount = selectedItems.filter((item) => canRevalidateRolloutItem(item, taskKind) && !busyItemKeys.has(itemKey(item))).length;
  const selectedCancelCount = selectedItems.filter((item) => canCancelRolloutItem(item) && !busyItemKeys.has(itemKey(item))).length;

  return <tr>
    <td colSpan={6}>
      <div className="rollout-detail">
        <div className="rollout-detail-toolbar">
          <label className="rollout-select-all">
            <input
              type="checkbox"
              aria-label="选择批次中的全部可操作实例"
              checked={allSelectableSelected}
              disabled={selectableItems.length === 0 || Boolean(batchAction)}
              onChange={toggleAll}
            />
            <span>全选</span>
          </label>
          <span className="rollout-selection-count">已选 {selectedItems.length} 项</span>
          <div className="rollout-batch-actions">
            <button
              className="icon-button compact"
              title="批量强制执行"
              aria-label="批量强制执行"
              disabled={selectedForceCount === 0 || Boolean(batchAction)}
              onClick={() => void runBatch('force')}
            >
              {batchAction === 'force' ? <LoaderCircle className="spin" size={14} /> : <FastForward size={14} />}
            </button>
            <button
              className="icon-button compact"
              title="批量继续等待或重试"
              aria-label="批量继续等待或重试"
              disabled={selectedContinueCount === 0 || Boolean(batchAction)}
              onClick={() => void runBatch('continue')}
            >
              {batchAction === 'continue' ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
            </button>
            <button
              className="icon-button compact"
              title="批量重新验证首次启动"
              aria-label="批量重新验证首次启动"
              disabled={selectedRevalidateCount === 0 || Boolean(batchAction)}
              onClick={() => void runBatch('revalidate')}
            >
              {batchAction === 'revalidate' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            </button>
            <button
              className="danger-icon"
              title="批量取消任务"
              aria-label="批量取消任务"
              disabled={selectedCancelCount === 0 || Boolean(batchAction)}
              onClick={() => void runBatch('cancel')}
            >
              {batchAction === 'cancel' ? <LoaderCircle className="spin" size={14} /> : <Ban size={14} />}
            </button>
          </div>
          <label className="rollout-detail-search">搜索<input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="实例、所有者、状态或阻塞原因" /></label>
        </div>
        <table>
          <thead><tr><th><span className="sr-only">选择</span></th><th>所有者</th><th>实例</th><th>目标</th><th>状态</th><th>阻塞原因</th><th>诊断</th><th>尝试</th><th>上次检查</th><th>下次检查</th><th><span className="sr-only">操作</span></th></tr></thead>
          <tbody>
            {visibleItems.map((item) => (
              <RolloutItemRow
                key={item.instanceId}
                item={item}
                owner={userById.get(item.userId)}
                taskKind={taskKind}
                selected={canSelectRolloutItem(item, taskKind) && selectedItemKeys.has(itemKey(item))}
                selectionDisabled={Boolean(batchAction)}
                onToggleSelected={toggleItem}
                busy={busyItemKeys.has(itemKey(item))}
                onAction={onAction}
              />
            ))}
          </tbody>
        </table>
        <PaginationBar page={page} total={filteredItems.length} pageSize={pageSize} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} />
      </div>
    </td>
  </tr>;
}

function RolloutItemRow({
  item,
  owner,
  taskKind,
  selected,
  selectionDisabled,
  onToggleSelected,
  busy,
  onAction,
}: {
  item: UpgradeRolloutItem;
  owner: PortalUser | undefined;
  taskKind: UpgradeRollout['taskKind'];
  selected: boolean;
  selectionDisabled: boolean;
  onToggleSelected(item: UpgradeRolloutItem): void;
  busy: boolean;
  onAction(item: UpgradeRolloutItem, action: UpgradeRolloutItemAction): void | Promise<void>;
}) {
  const canForce = canForceRolloutItem(item, taskKind);
  const canContinue = canContinueRolloutItem(item, taskKind);
  const canRevalidate = canRevalidateRolloutItem(item, taskKind);
  const canCancel = canCancelRolloutItem(item);
  const continueLabel = item.recovery
    ? '再次恢复'
    : item.status === 'waiting_for_idle' ? '继续等待' : '重新尝试';
  const selectable = canForce || canContinue || canRevalidate || canCancel;
  return <tr>
    <td>
      <input
        className="rollout-item-select"
        type="checkbox"
        aria-label={`选择任务项 ${item.instanceId}`}
        checked={selected}
        disabled={!selectable || selectionDisabled || busy}
        onChange={() => onToggleSelected(item)}
      />
    </td>
    <td>
      <strong>{owner?.name ?? owner?.email ?? item.userId}</strong>
      {owner?.name && <small>{owner.email}</small>}
    </td>
    <td className="mono">{item.instanceId}</td>
    <td className="mono">{targetLabel(item, taskKind)}</td>
    <td><span className={`operation-status ${item.status}`}>{rolloutItemStatusLabel(item.status, item.blocker)}</span></td>
    <td>{blockerLabel(item.blocker, item.error)}</td>
    <td>{item.diagnostics ? <details className="rollout-diagnostics"><summary>查看诊断</summary><div><span>诊断能力：{item.diagnostics.capabilityStatus === 'unsupported' ? '不支持' : item.diagnostics.capabilityStatus === 'unavailable' ? '暂不可用' : '可用'}</span><span>来源：{diagnosticRoleLabel(item.diagnostics.containerRole)}</span><span>错误：{item.diagnostics.error ?? item.error ?? '-'}</span><span>退出码：{item.diagnostics.exitCode ?? '-'}</span><span>OOM：{item.diagnostics.oomKilled == null ? '-' : item.diagnostics.oomKilled ? '是' : '否'}</span><span>健康：{item.diagnostics.health ?? '-'}</span><span>内存：{item.diagnostics.memoryLimit ?? '-'}</span><span>交换：{item.diagnostics.memorySwapLimit ?? '-'}</span><span>CPU：{item.diagnostics.cpus ?? '-'}</span><span>PID：{item.diagnostics.pidsLimit ?? '-'}</span>{item.diagnostics.logTail && <pre>{item.diagnostics.logTail}</pre>}</div></details> : '-'}</td>
    <td>{item.attemptCount}</td>
    <td>{formatTimestamp(item.lastCheckedAt)}</td>
    <td>{formatTimestamp(item.nextAttemptAt)}</td>
    <td className="row-actions">
      <div>
        {canForce && (
          <button className="icon-button compact" title="强制执行" aria-label="强制执行" disabled={busy} onClick={() => void onAction(item, 'force')}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <FastForward size={14} />}
          </button>
        )}
        {canContinue && (
          <button className="icon-button compact" title={continueLabel} aria-label={continueLabel} disabled={busy} onClick={() => void onAction(item, 'continue')}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
          </button>
        )}
        {canRevalidate && (
          <button className="icon-button compact" title="重新验证首次启动" aria-label="重新验证首次启动" disabled={busy} onClick={() => void onAction(item, 'revalidate')}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          </button>
        )}
        {canCancel && (
          <button className="danger-icon" title="取消此实例任务" aria-label="取消此实例任务" disabled={busy} onClick={() => void onAction(item, 'cancel')}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Ban size={14} />}
          </button>
        )}
      </div>
    </td>
  </tr>;
}

function itemKey(item: Pick<UpgradeRolloutItem, 'rolloutId' | 'instanceId'>): string {
  return `${item.rolloutId}:${item.instanceId}`;
}

function canSelectRolloutItem(
  item: Pick<UpgradeRolloutItem, 'status' | 'blocker'>,
  taskKind?: UpgradeRollout['taskKind'],
): boolean {
  return canForceRolloutItem(item, taskKind)
    || canContinueRolloutItem(item, taskKind)
    || canRevalidateRolloutItem(item, taskKind)
    || canCancelRolloutItem(item);
}

function formatTimestamp(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '-';
}

function taskKindLabel(taskKind: UpgradeRollout['taskKind']): string {
  if (taskKind === 'instance_recovery') return '实例恢复';
  if (taskKind === 'rebuild_same_image') return '原镜像重建';
  if (taskKind === 'apply_resource_policy') return '应用资源策略';
  return 'App 镜像升级';
}

function targetLabel(item: UpgradeRolloutItem, taskKind: UpgradeRollout['taskKind']): string {
  if (taskKind === 'rebuild_same_image') return '保留原镜像';
  if (taskKind === 'apply_resource_policy') {
    if (!item.targetResources) return '资源策略快照';
    return `${item.targetResources.cpus} CPU / ${item.targetResources.memory} / PID ${item.targetResources.pidsLimit}`;
  }
  return item.targetAppVersionId ?? '-';
}

function diagnosticRoleLabel(role: NonNullable<UpgradeRolloutItem['diagnostics']>['containerRole']): string {
  if (role === 'rollback') return '回滚候选';
  if (role === 'candidate') return '候选容器';
  if (role === 'previous') return '上一代容器';
  return '正式容器';
}
