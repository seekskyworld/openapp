import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, CircleUserRound, Container, LoaderCircle, ShieldCheck } from 'lucide-react';
import { api, type PortalEntryManifest, type PortalUser } from '../../api';
import { authApi, type ExternalAuthProvider } from '../../auth-api';
import { authMessages, type AuthCompatibility } from '../../auth-i18n';
import AuthLanguageSelect from './AuthLanguageSelect';
import WorkspaceLoginPage from './WorkspaceLoginPage';
import { useAuthLocale } from './useAuthLocale';
import { loadAuthUiExtension } from './auth-ui';

const isGenericFrontendBuild = typeof __OPENAPP_FRONTEND_BUILD_TARGET__ === 'string'
  && __OPENAPP_FRONTEND_BUILD_TARGET__ === 'generic';
import {
  selectExternalProvider,
  verificationCodeInvalid,
  useEmailAuth,
} from './useEmailAuth';

type LoginRole = 'user' | 'admin';
function ErrorNotice({ message }: { message: string }) {
  return <div className="notice error"><AlertCircle size={17} /><span>{message}</span></div>;
}

function BrandLogo() {
  return <div className="brand-mark"><img src="/openapp-logo.png" alt="" /></div>;
}

export type LoginPageMode = 'control' | 'workspace';

export default function LoginPage({ onLogin, initialError, mode = 'control', manifest, compatibility }: {
  onLogin: (user: PortalUser) => void;
  initialError?: unknown;
  mode?: LoginPageMode;
  manifest?: PortalEntryManifest;
  compatibility?: AuthCompatibility;
}) {
  if (mode === 'workspace') return <WorkspaceLoginPage onLogin={onLogin} initialError={initialError} manifest={manifest} compatibility={compatibility} />;
  return <ControlLoginPage onLogin={onLogin} initialError={initialError} compatibility={compatibility} />;
}

