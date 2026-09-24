import { useEffect, useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { type PortalEntryManifest, type PortalUser } from "../../api";
import { authApi, type ExternalAuthProvider } from "../../auth-api";
import { workspaceLoginCopyFor, type AuthCompatibility } from "../../auth-i18n";
import AuthLanguageSelect from "./AuthLanguageSelect";
import { useAuthLocale } from "./useAuthLocale";
import { loadAuthUiExtension } from "./auth-ui";
import LocalWorkspaceLoginPage from "./LocalWorkspaceLoginPage";
import EntryLoadingPage from "../entry/EntryLoadingPage";

const isGenericFrontendBuild =
  typeof __OPENAPP_FRONTEND_BUILD_TARGET__ === "string" && __OPENAPP_FRONTEND_BUILD_TARGET__ === "generic";
import {
  authRequirementNotice,
  selectExternalProvider,
  useEmailAuth,
  verificationCodeInvalid as isVerificationCodeInvalid,
} from "./useEmailAuth";

export default function WorkspaceLoginPage({
  onLogin,
  initialError,
  manifest,
  compatibility,
}: {
  onLogin: (user: PortalUser) => void;
  initialError?: unknown;
  manifest?: PortalEntryManifest;
  compatibility?: AuthCompatibility;
}) {
  if (manifest?.entry.challenge === "none" && (manifest.authProviderId ?? "none") === "none") {
    return <LocalWorkspaceLoginPage onLogin={onLogin} initialError={initialError} manifest={manifest} />;
  }
  return (
    <WorkspaceLoginExperience
      onLogin={onLogin}
      initialError={initialError}
      manifest={manifest}
      compatibility={compatibility}
    />
  );
}

interface WorkspaceLoginExperienceProps {
  onLogin: (user: PortalUser) => void;
  initialError?: unknown;
  manifest?: PortalEntryManifest;
  compatibility?: AuthCompatibility;
}

function WorkspaceLoginExperience({
  onLogin,
  initialError,
  manifest,
  compatibility,
}: WorkspaceLoginExperienceProps) {
  const [locale, setLocale] = useAuthLocale();
  const [provider, setProvider] = useState<ExternalAuthProvider | null>(null);
  const [legacyGatewayCompatibility, setLegacyGatewayCompatibility] = useState(false);
  const [loadedCompatibility, setLoadedCompatibility] = useState<AuthCompatibility>();
  const [entryLoading, setEntryLoading] = useState(true);
  const brandLabel = manifest?.entry.label || provider?.label || "OpenApp";
  const brandLogoUrl = manifest?.entry.logoUrl || provider?.iconUrl || "/openapp-logo.png";
  // 缺少 manifest 时使用产品无关的入口合同；旧 Gateway 若仍需旧文案，
  // 必须显式传入 compatibilityMode=true 的兼容 manifest。
  const legacyCompatibility =
    !isGenericFrontendBuild && (manifest?.compatibilityMode === true || legacyGatewayCompatibility);
  const effectiveCompatibility = compatibility ?? loadedCompatibility;
  const entryChallenge = manifest?.entry.challenge ?? "email_code";
  const supportsEmailCode = entryChallenge === "email_code";
  const copy = workspaceLoginCopyFor(
    locale,
    brandLabel,
    manifest?.authProviderId,
    legacyCompatibility,
    effectiveCompatibility,
  );
  const flow = useEmailAuth({
    provider,
    locale,
    onLogin,
    initialError,
    copy,
    legacyCompatibility,
    compatibility: effectiveCompatibility,
    errorCatalog: manifest?.errorCatalog,
    declaredFields: manifest?.entry.fields,
  });
  const {
    code,
    codeInputRef,
    codeSent,
    editEmail,
    email,
    emailInputRef,
    error,
    errorMessage,
    normalizedEmail,
    pending,
    providerFields,
    providerFieldInvalid,
    providerFieldValues,
    registrationFlow,
    sendCode,
    setError: setFlowError,
    submit,
    updateCode,
    updateEmail,
    updateProviderField,
  } = flow;
  const verificationCodeInvalid = isVerificationCodeInvalid(error);

  useEffect(() => {
    let active = true;
    setEntryLoading(true);
    setLoadedCompatibility(undefined);

    // 无认证入口由 App manifest 明确声明；这里不能再探测外部 Provider，
    // 否则通用 App 会误进入邮箱验证码流程并把 Provider 故障展示给用户。
    if (!supportsEmailCode) {
      setProvider(null);
      setFlowError(null);
      setEntryLoading(false);
      return () => {
        active = false;
      };
    }

    authApi
      .methods()
      .then(async (methods) => {
        if (!active) return;
        // 旧 Gateway 没有 manifest/mode 字段；现代 API 必须显式返回字段，
        // 因此这里按协议形状识别兼容边界，而不是按产品名或 Provider label 猜测。
        const needsExtension =
          !isGenericFrontendBuild &&
          (manifest?.compatibilityMode ??
            methods.compatibilityMode ??
            (!manifest && methods.authProviderId === undefined));
        setLegacyGatewayCompatibility(needsExtension);
        // Entry pages use the Provider selected by the registered App; when no
        // explicit selection exists, the first reviewed method is the generic default.
        const selectedProvider = selectExternalProvider(
          methods.external,
          manifest?.authProviderId ?? methods.authProviderId,
        );
        const workspaceProvider =
          supportsEmailCode && selectedProvider?.challenge === "email_code" ? selectedProvider : null;
        if (!compatibility && workspaceProvider) {
          const loaded = needsExtension
            ? await loadLegacyAuthCompatibilityDeferred(workspaceProvider.id)
            : await loadAuthUiExtension(workspaceProvider.id);
          if (!active) return;
          setLoadedCompatibility(loaded);
        }
        setProvider(workspaceProvider);
        if (!workspaceProvider) setFlowError({ type: "provider-unavailable" });
      })
      .catch((reason) => {
        if (active) setFlowError({ type: "methods", reason });
      })
      .finally(() => {
        if (active) setEntryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [manifest, manifest?.authProviderId, compatibility, supportsEmailCode, setFlowError]);

  const step = codeSent ? (registrationFlow ? "registration" : "code") : "email";
  const submitDisabled =
    pending ||
    !provider ||
    !supportsEmailCode ||
    !normalizedEmail ||
    (codeSent && (!flow.codeValid || flow.requiredProviderFieldsMissing));

  const AdapterView = effectiveCompatibility?.views?.workspace;
  if (entryLoading) return <EntryLoadingPage />;
  if (AdapterView) return <AdapterView locale={locale} onLogin={onLogin} initialError={initialError} />;

  return (
    <main className="workspace-auth-shell generic-auth" data-step={step} data-locale={locale}>
      <div
        className="workspace-auth-page-brand notranslate imt-notranslate"
        aria-label={brandLabel}
        translate="no"
      >
        <span className="workspace-auth-logo" aria-hidden="true">
          <img src={brandLogoUrl} alt="" />
        </span>
        <span className="workspace-auth-wordmark notranslate imt-notranslate" translate="no">
          {brandLabel}
        </span>
      </div>
      <AuthLanguageSelect
        className="workspace-auth-language"
        locale={locale}
        onChange={setLocale}
        variant="toggle"
      />

      <div className="workspace-auth-stack">
        <form
          className="workspace-auth-panel"
          onSubmit={(event) => void submit(event)}
          aria-label={copy.formLabel}
        >
          <header className="workspace-auth-header">
            <h1>
              <span>{copy.headingLead}</span>
              <em className="notranslate imt-notranslate" translate="no">
                {brandLabel}
              </em>
            </h1>
          </header>

          {!codeSent ? (
            <label className="workspace-auth-field">
              <span className="workspace-auth-field-label">{copy.emailLabel}</span>
              <span className="workspace-auth-input-wrap">
                <input
                  ref={emailInputRef}
                  type="email"
                  value={email}
                  autoFocus
                  autoComplete="email"
                  placeholder="you@example.com"
                  disabled={pending || !supportsEmailCode}
                  required
                  onChange={updateEmail}
                />
              </span>
            </label>
          ) : (
            <>
              <div className="workspace-auth-email-summary">
                <strong>{normalizedEmail}</strong>
                <button type="button" disabled={pending} onClick={editEmail}>
                  {copy.changeEmail}
                </button>
              </div>
              <label className="workspace-auth-field">
                <span className="workspace-auth-field-label">{copy.verificationCodeLabel}</span>
                <span
                  className="workspace-auth-input-wrap"
                  data-invalid={verificationCodeInvalid ? "true" : undefined}
                >
                  <input
                    ref={codeInputRef}
                    type="text"

                    value={code}
                    disabled={pending}
                    autoComplete="one-time-code"
                    maxLength={flow.codeMaxLength}
                    aria-label={copy.verificationCodeLabel}
                    aria-invalid={verificationCodeInvalid || undefined}
                    onChange={updateCode}
                  />
                </span>
              </label>
            </>
          )}

          {codeSent &&
            providerFields.map((field) => (
              <label className="workspace-auth-field" key={field.id}>
                <span className="workspace-auth-field-label">{field.label}</span>
                <span
                  className="workspace-auth-input-wrap"
                  data-invalid={providerFieldInvalid[field.id] ? "true" : undefined}
                >
                  <input
                    type={field.secret ? "password" : "text"}
                    value={providerFieldValues[field.id] ?? ""}
                    disabled={pending}
                    autoComplete="off"
                    maxLength={field.maxLength ?? 256}
                    placeholder={field.placeholder}
                    required={field.required === true}
                    aria-label={field.label}
                    aria-invalid={providerFieldInvalid[field.id] || undefined}
                    onChange={(event) => updateProviderField(field.id, event.currentTarget.value)}
                  />
                </span>
              </label>
            ))}

          <div className="workspace-auth-feedback" aria-live="polite">
            {(entryChallenge !== "email_code" || errorMessage) && (
              <p
                className={authRequirementNotice(error) ? "workspace-auth-status" : "workspace-auth-error"}
                role={authRequirementNotice(error) ? "status" : "alert"}
              >
                {entryChallenge !== "email_code" ? copy.entryUnavailable : errorMessage}
              </p>
            )}
            {codeSent && (
              <button
                className="workspace-auth-resend"
                type="button"
                disabled={pending || !normalizedEmail}
                onClick={() => void sendCode()}
              >
                {copy.resendCode}
              </button>
            )}
          </div>

          <button className="workspace-auth-submit" type="submit" disabled={submitDisabled}>
            {pending ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
            <span>
              {pending
                ? copy.pleaseWait
                : codeSent
                  ? registrationFlow
                    ? copy.completeRegistration
                    : copy.enterProvider
                  : copy.getVerificationCode}
            </span>
            {!pending && <ArrowRight size={16} aria-hidden="true" />}
          </button>

          {!codeSent && <p className="workspace-auth-legal">{copy.legalNotice}</p>}
        </form>
      </div>
    </main>
  );
}

/** 旧 Gateway 才需要的文案投影；保持通用入口的初始依赖图不含兼容代码。 */
async function loadLegacyAuthCompatibilityDeferred(providerId: string): Promise<AuthCompatibility> {
  const module = await import("./compat/load");
  return module.loadLegacyAuthCompatibility(providerId);
}
