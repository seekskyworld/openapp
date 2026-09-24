import { useEffect, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import { api, type PortalEntryManifest } from '../../api';
import {
  DEFAULT_ENTRY_MANIFEST,
  prepareUserWorkspace,
  WorkspaceEntryError,
  type WorkspaceEntryGateway,
  type WorkspaceEntryStage,
} from './user-entry-flow';

interface WorkspaceEntryPageProps {
  gateway?: WorkspaceEntryGateway;
  wait?: (milliseconds: number) => Promise<void>;
  navigate?: (url: string) => void;
}

const defaultNavigate = (url: string) => window.location.assign(url);

const stageLabels: Record<WorkspaceEntryStage, string> = {
  checking: '正在检查工作区',
  creating: '正在创建工作区',
  entering: '正在打开工作区',
  recovering: '正在恢复工作区',
};

const stageTitles: Record<WorkspaceEntryStage, string> = {
  checking: '无法读取工作区',
  creating: '无法创建工作区',
  entering: '工作区启动失败',
  recovering: '工作区需要管理员处理',
};

const statusLabels: Record<NonNullable<WorkspaceEntryError['containerStatus']>, string> = {
  creating: '创建中',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  stopped: '已停止',
  failed: '异常',
};

function errorTitle(error: WorkspaceEntryError): string {
  if (error.code === 'unauthorized' || error.code === 'session_expired' || error.code === 'app_auth_reauthentication_required') {
    return '登录状态已失效';
  }
  return error.stage ? stageTitles[error.stage] : '暂时无法进入工作区';
}

export default function WorkspaceEntryPage({ gateway = api, wait, navigate = defaultNavigate }: WorkspaceEntryPageProps) {
  const [stage, setStage] = useState<WorkspaceEntryStage>('checking');
  const [manifest, setManifest] = useState<PortalEntryManifest>(DEFAULT_ENTRY_MANIFEST);
  const [error, setError] = useState<WorkspaceEntryError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let active = true;
    setError(null);
    const run = async () => {
      await Promise.resolve();
      if (!active) return;
      try {
        const result = await prepareUserWorkspace({
          gateway,
          wait,
          onStage: (nextStage) => { if (active) setStage(nextStage); },
          onManifest: (nextManifest) => { if (active) setManifest(nextManifest); },
        });
        if (active) navigate(result.url);
      } catch (reason) {
        if (!active) return;
        setRetrying(false);
        setError(reason instanceof WorkspaceEntryError ? reason : new WorkspaceEntryError('暂时无法准备你的工作区，请稍后重试。'));
      }
    };
    void run();
    return () => { active = false; };
  }, [attempt, gateway, navigate, wait]);

  if (error) {
    return <main className="workspace-entry-shell workspace-entry-error-shell">
      <div className="workspace-entry-brand"><img src={manifest.entry.logoUrl} alt="" /><span>{manifest.appName}</span></div>
      <section className="workspace-entry-card" role="alert" aria-live="polite">
        <div className="workspace-entry-error-icon"><AlertCircle size={25} /></div>
        <h1>{errorTitle(error)}</h1>
        <p className="workspace-entry-error-message">{error.message}</p>
        <dl className="workspace-entry-details">
          {error.containerIds.length > 0
            ? <div><dt>关联实例</dt><dd>{error.containerIds.join('、')}</dd></div>
            : error.stage === 'creating' && <div><dt>状态</dt><dd>尚未创建工作区</dd></div>}
          {error.containerStatus && <div><dt>当前状态</dt><dd>{statusLabels[error.containerStatus]}</dd></div>}
          {error.code && <div><dt>错误代码</dt><dd>{error.code}</dd></div>}
          {error.requestId && <div><dt>请求编号</dt><dd>{error.requestId}</dd></div>}
        </dl>
        <button className="primary" type="button" disabled={retrying} onClick={() => { setRetrying(true); setAttempt((value) => value + 1); }}><RefreshCw size={17} />{retrying ? '重试中' : '重试'}</button>
      </section>
    </main>;
  }

  return <main className="workspace-entry-shell" aria-busy="true" aria-live="polite">
    <div className="workspace-entry-brand"><img src={manifest.entry.logoUrl} alt="" /><span>{manifest.appName}</span></div>
    <section className="workspace-entry-loading">
      <LoaderCircle className="workspace-entry-spinner" size={38} aria-hidden="true" />
      <span className="sr-only">{stageLabels[stage]}</span>
    </section>
  </main>;
}
