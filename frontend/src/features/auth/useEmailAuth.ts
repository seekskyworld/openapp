import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import { ApiError, type PortalUser } from '../../api';
import {
  authApi,
  type ExternalAuthField,
  type ExternalAuthProvider,
  type ExternalEmailCodeResult,
} from '../../auth-api';
import {
  formatAuthError,
  type AuthCompatibility,
  type AuthErrorCatalog,
  type AuthLocale,
} from '../../auth-i18n';

/** 通用邮箱验证码流程状态；Provider 专属字段由 manifest 声明。 */
export type AuthBusyState = 'code' | 'login' | null;

export type AuthFlowError =
  | { type: 'initial'; reason: unknown }
  | { type: 'provider-unavailable' }
  | { type: 'methods'; reason: unknown }
  | { type: 'send-code'; reason: unknown; providerLabel: string }
  | {
    type: 'login';
    reason: unknown;
    requiredFieldIds?: readonly string[];
    verificationCodeInvalid?: boolean;
  };

export interface EmailAuthCopy {
  providerUnavailable: string;
  methodsLoadFailed: string;
  sessionRestoreFailed: string;
  sendCodeFailed: (providerLabel: string) => string;
  loginFailed: string;
}

export interface EmailAuthFlow {
  provider: ExternalAuthProvider | null;
  /** Additional fields declared by the selected Provider (email/code excluded). */
  providerFields: readonly ExternalAuthField[];
  providerFieldValues: Readonly<Record<string, string>>;
  providerFieldInvalid: Readonly<Record<string, boolean>>;
  email: string;
  code: string;
  codeSent: boolean;
  registrationFlow: boolean;
  normalizedEmail: string;
  normalizedCode: string;
  codeMaxLength: number;
  codeValid: boolean;
  requiredProviderFieldsMissing: boolean;
  pending: boolean;
  busy: AuthBusyState;
  error: AuthFlowError | null;
  errorMessage: string;
  emailInputRef: RefObject<HTMLInputElement>;
  codeInputRef: RefObject<HTMLInputElement>;
  setError: Dispatch<SetStateAction<AuthFlowError | null>>;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  sendCode: () => Promise<void>;
  authenticate: () => Promise<void>;
  updateEmail: (event: ChangeEvent<HTMLInputElement>) => void;
  updateCode: (event: ChangeEvent<HTMLInputElement>) => void;
  updateProviderField: (fieldId: string, value: string) => void;
  editEmail: () => void;
  resetVerification: () => void;
  clearError: () => void;
}

export interface UseEmailAuthOptions {
  provider: ExternalAuthProvider | null;
  locale: AuthLocale;
  onLogin: (user: PortalUser) => void;
  initialError?: unknown;
  copy: EmailAuthCopy;
  /** 仅旧入口允许把 Provider 专属错误码投影为兼容文案。 */
  legacyCompatibility?: boolean;
  /** 由显式兼容入口注入的旧错误翻译；通用流程不识别产品错误码。 */
  compatibility?: AuthCompatibility;
  /** 由 Adapter manifest 提供的、经过服务端合同校验的错误文案。 */
  errorCatalog?: AuthErrorCatalog;
  /** Static Provider-specific values supplied by a reviewed App adapter. */
  providerData?: Readonly<Record<string, unknown>>;
  /**
   * Fields declared by the App entry manifest. The manifest is the stable
   * adapter contract; Provider presentation may add or refine the same ids.
   */
  declaredFields?: readonly ExternalAuthField[];
}

/** Selects the first registered external Provider for a generic App entry. */
export function selectExternalProvider(
  providers: readonly ExternalAuthProvider[],
  providerId?: string,
): ExternalAuthProvider | null {
  if (providerId?.trim()) {
    const normalized = providerId.trim().toLowerCase();
    return providers.find((candidate) => candidate.id.trim().toLowerCase() === normalized) ?? null;
  }
  return providers[0] ?? null;
}

/**
 * Shared email-code flow used by every entry shell. The surrounding pages own
 * provider discovery and presentation; this hook owns only the generic
 * challenge contract and registration state.
 */
