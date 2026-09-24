/** 浏览器登录扩展的公开类型；React 类型由调用方传入，后端 SDK 不依赖 React。 */
export const AUTH_UI_API_VERSION = 1 as const;
export interface AuthUiUser {
  id: string;
  email: string;
  name?: string;
  role: "user" | "admin" | "super_admin";
  authMethod?: string;
  passwordSetupRequired?: boolean;
  linkedProviders?: string[];
  createdAt?: string;
}
export interface AuthUiLoginProps {
  locale: "en" | "zh-CN";
  onLogin(user: AuthUiUser): void;
  initialError?: unknown;
}
export interface AuthUiError extends Error {
  status: number;
  code: string;
  requestId?: string;
}
export interface AuthUiHost<ReactApi> {
  React: ReactApi;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  ApiError: new (status: number, code: string, requestId?: string) => AuthUiError;
}
export interface AuthUiExtension<View> {
  views?: { workspace: View; control: View };
}
export type AuthUiFactory<ReactApi, View> = (host: AuthUiHost<ReactApi>) => AuthUiExtension<View>;
export interface AuthUiModule<ReactApi, View> {
  apiVersion: typeof AUTH_UI_API_VERSION;
  createAuthUi: AuthUiFactory<ReactApi, View>;
}
