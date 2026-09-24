import type { UpgradeRollout, UpgradeRolloutItem, UpgradeRolloutItemStatus, UpgradeRolloutStatus } from '../../admin-api';

export const ROLLOUT_STATUS_LABELS: Record<UpgradeRolloutStatus, string> = {
  running: '执行中',
  succeeded: '已完成',
  partial_failed: '部分失败',
  cancelled: '已取消',
  needs_attention: '需处理',
};

export const ITEM_STATUS_LABELS: Record<UpgradeRolloutItemStatus, string> = {
  queued: '排队中',
  assessing: '评估中',
  waiting_for_idle: '等待空闲',
  draining: '排空连接',
  rebuilding: '重建中',
  verifying: '校验中',
  awaiting_first_start: '等待首次启动验证',
  succeeded: '已完成',
  superseded: '已替代（未验证）',
  failed: '失败',
  cancelled: '已取消',
  needs_attention: '需处理',
};

const BLOCKER_LABELS: Record<string, string> = {
  active_stream: '存在活动流',
  active_websocket: '存在活动 WebSocket',
  activity_observation: '正在观察活动',
  recent_activity: '近期仍有活动',
  activity_timestamp_invalid: '活动时间无效',
  active_connection: '存在活动连接',
  instance_busy: '实例繁忙',
  instance_creating: '实例正在创建',
  portal_restarted: '服务重启后待恢复',
  retry_scheduled: '已安排重试',
  retry_limit_reached: '已达到重试上限',
  container_not_found: '实例不存在',
  app_version_not_ready: 'App 版本尚未就绪',
  candidate_recovery_pending: '候选事务恢复中，等待再次检查',
  candidate_awaiting_first_healthy_start: '新版本已部署，待首次启动验证',
  candidate_first_start_proof_missing: '首次启动验证证据缺失，需重新验证',
  superseded_by_newer_deployment: '已由后续版本替代，未执行首次启动验证',
};

const TERMINAL_ROLLOUT_STATUSES = new Set<UpgradeRolloutStatus>([
  'succeeded',
  'partial_failed',
  'cancelled',
  'needs_attention',
]);

const TERMINAL_ITEM_STATUSES = new Set<UpgradeRolloutItemStatus>([
  'succeeded',
  'superseded',
  'failed',
  'cancelled',
  'needs_attention',
]);

const ACTIONABLE_ITEM_STATUSES = new Set<UpgradeRolloutItemStatus>([
  'queued',
  'waiting_for_idle',
  'failed',
  'needs_attention',
]);

const CONTINUABLE_ITEM_STATUSES = new Set<UpgradeRolloutItemStatus>([
  'waiting_for_idle',
  'failed',
  'needs_attention',
]);

export function rolloutStatusLabel(status: UpgradeRolloutStatus): string {
  return ROLLOUT_STATUS_LABELS[status];
}

export function rolloutItemStatusLabel(
  status: UpgradeRolloutItemStatus,
  blocker?: string | null,
): string {
  if (status === 'awaiting_first_start' && blocker === 'candidate_awaiting_first_healthy_start') {
    return '已部署，待首次启动验证';
  }
  return ITEM_STATUS_LABELS[status];
}

export function rolloutProgress(rollout: Pick<UpgradeRollout, 'completed' | 'requested'>): number {
  if (!Number.isFinite(rollout.requested) || rollout.requested <= 0) return 0;
  if (!Number.isFinite(rollout.completed)) return 0;
  return Math.min(100, Math.max(0, Math.round((rollout.completed / rollout.requested) * 100)));
}

export function isTerminalRolloutStatus(status: UpgradeRolloutStatus): boolean {
  return TERMINAL_ROLLOUT_STATUSES.has(status);
}

export function isTerminalRollout(rollout: Pick<UpgradeRollout, 'status'>): boolean {
  return isTerminalRolloutStatus(rollout.status);
}

export function isTerminalRolloutItemStatus(status: UpgradeRolloutItemStatus): boolean {
  return TERMINAL_ITEM_STATUSES.has(status);
}

export function isTerminalRolloutItem(item: Pick<UpgradeRolloutItem, 'status'>): boolean {
  return isTerminalRolloutItemStatus(item.status);
}

export function isActionableRolloutItemStatus(status: UpgradeRolloutItemStatus): boolean {
  return ACTIONABLE_ITEM_STATUSES.has(status);
}

type ActionableRolloutItem = Pick<UpgradeRolloutItem, 'status'> & Partial<Pick<UpgradeRolloutItem, 'blocker'>>;

export function canForceRolloutItem(
  item: ActionableRolloutItem,
  taskKind?: UpgradeRollout['taskKind'],
): boolean {
  return isActionableRolloutItemStatus(item.status)
    && !(taskKind === 'image_upgrade' && item.blocker === 'candidate_first_start_proof_missing');
}

export function canCancelRolloutItem(item: Pick<UpgradeRolloutItem, 'status'>): boolean {
  return isActionableRolloutItemStatus(item.status);
}

export function canContinueRolloutItem(
  item: ActionableRolloutItem,
  taskKind?: UpgradeRollout['taskKind'],
): boolean {
  return CONTINUABLE_ITEM_STATUSES.has(item.status)
    && !(taskKind === 'image_upgrade' && item.blocker === 'candidate_first_start_proof_missing');
}

export function canRevalidateRolloutItem(
  item: ActionableRolloutItem,
  taskKind?: UpgradeRollout['taskKind'],
): boolean {
  return (taskKind === undefined || taskKind === 'image_upgrade')
    && item.status === 'needs_attention'
    && item.blocker === 'candidate_first_start_proof_missing';
}

export function blockerLabel(blocker: string | null | undefined, error?: string | null): string {
  if (blocker) return BLOCKER_LABELS[blocker] ?? blocker;
  if (error) return BLOCKER_LABELS[error] ?? error;
  return '-';
}