export function useEmailAuth({
  provider,
  locale,
  onLogin,
  initialError,
  copy,
  legacyCompatibility = false,
  compatibility,
  errorCatalog,
  providerData: staticProviderData,
  declaredFields = [],
}: UseEmailAuthOptions): EmailAuthFlow {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [providerFieldValues, setProviderFieldValues] = useState<Record<string, string>>({});
  const [providerFieldInvalid, setProviderFieldInvalid] = useState<Record<string, boolean>>({});
  const [emailCodeResult, setEmailCodeResult] = useState<ExternalEmailCodeResult | null>(null);
  const [errorProviderFields, setErrorProviderFields] = useState<readonly ExternalAuthField[]>([]);
  const [busy, setBusy] = useState<AuthBusyState>(null);
  const [error, setError] = useState<AuthFlowError | null>(
    initialError ? { type: 'initial', reason: initialError } : null,
  );
  const emailInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  const normalizedEmail = email.trim();
  const normalizedCode = code.trim();
  const pending = busy !== null;
  const compatibilityFields = useMemo(() => {
    if (!emailCodeResult || !legacyCompatibility || !compatibility?.emailCodeFields) return undefined;
    try {
      return compatibility.emailCodeFields(emailCodeResult, locale);
    } catch {
      // 兼容投影失败时回到 Provider 自身声明，不能阻塞通用登录流程。
      return undefined;
    }
  }, [compatibility, emailCodeResult, legacyCompatibility, locale]);
  const providerFields = useMemo(() => {
    const byId = new Map<string, ExternalAuthField>();
    // Manifest fields are the reviewed App contract. A live Provider may
    // refine a field (for example its localized label), so it wins by id.
    for (const field of declaredFields) byId.set(field.id, field);
    for (const field of provider?.fields ?? []) byId.set(field.id, field);
    for (const field of compatibilityFields ?? []) byId.set(field.id, field);
    for (const field of errorProviderFields) byId.set(field.id, field);
    return [...byId.values()].filter((field) => field.kind !== 'email' && field.kind !== 'verification_code');
  }, [compatibilityFields, declaredFields, errorProviderFields, provider]);
  const registrationFlow = codeSent && providerFields.length > 0;
  const requiredProviderFieldsMissing = providerFields.some((field) =>
    field.required === true && !(providerFieldValues[field.id] ?? '').trim());
  const codeField = [...declaredFields, ...(provider?.fields ?? [])].reverse().find((field) => field.kind === 'verification_code');
  const codeMaxLength = Math.min(codeField?.maxLength ?? 256, 256);
  const codeValid = normalizedCode.length > 0 && normalizedCode.length <= codeMaxLength;
  const errorMessage = authErrorMessage(error, copy, locale, legacyCompatibility, compatibility, errorCatalog);

  useEffect(() => {
    if (codeSent) codeInputRef.current?.focus();
  }, [codeSent]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider || !normalizedEmail || pending) return;
    if (!codeSent) {
      await sendCode();
      return;
    }
    if (!codeValid || requiredProviderFieldsMissing) return;
    await authenticate();
  }

  async function sendCode() {
    if (!provider || !normalizedEmail || pending) return;
    setBusy('code');
    clearError();
    try {
      const result = await authApi.sendExternalEmailCode(provider.id, normalizedEmail);
      setEmailCodeResult(result);
      setCodeSent(true);
    } catch (reason) {
      setError({ type: 'send-code', reason, providerLabel: provider.label });
    } finally {
      setBusy(null);
    }
  }

  async function authenticate() {
    if (!provider || !normalizedEmail || pending || !codeValid || requiredProviderFieldsMissing) return;
    setBusy('login');
    clearError();
    try {
      const additionalProviderData: Record<string, unknown> = { ...staticProviderData };
      for (const field of providerFields) {
        const value = (providerFieldValues[field.id] ?? '').trim();
        if (value) additionalProviderData[field.id] = value;
      }
      const providerData = Object.keys(additionalProviderData).length > 0
        ? additionalProviderData
        : undefined;
      const login = legacyCompatibility && compatibility?.externalLogin
        ? compatibility.externalLogin
        : authApi.externalLogin;
      const user = await login(
        provider.id,
        normalizedEmail,
        normalizedCode,
        providerData,
      );
      onLogin(user);
    } catch (reason) {
      const projection = classifyAuthError(reason, locale, legacyCompatibility, compatibility);
      const requiredFieldIds = projection?.requiredFieldIds ?? [];
      setProviderFieldInvalid(Object.fromEntries(requiredFieldIds.map((id) => [id, true])));
      setErrorProviderFields((current) => {
        const fields = new Map(current.map((field) => [field.id, field]));
        for (const field of projection?.fields ?? []) fields.set(field.id, field);
        for (const field of [...providerFields, ...fields.values()]) {
          if (requiredFieldIds.includes(field.id)) fields.set(field.id, { ...field, required: true });
        }
        return [...fields.values()];
      });
      setError({
        type: 'login',
        reason,
        ...(requiredFieldIds.length > 0 ? { requiredFieldIds } : {}),
        ...(projection?.verificationCodeInvalid ? { verificationCodeInvalid: true } : {}),
      });
    } finally {
      setBusy(null);
    }
  }

  function updateEmail(event: ChangeEvent<HTMLInputElement>) {
    setEmail(event.currentTarget.value);
    resetVerification();
  }

  function editEmail() {
    if (pending) return;
    resetVerification();
    window.setTimeout(() => emailInputRef.current?.focus(), 0);
  }

  function updateCode(event: ChangeEvent<HTMLInputElement>) {
    setCode(event.currentTarget.value.slice(0, codeMaxLength));
    clearError();
  }

  function updateProviderField(fieldId: string, value: string) {
    setProviderFieldValues((current) => ({ ...current, [fieldId]: value }));
    setProviderFieldInvalid((current) => ({ ...current, [fieldId]: false }));
    clearError();
  }

  function resetVerification() {
    setCode('');
    setProviderFieldValues({});
    setProviderFieldInvalid({});
    setEmailCodeResult(null);
    setErrorProviderFields([]);
    setCodeSent(false);
    clearError();
  }

  function clearError() {
    setError(null);
    setProviderFieldInvalid({});
  }

  return {
    provider,
    providerFields,
    providerFieldValues,
    providerFieldInvalid,
    email,
    code,
    codeSent,
    registrationFlow,
    normalizedEmail,
    normalizedCode,
    codeMaxLength,
    codeValid,
    requiredProviderFieldsMissing,
    pending,
    busy,
    error,
    errorMessage,
    emailInputRef,
    codeInputRef,
    setError,
    submit,
    sendCode,
    authenticate,
    updateEmail,
    updateCode,
    updateProviderField,
    editEmail,
    resetVerification,
    clearError,
  };
}

