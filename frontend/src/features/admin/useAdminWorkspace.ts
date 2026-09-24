import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, type AdminOverview, type ConfigRevision, type ForwardingPolicy, type InstancePolicy, type RuntimeImage, type RuntimeInfo } from '../../admin-api';
import { ApiError, api, type AdminContainerBatchAction, type PortalContainer, type PortalUser, type UserRole } from '../../api';
import { createUserErrorMessage } from './shared';
import { isManagementRole, userRoleLabel } from '../../user-role';

export function adminErrorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function roleUpdateErrorMessage(reason: unknown): string {
  const code = reason instanceof ApiError ? reason.code : '';
  if (code === 'password_required' || code === 'password_too_short') return '初始密码至少需要 12 个字符。';
  if (code === 'password_too_long') return '初始密码过长。';
  if (code === 'credential_update_conflict') return '账号凭据已发生变化，请刷新后重试。';
  if (code === 'last_super_admin_cannot_be_demoted') return '系统必须至少保留一个超级管理员。';
  if (code === 'self_role_change_forbidden') return '不能修改自己的账号角色。';
  if (code === 'role_change_conflict') return '账号角色已发生变化，请刷新后重试。';
  if (code === 'super_admin_required' || code === 'target_role_not_manageable') return '只有超级管理员可以修改账号角色。';
  if (code === 'network_unavailable') return '无法连接管理服务，请检查网络后重试。';
  return adminErrorMessage(reason, '角色更新失败，请稍后重试。');
}

export interface AdminWorkspaceState {
  overview: AdminOverview | null;
  users: PortalUser[];
  apps: string[];
  containers: PortalContainer[];
  runtime: RuntimeInfo | null;
  images: RuntimeImage[];
  forwarding: ForwardingPolicy | null;
  instancePolicy: InstancePolicy | null;
  policyRevision: ConfigRevision | null;
  loading: boolean;
  refreshing: boolean;
  lastUpdatedAt: string | null;
  failedSources: string[];
  error: string;
  notice: string;
  busy: Record<string, boolean>;
  load(silent?: boolean): Promise<void>;
  containerAction(container: PortalContainer, action: 'start' | 'stop' | 'rebuild' | 'rebuild-latest' | 'delete'): Promise<void>;
  batchContainerAction(ids: string[], action: AdminContainerBatchAction): Promise<AdminTask | null>;
  updateRole(user: PortalUser, role: UserRole, password?: string): Promise<UserRoleUpdateResult>;
  createUser(email: string, password: string, role: UserRole): Promise<boolean>;
  setBusy(value: Record<string, boolean>): void;
  setError(value: string): void;
  setNotice(value: string): void;
  setImages(value: React.SetStateAction<RuntimeImage[]>): void;
  setInstancePolicy(value: InstancePolicy | null): void;
  setPolicyRevision(value: ConfigRevision | null): void;
  setForwarding(value: ForwardingPolicy | null): void;
}

export interface AdminTask { id: string; kind: 'operation' | 'rollout' }
export type UserRoleUpdateResult = 'updated' | 'local_credential_setup_required' | 'failed';

