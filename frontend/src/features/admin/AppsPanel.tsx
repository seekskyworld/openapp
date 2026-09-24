import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Archive, Check, CloudUpload, LoaderCircle, PackageCheck, Plus, RefreshCw, RotateCcw, Server, X } from 'lucide-react';
import { adminApi, newIdempotencyKey, type AdminOperation, type AppDefinition, type AppVersion, type BuildPackage, type BuildStrategy, type RuntimeImage } from '../../admin-api';
import { isCurrentAppVersionMutation, isCurrentAppVersionRequest, sortAppVersions } from './app-catalog-state';
import {
  createAppImageUpdateDraft,
  currentAppRevision,
  inheritedPackageIdsForRevision,
  packagesForAppVersion,
  replaceAppImageUpdatePackage,
  resetAppImageUpdateSlot,
  resolveAppImageUpdateDraft,
  type AppImageUpdateDraft,
} from './app-build-state';
import { pollAdminOperation } from './operation-polling';
import { EmptyRow, PaginationBar, message, paginateItems, usePersistentPageSize } from './shared';
declare const __OPENAPP_FRONTEND_BUILD_TARGET__: string | undefined;
const isGenericFrontendBuild = typeof __OPENAPP_FRONTEND_BUILD_TARGET__ === 'string'
  && __OPENAPP_FRONTEND_BUILD_TARGET__ === 'generic';

const MAX_BUILD_PACKAGE_BYTES = 512 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 30 * 60_000;
const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/u;

interface AppsPanelProps {
  images: RuntimeImage[];
}

const STATUS_LABELS: Record<AppVersion['status'], string> = {
  legacy: '兼容镜像',
  uploaded: '候选未就绪',
  image_ready: '候选已测试',
  active: '当前镜像',
  archived: '已归档',
};

function fallbackApp(id: string, authAdapterId: string): AppDefinition {
  const now = new Date(0).toISOString();
  return { id, name: id, description: '', authAdapterId, status: 'active', createdAt: now, updatedAt: now };
}

