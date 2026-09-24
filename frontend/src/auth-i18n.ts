import { ApiError } from "./api";
import type { ComponentType } from "react";
import type { AuthUiLoginProps } from "@openapp/contracts/ui";
import type { PortalUser, PortalEntryManifest } from "./api";
import type { ExternalAuthField, ExternalEmailCodeResult, ExternalAuthProvider } from "./auth-api";

export type AuthLocale = "en" | "zh-CN";

/** 由已校验 Adapter manifest 提供的浏览器安全错误文案。 */
export type AuthErrorCatalog = Readonly<Record<string, Readonly<Record<string, string>>>>;

interface BrowserLanguageSource {
  language?: string;
  languages?: readonly string[];
}

export interface WorkspaceLoginMessages {
  formLabel: string;
  headingLead: string;
  emailLabel: string;
  changeEmail: string;
  verificationCodeLabel: string;
  resendCode: string;
  pleaseWait: string;
  completeRegistration: string;
  enterProvider: string;
  getVerificationCode: string;
  legalNotice: string;
  providerUnavailable: string;
  entryUnavailable: string;
  methodsLoadFailed: string;
  sessionRestoreFailed: string;
  sendCodeFailed: (providerLabel: string) => string;
  loginFailed: string;
}

/**
 * 历史认证投影由 Adapter 注入；普通登录视图使用 AuthUiExtension 独立加载。
 * 通用 Shell 不直接依赖 Provider 实现，未注入时使用中性文案和错误合同。
 */
export interface AuthCompatibility {
  legacyEntryManifest?: PortalEntryManifest;
  legacyAuthProviderConfigured?: (value: unknown) => boolean | undefined;
  legacyFallbackAuthAdapterId?: (appId: string) => string;
  views?: {
    workspace: ComponentType<AdapterLoginViewProps>;
    control: ComponentType<AdapterLoginViewProps>;
  };
  selectProvider?: (providers: readonly ExternalAuthProvider[]) => ExternalAuthProvider | null;
  workspaceLoginCopy?: (locale: AuthLocale, base: WorkspaceLoginMessages) => WorkspaceLoginMessages;
  authErrorMessage?: (code: string, locale: AuthLocale) => string | undefined;
  /** 将旧挑战响应投影为通用字段；通用入口不会读取 Provider 字段名。 */
  emailCodeFields?: (result: ExternalEmailCodeResult, locale: AuthLocale) => readonly ExternalAuthField[];
  /** 将旧错误投影为字段状态；通用流程只消费字段 id 和分类。 */
  classifyAuthError?: (reason: unknown, locale: AuthLocale) => AuthErrorProjection | undefined;
  /** 旧网关需要的请求形态；现代入口始终使用 authApi 的 providerData 合同。 */
  externalLogin?: (
    provider: string,
    email: string,
    code: string,
    providerData?: Readonly<Record<string, unknown>>,
  ) => Promise<PortalUser>;
}

export type AdapterLoginViewProps = AuthUiLoginProps;

export interface AuthErrorProjection {
  readonly requiredFieldIds?: readonly string[];
  readonly verificationCodeInvalid?: boolean;
  readonly fields?: readonly ExternalAuthField[];
}

export interface ControlLoginMessages {
  brandHeadline: string;
  brandDescription: string;
  securityFact: string;
  isolatedAppFact: string;
  roleLabel: string;
  userRole: string;
  adminRole: string;
  adminHeading: string;
  providerHeading: (providerLabel: string) => string;
  adminDescription: string;
  providerDescription: string;
  adminNotice: string;
  returnToSso: string;
  emailAddress: string;
  password: string;
  verificationCode: string;
  verificationCodePlaceholder: string;
  resend: string;
  sendVerificationCode: string;
  codeSent: (email: string) => string;
  signingIn: string;
  completeRegistration: string;
  signInWith: (providerLabel: string) => string;
  signIn: string;
  ssoSignIn: string;
  providerButtonLabel: (providerLabel: string) => string;
  providerUnavailable: string;
  methodsLoadFailed: string;
  sessionRestoreFailed: string;
  sendCodeFailed: (providerLabel: string) => string;
  loginFailed: string;
}

export interface AuthMessages {
  languageLabel: string;
  switchLanguage: (language: string) => string;
  workspaceLogin: WorkspaceLoginMessages;
  controlLogin: ControlLoginMessages;
}

