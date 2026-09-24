import { Activity, Container, Cpu, Gauge, ShieldCheck, Users } from 'lucide-react';
import type { AdminOverview, ForwardingPolicy, RuntimeInfo } from '../../admin-api';

function formatBytes(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '-';
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function runtimeStatusLabel(runtime: RuntimeInfo | null): string {
  if (runtime === null) return '未知';
  if (runtime.available) return '正常';
  return runtime.capabilityStatus === 'unsupported' ? '未检测' : '异常';
}

export default function OverviewPanel({ overview, runtime, forwarding }: { overview: AdminOverview | null; runtime: RuntimeInfo | null; forwarding: ForwardingPolicy | null }) {
  if (!overview) return <div className="empty"><h2>暂无概览数据</h2></div>;
  const states = overview.states ?? {};
  const capacity = overview.capacity;
  const activity = overview.activity;
  return <div className="admin-section">
    <div className="stats admin-stats">
      <div><Users /><span><strong>{overview.users}</strong>Portal 用户</span></div>
      <div><Container /><span><strong>{overview.containers}</strong>App 实例</span></div>
      <div><Activity /><span><strong>{runtimeStatusLabel(runtime)}</strong>运行时状态</span></div>
      <div><ShieldCheck /><span><strong>{forwarding === null ? '未知' : forwarding.enabled ? '已启用' : '已关闭'}</strong>请求转发</span></div>
    </div>
    <div className="admin-monitor-grid">
      <section>
        <div className="monitor-heading"><Gauge size={17} /><h2>实例状态</h2></div>
        <div className="state-summary"><span>运行中 <b>{states.running ?? '-'}</b></span><span>已停止 <b>{states.stopped ?? '-'}</b></span><span>创建中 <b>{states.creating ?? '-'}</b></span><span>异常 <b>{states.failed ?? '-'}</b></span></div>
        {capacity && <p className="monitor-note">容量 {capacity.totalUsed}/{capacity.totalLimit}，运行中 {capacity.runningUsed}/{capacity.runningLimit}</p>}
      </section>
      <section>
        <div className="monitor-heading"><Cpu size={17} /><h2>当前资源</h2></div>
        <dl className="monitor-list"><div><dt>CPU</dt><dd>{activity?.cpuPercent == null ? '-' : `${activity.cpuPercent.toFixed(1)}%`}</dd></div><div><dt>内存</dt><dd>{formatBytes(activity?.memoryWorkingSetBytes)}</dd></div><div><dt>网络收发</dt><dd>{activity ? `${formatBytes(activity.networkRxBytes)} / ${formatBytes(activity.networkTxBytes)}` : '-'}</dd></div><div><dt>进程</dt><dd>{activity?.pids ?? '-'}</dd></div><div><dt>GPU</dt><dd>{activity?.gpuUtilizationPercent == null ? '-' : `${activity.gpuUtilizationPercent.toFixed(1)}%`}</dd></div></dl>
      </section>
    </div>
    {overview.persistenceDegraded && <section className="admin-alerts"><div className="critical"><strong>严重</strong><span>持久化暂不可用，当前保留上一次成功获取的可信概览。</span></div></section>}
    {overview.alerts && overview.alerts.length > 0 && <section className="admin-alerts"><h2>当前告警</h2>{overview.alerts.map((alert) => <div className={alert.severity} key={alert.id}><strong>{alert.severity === 'critical' ? '严重' : '提醒'}</strong><span>{alert.message}</span><time>{new Date(alert.createdAt).toLocaleTimeString('zh-CN')}</time></div>)}</section>}
    <div className="admin-summary-grid">
      <section><h2>执行 Provider</h2><dl><div><dt>兼容驱动</dt><dd>{runtime?.runtime ?? '-'}</dd></div><div><dt>状态</dt><dd>{runtimeStatusLabel(runtime)}</dd></div><div><dt>版本</dt><dd>{runtime?.version ?? '-'}</dd></div><div><dt>平台</dt><dd>{[runtime?.platform, runtime?.architecture].filter(Boolean).join(' / ') || '-'}</dd></div><div><dt>Provider 健康</dt><dd>{overview.providerHealth?.map((provider) => `${provider.providerId}: ${provider.status}`).join(' / ') || '-'}</dd></div></dl></section>
      <section><h2>服务策略</h2><dl><div><dt>身份提供方</dt><dd>{overview.authProvider}</dd></div><div><dt>用户</dt><dd>{overview.users}</dd></div><div><dt>实例</dt><dd>{overview.containers}</dd></div><div><dt>转发白名单</dt><dd>{forwarding ? `${forwarding.allowedHosts.length} 项` : '-'}</dd></div><div><dt>运行时健康</dt><dd>{overview.health?.status ?? '-'}</dd></div></dl></section>
    </div>
  </div>;
}
