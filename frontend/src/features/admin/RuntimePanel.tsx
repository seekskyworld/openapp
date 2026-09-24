import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Download, HardDriveUpload, LoaderCircle, RefreshCw, Server, Trash2 } from 'lucide-react';
import {
  adminApi,
  type AdminOperation,
  type ResourceCleanupBlocker,
  type ResourceCleanupItem,
  type ResourceCleanupPreview,
  type ResourceCleanupRun,
  type RuntimeImage,
  type RuntimeInfo,
} from '../../admin-api';
import { ADMIN_OPERATION_TIMEOUT_MS, pollAdminOperation } from './operation-polling';
import { EmptyRow, PaginationBar, message, paginateItems, usePersistentPageSize } from './shared';

interface RuntimePanelProps {
  runtime: RuntimeInfo | null;
  images: RuntimeImage[];
  busy: Record<string, boolean>;
  setBusy: (value: Record<string, boolean>) => void;
  setImages: Dispatch<SetStateAction<RuntimeImage[]>>;
  setError: (value: string) => void;
  setNotice: (value: string) => void;
}

function runtimeErrorLabel(code: string): string {
  if (code === 'provider_health_unsupported') return '当前 Provider 不提供健康检查；这不表示工作区运行故障。';
  if (code === 'provider_unavailable' || code === 'provider_health_unavailable') return '当前 Provider 暂时不可用，请检查服务连接和后端日志。';
  if (code === 'docker_socket_permission_denied') return 'Docker Socket 权限不足，请核对 DOCKER_GID 后重建 Portal Backend。';
  if (code === 'docker_daemon_unavailable') return '无法连接 Docker daemon，请确认服务和 Socket 挂载。';
  return 'Provider 状态检查失败，请查看 Portal Backend 日志。';
}

