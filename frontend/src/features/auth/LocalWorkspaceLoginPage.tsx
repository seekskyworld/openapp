import { useState, type FormEvent } from "react";
import { ApiError, type PortalEntryManifest, type PortalUser } from "../../api";
import { authApi } from "../../auth-api";
import { formatAuthError } from "../../auth-i18n";
import AuthLanguageSelect from "./AuthLanguageSelect";
import { useAuthLocale } from "./useAuthLocale";

/** Local platform accounts for an App that explicitly declares no external identity provider. */
export default function LocalWorkspaceLoginPage({
  onLogin,
  initialError,
  manifest,
}: {
  onLogin: (user: PortalUser) => void;
  initialError?: unknown;
  manifest: PortalEntryManifest;
}) {
  const [locale, setLocale] = useAuthLocale();
  const [register, setRegister] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(initialError ?? undefined);
  const en = locale === "en";
  const label = manifest.entry.label || "OpenApp";
  const action = register ? (en ? "Create account" : "创建账号") : en ? "Sign in" : "登录";
  const fallback = en ? "Unable to sign in. Please try again." : "暂时无法登录，请稍后重试。";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    setPending(true);
    setError(undefined);
    try {
      const user = register
        ? await authApi.localRegister(email, password)
        : await authApi.localLogin(email, password);
      onLogin(user);
    } catch (reason) {
      setError(reason);
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="workspace-auth-shell generic-auth" data-locale={locale}>
      <div className="workspace-auth-page-brand" aria-label={label}>
        <span className="workspace-auth-logo" aria-hidden="true">
          <img src={manifest.entry.logoUrl || "/openapp-logo.png"} alt="" />
        </span>
        <span className="workspace-auth-wordmark">{label}</span>
      </div>
      <AuthLanguageSelect
        className="workspace-auth-language"
        locale={locale}
        onChange={setLocale}
        variant="toggle"
      />
      <div className="workspace-auth-stack">
        <form className="workspace-auth-panel" onSubmit={(event) => void submit(event)} aria-label={action}>
          <header className="workspace-auth-header">
            <h1>
              <span>{en ? "Your own space in" : "你的独立空间"}</span>
              <em>{label}</em>
            </h1>
          </header>
          <label className="workspace-auth-field">
            <span className="workspace-auth-field-label">{en ? "Email" : "邮箱"}</span>
            <span className="workspace-auth-input-wrap">
              <input
                name="email"
                type="email"
                autoComplete="username"
                placeholder="you@example.com"
                required
                disabled={pending}
              />
            </span>
          </label>
          <label className="workspace-auth-field">
            <span className="workspace-auth-field-label">{en ? "Password" : "密码"}</span>
            <span className="workspace-auth-input-wrap">
              <input
                name="password"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                minLength={register ? 12 : undefined}
                required
                disabled={pending}
              />
            </span>
          </label>
          {register && <p>{en ? "Use at least 12 characters." : "密码至少需要 12 个字符。"}</p>}
          {error !== undefined && (
            <p className="workspace-auth-error" role="alert">
              {error instanceof ApiError ? formatAuthError(error, fallback, locale) : fallback}
            </p>
          )}
          <button className="workspace-auth-submit" type="submit" disabled={pending}>
            {pending ? (en ? "Please wait…" : "请稍候…") : action}
          </button>
          <div className="workspace-auth-email-summary">
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setRegister(!register);
                setError(undefined);
              }}
            >
              {register
                ? en
                  ? "Already have an account? Sign in"
                  : "已有账号？登录"
                : en
                  ? "New here? Create an account"
                  : "没有账号？创建账号"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