/** 只有旧 `/api/admin/apps` 省略 items 时才加载兼容投影。 */
async function normalizeAppResponse(result: { apps: string[]; items?: AppDefinition[] }): Promise<AppDefinition[]> {
  // 现代接口可以合法返回空列表；只有完全没有 items 字段的旧响应才
    // 触发旧响应兼容投影，避免新 App 空目录也加载产品代码。
  if (Array.isArray(result.items)) return result.items;
  if (isGenericFrontendBuild) return result.apps.map((id) => fallbackApp(id, 'none'));
  const { loadLegacyAuthCompatibility } = await import('../auth/compat/load');
  const adapter = await loadLegacyAuthCompatibility(undefined);
  return result.apps.map((id) => fallbackApp(id, adapter.legacyFallbackAuthAdapterId?.(id) ?? 'none'));
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024;
  let unit = units[0]!;
  for (let index = 1; amount >= 1024 && index < units.length; index += 1) {
    amount /= 1024;
    unit = units[index]!;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '-';
}

function revisionLabel(revision: AppVersion | null): string {
  return revision?.revision === undefined ? '#-' : `#${revision.revision}`;
}

function sourceVersionLabel(pkg: BuildPackage | undefined): string {
  return pkg?.sourceVersion?.trim() || '未知';
}

function appError(reason: unknown, fallback: string): string {
  const code = reason instanceof Error ? reason.message : '';
  if (code === 'app_exists') return '这个 App ID 已经存在。';
  if (code === 'invalid_app_id') return 'App ID 只能使用小写字母、数字、点、下划线和短横线。';
  if (code === 'invalid_app_name') return '请输入 App 名称。';
  if (code === 'app_archived') return '已归档的 App 不能上传或修改版本。';
  if (code === 'default_app_cannot_be_archived') return '请先把实例策略切换到其他 App，再归档当前默认 App。';
  if (code === 'app_version_exists') return '这个版本号已经上传过。';
  if (code === 'app_version_image_required') return '请先关联一个已存在的运行时镜像。';
  if (code === 'app_version_release_required') return '该版本缺少策略要求的构建包。';
  if (code === 'runtime_image_not_found') return '运行时中没有找到这个镜像，请先导入或拉取。';
  if (code === 'app_version_not_ready') return '该 App 当前没有可启动的激活版本。';
  if (code === 'release_build_id_mismatch') return '两个发布包不是同一次构建，请重新选择。';
  if (code === 'release_version_mismatch') return '两个发布包的版本号不一致。';
  if (code === 'release_pair_required') return '必须同时选择 Backend 和 Web 发布包。';
  if (code === 'app_version_archived') return '该版本已经归档。';
  if (code === 'app_version_immutable') return '已激活或兼容版本不可替换镜像，请上传新的版本。';
  if (code === 'release_artifact_binding_mismatch') return '该镜像与版本的构建包快照不一致，不能绑定。';
  if (code === 'image_artifact_required') return '该版本必须从镜像产物列表绑定，不能直接填写镜像引用。';
  if (code === 'build_package_not_found' || code === 'build_package_file_missing') return '构建包记录或文件已不存在，请重新上传该槽位。';
  if (code.startsWith('required_build_package_missing') || code === 'build_package_selection_required') return '请先上传策略要求的全部构建包。';
  if (code === 'build_package_checksum_mismatch') return '构建包校验失败，请重新上传。';
  if (code === 'build_strategy_package_inspection_unavailable' || code === 'build_strategy_package_inspection_mismatch') return '当前策略无法解析这组构建包，请检查策略 revision 与包内容。';
  if (code === 'app_revision_conflict') return '当前镜像已被其他管理员更新，列表已刷新，请重新选择。';
  if (code === 'app_image_update_no_changes' || code === 'app_image_update_replacement_required') return '请至少替换一个包或移除一个可选槽位。';
  if (code === 'invalid_build_package_selection' || code === 'unsupported_build_package') return '替换包不符合当前构建策略，请重新选择。';
  if (code === 'network_unavailable') return '无法连接管理服务，请检查网络后重试。';
  if (code.startsWith('archive_') || code === 'invalid_release_archive') return '发布包格式或内容不符合要求。';
  return message(reason, fallback);
}

export default function AppsPanel(_props: AppsPanelProps) {
  const [apps, setApps] = useState<AppDefinition[]>([]);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [appQuery, setAppQuery] = useState('');
  const [appPage, setAppPage] = useState(1);
  const [appPageSize, setAppPageSize] = usePersistentPageSize('apps');
  const [versions, setVersions] = useState<AppVersion[]>([]);
  const [versionPage, setVersionPage] = useState(1);
  const [versionPageSize, setVersionPageSize] = usePersistentPageSize('app-versions');
  const [versionQuery, setVersionQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createId, setCreateId] = useState('');
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [activeOperation, setActiveOperation] = useState<AdminOperation | null>(null);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);
  const [strategies, setStrategies] = useState<BuildStrategy[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState('');
  const [importImageReference, setImportImageReference] = useState('');
  const imageImportKeys = useRef(new Map<string, string>());
  const [buildPackages, setBuildPackages] = useState<Record<string, File | null>>({});
  const [packageCatalog, setPackageCatalog] = useState<BuildPackage[]>([]);
  const [imageUpdateDraft, setImageUpdateDraft] = useState<AppImageUpdateDraft>(() => createAppImageUpdateDraft({}));
  const [packageInputVersions, setPackageInputVersions] = useState<Record<string, number>>({});
  const [uploadingPackageKey, setUploadingPackageKey] = useState<string | null>(null);
  const [imageUpdateBusy, setImageUpdateBusy] = useState(false);
  const appsRequest = useRef<AbortController | null>(null);
  const versionsRequest = useRef<AbortController | null>(null);
  const versionsSequence = useRef(0);
  const selectedAppIdRef = useRef('');
  const versionMutationSequence = useRef(0);
  const operationControllers = useRef(new Set<AbortController>());
  const mounted = useRef(false);

  const selectedApp = useMemo(() => apps.find((app) => app.id === selectedAppId) ?? null, [apps, selectedAppId]);
  const selectedAppIsActive = selectedApp?.status === 'active';
  const availableStrategies = useMemo(() => strategies.filter((item) => item.status === 'active'
    && (item.appIds?.includes(selectedAppId) || item.executable === false)), [strategies, selectedAppId]);
  const selectedStrategy = useMemo(() => availableStrategies.find((item) => item.id === selectedStrategyId) ?? null, [availableStrategies, selectedStrategyId]);
  useEffect(() => {
    if (!availableStrategies.some((item) => item.id === selectedStrategyId)) {
      setSelectedStrategyId(availableStrategies[0]?.id ?? '');
      setBuildPackages({});
    }
  }, [availableStrategies, selectedStrategyId]);
  const strategyUnavailable = selectedStrategy?.executable === false;
  const strategyUnavailableMessage = selectedStrategy?.unavailableReason === 'control_plane_only'
    ? '当前为仅控制面模式，构建策略仅供查看，不能上传或构建镜像。'
    : selectedStrategy?.unavailableReason === 'adapter_version_mismatch'
      ? '已加载的 Adapter 与此构建策略版本不匹配，请联系管理员更新组合配置。'
      : '此构建策略对应的 Adapter 未加载或策略不可执行；当前显示的是数据库中的历史配置。';
  const currentRevision = useMemo(() => currentAppRevision(versions), [versions]);
  const filteredApps = useMemo(() => {
    const query = appQuery.trim().toLowerCase();
    return query ? apps.filter((app) => [app.id, app.name, app.description].some((value) => value.toLowerCase().includes(query))) : apps;
  }, [appQuery, apps]);
  const visibleApps = paginateItems(filteredApps, appPage, appPageSize);
  const filteredVersions = useMemo(() => {
    const query = versionQuery.trim().toLowerCase();
    return query ? versions.filter((version) => [version.id, version.version, version.buildId, version.imageReference].filter(Boolean).some((value) => value!.toLowerCase().includes(query))) : versions;
  }, [versionQuery, versions]);
  const visibleVersions = paginateItems(filteredVersions, versionPage, versionPageSize);
  const packageById = useMemo(() => new Map(packageCatalog.map((pkg) => [pkg.id, pkg])), [packageCatalog]);
  const resolvedImageUpdate = useMemo(
    () => selectedStrategy ? resolveAppImageUpdateDraft(selectedStrategy, imageUpdateDraft) : null,
    [imageUpdateDraft, selectedStrategy],
  );

  useEffect(() => {
    mounted.current = true;
    void loadApps();
    void loadBuildCatalog();
    return () => {
      mounted.current = false;
      appsRequest.current?.abort(new DOMException('App catalog unmounted', 'AbortError'));
      versionsRequest.current?.abort(new DOMException('App version load unmounted', 'AbortError'));
      for (const controller of operationControllers.current) controller.abort(new DOMException('App catalog unmounted', 'AbortError'));
      operationControllers.current.clear();
    };
  }, []);

  async function loadBuildCatalog(signal?: AbortSignal): Promise<void> {
    try {
      const [strategyResult, packageResult] = await Promise.all([
        adminApi.buildStrategies(signal),
        adminApi.buildPackages(undefined, undefined, signal),
      ]);
      if (signal?.aborted) return;
      setStrategies(strategyResult.strategies);
      const activeStrategies = strategyResult.strategies.filter((item) => item.status === 'active');
      if (activeStrategies.length > 0 && !activeStrategies.some((item) => item.id === selectedStrategyId)) {
        setSelectedStrategyId(activeStrategies[0]!.id);
      }
      setPackageCatalog(packageResult.packages);
    } catch (reason) {
      if (!signal?.aborted) setError(appError(reason, '构建策略与包目录加载失败，请稍后重试。'));
    }
  }

  useEffect(() => {
    selectedAppIdRef.current = selectedAppId;
    if (!selectedAppId) {
      versionsSequence.current += 1;
      versionsRequest.current?.abort(new DOMException('App version selection cleared', 'AbortError'));
      versionsRequest.current = null;
      setVersions([]);
      setImageUpdateDraft(createAppImageUpdateDraft({}));
      setVersionsLoading(false);
      return;
    }
    setVersions([]);
    void loadVersions(selectedAppId);
  }, [selectedAppId]);

  async function loadApps(signal?: AbortSignal): Promise<void> {
    appsRequest.current?.abort(new DOMException('App catalog refresh superseded', 'AbortError'));
    const controller = signal ? null : new AbortController();
    const requestSignal = signal ?? controller!.signal;
    if (!signal) appsRequest.current = controller;
    if (!signal) setRefreshing(true);
    try {
      const result = await adminApi.apps(requestSignal);
      if (requestSignal.aborted) return;
      const next = await normalizeAppResponse(result);
      setApps(next);
      const selected = next.some((app) => app.id === selectedAppIdRef.current)
        ? selectedAppIdRef.current
        : next.find((app) => app.status === 'active')?.id ?? next[0]?.id ?? '';
      selectApp(selected);
      setError('');
    } catch (reason) {
      if (!requestSignal.aborted) setError(appError(reason, 'App 目录加载失败，请稍后重试。'));
    } finally {
      if (!requestSignal.aborted && mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
      if (appsRequest.current === controller) appsRequest.current = null;
    }
  }

  async function loadVersions(appId: string): Promise<void> {
    const sequence = ++versionsSequence.current;
    versionsRequest.current?.abort(new DOMException('App version load superseded', 'AbortError'));
    const controller = new AbortController();
    versionsRequest.current = controller;
    setVersionsLoading(true);
    setError('');
    const isCurrent = () => isCurrentAppVersionRequest({
      requestedAppId: appId,
      selectedAppId: selectedAppIdRef.current,
      requestSequence: sequence,
      latestSequence: versionsSequence.current,
      aborted: controller.signal.aborted,
    });
    try {
      const result = await adminApi.appVersions(appId, controller.signal);
      if (!isCurrent()) return;
      const orderedVersions = sortAppVersions(result.versions);
      setVersions(orderedVersions);
      setVersionPage(1);
      setImageUpdateDraft(createAppImageUpdateDraft(
        inheritedPackageIdsForRevision(currentAppRevision(orderedVersions)),
      ));
    } catch (reason) {
      if (isCurrent()) setError(appError(reason, '版本列表加载失败，请稍后重试。'));
    } finally {
      if (isCurrent()) setVersionsLoading(false);
      if (versionsRequest.current === controller) versionsRequest.current = null;
    }
  }

  function beginOperation(): AbortController {
    const controller = new AbortController();
    operationControllers.current.add(controller);
    return controller;
  }

  function selectApp(appId: string): void {
    if (selectedAppIdRef.current !== appId) {
      versionMutationSequence.current += 1;
      setBusyVersion(null);
      setActiveOperation(null);
      setError('');
      setNotice('');
    }
    selectedAppIdRef.current = appId;
    setSelectedAppId(appId);
  }

  function beginVersionMutation(appId: string, key: string): { appId: string; key: string; sequence: number } {
    const sequence = ++versionMutationSequence.current;
    setBusyVersion(key);
    return { appId, key, sequence };
  }

  function isCurrentVersionMutation(context: { appId: string; sequence: number }): boolean {
    return isCurrentAppVersionMutation({
      requestedAppId: context.appId,
      selectedAppId: selectedAppIdRef.current,
      mutationSequence: context.sequence,
      latestMutationSequence: versionMutationSequence.current,
      mounted: mounted.current,
    });
  }

  function finishVersionMutation(context: { sequence: number }): void {
    if (mounted.current && versionMutationSequence.current === context.sequence) setBusyVersion(null);
  }

  async function waitForOperation(id: string, signal: AbortSignal, appId?: string): Promise<AdminOperation> {
    return pollAdminOperation(id, {
      signal,
      timeoutMs: OPERATION_TIMEOUT_MS,
      requestOperation: adminApi.operation,
      onUpdate: (operation) => {
        if (mounted.current && !signal.aborted && (!appId || selectedAppIdRef.current === appId)) setActiveOperation(operation);
      },
    });
  }

  async function createApp(event: FormEvent): Promise<void> {
    event.preventDefault();
    const id = createId.trim().toLowerCase();
    const name = createName.trim();
    if (!APP_ID_PATTERN.test(id)) { setError('App ID 只能使用小写字母、数字、点、下划线和短横线。'); return; }
    if (!name) { setError('请输入 App 名称。'); return; }
    setCreateBusy(true); setError(''); setNotice('');
    try {
      const result = await adminApi.createApp({ id, name, description: createDescription.trim() });
      setApps((current) => [result.app, ...current.filter((app) => app.id !== result.app.id)]);
      selectApp(result.app.id);
      setCreateId(''); setCreateName(''); setCreateDescription(''); setCreateOpen(false);
      setNotice(`App「${result.app.name}」已创建。`);
    } catch (reason) {
      setError(appError(reason, 'App 创建失败，请稍后重试。'));
    } finally {
      setCreateBusy(false);
    }
  }

  async function toggleArchive(app: AppDefinition): Promise<void> {
    const nextStatus = app.status === 'active' ? 'archived' : 'active';
    if (nextStatus === 'archived' && !window.confirm(`归档 App「${app.name}」？已有实例不会被删除，但新实例不能再使用它。`)) return;
    const mutation = beginVersionMutation(app.id, `app:${app.id}`);
    setError(''); setNotice('');
    try {
      const result = await adminApi.updateApp(app.id, { status: nextStatus });
      setApps((current) => current.map((item) => item.id === result.app.id ? result.app : item));
      if (isCurrentVersionMutation(mutation)) setNotice(nextStatus === 'archived' ? `App「${app.name}」已归档。` : `App「${app.name}」已重新启用。`);
    } catch (reason) {
      if (isCurrentVersionMutation(mutation)) setError(appError(reason, 'App 状态更新失败，请稍后重试。'));
    } finally {
      finishVersionMutation(mutation);
    }
  }

  async function uploadStrategyPackage(requirement: BuildStrategy['packageRequirements'][number]): Promise<void> {
    const strategy = selectedStrategy;
    const file = buildPackages[requirement.key];
    if (!strategy || !file || strategyUnavailable) return;
    if (!requirement.acceptedExtensions.some((extension) => file.name.toLowerCase().endsWith(extension))) {
      setError(`${requirement.key} 构建包格式不符合策略要求。`);
      return;
    }
    const maximumBytes = requirement.maxBytes ?? MAX_BUILD_PACKAGE_BYTES;
    if (file.size <= 0 || file.size > maximumBytes) {
      setError(`${requirement.key} 构建包大小必须大于 0 且不超过 ${formatBytes(maximumBytes)}。`);
      return;
    }
    const controller = beginOperation();
    setUploadingPackageKey(requirement.key); setError(''); setNotice('');
    try {
      const result = await adminApi.uploadBuildPackage(strategy.id, requirement.key, file, controller.signal);
      controller.signal.throwIfAborted();
      setPackageCatalog((current) => [result.package, ...current.filter((item) => item.id !== result.package.id)]);
      setImageUpdateDraft((current) => replaceAppImageUpdatePackage(current, requirement.key, result.package.id));
      setBuildPackages((current) => ({ ...current, [requirement.key]: null }));
      setPackageInputVersions((current) => ({ ...current, [requirement.key]: (current[requirement.key] ?? 0) + 1 }));
      setNotice(`${requirement.key} 构建包已上传并选为替换包。`);
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setError(appError(reason, `${requirement.key} 构建包上传失败。`));
    } finally {
      operationControllers.current.delete(controller);
      if (mounted.current) setUploadingPackageKey(null);
    }
  }

  async function buildImageCandidate(): Promise<void> {
    if (!selectedApp || !selectedStrategy || strategyUnavailable || !resolvedImageUpdate?.canBuild) return;
    if (!selectedAppIsActive) { setError('请先启用当前 App，再更新镜像。'); return; }
    const appId = selectedApp.id;
    const expectedRevision = currentRevision?.revision ?? 0;
    const controller = beginOperation();
    setImageUpdateBusy(true); setError(''); setNotice('');
    try {
      const submitted = await adminApi.createAppImageUpdate(appId, {
        strategyId: selectedStrategy.id,
        expectedRevision,
        replacementPackageIds: { ...imageUpdateDraft.replacementPackageIds },
      }, controller.signal);
      if (selectedAppIdRef.current === appId) setActiveOperation(submitted.operation);
      await waitForOperation(submitted.operationId, controller.signal, appId);
      if (selectedAppIdRef.current === appId) {
        await loadVersions(appId);
        if (mounted.current && selectedAppIdRef.current === appId) {
          setNotice(`App「${selectedApp.name}」的候选镜像已构建并通过运行测试。`);
        }
      }
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted && selectedAppIdRef.current === appId) {
        if (reason instanceof Error && reason.message === 'app_revision_conflict') await loadVersions(appId);
        if (mounted.current && selectedAppIdRef.current === appId) {
          setError(appError(reason, '候选镜像构建或运行测试失败，请查看操作详情。'));
        }
      }
    } finally {
      operationControllers.current.delete(controller);
      if (mounted.current) setImageUpdateBusy(false);
    }
  }

  async function importExistingImage(): Promise<void> {
    if (!selectedApp || !importImageReference.trim() || imageUpdateBusy) return;
    const appId = selectedApp.id;
    const requestKey = JSON.stringify([appId, importImageReference.trim()]);
    const idempotencyKey = imageImportKeys.current.get(requestKey) ?? newIdempotencyKey();
    imageImportKeys.current.set(requestKey, idempotencyKey);
    let submittedId: string | undefined;
    const controller = beginOperation();
    setImageUpdateBusy(true); setError(''); setNotice('');
    try {
      const submitted = await adminApi.importAppImage(appId, importImageReference.trim(), controller.signal, idempotencyKey);
      submittedId = submitted.operationId;
      if (selectedAppIdRef.current === appId) setActiveOperation(submitted.operation);
      await waitForOperation(submitted.operationId, controller.signal, appId);
      imageImportKeys.current.delete(requestKey);
      if (selectedAppIdRef.current === appId) {
        await loadVersions(appId);
        setNotice('镜像已校验并保存为候选 Revision，可选择设为当前镜像。');
        setImportImageReference('');
      }
    } catch (reason) {
      // 网络中断保留幂等键；明确失败的任务允许用户修复镜像后重新发起。
      if (submittedId && !controller.signal.aborted) {
        const result = await adminApi.operation(submittedId, controller.signal).catch(() => null);
        if (result?.operation.status === 'failed' || result?.operation.status === 'cancelled') imageImportKeys.current.delete(requestKey);
      }
      if (!controller.signal.aborted && selectedAppIdRef.current === appId) setError(appError(reason, '镜像导入失败，请检查镜像和 App 运行合同。'));
    } finally {
      operationControllers.current.delete(controller);
      if (mounted.current) setImageUpdateBusy(false);
    }
  }

  async function bindImageCandidate(revision: AppVersion): Promise<void> {
    if (!selectedApp || revision.status !== 'image_ready' || !revision.imageReference) return;
    const appId = selectedApp.id;
    const expectedRevision = currentRevision?.revision ?? 0;
    const targetRevision = revision.revision ?? 0;
    const rollback = targetRevision < expectedRevision;
    const question = rollback
      ? `将 App「${selectedApp.name}」从 ${revisionLabel(currentRevision)} 回滚到 ${revisionLabel(revision)}？`
      : `将 ${revisionLabel(revision)} 设为 App「${selectedApp.name}」的当前镜像？`;
    if (!window.confirm(`${question}新建实例会使用该镜像，已有实例不会自动升级。`)) return;
    const mutation = beginVersionMutation(appId, revision.id);
    setError(''); setNotice('');
    try {
      await adminApi.bindAppImageUpdate(appId, revision.id, expectedRevision);
      if (isCurrentVersionMutation(mutation)) {
        await loadVersions(appId);
        if (isCurrentVersionMutation(mutation)) {
          setNotice(rollback
            ? `App「${selectedApp.name}」已回滚到 ${revisionLabel(revision)}。`
            : `${revisionLabel(revision)} 已设为 App「${selectedApp.name}」的当前镜像。`);
        }
      }
    } catch (reason) {
      if (isCurrentVersionMutation(mutation)) {
        if (reason instanceof Error && reason.message === 'app_revision_conflict') await loadVersions(appId);
        if (isCurrentVersionMutation(mutation)) {
          setError(appError(reason, '当前镜像设置失败，请刷新后重试。'));
        }
      }
    } finally {
      finishVersionMutation(mutation);
    }
  }

  return (
    <div className="admin-section admin-stack apps-panel">
      <section>
        <div className="section-heading">
          <div><h2>App 目录</h2><p>为 App 构建、测试并切换当前镜像；已有实例继续使用创建时的镜像快照。</p></div>
          <div className="section-commands"><span>{apps.length} 个 App</span><button className="icon-button" title="刷新 App 目录" aria-label="刷新 App 目录" disabled={refreshing} onClick={() => void loadApps()}><RefreshCw className={refreshing ? 'spin' : ''} size={16} /></button><button className="primary compact" onClick={() => { setCreateOpen((current) => !current); setError(''); }}><Plus size={15} />{createOpen ? '收起' : '创建 App'}</button></div>
        </div>
        {createOpen && <form className="app-create-form" onSubmit={(event) => void createApp(event)}>
          <label>App ID<input value={createId} onChange={(event) => setCreateId(event.target.value)} placeholder="story-app" autoComplete="off" disabled={createBusy} /></label>
          <label>显示名称<input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="Story App" disabled={createBusy} /></label>
          <label className="app-description-field">描述<input value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} placeholder="可选的用途说明" disabled={createBusy} /></label>
          <div className="app-create-actions"><button type="button" className="secondary" disabled={createBusy} onClick={() => setCreateOpen(false)}><X size={15} />取消</button><button type="submit" className="primary" disabled={createBusy || !createId.trim() || !createName.trim()}>{createBusy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{createBusy ? '创建中' : '创建 App'}</button></div>
        </form>}
        {error && <div className="notice error app-notice" role="alert">{error}</div>}
        {notice && <div className="notice success app-notice" role="status">{notice}</div>}
      </section>

      {loading ? <div className="center-state"><LoaderCircle className="spin" /><p>正在加载 App 目录</p></div> : apps.length === 0 ? <div className="empty"><Server className="empty-icon" /><h2>还没有 App</h2><p>创建 App 后可导入镜像，或使用已安装 Adapter 的构建策略。</p></div> : <div className="apps-catalog-layout">
        <section className="app-list-section">
          <div className="section-heading"><div><h2>应用</h2><p>选择一个 App 更新镜像。</p></div></div>
          <div className="resource-filters"><label>搜索<input value={appQuery} onChange={(event) => { setAppQuery(event.target.value); setAppPage(1); }} placeholder="App ID、名称或描述" /></label></div>
          <div className="app-list" role="listbox" aria-label="App 列表">
            {visibleApps.map((app) => <button type="button" role="option" aria-selected={app.id === selectedAppId} className={`app-list-item${app.id === selectedAppId ? ' selected' : ''}`} key={app.id} onClick={() => { selectApp(app.id); setError(''); setNotice(''); }}><span className="app-list-icon"><Server size={16} /></span><span><strong>{app.name}</strong><small>{app.id} · {app.status === 'active' ? '启用' : '已归档'}</small></span><span className={`app-status-dot ${app.status}`} /></button>)}
          </div>
          <PaginationBar page={appPage} total={filteredApps.length} pageSize={appPageSize} onPage={setAppPage} onPageSize={(value) => { setAppPageSize(value); setAppPage(1); }} />
        </section>

        <section className="app-version-section">
          {selectedApp && <>
            <div className="section-heading"><div><div className="app-title-line"><h2>{selectedApp.name}</h2><span className={`app-status-badge ${selectedApp.status}`}>{selectedApp.status === 'active' ? '启用' : '已归档'}</span></div><p>{selectedApp.description || '暂无描述'} · <span className="mono">{selectedApp.id}</span></p></div><button className={selectedApp.status === 'active' ? 'danger-outline compact' : 'secondary compact'} disabled={busyVersion === `app:${selectedApp.id}` || imageUpdateBusy || uploadingPackageKey !== null} onClick={() => void toggleArchive(selectedApp)}>{busyVersion === `app:${selectedApp.id}` ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />}{selectedApp.status === 'active' ? '归档 App' : '重新启用'}</button></div>
            <div className="app-version-upload app-image-build-workbench">
              <div className="app-version-upload-heading">
                <div><strong>更新 App 镜像</strong><small>未替换的槽位继承当前 Revision；候选镜像通过运行测试后才可设为当前镜像。</small></div>
                {activeOperation && <span className="app-operation-status"><PackageCheck size={14} />{activeOperation.stage} {activeOperation.progress}%</span>}
              </div>
              <div className="app-current-revision">
                <span>当前 Revision</span><strong>{revisionLabel(currentRevision)}</strong>
                <small title={currentRevision?.imageReference ?? undefined}>{currentRevision?.imageReference ?? '尚未设置当前镜像'}</small>
              </div>
              <div className="app-build-strategy-row">
                <label>构建策略<select value={selectedStrategyId} disabled={imageUpdateBusy || uploadingPackageKey !== null || busyVersion !== null} onChange={(event) => { setSelectedStrategyId(event.target.value); setBuildPackages({}); setImageUpdateDraft(createAppImageUpdateDraft(inheritedPackageIdsForRevision(currentRevision))); }}>
                  {availableStrategies.map((strategy) => <option value={strategy.id} key={strategy.id}>{strategy.name}</option>)}
                </select></label>
                {selectedStrategy && <small>{selectedStrategy.description}</small>}
              </div>
              {strategyUnavailable && <div className="notice" role="status">{strategyUnavailableMessage}</div>}
              {selectedApp.canImportImage && <div className="app-package-upload-row"><label>已有镜像<input value={importImageReference} onChange={(event) => setImportImageReference(event.target.value)} placeholder="registry.example/app:version" disabled={imageUpdateBusy} /></label><button className="secondary" disabled={!selectedAppIsActive || imageUpdateBusy || !importImageReference.trim()} onClick={() => void importExistingImage()}>校验并导入镜像</button></div>}
              {!strategyUnavailable && selectedStrategy && <>
              <div className="app-package-slots">
                {selectedStrategy?.packageRequirements.map((requirement) => {
                  const availablePackages = packageCatalog.filter((pkg) => pkg.strategyId === selectedStrategy.id && pkg.key === requirement.key);
                  const inheritedId = imageUpdateDraft.inheritedPackageIds[requirement.key];
                  const replacementId = imageUpdateDraft.replacementPackageIds[requirement.key];
                  const inheritedPackage = inheritedId ? packageById.get(inheritedId) : undefined;
                  const replacementPackage = replacementId ? packageById.get(replacementId) : undefined;
                  const file = buildPackages[requirement.key];
                  const busy = uploadingPackageKey === requirement.key;
                  const missing = resolvedImageUpdate?.missingRequiredSlots.includes(requirement.key) ?? false;
                  return <div className={`app-package-slot${replacementId ? ' replaced' : ''}${missing ? ' incomplete' : ''}`} key={requirement.key}>
                    <div className="app-package-slot-heading"><strong>{requirement.key}</strong><span>{requirement.required ? '必需' : '可选'} · {requirement.acceptedExtensions.join(' / ')} · 最大 {formatBytes(requirement.maxBytes ?? MAX_BUILD_PACKAGE_BYTES)}</span></div>
                    <div className="app-package-baseline"><span>继承来源</span><strong>{inheritedId ? `${revisionLabel(currentRevision)} · 版本 ${sourceVersionLabel(inheritedPackage)}` : '当前 Revision 无此包'}</strong></div>
                    <div className="app-package-selection-row"><label>替换为<select value={replacementId === null ? '__remove__' : replacementId ?? ''} disabled={uploadingPackageKey !== null || imageUpdateBusy || busyVersion !== null} onChange={(event) => { setImageUpdateDraft((current) => replaceAppImageUpdatePackage(current, requirement.key, event.target.value === '__remove__' ? null : event.target.value)); setBuildPackages((current) => ({ ...current, [requirement.key]: null })); setPackageInputVersions((current) => ({ ...current, [requirement.key]: (current[requirement.key] ?? 0) + 1 })); }}><option value="">{inheritedId ? '不替换，继承当前包' : requirement.required ? '请选择替换包' : '不使用'}</option>{!requirement.required && inheritedId && <option value="__remove__">移除当前包</option>}{availablePackages.map((pkg) => <option value={pkg.id} key={pkg.id}>版本 {sourceVersionLabel(pkg)} · {pkg.originalName} · {formatBytes(pkg.artifact.size)}</option>)}</select></label>{replacementId !== undefined && <button className="icon-button compact" title="恢复继承当前包" aria-label={`恢复继承 ${requirement.key} 当前包`} disabled={uploadingPackageKey !== null || imageUpdateBusy || busyVersion !== null} onClick={() => setImageUpdateDraft((current) => resetAppImageUpdateSlot(current, requirement.key))}><RotateCcw size={14} /></button>}</div>
                    <div className="app-package-upload-row"><input key={`${selectedStrategy.id}-${requirement.key}-${packageInputVersions[requirement.key] ?? 0}`} type="file" aria-label={`上传 ${requirement.key} 构建包`} accept={requirement.acceptedExtensions.join(',')} disabled={strategyUnavailable || uploadingPackageKey !== null || imageUpdateBusy || busyVersion !== null} onChange={(event) => { const next = event.target.files?.[0] ?? null; setBuildPackages((current) => ({ ...current, [requirement.key]: next })); setError(''); }} /><button className="secondary compact" disabled={strategyUnavailable || !file || uploadingPackageKey !== null || imageUpdateBusy || busyVersion !== null} onClick={() => void uploadStrategyPackage(requirement)}>{busy ? <LoaderCircle className="spin" size={14} /> : <CloudUpload size={14} />}{busy ? '上传中' : '上传并替换'}</button></div>
                    <small>{replacementId === null ? '新版本将移除此槽位' : file ? `${file.name} · ${formatBytes(file.size)}` : replacementPackage ? `将替换为来源版本 ${sourceVersionLabel(replacementPackage)} · ${replacementPackage.originalName}` : missing ? '缺少必需包，请选择或上传' : inheritedId ? `将继承来源版本 ${sourceVersionLabel(inheritedPackage)}` : '当前不使用此槽位'}</small>
                  </div>;
                })}
              </div>
              <div className="app-build-actions"><span>{resolvedImageUpdate?.changedSlots.length ? `将更新 ${resolvedImageUpdate.changedSlots.join('、')}` : '尚未选择替换包'}</span><button className="primary" disabled={strategyUnavailable || !selectedAppIsActive || !resolvedImageUpdate?.canBuild || imageUpdateBusy || uploadingPackageKey !== null || busyVersion !== null} onClick={() => void buildImageCandidate()}>{imageUpdateBusy ? <LoaderCircle className="spin" size={15} /> : <PackageCheck size={15} />}{imageUpdateBusy ? '正在构建并测试' : '构建并测试候选镜像'}</button></div>
              </>}
              {!selectedAppIsActive && <p className="app-muted-note">当前 App 已归档；重新启用后才能构建或切换镜像。</p>}
            </div>

            <div className="section-heading app-versions-heading"><div><h2>Revision 历史</h2><p>每个 Revision 固定记录各槽位的包来源和不可变镜像；可将已测试候选设为当前镜像。</p></div><div className="section-commands"><label>搜索<input value={versionQuery} onChange={(event) => { setVersionQuery(event.target.value); setVersionPage(1); }} placeholder="版本、构建或镜像" /></label><button className="icon-button" title="刷新 Revision" aria-label="刷新 Revision" disabled={versionsLoading} onClick={() => void loadVersions(selectedApp.id)}><RefreshCw className={versionsLoading ? 'spin' : ''} size={16} /></button></div></div>
            <div className="table-wrap app-versions-table app-revisions-table"><table><thead><tr><th>Revision</th><th>构建包来源</th><th>镜像</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{versionsLoading && versions.length === 0 ? <EmptyRow columns={5} text="正在加载 Revision" /> : versions.length === 0 ? <EmptyRow columns={5} text="尚无 Revision，请先导入镜像或选择构建包" /> : visibleVersions.map((revision) => {
              const revisionBusy = busyVersion === revision.id;
              const packages = packagesForAppVersion(revision);
              return <tr key={revision.id}><td><strong>{revisionLabel(revision)}</strong><small>{formatDate(revision.createdAt)}</small></td><td><div className="app-revision-packages">{packages.length === 0 ? <span>无包快照</span> : packages.map((pkg) => { const sourcePackage = pkg.packageId ? packageById.get(pkg.packageId) : undefined; return <span key={pkg.key}><b>{pkg.key}</b><small>来源版本 {sourceVersionLabel(sourcePackage)}</small></span>; })}</div></td><td><strong className="mono app-revision-image" title={revision.imageReference ?? undefined}>{revision.imageReference ? `${revision.imageReference.slice(0, 32)}${revision.imageReference.length > 32 ? '…' : ''}` : '尚无候选镜像'}</strong></td><td><span className={`app-version-status ${revision.status}`}>{revision.status === 'active' ? <Check size={13} /> : null}{STATUS_LABELS[revision.status]}</span>{revision.activatedAt && <small>{formatDate(revision.activatedAt)}</small>}</td><td className="row-actions app-version-actions">{revision.status === 'image_ready' ? <button className="secondary compact" disabled={revisionBusy || !selectedAppIsActive || busyVersion !== null || imageUpdateBusy} onClick={() => void bindImageCandidate(revision)}>{revisionBusy ? <LoaderCircle className="spin" size={14} /> : <PackageCheck size={14} />}设为当前镜像</button> : revision.status === 'active' ? <span className="app-current-marker">已生效</span> : null}</td></tr>;
            })}</tbody></table></div><PaginationBar page={versionPage} total={filteredVersions.length} pageSize={versionPageSize} onPage={setVersionPage} onPageSize={(value) => { setVersionPageSize(value); setVersionPage(1); }} />
          </>}
        </section>
      </div>}
    </div>
  );
}