export default function RuntimePanel({
  runtime,
  images,
  busy,
  setBusy,
  setImages,
  setError,
  setNotice,
}: RuntimePanelProps) {
  const [reference, setReference] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [loadReference, setLoadReference] = useState('');
  const [activeOperation, setActiveOperation] = useState<AdminOperation | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<ResourceCleanupPreview | null>(null);
  const [imagePage, setImagePage] = useState(1);
  const [imagePageSize, setImagePageSize] = usePersistentPageSize('runtime-images');
  const [imageQuery, setImageQuery] = useState('');
  const [cleanupKeepPrevious, setCleanupKeepPrevious] = useState(1);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupDeleting, setCleanupDeleting] = useState<string | null>(null);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupError, setCleanupError] = useState('');
  const mounted = useRef(false);
  const operationControllers = useRef(new Set<AbortController>());
  const cleanupController = useRef<AbortController | null>(null);
  const cleanupRunController = useRef<AbortController | null>(null);
  const cleanupDeleteInFlight = useRef<string | null>(null);
  const cleanupRequestVersion = useRef(0);
  const lifecycleVersion = useRef(0);

  useEffect(() => {
    mounted.current = true;
    lifecycleVersion.current += 1;
    void refreshCleanupPreview(1);
    return () => {
      mounted.current = false;
      lifecycleVersion.current += 1;
      cleanupRequestVersion.current += 1;
      for (const controller of operationControllers.current) controller.abort(new DOMException('Runtime panel unmounted', 'AbortError'));
      operationControllers.current.clear();
      cleanupController.current = null;
      cleanupRunController.current = null;
      cleanupDeleteInFlight.current = null;
      setBusy({ pull: false, load: false });
    };
  }, [setBusy]);

  function beginOperation(): AbortController {
    const controller = new AbortController();
    operationControllers.current.add(controller);
    return controller;
  }

  async function waitForOperation(id: string, signal: AbortSignal): Promise<AdminOperation> {
    return pollAdminOperation(id, {
      signal,
      timeoutMs: ADMIN_OPERATION_TIMEOUT_MS,
      requestOperation: adminApi.operation,
      onUpdate: (operation) => {
        if (mounted.current && !signal.aborted) setActiveOperation(operation);
      },
    });
  }

  async function refreshImages(signal: AbortSignal): Promise<void> {
    const result = await adminApi.images(signal);
    signal.throwIfAborted();
    if (mounted.current) setImages(result.images);
  }

  async function refreshCleanupPreview(previousRevisions = cleanupKeepPrevious): Promise<boolean> {
    cleanupController.current?.abort(new DOMException('Cleanup preview superseded', 'AbortError'));
    const controller = beginOperation();
    const requestVersion = ++cleanupRequestVersion.current;
    cleanupController.current = controller;
    setCleanupLoading(true);
    setCleanupError('');
    try {
      const previewResult = await adminApi.resourceCleanupPreview(previousRevisions, controller.signal);
      controller.signal.throwIfAborted();
      if (mounted.current && cleanupRequestVersion.current === requestVersion) {
        setCleanupPreview(previewResult.preview);
        return true;
      }
      return false;
    } catch (reason) {
      if (mounted.current && cleanupRequestVersion.current === requestVersion && !controller.signal.aborted) {
        setCleanupError(cleanupErrorLabel(reason, '资源清理预览加载失败'));
      }
      return false;
    } finally {
      operationControllers.current.delete(controller);
      if (cleanupController.current === controller) cleanupController.current = null;
      if (mounted.current && cleanupRequestVersion.current === requestVersion) setCleanupLoading(false);
    }
  }

  async function deleteCleanupResource(item: ResourceCleanupItem): Promise<void> {
    if (
      item.blockers.length > 0
      || cleanupDeleteInFlight.current
      || cleanupRunController.current
      || cleanupDeleting
      || cleanupRunning
      || cleanupLoading
      || cleanupError !== ''
      || cleanupPreview === null
      || cleanupKeepPrevious !== cleanupPreview.retention.previousRevisions
    ) return;
    const isPackage = item.kind === 'build_package';
    const resourceLabel = isPackage ? '构建包' : '镜像产物';
    const impact = isPackage
      ? '构建包记录和对应存储文件将被删除，且无法恢复。'
      : '镜像产物记录将被删除；仅当运行时镜像仍与该产物匹配时，对应镜像才会一并清理。';
    if (!window.confirm(`确定删除${resourceLabel} ${item.id}？${impact}`)) return;

    const key = `${item.kind}:${item.id}`;
    const lifecycle = lifecycleVersion.current;
    cleanupDeleteInFlight.current = key;
    setCleanupDeleting(key);
    setCleanupError('');
    setError('');
    try {
      let successNotice: string;
      if (isPackage) {
        const result = await adminApi.deleteBuildPackage(item.id);
        successNotice = result.deleted.storageRemoved
          ? `构建包 ${item.id} 及其存储文件已删除。`
          : `构建包 ${item.id} 的记录已删除，但存储文件未确认清理，请检查后端日志。`;
      } else {
        const result = await adminApi.deleteImageArtifact(item.id);
        successNotice = result.deleted.runtimeImageRemoved
          ? `镜像产物 ${item.id} 及对应运行时镜像已删除。`
          : `镜像产物 ${item.id} 的记录已删除；运行时镜像未删除，可能已不存在或已被替换。`;
      }
      if (!mounted.current || lifecycleVersion.current !== lifecycle) return;
      setNotice(successNotice);
      await refreshCleanupPreview(cleanupKeepPrevious);
    } catch (reason) {
      if (mounted.current && lifecycleVersion.current === lifecycle) setCleanupError(cleanupErrorLabel(reason, `${resourceLabel}删除失败`));
    } finally {
      if (lifecycleVersion.current === lifecycle && cleanupDeleteInFlight.current === key) cleanupDeleteInFlight.current = null;
      if (mounted.current && lifecycleVersion.current === lifecycle) setCleanupDeleting(null);
    }
  }

  async function runResourceCleanup(): Promise<void> {
    if (
      cleanupRunController.current
      || cleanupDeleteInFlight.current
      || cleanupDeleting
      || cleanupRunning
      || cleanupLoading
      || cleanupError !== ''
      || cleanupPreview === null
      || cleanupKeepPrevious !== cleanupPreview.retention.previousRevisions
    ) return;
    const keepPrevious = cleanupPreview.retention.previousRevisions;
    const confirmed = window.confirm([
      '确定按当前保留策略执行资源清理？',
      '',
      `- 每个 App 保留最近 ${keepPrevious} 个可回滚 Revision，且保留数始终不少于 1；当前 Revision 永远保留。`,
      '- 任何 Container 正在引用的 Revision、包和镜像都不会处理。',
      '- 更旧且未被 Container 引用的 Revision 会归档，并解除其构建包与镜像关联。',
      '- 解除关联后没有其他引用的构建包和镜像产物会永久删除，无法恢复。',
      '',
      '执行时服务端会重新检查全部引用，并只处理满足以上规则的资源。',
    ].join('\n'));
    if (!confirmed) return;

    const controller = beginOperation();
    const lifecycle = lifecycleVersion.current;
    cleanupRunController.current = controller;
    setCleanupRunning(true);
    setCleanupError('');
    setError('');
    try {
      const { result } = await adminApi.runResourceCleanup(keepPrevious, controller.signal);
      controller.signal.throwIfAborted();
      if (!mounted.current || lifecycleVersion.current !== lifecycle) return;
      setNotice(resourceCleanupResultLabel(result));

      const imageRefresh = refreshImages(controller.signal).then(() => true, () => false);
      const [previewRefreshed, imagesRefreshed] = await Promise.all([
        refreshCleanupPreview(keepPrevious),
        imageRefresh,
      ]);
      controller.signal.throwIfAborted();
      if (!mounted.current || lifecycleVersion.current !== lifecycle) return;
      if (result.storageCleanupFailedIds.length > 0) {
        setCleanupError(`清理已完成，但 ${result.storageCleanupFailedIds.length} 个 Revision 的存储目录未清理，请检查后端日志：${result.storageCleanupFailedIds.map(shortId).join('、')}`);
      } else if (!previewRefreshed || !imagesRefreshed) {
        setCleanupError('资源清理已完成，但部分列表刷新失败。请重新刷新预览。');
      }
    } catch (reason) {
      if (mounted.current && lifecycleVersion.current === lifecycle && !controller.signal.aborted) {
        setCleanupError(cleanupErrorLabel(reason, '资源清理执行失败'));
      }
    } finally {
      operationControllers.current.delete(controller);
      if (cleanupRunController.current === controller) cleanupRunController.current = null;
      if (mounted.current && lifecycleVersion.current === lifecycle) setCleanupRunning(false);
    }
  }

  async function pull(): Promise<void> {
    const controller = beginOperation();
    setBusy({ pull: true });
    setError('');
    try {
      const submitted = await adminApi.pullImage(reference.trim(), controller.signal);
      controller.signal.throwIfAborted();
      setActiveOperation(submitted.operation);
      await waitForOperation(submitted.operationId, controller.signal);
      await refreshImages(controller.signal);
      controller.signal.throwIfAborted();
      setReference('');
      setNotice('镜像拉取完成。');
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setError(message(reason, '镜像拉取失败'));
    } finally {
      operationControllers.current.delete(controller);
      if (mounted.current) setBusy({ pull: false });
    }
  }

  async function loadImage(): Promise<void> {
    if (!imageFile || !loadReference.trim()) return;
    const controller = beginOperation();
    setBusy({ load: true });
    setError('');
    try {
      const submitted = await adminApi.loadImage(imageFile, loadReference.trim(), controller.signal);
      controller.signal.throwIfAborted();
      setActiveOperation(submitted.operation);
      await waitForOperation(submitted.operationId, controller.signal);
      await refreshImages(controller.signal);
      controller.signal.throwIfAborted();
      setImageFile(null);
      setLoadReference('');
      setNotice('镜像文件上传并导入完成。');
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setError(message(reason, '镜像导入失败'));
    } finally {
      operationControllers.current.delete(controller);
      if (mounted.current) setBusy({ load: false });
    }
  }

  const cleanupPreviewFresh = cleanupPreview !== null
    && cleanupKeepPrevious === cleanupPreview.retention.previousRevisions
    && cleanupError === ''
    && !cleanupLoading;
  const filteredImages = images.filter((image) => {
    const query = imageQuery.trim().toLowerCase();
    return !query || [image.reference, image.id, image.size].filter(Boolean).some((value) => value!.toLowerCase().includes(query));
  });
  const visibleImages = paginateItems(filteredImages, imagePage, imagePageSize);

  return (
    <div className="admin-section admin-stack">
      {activeOperation && (
        <section className="operation-strip" aria-live="polite">
          <div><strong>{operationLabel(activeOperation.type)}</strong><span>{activeOperation.stage}</span></div>
          <div className="operation-progress"><i style={{ width: `${activeOperation.progress}%` }} /></div>
          <span>{activeOperation.progress}%</span>
        </section>
      )}
      <section className="runtime-strip">
        <div className="runtime-icon"><Server /></div>
        <div>
          <h2>{runtime?.runtime ?? '容器运行时'}</h2>
          <p>{runtime?.host ?? '本机容器服务'} · {runtime?.version ?? '版本未知'}</p>
        </div>
        <span
          className={`runtime-health ${runtime?.available ? 'ok' : ''}`}
          style={runtime?.capabilityStatus === 'unsupported' ? { color: '#596579', background: '#eef1f5' } : undefined}
        >
          {runtime?.available ? '运行正常' : runtime?.capabilityStatus === 'unsupported' ? '未提供健康检查' : '不可用'}
        </span>
      </section>
      {!runtime?.available && runtime?.error && <div className={`notice ${runtime.capabilityStatus === 'unsupported' ? '' : 'error'}`} role="status">{runtimeErrorLabel(runtime.error)}</div>}

      <section>
        <div className="section-heading"><div><h2>添加镜像</h2><p>从 Registry 拉取，或上传 Docker/OCI 镜像归档。</p></div></div>
        <div className="image-actions">
          <div>
            <label>镜像地址<input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="registry.example.com/openapp:latest" /></label>
            <button className="primary" disabled={!reference.trim() || Boolean(busy.pull)} onClick={() => void pull()}>{busy.pull ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}拉取镜像</button>
          </div>
          <div>
            <label>导入后的镜像名称<input value={loadReference} onChange={(event) => setLoadReference(event.target.value)} placeholder="openapp:imported" /></label>
            <label>本地镜像归档<input type="file" accept=".tar,.tar.gz,.tgz,application/x-tar,application/gzip" onChange={(event) => setImageFile(event.target.files?.[0] ?? null)} /></label>
            {imageFile && <small>{imageFile.name} · {formatBytes(imageFile.size)}{busy.load ? ' · 正在上传并导入' : ''}</small>}
            <button className="secondary" disabled={!imageFile || !loadReference.trim() || Boolean(busy.load)} onClick={() => void loadImage()}>{busy.load ? <LoaderCircle className="spin" size={16} /> : <HardDriveUpload size={16} />}上传并导入</button>
          </div>
        </div>
      </section>

      <section>
        <div className="section-heading"><div><h2>本地镜像</h2><p>可用于创建 OpenApp 实例的运行镜像。</p></div><div className="section-commands"><label>搜索<input value={imageQuery} onChange={(event) => { setImageQuery(event.target.value); setImagePage(1); }} placeholder="镜像名称、ID 或大小" /></label><span>{filteredImages.length} 个镜像</span></div></div>
        <div className="table-wrap"><table><thead><tr><th>镜像</th><th>ID</th><th>大小</th></tr></thead><tbody>
          {visibleImages.length === 0 ? <EmptyRow columns={3} text="暂无镜像" /> : visibleImages.map((image) => <tr key={`${image.reference}:${image.id ?? ''}`}><td><strong>{image.reference}</strong></td><td className="mono">{image.id ?? '-'}</td><td>{image.size ?? '-'}</td></tr>)}
        </tbody></table></div>
        <PaginationBar page={imagePage} total={filteredImages.length} pageSize={imagePageSize} onPage={setImagePage} onPageSize={(value) => { setImagePageSize(value); setImagePage(1); }} />
      </section>

      <section className="resource-cleanup-section" aria-busy={cleanupRunning || cleanupLoading}>
        <div className="section-heading cleanup-heading">
          <div><h2>资源清理</h2><p>可以单独删除无引用资源，或按保留策略归档旧 Revision 后释放资源；系统不会自动清理，也不提供强制删除。</p></div>
          <div className="cleanup-controls">
            <label>保留回滚 Revision<input type="number" min={1} max={20} value={cleanupKeepPrevious} disabled={cleanupLoading || cleanupDeleting !== null || cleanupRunning} onChange={(event) => setCleanupKeepPrevious(Math.min(20, Math.max(1, Math.trunc(Number(event.target.value) || 1))))} /></label>
            <button className="secondary" disabled={cleanupLoading || cleanupDeleting !== null || cleanupRunning} onClick={() => void refreshCleanupPreview()}>{cleanupLoading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}刷新预览</button>
            <button className="danger-outline cleanup-run-button" disabled={!cleanupPreviewFresh || cleanupDeleting !== null || cleanupRunning} onClick={() => void runResourceCleanup()}>{cleanupRunning ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}{cleanupRunning ? '正在执行清理' : '按当前策略执行清理'}</button>
          </div>
        </div>
        <p className="cleanup-safety-note">默认至少保留 1 个上一 Revision 作为回滚点。任何已有 Revision、实例或镜像构建仍在引用的资源都会保持锁定。</p>
        {cleanupError && <div className="notice error cleanup-notice" role="alert">{cleanupError}</div>}
        {cleanupLoading && !cleanupPreview ? <div className="cleanup-loading" aria-live="polite"><LoaderCircle className="spin" size={18} />正在检查资源引用</div> : cleanupPreview && (
          <>
            <div className={`cleanup-summary${cleanupKeepPrevious !== cleanupPreview.retention.previousRevisions ? ' stale' : ''}`} aria-live="polite">
              <span>当前预览保留 <strong>{cleanupPreview.retention.previousRevisions}</strong> 个回滚 Revision</span>
              <span>当前无引用资源 <strong>{cleanupPreview.candidates.length}</strong> / {cleanupPreview.buildPackages.length + cleanupPreview.imageArtifacts.length} 项，可单独删除</span>
              <span>策略清理还会归档保留范围外且无实例引用的旧 Revision</span>
              {cleanupKeepPrevious !== cleanupPreview.retention.previousRevisions && <span>保留数量已更改，请刷新后再操作</span>}
            </div>
            {cleanupRunning && <div className="cleanup-run-status" aria-live="polite"><LoaderCircle className="spin" size={16} />正在归档旧 Revision，并清理解除引用后的构建包与镜像产物</div>}
            <CleanupResourceGroup
              title="构建包 (Build Package)"
              description="上传并通过策略检查的构建包。删除后不能再用于后续镜像构建。"
              emptyText="暂无 Build Package"
              items={cleanupPreview.buildPackages}
              listKey="cleanup-build-packages"
              deletingKey={cleanupDeleting}
              previewStale={cleanupKeepPrevious !== cleanupPreview.retention.previousRevisions}
              actionsDisabled={cleanupLoading || cleanupRunning || cleanupError !== ''}
              onDelete={deleteCleanupResource}
            />
            <CleanupResourceGroup
              title="镜像产物 (Image Artifact)"
              description="已完成构建和运行测试的不可变镜像产物。实例或 Revision 仍在使用时不能删除。"
              emptyText="暂无 Image Artifact"
              items={cleanupPreview.imageArtifacts}
              listKey="cleanup-image-artifacts"
              deletingKey={cleanupDeleting}
              previewStale={cleanupKeepPrevious !== cleanupPreview.retention.previousRevisions}
              actionsDisabled={cleanupLoading || cleanupRunning || cleanupError !== ''}
              onDelete={deleteCleanupResource}
            />
          </>
        )}
      </section>
    </div>
  );
}

