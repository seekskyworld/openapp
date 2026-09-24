import { useEffect, useState } from 'react';
import { AlertCircle, KeyRound, LoaderCircle, X } from 'lucide-react';
import type { PortalUser } from '../../api';
import { isManagementRole } from '../../user-role';
import { authApi } from '../../auth-api';
import { formatAuthError } from '../../auth-i18n';

type VerifyMode = 'password' | 'external';

export default function PasswordDialog({ user, onClose, onChanged }: { user: PortalUser; onClose: () => void; onChanged: (user: PortalUser) => void }) {
  const linkedProviders = isManagementRole(user.role) ? [] : user.linkedProviders ?? [];
  const [provider, setProvider] = useState(linkedProviders[0] ?? '');
  const [mode, setMode] = useState<VerifyMode>('password');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState<'code' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [providerLabels, setProviderLabels] = useState<Record<string, string>>({});
  const newPasswordLength = Array.from(newPassword).length;
  const confirmationLength = Array.from(confirmation).length;
  const linkedProviderKey = linkedProviders.join('\0');

  useEffect(() => {
    if (!linkedProviderKey) return undefined;
    let active = true;
    void authApi.methods().then((methods) => {
      if (!active) return;
      setProviderLabels(Object.fromEntries(
        methods.external
          .filter((item) => item.id.trim() && item.label.trim())
          .map((item) => [item.id.trim().toLowerCase(), item.label.trim()]),
      ));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [linkedProviderKey]);

  async function sendCode() {
    if (!provider) return;
    setBusy('code'); setError('');
    try { await authApi.sendExternalPasswordCode(provider); setCodeSent(true); }
    catch (reason) { setError(formatAuthError(reason, '验证码发送失败，请稍后重试。', 'zh-CN')); }
    finally { setBusy(null); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmation) { setError('两次输入的密码不一致。'); return; }
    setBusy('save'); setError('');
    try {
      const updated = mode === 'external' && provider
        ? await authApi.changePasswordWithExternal(provider, code, newPassword)
        : await authApi.changePassword(currentPassword, newPassword);
      onChanged(updated);
    } catch (reason) { setError(formatAuthError(reason, '密码修改失败，请稍后重试。', 'zh-CN')); }
    finally { setBusy(null); }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dialog credential-dialog" role="dialog" aria-modal="true" aria-labelledby="password-dialog-title">
      <div className="dialog-heading"><div><p className="eyebrow">账号安全</p><h2 id="password-dialog-title">修改 OpenApp 密码</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></div>
      {provider && <div className="segments credential-modes"><button type="button" className={mode === 'password' ? 'active' : ''} onClick={() => { setMode('password'); setError(''); }}><KeyRound size={15} />原密码验证</button><button type="button" className={mode === 'external' ? 'active' : ''} onClick={() => { setMode('external'); setError(''); }}>第三方验证码</button></div>}
      <form onSubmit={submit}>
        {mode === 'password'
          ? <label>当前密码<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required autoComplete="current-password" /></label>
          : <>{linkedProviders.length > 1 && <label>验证方式<select value={provider} onChange={(event) => { setProvider(event.target.value); setCode(''); setCodeSent(false); setError(''); }}>{linkedProviders.map((id) => <option value={id} key={id}>{providerLabel(id, providerLabels)}</option>)}</select></label>}<label>发送至账号<span className="code-row"><input value={code} onChange={(event) => setCode(event.target.value.slice(0, 256))} placeholder="验证码"   required autoComplete="one-time-code" /><button type="button" className="secondary" onClick={() => void sendCode()} disabled={busy !== null}>{busy === 'code' ? <LoaderCircle className="spin" size={16} /> : codeSent ? '重新发送' : '发送验证码'}</button></span><span className="field-hint">使用 {providerLabel(provider, providerLabels)} 验证，验证码将发送至 {user.email}</span></label></>}
        <label>新密码<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 12 个字符" required autoComplete="new-password" /></label>
        <label>确认新密码<input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="再次输入密码" required autoComplete="new-password" /></label>
        {error && <div className="notice error"><AlertCircle size={17} /><span>{error}</span></div>}
        <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={busy !== null || newPasswordLength < 12 || confirmationLength < 12 || (mode === 'password' ? !currentPassword : !code.trim())}>{busy === 'save' ? <LoaderCircle className="spin" size={16} /> : null}保存密码</button></div>
      </form>
    </section>
  </div>;
}

function providerLabel(provider: string, labels: Readonly<Record<string, string>>): string {
  const normalized = provider.trim().toLowerCase();
  return labels[normalized] ?? (provider.trim() || '认证 Provider');
}