export function authRequirementNotice(error: AuthFlowError | null): boolean {
  return error?.type === 'login' && (error.requiredFieldIds?.length ?? 0) > 0;
}

export function verificationCodeInvalid(error: AuthFlowError | null): boolean {
  if (error?.type !== 'login' || !(error.reason instanceof ApiError)) return false;
  return error.verificationCodeInvalid === true
    || error.reason.code === 'verification_code_required'
    || error.reason.code === 'verification_code_invalid';
}

export function authErrorMessage(
  error: AuthFlowError | null,
  copy: EmailAuthCopy,
  locale: AuthLocale,
  legacyCompatibility = false,
  compatibility?: AuthCompatibility,
  errorCatalog?: AuthErrorCatalog,
): string {
  if (!error) return '';
  if (error.type === 'initial') return formatAuthError(error.reason, copy.sessionRestoreFailed, locale, legacyCompatibility, compatibility, errorCatalog);
  if (error.type === 'provider-unavailable') return copy.providerUnavailable;
  if (error.type === 'methods') return formatAuthError(error.reason, copy.methodsLoadFailed, locale, legacyCompatibility, compatibility, errorCatalog);
  if (error.type === 'send-code') {
    return formatAuthError(error.reason, copy.sendCodeFailed(error.providerLabel), locale, legacyCompatibility, compatibility, errorCatalog);
  }
  return formatAuthError(error.reason, copy.loginFailed, locale, legacyCompatibility, compatibility, errorCatalog);
}

function classifyAuthError(
  reason: unknown,
  locale: AuthLocale,
  legacyCompatibility: boolean,
  compatibility?: AuthCompatibility,
): {
  requiredFieldIds?: readonly string[];
  verificationCodeInvalid?: boolean;
  fields?: readonly ExternalAuthField[];
} | undefined {
  if (legacyCompatibility && compatibility?.classifyAuthError) {
    const projected = compatibility.classifyAuthError(reason, locale);
    if (projected) return projected;
  }
  if (reason instanceof ApiError && (reason.code === 'verification_code_required' || reason.code === 'verification_code_invalid')) {
    return { verificationCodeInvalid: true };
  }
  return undefined;
}
