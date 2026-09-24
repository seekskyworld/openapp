import { useState } from 'react';
import { AlertCircle, KeyRound, LoaderCircle } from 'lucide-react';
import type { PortalUser } from '../../api';
import { authApi } from '../../auth-api';
import { formatAuthError } from '../../auth-i18n';

export default function PasswordSetupPage({ user, onComplete }: { user: PortalUser; onComplete: (user: PortalUser) => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const passwordLength = Array.from(password).length;
  const confirmationLength = Array.from(confirmation).length;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirmation) { setError('两次输入的密码不一致。'); return; }
    setBusy(true); setError('');
    try { onComplete(await authApi.setupPassword(password)); }
    catch (reason) { setError(formatAuthError(reason, '密码设置失败，请稍后重试。', 'zh-CN')); }
    finally { setBusy(false); }
  }

  return <main className="credential-page"><section className="credential-card"><div className="credential-icon"><KeyRound size={22} /></div><p className="eyebrow">首次登录</p><h1>设置 OpenApp 密码</h1><p>你已使用第三方账号验证 <strong>{user.email}</strong>。请设置本系统密码，之后可以直接登录 OpenApp。</p><form onSubmit={submit}><label>新密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 12 个字符" required autoComplete="new-password" /></label><label>确认新密码<input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="再次输入密码" required autoComplete="new-password" /></label>{error && <div className="notice error"><AlertCircle size={17} /><span>{error}</span></div>}<button className="primary full" disabled={busy || passwordLength < 12 || confirmationLength < 12}>{busy ? <><LoaderCircle className="spin" size={17} />正在保存</> : '设置密码并继续'}</button></form></section></main>;
}