interface CleanupResourceGroupProps {
  title: string;
  description: string;
  emptyText: string;
  items: ResourceCleanupItem[];
  listKey: string;
  deletingKey: string | null;
  previewStale: boolean;
  actionsDisabled: boolean;
  onDelete: (item: ResourceCleanupItem) => Promise<void>;
}

function CleanupResourceGroup({ title, description, emptyText, items, listKey, deletingKey, previewStale, actionsDisabled, onDelete }: CleanupResourceGroupProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistentPageSize(listKey);
  const [query, setQuery] = useState('');
  const filteredItems = items.filter((item) => {
    const value = query.trim().toLowerCase();
    return !value || [item.id, item.kind].some((entry) => entry.toLowerCase().includes(value));
  });
  const visibleItems = paginateItems(filteredItems, page, pageSize);
  return <div className="cleanup-resource-group">
    <div className="cleanup-resource-heading"><div><h3>{title}</h3><p>{description}</p></div><div className="section-commands"><label>搜索<input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="资源 ID" /></label><span>{filteredItems.length} 项</span></div></div>
    <div className="table-wrap cleanup-table"><table><thead><tr><th>资源</th><th>详情</th><th>引用状态</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>
      {visibleItems.length === 0 ? <EmptyRow columns={4} text={emptyText} /> : visibleItems.map((item) => {
        const detail = cleanupItemDetails(item);
        const key = `${item.kind}:${item.id}`;
        const blocked = item.blockers.length > 0;
        const deleting = deletingKey === key;
        return <tr key={key}>
          <td><strong>{detail.primary}</strong><small className="mono" title={item.id}>{item.id}</small></td>
          <td>{detail.secondary}</td>
          <td><div className="cleanup-blockers">{blocked ? item.blockers.map((blocker, index) => <span className={`cleanup-blocker ${blocker.type}`} key={`${blocker.type}:${blocker.id}:${index}`}>{cleanupBlockerLabel(blocker)}</span>) : <span className="cleanup-available">可删除</span>}</div></td>
          <td className="row-actions"><button className="danger-outline compact" disabled={blocked || previewStale || actionsDisabled || deletingKey !== null} title={blocked ? '仍有引用，不能删除' : previewStale || actionsDisabled ? '请先刷新预览' : `删除 ${item.id}`} onClick={() => void onDelete(item)}>{deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{deleting ? '删除中' : '删除'}</button></td>
        </tr>;
      })}
    </tbody></table></div><PaginationBar page={page} total={filteredItems.length} pageSize={pageSize} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} />
  </div>;
}