function ControlLoginPage({ onLogin, initialError, compatibility }: {
  onLogin: (user: PortalUser) => void;
  initialError?: unknown;
  compatibility?: AuthCompatibility;
}) {
  const [locale, setLocale] = useAuthLocale();
  const [role, setRole] = useState<LoginRole>('user');
  const [externalProvider, setExternalProvider] = useState<ExternalAuthProvider | null>(null);
  const [externalProviders, setExternalProviders] = useState<ExternalAuthProvider[]>([]);
  const [entryManifest, setEntryManifest] = useState<PortalEntryManifest>();
  // 通用入口先按中性合同渲染；只有服务端明确返回兼容标记时才启用旧投影。
  const [compatibilityMode, setCompatibilityMode] = useState(false);
  const [loadedCompatibility, setLoadedCompatibility] = useState<AuthCompatibility>();
  const [password, setPassword] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const copy = authMessages(locale).controlLogin;
  const flow = useEmailAuth({
    provider: externalProvider,
    locale,
    onLogin,
    initialError,
    copy: {
      providerUnavailable: copy.providerUnavailable,
      methodsLoadFailed: copy.methodsLoadFailed,
      sessionRestoreFailed: copy.sessionRestoreFailed,
      sendCodeFailed: copy.sendCodeFailed,
      loginFailed: copy.loginFailed,
    },
    legacyCompatibility: compatibilityMode,
    compatibility: compatibility ?? loadedCompatibility,
    declaredFields: entryManifest?.entry.fields,
  });
  const {
    code,
    codeInputRef,
    codeSent,
    email,
    emailInputRef,
    editEmail,
    error,
    errorMessage,
    normalizedEmail,
    busy: externalBusyState,
    pending: externalPending,
    providerFields,
    providerFieldInvalid,
    providerFieldValues,
    registrationFlow,
    resetVerification,
    sendCode,
    setError: setFlowError,
    submit: submitExternal,
    updateCode,
    updateEmail,
    updateProviderField,
  } = flow;
  const busy = externalProvider ? externalBusyState : (adminBusy ? 'login' : null);
  const codeInvalid = verificationCodeInvalid(error);

  useEffect(() => {
    let active = true;
    authApi.methods()
      .then(async (methods) => {
        if (!active) return;
        let nextManifest: PortalEntryManifest | undefined;
        // 旧 Gateway 没有模式字段时仍可使用 methods，但不能据此猜测产品。
        if (methods.compatibilityMode !== undefined || methods.authProviderId !== undefined) {
          try {
            nextManifest = await api.entryManifest();
          } catch {
            // manifest 暂时不可用时仍可用 methods 的通用 Provider 选择结果。
          }
        }
        if (!active) return;
        const legacyGateway = !nextManifest
          && methods.compatibilityMode === undefined
          && methods.authProviderId === undefined;
        const nextCompatibility = !isGenericFrontendBuild && (nextManifest?.compatibilityMode
          ?? methods.compatibilityMode
          ?? legacyGateway);
        const preferredProviderId = nextManifest?.authProviderId ?? methods.authProviderId;
        const extension: AuthCompatibility | undefined = compatibility ?? (methods.external.length === 0 ? undefined : nextCompatibility
          ? await loadLegacyAuthCompatibilityDeferred(preferredProviderId)
          : await loadAuthUiExtension(preferredProviderId ?? methods.external[0]?.id));
        if (!active) return;
        const workspaceProvider = !preferredProviderId && extension?.selectProvider
          ? extension.selectProvider(methods.external)
          : selectExternalProvider(methods.external, preferredProviderId);
        setEntryManifest(nextManifest);
        setCompatibilityMode(nextCompatibility);
        setLoadedCompatibility(extension);
        setExternalProviders(workspaceProvider ? [workspaceProvider] : []);
        if (!workspaceProvider) setFlowError({ type: 'provider-unavailable' });
      })
      .catch((reason) => {
        if (active) setFlowError({ type: 'methods', reason });
      });
    return () => { active = false; };
  }, [compatibility, setFlowError]);

  const passwordLongEnough = Array.from(password).length >= 12;

  function resetExternalFlow() {
    setExternalProvider(null);
    resetVerification();
  }

  function chooseRole(nextRole: LoginRole) {
    setRole(nextRole);
    flow.clearError();
    resetExternalFlow();
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    if (externalProvider) {
      await submitExternal(event);
      return;
    }
    event.preventDefault();
    if (adminBusy) return;
    setAdminBusy(true);
    flow.clearError();
    try {
      const user = await authApi.localAdminLogin(email.trim(), password);
      onLogin(user);
    } catch (reason) {
      setFlowError({ type: 'login', reason });
    } finally {
      setAdminBusy(false);
    }
  }

  const AdapterView = (compatibility ?? loadedCompatibility)?.views?.control;
  const adapterOwnsSso = Boolean(AdapterView);
  return <main className="login-shell">
    <AuthLanguageSelect className="control-auth-language" locale={locale} onChange={setLocale} />
    <section className="login-brand">
      <BrandLogo />
      <p className="eyebrow">OpenApp</p>
      <h1>{copy.brandHeadline}</h1>
      <p>{copy.brandDescription}</p>
      <div className="brand-facts">
        <span><ShieldCheck size={17} />{copy.securityFact}</span>
        <span><Container size={17} />{copy.isolatedAppFact}</span>
      </div>
    </section>
    <section className="login-panel">
      <div className="login-card">
        {(role === 'admin' || externalProvider) && <div className="login-heading">
          <h2>{role === 'admin' ? copy.adminHeading : copy.providerHeading(externalProvider?.label ?? '')}</h2>
          <p>{role === 'admin' ? copy.adminDescription : copy.providerDescription}</p>
        </div>}
        <div className="segments" aria-label={copy.roleLabel}>
          <button type="button" className={role === 'user' ? 'active' : ''} onClick={() => chooseRole('user')}>
            <CircleUserRound size={16} />{copy.userRole}
          </button>
          <button type="button" className={role === 'admin' ? 'active' : ''} onClick={() => chooseRole('admin')}>
            <ShieldCheck size={16} />{copy.adminRole}
          </button>
        </div>
        {role === 'admin' && <div className="notice info"><ShieldCheck size={17} /><span>{copy.adminNotice}</span></div>}
        {role === 'user' && adapterOwnsSso && AdapterView && <AdapterView locale={locale} onLogin={onLogin} initialError={initialError} />}
        {!adapterOwnsSso && externalProvider && <button type="button" className="external-back" onClick={resetExternalFlow}>
          <ArrowLeft size={15} />{copy.returnToSso}
        </button>}
        {(role === 'admin' || (!adapterOwnsSso && externalProvider)) && <form onSubmit={(event) => void login(event)}>
          {(!externalProvider || !codeSent) && <label>{copy.emailAddress}<input
            ref={emailInputRef}
            type="email"
            value={email}
            disabled={externalProvider ? externalPending : adminBusy}
            onChange={updateEmail}
            placeholder="name@example.com"
            required
            autoComplete="email"
          /></label>}
          {externalProvider && codeSent && <button type="button" className="external-back" disabled={externalPending} onClick={editEmail}>
            <ArrowLeft size={15} />{authMessages(locale).workspaceLogin.changeEmail}
          </button>}
          {role === 'admin' && !externalProvider && <label>{copy.password}<input
            type="password"
            value={password}
            onChange={(event) => { setPassword(event.target.value); flow.clearError(); }}
            placeholder={copy.password}
            required
            autoComplete="current-password"
          /></label>}
          {externalProvider && codeSent && <label>{copy.verificationCode}<div className="code-row">
            <input
              ref={codeInputRef}
              value={code}
              onChange={updateCode}
              placeholder={copy.verificationCodePlaceholder}


              maxLength={flow.codeMaxLength}

              required={codeSent}
              autoComplete="one-time-code"
              aria-label={copy.verificationCode}
              aria-invalid={codeInvalid || undefined}
            />
            <button type="button" className="secondary" onClick={() => void sendCode()} disabled={!normalizedEmail || busy !== null}>
              {externalBusyState === 'code' ? <LoaderCircle className="spin" size={16} /> : codeSent ? copy.resend : copy.sendVerificationCode}
            </button>
          </div></label>}
          {externalProvider && codeSent && providerFields.map((field) => <label key={field.id}>{field.label}<input
            type={field.secret ? 'password' : 'text'}
            value={providerFieldValues[field.id] ?? ''}
            disabled={externalPending}
            onChange={(event) => updateProviderField(field.id, event.currentTarget.value)}
            placeholder={field.placeholder}
            required={field.required === true}
            autoComplete="off"
            maxLength={field.maxLength ?? 256}
            aria-label={field.label}
            aria-invalid={providerFieldInvalid[field.id] || undefined}
          /></label>)}
          <div aria-live="polite">
            {externalProvider && codeSent && <p className="hint">{copy.codeSent(normalizedEmail)}</p>}
            {errorMessage && <ErrorNotice message={errorMessage} />}
          </div>
          <button className="primary full" disabled={busy !== null || !normalizedEmail || (externalProvider ? codeSent && (!flow.codeValid || flow.requiredProviderFieldsMissing) : !passwordLongEnough)}>
            {busy === 'login'
              ? <><LoaderCircle className="spin" size={17} />{copy.signingIn}</>
              : <>{busy === 'code' && <LoaderCircle className="spin" size={17} />}{externalProvider ? (!codeSent ? copy.sendVerificationCode : registrationFlow ? copy.completeRegistration : copy.signInWith(externalProvider.label)) : copy.signIn}<ArrowRight size={17} /></>}
          </button>
        </form>}
        {role === 'user' && !adapterOwnsSso && !externalProvider && <div className="external-login">
          <div className="external-divider"><span>{copy.ssoSignIn}</span></div>
          <div className="external-providers">{externalProviders.map((provider) => {
            const label = copy.providerButtonLabel(provider.label);
            return <button
              type="button"
              className="external-provider"
              key={provider.id}
              title={label}
              aria-label={label}
              onClick={() => { resetVerification(); setExternalProvider(provider); }}
            ><img src={provider.iconUrl} alt="" /></button>;
          })}</div>
          {errorMessage && <ErrorNotice message={errorMessage} />}
        </div>}
      </div>
    </section>
  </main>;
}

/** 只有旧 Gateway 缺少现代 manifest/mode 字段时才加载产品兼容文案。 */
async function loadLegacyAuthCompatibilityDeferred(providerId: string | undefined): Promise<AuthCompatibility> {
  const module = await import('./compat/load');
  return module.loadLegacyAuthCompatibility(providerId);
}
