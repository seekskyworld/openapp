/**
 * 通用认证核心只负责明确的无外部认证模式。外部身份
 * Provider 必须由 App/平台插件注册，避免 Core 静态依赖某个供应商实现。
 */
import type { AuthProvider, AuthService } from "./types.js";

export interface GenericAuthConfig {
  readonly authProvider: string;
}

export function createGenericAuthService(
  config: GenericAuthConfig,
): AuthService {
  if (config.authProvider !== "none") throw new Error("auth_provider_not_registered");
  const provider: AuthProvider = new NoAuthProvider();
  return {
    provider: provider.id,
    sendEmailCode: (email) => provider.sendEmailCode(email),
    login: (input) => provider.login(input),
  };
}

class NoAuthProvider implements AuthProvider {
  readonly id = "none";

  async sendEmailCode(): Promise<void> {
    throw new Error("auth_provider_not_configured");
  }

  async login(): Promise<never> {
    throw new Error("auth_provider_not_configured");
  }
}
