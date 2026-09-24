import { useCallback, useRef, useState } from 'react';
import { adminApi, type UpgradeRollout, type UpgradeRolloutDetail, type UpgradeRolloutItem } from '../../admin-api';
import { message } from './shared';

export type UpgradeRolloutItemAction = 'force' | 'continue' | 'revalidate' | 'cancel';

export function useUpgradeRollouts(reportError: (value: string) => void) {
  const [rollouts, setRollouts] = useState<UpgradeRollout[]>([]);
  const [details, setDetails] = useState<Record<string, UpgradeRolloutDetail>>({});
  const [expandedRolloutId, setExpandedRolloutId] = useState<string | null>(null);
  const [busyItemKeys, setBusyItemKeys] = useState<Set<string>>(() => new Set());
  const expandedRolloutIdRef = useRef<string | null>(null);
  const detailsRef = useRef<Record<string, UpgradeRolloutDetail>>({});
  const busyItemKeysRef = useRef(new Set<string>());
  const loadSequenceRef = useRef(0);

  const cacheDetail = useCallback((detail: UpgradeRolloutDetail) => {
    const next = { ...detailsRef.current, [detail.rollout.id]: detail };
    detailsRef.current = next;
    setDetails(next);
  }, []);

  const load = useCallback(async (limit: number, signal: AbortSignal): Promise<void> => {
    const requestedExpandedRolloutId = expandedRolloutIdRef.current;
    const sequence = ++loadSequenceRef.current;
    const detailRequest = requestedExpandedRolloutId
      ? adminApi.upgradeRollout(requestedExpandedRolloutId, signal)
      : Promise.resolve(null);
    const results = await Promise.allSettled([
      adminApi.upgradeRollouts(limit, signal),
      detailRequest,
    ]);
    if (sequence !== loadSequenceRef.current || signal.aborted) return;
    if (results[0].status === 'fulfilled') setRollouts(results[0].value.rollouts);
    const detailResult = results[1];
    if (requestedExpandedRolloutId
      && expandedRolloutIdRef.current === requestedExpandedRolloutId
      && detailResult.status === 'fulfilled'
      && detailResult.value) {
      cacheDetail(detailResult.value);
    }
    if (results.some((result) => result.status === 'rejected')) throw new Error('task_batch_load_failed');
  }, [cacheDetail]);

  const toggle = useCallback(async (rolloutId: string): Promise<void> => {
    if (expandedRolloutIdRef.current === rolloutId) {
      expandedRolloutIdRef.current = null;
      setExpandedRolloutId(null);
      return;
    }
    expandedRolloutIdRef.current = rolloutId;
    setExpandedRolloutId(rolloutId);
    if (detailsRef.current[rolloutId]) return;
    try {
      cacheDetail(await adminApi.upgradeRollout(rolloutId));
    } catch (reason) {
      reportError(message(reason, '任务批次明细加载失败'));
    }
  }, [cacheDetail, reportError]);

  const action = useCallback(async (
    item: UpgradeRolloutItem,
    kind: UpgradeRolloutItemAction,
  ): Promise<void> => {
    const key = itemKey(item);
    if (busyItemKeysRef.current.has(key)) return;
    busyItemKeysRef.current.add(key);
    setBusyItemKeys(new Set(busyItemKeysRef.current));
    try {
      const detail = await adminApi.upgradeRolloutItemAction(item.rolloutId, item.instanceId, kind);
      cacheDetail(detail);
      setRollouts((current) => current.map((rollout) => (
        rollout.id === detail.rollout.id ? detail.rollout : rollout
      )));
    } catch (reason) {
      reportError(message(reason, '任务批次操作失败'));
    } finally {
      busyItemKeysRef.current.delete(key);
      setBusyItemKeys(new Set(busyItemKeysRef.current));
    }
  }, [cacheDetail, reportError]);

  return {
    rollouts,
    details,
    expandedRolloutId,
    busyItemKeys,
    load,
    toggle,
    action,
  };
}

function itemKey(item: Pick<UpgradeRolloutItem, 'rolloutId' | 'instanceId'>): string {
  return `${item.rolloutId}:${item.instanceId}`;
}
