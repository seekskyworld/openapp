import { AppWindow, Gauge, History, Image, LoaderCircle, Network, RefreshCw, Settings2, Users } from 'lucide-react';
import ForwardingPanel from './features/admin/ForwardingPanel';
import AppsPanel from './features/admin/AppsPanel';
import OverviewPanel from './features/admin/OverviewPanel';
import OperationsPanel from './features/admin/OperationsPanel';
import PolicyPanel from './features/admin/PolicyPanel';
import ResourcesPanel from './features/admin/ResourcesPanel';
import RuntimePanel from './features/admin/RuntimePanel';
import { useAdminWorkspace } from './features/admin/useAdminWorkspace';
import type { AdminView } from './navigation';
import type { PortalUser } from './api';

export default function AdminDashboard({ currentUser, view, onViewChange }: {
  currentUser: PortalUser;
  view: AdminView;
  onViewChange: (view: AdminView) => void;
}) {
  const workspace = useAdminWorkspace();
  const dataTime = workspace.lastUpdatedAt ? new Date(workspace.lastUpdatedAt).toLocaleTimeString('zh-CN') : '尚未采集';

  return (
    <section className="page admin-workbench">
      <div className="page-title">
        <div><p className="eyebrow">管理员</p><h1>OpenApp 管理工作台</h1><p>管理账号、实例运行时、镜像与访问转发策略。</p></div>
        <button className="icon-button" title="刷新全部数据" onClick={() => void workspace.load()} disabled={workspace.refreshing}>
          <RefreshCw className={workspace.refreshing ? 'spin' : ''} size={18} />
        </button>
      </div>
      <div className="admin-status-strip" role="status">
        <span className="admin-live"><i />自动刷新中</span>
        <span>数据时间 {dataTime}</span>
        <span className={workspace.failedSources.length > 0 ? 'stale' : ''}>{workspace.failedSources.length > 0 ? '部分数据过期' : '数据正常'}</span>
        <span className="admin-status-spacer" />
        <span>运行时 {workspace.runtime === null ? '未知' : workspace.runtime.available ? '可用' : '不可用'}</span>
        <span>转发 {workspace.forwarding === null ? '未知' : workspace.forwarding.enabled ? '已启用' : '已关闭'}</span>
      </div>
      <nav className="admin-tabs" aria-label="管理视图">
        <button className={view === 'overview' ? 'active' : ''} onClick={() => onViewChange('overview')}><Gauge size={16} />概览</button>
        <button className={view === 'resources' ? 'active' : ''} onClick={() => onViewChange('resources')}><Users size={16} />用户与实例</button>
        <button className={view === 'apps' ? 'active' : ''} onClick={() => onViewChange('apps')}><AppWindow size={16} />App 目录</button>
        <button className={view === 'policy' ? 'active' : ''} onClick={() => onViewChange('policy')}><Settings2 size={16} />实例策略</button>
        <button className={view === 'runtime' ? 'active' : ''} onClick={() => onViewChange('runtime')}><Image size={16} />运行时与镜像</button>
        <button className={view === 'forwarding' ? 'active' : ''} onClick={() => onViewChange('forwarding')}><Network size={16} />转发策略</button>
        <button className={view === 'operations' ? 'active' : ''} onClick={() => onViewChange('operations')}><History size={16} />操作与审计</button>
      </nav>
      {workspace.error && <div className="notice error" role="alert">{workspace.error}</div>}
      {workspace.notice && <div className="notice success" role="status">{workspace.notice}</div>}
      {workspace.loading && view !== 'operations' ? (
        <div className="center-state"><LoaderCircle className="spin" /><p>正在加载管理工作台</p></div>
      ) : (
        <>
          {view === 'overview' && <OverviewPanel overview={workspace.overview} runtime={workspace.runtime} forwarding={workspace.forwarding} />}
          {view === 'resources' && (
            <ResourcesPanel
              currentUser={currentUser}
              users={workspace.users}
              containers={workspace.containers}
              busy={workspace.busy}
              error={workspace.error}
              onCreateUser={workspace.createUser}
              onRole={workspace.updateRole}
              onContainer={workspace.containerAction}
              onBatch={workspace.batchContainerAction}
              onOpenOperations={() => onViewChange('operations')}
            />
          )}
          {view === 'apps' && <AppsPanel images={workspace.images} />}
          {view === 'policy' && (workspace.instancePolicy ? (
            <PolicyPanel
              policy={workspace.instancePolicy}
              apps={workspace.apps}
              revision={workspace.policyRevision}
              containerCount={workspace.overview?.containers ?? workspace.containers.length}
              busy={Boolean(workspace.busy.policy)}
              onSaved={(policy, revision) => { workspace.setInstancePolicy(policy); workspace.setPolicyRevision(revision ?? workspace.policyRevision); }}
              setBusy={workspace.setBusy}
              setError={workspace.setError}
              setNotice={workspace.setNotice}
            />
          ) : <div className="empty"><h2>实例策略暂不可用</h2><p>请检查管理接口或刷新页面。</p></div>)}
          {view === 'runtime' && (
            <RuntimePanel
              runtime={workspace.runtime}
              images={workspace.images}
              busy={workspace.busy}
              setBusy={workspace.setBusy}
              setImages={workspace.setImages}
              setError={workspace.setError}
              setNotice={workspace.setNotice}
            />
          )}
          {view === 'forwarding' && workspace.forwarding && (
            <ForwardingPanel
              forwarding={workspace.forwarding}
              busy={Boolean(workspace.busy.forwarding)}
              onSaved={workspace.setForwarding}
              setBusy={workspace.setBusy}
              setError={workspace.setError}
              setNotice={workspace.setNotice}
            />
          )}
          {view === 'operations' && <OperationsPanel users={workspace.users} />}
        </>
      )}
    </section>
  );
}
