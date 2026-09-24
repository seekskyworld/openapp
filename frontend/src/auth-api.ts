import { ApiError, request, type PortalUser } from './api';

export type AuthSession =
  | { authenticated: false; status: 'unauthenticated' }
  | { authenticated: true; status: 'authenticated'; user: PortalUser };

export interface ExternalAuthProvider {
  id: string;
  label: string;
  iconUrl: string;
  challenge: 'email_code' | 'oidc' | 'none';
  /** Optional Provider-owned fields; the shell renders only these reviewed kinds. */
  fields?: readonly ExternalAuthField[];
  capabilities?: Readonly<Record<string, boolean>>;
}

export type ExternalAuthFieldKind = 'email' | 'verification_code' | 'text' | (string & {});

export interface ExternalAuthField {
  id: string;
  kind: ExternalAuthFieldKind;
  label: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  maxLength?: number;
}

export interface AuthMethods {
  local: { enabled: boolean; label: string };
  external: ExternalAuthProvider[];
  /** 服务端当前默认 Provider；入口 manifest 可以覆盖它。 */
  authProviderId?: string;
  /** 旧组合根的兼容提示；通用客户端不应根据 Provider 名称猜测。 */
  compatibilityMode?: boolean;
  admin: { localOnly: boolean };
}

export interface ExternalEmailCodeResult {
  /** Provider 自有的挑战元数据；Shell 只能透传，不能解释其语义。 */
  providerData?: Readonly<Record<string, unknown>>;
  isNewUser?: boolean;
}

export interface AuthApi {
  session(): Promise<AuthSession>;
  methods(): Promise<AuthMethods>;
  localLogin(email: string, password: string): Promise<PortalUser>;
  localAdminLogin(email: string, password: string): Promise<PortalUser>;
  localRegister(email: string, password: string): Promise<PortalUser>;
  sendExternalEmailCode(provider: string, email: string): Promise<ExternalEmailCodeResult>;
  externalLogin(
    provider: string,
    email: string,
    code: string,
    providerData?: Readonly<Record<string, unknown>>,
  ): Promise<PortalUser>;
  setupPassword(newPassword: string): Promise<PortalUser>;
  changePassword(currentPassword: string, newPassword: string): Promise<PortalUser>;
  sendExternalPasswordCode(provider: string): Promise<void>;
  changePasswordWithExternal(provider: string, code: string, newPassword: string): Promise<PortalUser>;
  logout(): Promise<void>;
}

interface SessionResponse {
  authenticated?: boolean;
  status?: string;
  user?: PortalUser;
}

export const authApi: AuthApi = {
  async session() {
    const response = await request<SessionResponse>('/api/auth/session');
    if (response.authenticated === false) return { authenticated: false, status: 'unauthenticated' };
    if (response.authenticated === true && response.user) {
      return { authenticated: true, status: 'authenticated', user: response.user };
    }
    throw new ApiError(200, 'invalid_server_response');
  },
  methods: () => request<AuthMethods>('/api/auth/methods'),
  async localLogin(email, password) {
    const response = await request<{ user?: PortalUser }>('/api/auth/local/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    if (!response.user) throw new ApiError(200, 'invalid_server_response');
    return response.user;
  },
  async localAdminLogin(email, password) {
    const response = await request<{ user?: PortalUser }>('/api/auth/local/admin-login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    if (!response.user) throw new ApiError(200, 'invalid_server_response');
    return response.user;
  },
  async localRegister(email, password) {
    const response = await request<{ user?: PortalUser }>('/api/auth/local/register', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    if (!response.user) throw new ApiError(200, 'invalid_server_response');
    return response.user;
  },
  async sendExternalEmailCode(provider, email) {
    const response = await request<{
      ok?: boolean;
      providerData?: unknown;
      isNewUser?: unknown;
      [key: string]: unknown;
    }>(`/api/auth/external/${encodeURIComponent(provider)}/email-codes`, {
      method: 'POST', body: JSON.stringify({ email }),
    });
    if (response.ok !== true) throw new ApiError(200, 'invalid_server_response');
    const providerData = readProviderData(response);
    return {
      ...(providerData ? { providerData } : {}),
      ...(typeof response.isNewUser === 'boolean' ? { isNewUser: response.isNewUser } : {}),
    };
  },
  async externalLogin(provider, email, code, providerData) {
    const response = await request<{ user?: PortalUser }>(`/api/auth/external/${encodeURIComponent(provider)}/login`, {
      method: 'POST', body: JSON.stringify({
        email,
        code,
        ...(providerData && Object.keys(providerData).length > 0 ? { providerData } : {}),
      }),
    });
    if (!response.user) throw new ApiError(200, 'invalid_server_response');
    return response.user;
  },
  async setupPassword(newPassword) {
    return userResponse('/api/auth/password/setup', { newPassword });
  },
  async changePassword(currentPassword, newPassword) {
    return userResponse('/api/auth/password/change', { currentPassword, newPassword });
  },
  async sendExternalPasswordCode(provider) {
    const response = await request<{ ok?: boolean }>(`/api/auth/password/external/${encodeURIComponent(provider)}/email-codes`, {
      method: 'POST', body: '{}',
    });
    if (response.ok !== true) throw new ApiError(200, 'invalid_server_response');
  },
  async changePasswordWithExternal(provider, code, newPassword) {
    return userResponse(`/api/auth/password/external/${encodeURIComponent(provider)}/change`, { code, newPassword });
  },
  async logout() {
    const response = await request<{ ok?: boolean }>('/api/auth/logout', { method: 'POST', body: '{}' });
    if (response.ok !== true) throw new ApiError(200, 'invalid_server_response');
  },
};

async function userResponse(path: string, body: Record<string, unknown>): Promise<PortalUser> {
  const response = await request<{ user?: PortalUser }>(path, { method: 'POST', body: JSON.stringify(body) });
  if (!response.user) throw new ApiError(200, 'invalid_server_response');
  return response.user;
}

function readProviderData(response: Record<string, unknown>): Readonly<Record<string, unknown>> | undefined {
  const providerData = isRecord(response.providerData) ? { ...response.providerData } : {};
  // 旧网关会把 Provider 挑战元数据放在 `ok` 旁边。这里只保留标量值，
  // 交给显式兼容投影解释，避免这些字段名进入通用 API 合同。
  for (const [key, value] of Object.entries(response)) {
    if (key === 'ok' || key === 'providerData' || key === 'isNewUser') continue;
    if (isProviderDataScalar(value) && providerData[key] === undefined) providerData[key] = value;
  }
  return Object.keys(providerData).length > 0 ? providerData : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProviderDataScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