export const authLocaleOptions: ReadonlyArray<{
  locale: AuthLocale;
  label: string;
  nativeLabel: string;
  shortLabel: string;
}> = [
  { locale: "en", label: "English", nativeLabel: "English", shortLabel: "EN" },
  { locale: "zh-CN", label: "简体中文", nativeLabel: "中文", shortLabel: "ZH" },
];

const messages: Record<AuthLocale, AuthMessages> = {
  en: {
    languageLabel: "Language",
    switchLanguage: (language) => `Switch to ${language}`,
    workspaceLogin: {
      formLabel: "Sign in to OpenApp",
      headingLead: "Return to your",
      emailLabel: "Email",
      changeEmail: "Change email",
      verificationCodeLabel: "Verification code",
      resendCode: "Resend verification code",
      pleaseWait: "Please wait",
      completeRegistration: "Continue sign-in",
      enterProvider: "Enter your workspace",
      getVerificationCode: "Get code",
      legalNotice: "By continuing, you agree to the Terms of Use and Privacy Policy.",
      providerUnavailable: "No enterprise account sign-in method is currently available.",
      entryUnavailable: "This application does not expose a supported sign-in method yet.",
      methodsLoadFailed: "Unable to load sign-in methods. Please try again later.",
      sessionRestoreFailed: "Unable to restore your session. Please sign in again.",
      sendCodeFailed: (providerLabel) =>
        `${providerLabel} could not send a verification code. Please try again later.`,
      loginFailed: "Sign-in failed. Please try again later.",
    },
    controlLogin: {
      brandHeadline: "Prepare an independent App environment for every user",
      brandDescription: "Enterprise SSO with secure isolation.",
      securityFact: "Enterprise identity security",
      isolatedAppFact: "Independent App environment",
      roleLabel: "Sign-in role",
      userRole: "User",
      adminRole: "Administrator",
      adminHeading: "Administrator sign-in",
      providerHeading: (providerLabel) => `Sign in with ${providerLabel}`,
      adminDescription: "Use an OpenApp local account, or sign in with SSO from the user entry.",
      providerDescription: "Verify your external account to create or link an OpenApp account automatically.",
      adminNotice:
        "Administrator access can only be granted by an existing administrator. Administrators retain access when signing in with SSO.",
      returnToSso: "Back to SSO sign-in",
      emailAddress: "Email address",
      password: "Password",
      verificationCode: "Verification code",
      verificationCodePlaceholder: "verification code",
      resend: "Resend",
      sendVerificationCode: "Send code",
      codeSent: (email) => `A verification code was sent to ${email}. Check your email.`,
      signingIn: "Signing in",
      completeRegistration: "Continue sign-in",
      signInWith: (providerLabel) => `Sign in with ${providerLabel}`,
      signIn: "Sign in",
      ssoSignIn: "SSO sign-in",
      providerButtonLabel: (providerLabel) => `Sign in with ${providerLabel}`,
      providerUnavailable: "No enterprise account sign-in method is currently available.",
      methodsLoadFailed: "Unable to load sign-in methods. Please try again later.",
      sessionRestoreFailed: "Unable to restore your session. Please sign in again.",
      sendCodeFailed: (providerLabel) =>
        `${providerLabel} could not send a verification code. Please try again later.`,
      loginFailed: "Sign-in failed. Please try again later.",
    },
  },
  "zh-CN": {
    languageLabel: "语言",
    switchLanguage: (language) => `切换为${language}`,
    workspaceLogin: {
      formLabel: "登录 OpenApp",
      headingLead: "回到你的",
      emailLabel: "邮箱",
      changeEmail: "更换邮箱",
      verificationCodeLabel: "验证码",
      resendCode: "重新发送验证码",
      pleaseWait: "请稍候",
      completeRegistration: "继续登录",
      enterProvider: "进入工作区",
      getVerificationCode: "获取验证码",
      legalNotice: "继续即表示同意《服务条款》和《隐私政策》。",
      providerUnavailable: "当前没有可用的企业账号登录方式。",
      entryUnavailable: "此应用尚未提供 OpenApp 支持的登录方式。",
      methodsLoadFailed: "无法读取登录方式，请稍后重试。",
      sessionRestoreFailed: "无法恢复登录状态，请重新登录。",
      sendCodeFailed: (providerLabel) => `${providerLabel} 验证码发送失败，请稍后重试。`,
      loginFailed: "登录失败，请稍后重试。",
    },
    controlLogin: {
      brandHeadline: "为每位用户准备独立的 App 环境",
      brandDescription: "企业 SSO 登录，保障安全隔离。",
      securityFact: "企业级身份安全",
      isolatedAppFact: "独立 App 环境",
      roleLabel: "登录角色",
      userRole: "用户",
      adminRole: "管理员",
      adminHeading: "管理员登录",
      providerHeading: (providerLabel) => `${providerLabel} 登录`,
      adminDescription: "使用 OpenApp 本地账号登录；也可从用户入口使用 SSO。",
      providerDescription: "验证第三方账号后将自动创建或关联 OpenApp 账号。",
      adminNotice: "管理员角色只能由现有管理员授予；已有管理员使用 SSO 登录时仍保留管理权限。",
      returnToSso: "返回 SSO 登录",
      emailAddress: "邮箱地址",
      password: "密码",
      verificationCode: "验证码",
      verificationCodePlaceholder: "验证码",
      resend: "重新发送",
      sendVerificationCode: "发送验证码",
      codeSent: (email) => `验证码已发送至 ${email}，请检查邮箱。`,
      signingIn: "正在登录",
      completeRegistration: "继续登录",
      signInWith: (providerLabel) => `使用 ${providerLabel} 登录`,
      signIn: "登录",
      ssoSignIn: "SSO登录",
      providerButtonLabel: (providerLabel) => `使用 ${providerLabel} 登录`,
      providerUnavailable: "当前没有可用的企业账号登录方式。",
      methodsLoadFailed: "无法读取登录方式，请稍后重试。",
      sessionRestoreFailed: "无法恢复登录状态，请重新登录。",
      sendCodeFailed: (providerLabel) => `${providerLabel} 验证码发送失败，请稍后重试。`,
      loginFailed: "登录失败，请稍后重试。",
    },
  },
};