export function useAdminWorkspace(): AdminWorkspaceState {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [apps, setApps] = useState<string[]>([]);
  const [containers, setContainers] = useState<PortalContainer[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [images, setImages] = useState<RuntimeImage[]>([]);
  const [forwarding, setForwarding] = useState<ForwardingPolicy | null>(null);
  const [instancePolicy, setInstancePolicy] = useState<InstancePolicy | null>(null);
  const [policyRevision, setPolicyRevision] = useState<ConfigRevision | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const loadingRef = useRef(false);
  const requestVersionRef = useRef(0);
  const initializedRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusyState] = useState<Record<string, boolean>>({});
  const setBusy = useCallback((updates: Record<string, boolean>) => {
    setBusyState((current) => {
      const next = { ...current };
      for (const [key, active] of Object.entries(updates)) {
        if (active) next[key] = true;
        else delete next[key];
      }
      return next;
    });
  }, []);

  const load = useCallback(async (silent = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const requestVersion = ++requestVersionRef.current;
    if (!silent && !initializedRef.current) setLoading(true);
    setRefreshing(true); setError(''); setNotice('');
    const results = await Promise.allSettled([
      adminApi.overview(), adminApi.users(), adminApi.apps(), adminApi.containers(), adminApi.runtime(), adminApi.images(), adminApi.forwarding(), adminApi.instancePolicy(),
    ] as const);
    const [overviewResult, userResult, appsResult, containerResult, runtimeResult, imageResult, forwardingResult, policyResult] = results;
    if (requestVersion !== requestVersionRef.current) {
      loadingRef.current = false;
      // An instance action can invalidate the initial request before it
      // resolves. Do not leave the whole dashboard behind its loading gate.
      if (!initializedRef.current) setLoading(false);
      setRefreshing(false);
      return;
    }
    if (overviewResult.status === 'fulfilled') {
      const nextOverview = overviewResult.value;
      if (nextOverview.persistenceDegraded) {
        setOverview((current) => current ? { ...current, persistenceDegraded: true } : null);
      } else {
        setOverview(nextOverview);
      }
    }
    if (userResult.status === 'fulfilled') setUsers(userResult.value.users);
    if (appsResult.status === 'fulfilled' && appsResult.value.apps.length > 0) setApps(appsResult.value.apps);
    if (containerResult.status === 'fulfilled') setContainers(containerResult.value.containers);
    if (runtimeResult.status === 'fulfilled') setRuntime(runtimeResult.value.status);
    if (imageResult.status === 'fulfilled') setImages(imageResult.value.images);
    if (forwardingResult.status === 'fulfilled') setForwarding(forwardingResult.value.forwarding);
    if (policyResult.status === 'fulfilled') { setInstancePolicy(policyResult.value.policy); setPolicyRevision(policyResult.value.revision ?? null); }
    const labels = ['概览', '用户', 'App', '实例', '运行时', '镜像', '转发', '实例策略'];
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [labels[index]!] : []);
    if (overviewResult.status === 'fulfilled' && overviewResult.value.persistenceDegraded) failed.push('持久化');
    const uniqueFailed = [...new Set(failed)];
    setFailedSources(uniqueFailed);
    if (uniqueFailed.length > 0) setError(`部分管理数据加载失败（${uniqueFailed.join('、')}），其余数据仍可使用。`);
    else setLastUpdatedAt(new Date().toISOString());
    initializedRef.current = true;
    setLoading(false);
    setRefreshing(false);
    loadingRef.current = false;
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function containerAction(container: PortalContainer, action: 'start' | 'stop' | 'rebuild' | 'rebuild-latest' | 'delete') {
    if (action === 'delete' && !window.confirm(`确定删除 ${container.id} 吗？该实例的持久数据会一并删除。`)) return;
    if (action === 'rebuild' && !window.confirm(`创建 ${container.id} 的原镜像重建任务批次？任务会等待实例空闲，持久数据卷（Volume）会保留，已绑定的 App 版本和镜像不会改变。`)) return;
    if (action === 'rebuild-latest' && !window.confirm(`创建 ${container.id} 的镜像升级任务批次？任务会等待实例空闲，持久数据卷（Volume）会保留。`)) return;
    requestVersionRef.current += 1;
    setBusy({ [`container:${container.id}`]: true }); setError(''); setNotice('');
    try {
      if (action === 'delete') {
        await api.adminDeleteContainer(container.id);
        setContainers((current) => current.filter((item) => item.id !== container.id));
        setNotice('实例及其持久数据已删除。');
        return;
      }
      if (action === 'rebuild-latest') {
        const detail = await adminApi.createTaskBatch([container.id], 'image_upgrade');
        setNotice(`已创建实例镜像升级任务批次（${detail.rollout.id.slice(0, 8)}），可在“操作与审计”查看进度。`);
        return;
      }
      if (action === 'rebuild') {
        const detail = await adminApi.createTaskBatch([container.id], 'rebuild_same_image');
        setNotice(`已创建实例原镜像重建任务批次（${detail.rollout.id.slice(0, 8)}），可在“操作与审计”查看进度。`);
        return;
      }
      const { container: updated } = await api.adminContainerAction(container.id, action);
      setContainers((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(action === 'start' ? '实例启动命令已提交。' : '实例停止命令已提交。');
    } catch (reason) { setError(adminErrorMessage(reason, '实例操作失败')); }
    finally { setBusy({ [`container:${container.id}`]: false }); }
  }

  async function updateRole(user: PortalUser, role: UserRole, password?: string): Promise<UserRoleUpdateResult> {
    requestVersionRef.current += 1;
    setBusy({ [`user:${user.id}`]: true }); setError(''); setNotice('');
    try {
      const { user: updated } = await adminApi.updateUserRole(user.id, user.role, role, password);
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(`${updated.email} 的角色已更新。`);
      return 'updated';
    } catch (reason) {
      if (isManagementRole(role) && password === undefined && reason instanceof ApiError && reason.code === 'local_credentials_required') {
        return 'local_credential_setup_required';
      }
      setError(roleUpdateErrorMessage(reason));
      return 'failed';
    }
    finally { setBusy({ [`user:${user.id}`]: false }); }
  }

  async function batchContainerAction(ids: string[], action: AdminContainerBatchAction): Promise<AdminTask | null> {
    requestVersionRef.current += 1;
    setBusy({ batch: true }); setError(''); setNotice('');
    try {
      if (action === 'rebuild-latest') {
        const detail = await adminApi.createTaskBatch(ids, 'image_upgrade');
        setNotice(`已创建 ${ids.length} 个实例的镜像升级任务批次（${detail.rollout.id.slice(0, 8)}），可在“操作与审计”查看进度。`);
        return { kind: 'rollout', id: detail.rollout.id };
      }
      if (action === 'rebuild') {
        const detail = await adminApi.createTaskBatch(ids, 'rebuild_same_image');
        setNotice(`已创建 ${ids.length} 个实例的原镜像重建任务批次（${detail.rollout.id.slice(0, 8)}），可在“操作与审计”查看进度。`);
        return { kind: 'rollout', id: detail.rollout.id };
      }
      const { operation } = await adminApi.batchContainers(ids, action);
      const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重建';
      setNotice(`已提交 ${ids.length} 个实例的批量${label}任务（${operation.id.slice(0, 8)}），可在“操作与审计”查看进度。`);
      return { kind: 'operation', id: operation.id };
    } catch (reason) {
      setError(adminErrorMessage(reason, '批量实例操作失败'));
      return null;
    } finally { setBusy({ batch: false }); }
  }

  async function createUser(email: string, password: string, role: UserRole): Promise<boolean> {
    requestVersionRef.current += 1;
    setBusy({ createUser: true }); setError(''); setNotice('');
    try {
      const { user } = await adminApi.createUser(email, password, role);
      setUsers((current) => [user, ...current.filter((item) => item.id !== user.id)]);
      setNotice(`${user.email} 已创建为${userRoleLabel(user.role)}。`);
      return true;
    } catch (reason) { setError(createUserErrorMessage(reason)); return false; }
    finally { setBusy({ createUser: false }); }
  }

  return { overview, users, apps, containers, runtime, images, forwarding, instancePolicy, policyRevision, loading, refreshing, lastUpdatedAt, failedSources, error, notice, busy, load, containerAction, batchContainerAction, updateRole, createUser, setBusy, setError, setNotice, setImages, setInstancePolicy, setPolicyRevision, setForwarding };
}
