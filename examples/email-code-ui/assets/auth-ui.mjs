/** 可复制的中性登录扩展；只使用宿主公开能力，不保存凭据或实现身份服务。 */
export const apiVersion = 1;
const providerId = 'sample-auth';

/** 接收宿主 React/HTTP 能力并返回两种登录视图；真实身份校验和会话仍由后端负责。 */
export function createAuthUi({ React, request, ApiError }) {
  const { createElement: h, useEffect, useRef, useState } = React;
  const endpoint = `/api/auth/external/${encodeURIComponent(providerId)}`;
  const copyFor = locale => locale === 'zh-CN'
    ? { title: '登录示例应用', email: '邮箱', code: '验证码', name: '显示名称', send: '获取验证码', resend: '重新发送', login: '登录', change: '更换邮箱', busy: '请稍候…', error: '请求失败，请重试。', invalid: '验证码无效，请重试。', required: '请填写显示名称。' }
    : { title: 'Sign in to Sample App', email: 'Email', code: 'Verification code', name: 'Display name', send: 'Get code', resend: 'Resend code', login: 'Sign in', change: 'Change email', busy: 'Please wait…', error: 'Request failed. Please retry.', invalid: 'Invalid verification code. Please retry.', required: 'Enter a display name.' };

  function useLogin({ onLogin, initialError }, copy) {
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [sent, setSent] = useState(false);
    const [needsName, setNeedsName] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(initialError);
    const generation = useRef(0);
    const active = useRef(null);
    useEffect(() => () => { generation.current++; active.current?.abort(); }, []);

    async function perform(operation) {
      if (active.current) return;
      const controller = new AbortController();
      const current = generation.current;
      active.current = controller;
      setBusy(true);
      setError(undefined);
      const isCurrent = () => current === generation.current && !controller.signal.aborted;
      try { await operation(controller.signal, isCurrent); }
      catch (reason) {
        if (!isCurrent()) return;
        setError(reason);
        if (reason instanceof ApiError && reason.code === 'display_name_required') setNeedsName(true);
      } finally {
        // 被取消的旧请求不能清掉新一轮登录的 pending 状态。
        if (active.current === controller) active.current = null;
        if (isCurrent()) setBusy(false);
      }
    }

    function reset() {
      generation.current++;
      active.current?.abort();
      active.current = null;
      setBusy(false);
      setSent(false);
      setCode('');
      setDisplayName('');
      setNeedsName(false);
      setError(undefined);
    }
    const send = () => perform(async (signal, isCurrent) => {
      const result = await request(`${endpoint}/email-codes`, { method: 'POST', signal, body: JSON.stringify({ email: email.trim() }) });
      if (result?.ok !== true) throw new ApiError(200, 'invalid_server_response');
      if (!isCurrent()) return;
      setNeedsName(result.providerData?.requiresDisplayName === true);
      setCode('');
      setSent(true);
    });
    const submit = event => {
      event.preventDefault();
      if (!email.trim() || (sent && (!code.trim() || (needsName && !displayName.trim())))) return;
      if (!sent) return send();
      return perform(async (signal, isCurrent) => {
        const result = await request(`${endpoint}/login`, { method: 'POST', signal, body: JSON.stringify({
          email: email.trim(), code: code.trim(), providerData: needsName ? { displayName: displayName.trim() } : {},
        }) });
        if (!result?.user?.id || !result.user.email || !result.user.role) throw new ApiError(200, 'invalid_server_response');
        if (isCurrent()) { setCode(''); onLogin(result.user); }
      });
    };
    const publicErrors = { verification_code_invalid: copy.invalid, display_name_required: copy.required };
    const message = error ? (error instanceof ApiError && Object.hasOwn(publicErrors, error.code) ? publicErrors[error.code] : copy.error) : '';
    return { email, setEmail, code, setCode, displayName, setDisplayName, sent, needsName, busy, message, reset, send, submit };
  }

  function LoginView({ variant, ...props }) {
    const copy = copyFor(props.locale);
    const flow = useLogin(props, copy);
    const [open, setOpen] = useState(variant === 'workspace');
    const input = (label, type, value, onChange, options = {}) => h('label', null, label,
      h('input', { 'aria-label': label, type, value, onChange: e => onChange(e.target.value), disabled: flow.busy, required: true, ...options }));
    return h('section', { className: 'sample-auth', 'data-auth-view': variant },
      h('link', { rel: 'stylesheet', href: new URL('./login.css', import.meta.url).href }),
      !open ? h('button', { type: 'button', onClick: () => setOpen(true) },
        h('img', { src: new URL('./logo.svg', import.meta.url).href, alt: '' }), copy.title)
      : h(React.Fragment, null,
        h('h2', null, copy.title),
        h('form', { onSubmit: flow.submit },
          !flow.sent ? input(copy.email, 'email', flow.email, flow.setEmail, { autoComplete: 'email', maxLength: 320 })
          : h(React.Fragment, null,
            h('p', null, flow.email),
            input(copy.code, 'text', flow.code, flow.setCode, { autoComplete: 'one-time-code', maxLength: 256 }),
            flow.needsName && input(copy.name, 'text', flow.displayName, flow.setDisplayName, { maxLength: 80 }),
            h('button', { type: 'button', onClick: flow.reset }, copy.change),
            h('button', { type: 'button', disabled: flow.busy, onClick: flow.send }, copy.resend)),
          flow.message && h('p', { role: 'alert' }, flow.message),
          h('button', { type: 'submit', disabled: flow.busy }, flow.busy ? copy.busy : flow.sent ? copy.login : copy.send))));
  }
  return { views: {
    workspace: props => h(LoginView, { ...props, variant: 'workspace' }),
    control: props => h(LoginView, { ...props, variant: 'control' }),
  } };
}