const authErrors: Record<AuthLocale, Record<string, string>> = {
  en: {
    valid_email_required: "Enter a valid email address.",
    verification_code_required: "Enter the verification code.",
    verification_code_invalid: "The verification code is incorrect or has expired.",
    rate_limited: "Too many requests. Please try again later.",
    user_disabled: "This account has been disabled.",
    authentication_required: "Your session has expired. Please sign in again.",
    admin_required: "This account does not have administrator access.",
    super_admin_required: "Only a super administrator can manage account roles.",
    network_unavailable: "Unable to reach the sign-in service. Check your network and try again.",
    invalid_server_response: "The sign-in service returned an invalid response. Please try again later.",
    request_failed: "The sign-in request failed. Please try again later.",
    password_required: "Enter your password.",
    password_too_short: "Your password must contain at least 12 characters.",
    password_too_long: "Your password must not exceed 256 bytes.",
    invalid_credentials: "The email address or password is incorrect.",
    account_exists: "An account already exists for this email. Use its original sign-in method.",
    local_admin_login_required: "Administrators must sign in with an OpenApp local account.",
    local_credentials_required:
      "This account has no local password and cannot be assigned a management role.",
    password_confirmation_mismatch: "The passwords do not match.",
    password_setup_required: "Set a password for your OpenApp account first.",
    password_setup_not_allowed: "This account cannot set an initial password.",
    password_already_set: "This account already has a local password.",
    invalid_current_password: "The current password is incorrect.",
    external_password_change_not_allowed:
      "Administrators cannot change passwords through an external account.",
    external_identity_not_linked: "This external account is not linked to the current account.",
    external_identity_mismatch: "The verified external identity does not match the current account.",
    credential_update_conflict: "The account credentials changed. Refresh and try again.",
    last_super_admin_cannot_be_demoted: "At least one super administrator must remain.",
    role_change_conflict: "The account role changed. Refresh and try again.",
    self_role_change_forbidden: "You cannot change your own account role.",
    target_role_not_manageable: "You do not have permission to manage this account role.",
    auth_provider_not_found: "This external sign-in method is currently unavailable.",
  },
  "zh-CN": {
    valid_email_required: "请输入有效的邮箱地址。",
    verification_code_required: "请输入 验证码。",
    verification_code_invalid: "验证码错误或已过期。",
    rate_limited: "请求过于频繁，请稍后再试。",
    user_disabled: "账号已被禁用。",
    authentication_required: "登录状态已失效，请重新登录。",
    admin_required: "当前账号没有管理员权限。",
    super_admin_required: "只有超级管理员可以管理账号角色。",
    network_unavailable: "无法连接登录服务，请检查网络后重试。",
    invalid_server_response: "登录服务返回了无法识别的数据，请稍后重试。",
    request_failed: "登录请求失败，请稍后重试。",
    password_required: "请输入密码。",
    password_too_short: "密码至少需要 12 个字符。",
    password_too_long: "密码过长，请控制在 256 字节以内。",
    invalid_credentials: "邮箱或密码不正确。",
    account_exists: "该邮箱已有账号，请使用原登录方式。",
    local_admin_login_required: "管理员必须使用 OpenApp 本地账号登录。",
    local_credentials_required: "该账号还没有本地密码，不能设为管理角色。",
    password_confirmation_mismatch: "两次输入的密码不一致。",
    password_setup_required: "请先为 OpenApp 账号设置密码。",
    password_setup_not_allowed: "当前账号不能执行首次密码设置。",
    password_already_set: "该账号已经设置过本地密码。",
    invalid_current_password: "当前密码不正确。",
    external_password_change_not_allowed: "管理员不能使用第三方账号修改密码。",
    external_identity_not_linked: "该第三方账号尚未与当前账号关联。",
    external_identity_mismatch: "验证的第三方身份与当前账号不一致。",
    credential_update_conflict: "账号凭据已发生变化，请刷新后重试。",
    last_super_admin_cannot_be_demoted: "系统必须至少保留一个超级管理员。",
    role_change_conflict: "账号角色已发生变化，请刷新后重试。",
    self_role_change_forbidden: "不能修改自己的账号角色。",
    target_role_not_manageable: "当前账号无权管理该账号角色。",
    auth_provider_not_found: "该第三方登录方式当前不可用。",
  },
};