function cleanupBlockerLabel(blocker: ResourceCleanupBlocker): string {
  const revision = blocker.revision === undefined
    ? `${blocker.appId ?? 'App'} · ${shortId(blocker.id)}`
    : `${blocker.appId ?? 'App'} #${blocker.revision}`;
  if (blocker.type === 'active_app_revision') return `当前 Revision · ${revision}`;
  if (blocker.type === 'retained_rollback_revision') return `回滚保留 Revision · ${revision}`;
  if (blocker.type === 'app_revision') return `其他 Revision · ${revision}`;
  if (blocker.type === 'image_build') return `镜像构建 · ${shortId(blocker.id)}${blocker.status ? ` · ${buildStatusLabel(blocker.status)}` : ''}`;
  return `实例 · ${shortId(blocker.id)}${blocker.status ? ` · ${containerStatusLabel(blocker.status)}` : ''}`;
}

function cleanupItemDetails(item: ResourceCleanupItem): { primary: string; secondary: string } {
  if (item.kind === 'build_package') {
    const source = item.metadata.sourceVersion ? `来源版本 ${item.metadata.sourceVersion}` : `策略 ${item.metadata.strategyId}`;
    return { primary: item.metadata.originalName, secondary: `${item.metadata.key} · ${source} · ${formatBytes(item.metadata.size)}` };
  }
  return { primary: item.metadata.imageReference, secondary: `${shortId(item.metadata.imageId)} · ${item.metadata.runtimeContract}` };
}

