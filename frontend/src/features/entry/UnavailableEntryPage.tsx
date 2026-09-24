import { ArrowRight, Plug } from 'lucide-react';

export default function UnavailableEntryPage({ missing }: { missing: boolean }) {
  return <main className="workspace-entry-shell">
    <div className="workspace-entry-brand"><img src="/openapp-logo.png" alt="" /><span>OpenApp</span></div>
    <section className="workspace-entry-card" aria-labelledby="entry-status-title">
      <div className="workspace-entry-setup-icon"><Plug size={25} aria-hidden="true" /></div>
      <h1 id="entry-status-title">{missing ? '尚未配置应用 Adapter' : '应用入口暂不可用'}</h1>
      <p className="workspace-entry-error-message">{missing
        ? 'OpenApp 控制面已启动。当前未加载应用适配器，暂时无法进入业务应用。'
        : '暂时无法获取应用入口，请稍后刷新重试，或进入管理控制台检查服务状态。'}</p>
      <a className="primary workspace-entry-control-link" href="/control">进入管理控制台<ArrowRight size={17} aria-hidden="true" /></a>
      {missing && <p className="workspace-entry-setup-hint">接入 Adapter 并重新组合部署后，这里将显示应用入口。</p>}
    </section>
  </main>;
}