export function authMessages(locale: AuthLocale): AuthMessages {
  return messages[locale];
}

/**
 * 根据入口 manifest 元数据解析文案。旧文案只能由显式兼容标记启用，不能
 * 因 Provider 的名称或展示标签而切换模式。
 */
export function workspaceLoginCopyFor(
  locale: AuthLocale,
  providerLabel: string,
  _providerId?: string,
  legacyCompatibility = false,
  compatibility?: AuthCompatibility,
): WorkspaceLoginMessages {
  const base = authMessages(locale).workspaceLogin;
  const normalizedLabel = providerLabel.trim() || "OpenApp";
  if (legacyCompatibility && compatibility?.workspaceLoginCopy) {
    return compatibility.workspaceLoginCopy(locale, base);
  }
  if (locale === "zh-CN") {
    return {
      ...base,
      formLabel: `登录 ${normalizedLabel}`,
      headingLead: "进入你的",
      enterProvider: `进入 ${normalizedLabel}`,
    };
  }
  return {
    ...base,
    formLabel: `Sign in to ${normalizedLabel}`,
    headingLead: "Return to your",
    enterProvider: `Enter ${normalizedLabel}`,
  };
}

export function resolveAuthLocale(
  source: BrowserLanguageSource | undefined = typeof navigator === "undefined" ? undefined : navigator,
): AuthLocale {
  const candidates = [...(source?.languages ?? []), source?.language];
  for (const candidate of candidates) {
    const locale = normalizeAuthLocale(candidate);
    if (locale) return locale;
  }
  return "en";
}

export function formatAuthError(
  reason: unknown,
  fallback: string,
  locale: AuthLocale = "en",
  legacyCompatibility = false,
  compatibility?: AuthCompatibility,
  errorCatalog?: AuthErrorCatalog,
): string {
  if (!(reason instanceof ApiError)) {
    if (reason instanceof Error && reason.message) return reason.message;
    if (typeof reason === "string" && reason.trim()) return reason;
    return fallback;
  }
  const localizedErrors = authErrors[locale];
  const manifestMessage = errorCatalog?.[locale]?.[reason.code];
  if (manifestMessage) return manifestMessage;
  if (localizedErrors[reason.code]) return localizedErrors[reason.code]!;
  if (legacyCompatibility && compatibility?.authErrorMessage) {
    const legacyMessage = compatibility.authErrorMessage(reason.code, locale);
    if (legacyMessage) return legacyMessage;
  }
  if (reason.status === 429)
    return locale === "en" ? "Too many operations. Please try again later." : "操作过于频繁，请稍后再试。";
  if (reason.status >= 500)
    return locale === "en"
      ? "The sign-in service is temporarily unavailable. Please try again later."
      : "登录服务暂时不可用，请稍后重试。";
  return fallback;
}

function normalizeAuthLocale(language: string | undefined): AuthLocale | null {
  const primary = language?.trim().split(/[-_]/u, 1)[0]?.toLowerCase();
  if (primary === "zh") return "zh-CN";
  if (primary === "en") return "en";
  return null;
}