function cleanupErrorLabel(reason: unknown, fallback: string): string {
  const code = reason instanceof Error ? reason.message : '';
  if (code === 'resource_in_use') return '资源引用关系已发生变化，当前不能删除。请刷新预览后重试。';
  if (code === 'build_package_not_found' || code === 'image_artifact_not_found') return '资源已不存在，请刷新预览。';
  if (code === 'invalid_cleanup_retention') return '回滚保留数量必须在 1 到 20 之间。';
  return message(reason, fallback);
}

function resourceCleanupResultLabel(result: ResourceCleanupRun): string {
  const changed = result.retiredRevisionIds.length
    + result.releasedBuildIds.length
    + result.deletedBuildPackageIds.length
    + result.deletedImageArtifactIds.length;
  if (changed === 0) return `资源检查完成，已保留最近 ${result.retention.previousRevisions} 个回滚 Revision，没有需要清理的资源。`;
  return `资源清理完成：归档 ${result.retiredRevisionIds.length} 个 Revision，释放 ${result.releasedBuildIds.length} 个构建，删除 ${result.deletedBuildPackageIds.length} 个构建包和 ${result.deletedImageArtifactIds.length} 个镜像产物。`;
}

function buildStatusLabel(status: string): string {
  const labels: Record<string, string> = { queued: '排队中', building: '构建中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
  return labels[status] ?? status;
}

function containerStatusLabel(status: string): string {
  const labels: Record<string, string> = { creating: '创建中', starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', failed: '异常' };
  return labels[status] ?? status;
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function operationLabel(type: string): string {
  if (type === 'image.pull') return '正在拉取镜像';
  if (type === 'image.load') return '正在导入镜像';
  return type;
}
