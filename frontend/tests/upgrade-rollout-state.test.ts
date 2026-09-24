import assert from 'node:assert/strict';
import test from 'node:test';
import type { UpgradeRolloutItemStatus, UpgradeRolloutStatus } from '../src/admin-api.ts';
import {
  blockerLabel,
  canCancelRolloutItem,
  canContinueRolloutItem,
  canForceRolloutItem,
  canRevalidateRolloutItem,
  isTerminalRollout,
  isTerminalRolloutItem,
  rolloutItemStatusLabel,
  rolloutProgress,
  rolloutStatusLabel,
} from '../src/features/admin/upgrade-rollout-state.ts';

test('rollout and item statuses have operator-facing labels', () => {
  const rolloutLabels: Record<UpgradeRolloutStatus, string> = {
    running: '执行中',
    succeeded: '已完成',
    partial_failed: '部分失败',
    cancelled: '已取消',
    needs_attention: '需处理',
  };
  const itemLabels: Record<UpgradeRolloutItemStatus, string> = {
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

  for (const [status, label] of Object.entries(rolloutLabels)) {
    assert.equal(rolloutStatusLabel(status as UpgradeRolloutStatus), label);
  }
  for (const [status, label] of Object.entries(itemLabels)) {
    assert.equal(rolloutItemStatusLabel(status as UpgradeRolloutItemStatus), label);
  }
});

test('rollout progress is rounded and clamped to a valid percentage', () => {
  assert.equal(rolloutProgress({ completed: 1, requested: 3 }), 33);
  assert.equal(rolloutProgress({ completed: -1, requested: 4 }), 0);
  assert.equal(rolloutProgress({ completed: 5, requested: 4 }), 100);
  assert.equal(rolloutProgress({ completed: 0, requested: 0 }), 0);
});

test('terminal states follow the backend rollout contract', () => {
  const rolloutStates: Record<UpgradeRolloutStatus, boolean> = {
    running: false,
    succeeded: true,
    partial_failed: true,
    cancelled: true,
    needs_attention: true,
  };
  const itemStates: Record<UpgradeRolloutItemStatus, boolean> = {
    queued: false,
    assessing: false,
    waiting_for_idle: false,
    draining: false,
    rebuilding: false,
    verifying: false,
    awaiting_first_start: false,
    succeeded: true,
    superseded: true,
    failed: true,
    cancelled: true,
    needs_attention: true,
  };

  for (const [status, terminal] of Object.entries(rolloutStates)) {
    assert.equal(isTerminalRollout({ status: status as UpgradeRolloutStatus }), terminal);
  }
  for (const [status, terminal] of Object.entries(itemStates)) {
    assert.equal(isTerminalRolloutItem({ status: status as UpgradeRolloutItemStatus }), terminal);
  }
});

test('known blockers are readable and unknown diagnostics remain visible', () => {
  assert.deepEqual([
    blockerLabel('active_stream'),
    blockerLabel('active_websocket'),
    blockerLabel('activity_observation'),
    blockerLabel('recent_activity'),
    blockerLabel('activity_timestamp_invalid'),
    blockerLabel('active_connection'),
    blockerLabel('instance_busy'),
    blockerLabel('instance_creating'),
    blockerLabel('portal_restarted'),
    blockerLabel('retry_scheduled'),
    blockerLabel('retry_limit_reached'),
    blockerLabel('container_not_found'),
    blockerLabel('app_version_not_ready'),
    blockerLabel('candidate_recovery_pending'),
    blockerLabel('candidate_awaiting_first_healthy_start'),
    blockerLabel('candidate_first_start_proof_missing'),
    blockerLabel('superseded_by_newer_deployment'),
  ], [
    '存在活动流',
    '存在活动 WebSocket',
    '正在观察活动',
    '近期仍有活动',
    '活动时间无效',
    '存在活动连接',
    '实例繁忙',
    '实例正在创建',
    '服务重启后待恢复',
    '已安排重试',
    '已达到重试上限',
    '实例不存在',
    'App 版本尚未就绪',
    '候选事务恢复中，等待再次检查',
    '新版本已部署，待首次启动验证',
    '首次启动验证证据缺失，需重新验证',
    '已由后续版本替代，未执行首次启动验证',
  ]);
  assert.equal(blockerLabel('new_backend_blocker'), 'new_backend_blocker');
  assert.equal(blockerLabel(null, 'upgrade_verification_failed'), 'upgrade_verification_failed');
  assert.equal(blockerLabel(null, null), '-');
});

test('awaiting first start status distinguishes deployed candidates from recovery', () => {
  assert.equal(
    rolloutItemStatusLabel('awaiting_first_start', 'candidate_awaiting_first_healthy_start'),
    '已部署，待首次启动验证',
  );
  assert.equal(
    rolloutItemStatusLabel('awaiting_first_start', 'candidate_recovery_pending'),
    '等待首次启动验证',
  );
});

test('item actions are exposed only for backend-actionable states', () => {
  const actionable = new Set<UpgradeRolloutItemStatus>(['queued', 'waiting_for_idle', 'failed', 'needs_attention']);
  const continuable = new Set<UpgradeRolloutItemStatus>(['waiting_for_idle', 'failed', 'needs_attention']);
  const statuses: UpgradeRolloutItemStatus[] = [
    'queued',
    'assessing',
    'waiting_for_idle',
    'draining',
    'rebuilding',
    'verifying',
    'awaiting_first_start',
    'succeeded',
    'failed',
    'cancelled',
    'needs_attention',
  ];

  for (const status of statuses) {
    assert.equal(canForceRolloutItem({ status }), actionable.has(status), `force: ${status}`);
    assert.equal(canCancelRolloutItem({ status }), actionable.has(status), `cancel: ${status}`);
    assert.equal(canContinueRolloutItem({ status }), continuable.has(status), `continue: ${status}`);
  }

  const missingProof = { status: 'needs_attention' as const, blocker: 'candidate_first_start_proof_missing' };
  assert.equal(canForceRolloutItem(missingProof, 'image_upgrade'), false);
  assert.equal(canContinueRolloutItem(missingProof, 'image_upgrade'), false);
  assert.equal(canForceRolloutItem(missingProof, 'rebuild_same_image'), true);
  assert.equal(canContinueRolloutItem(missingProof, 'rebuild_same_image'), true);
  assert.equal(canRevalidateRolloutItem(missingProof, 'image_upgrade'), true);
  assert.equal(canRevalidateRolloutItem(missingProof, 'rebuild_same_image'), false);
  assert.equal(canCancelRolloutItem(missingProof), true);
});
