/** 同源部署清单选择经过审核的登录视图；普通插件 UI 不依赖历史协议开关。 */
import * as React from "react";
import { ApiError, request } from "../../api";
import type { AuthCompatibility } from "../../auth-i18n";
import type {
  AuthUiHost as PublicAuthUiHost,
  AuthUiExtension as PublicAuthUiExtension,
  AuthUiLoginProps,
} from "@openapp/contracts/ui";

export type AuthUiExtension = PublicAuthUiExtension<React.ComponentType<AuthUiLoginProps>>;
export type AuthUiHost = PublicAuthUiHost<typeof React>;
export interface AuthUiModule {
  apiVersion: number;
  createAuthUi?: (host: AuthUiHost) => AuthUiExtension;
  createAuthCompatibility?: (host: AuthUiHost) => AuthCompatibility;
}
export const authUiHost: AuthUiHost = { ApiError, request, React };

/** 缺少清单代表未部署 UI 扩展；非法清单与模块必须报错，不能绕过校验。 */
export async function loadAuthUiModule(
  providerId: string | undefined,
  importModule: (url: string) => Promise<AuthUiModule> = (url) => import(/* @vite-ignore */ url),
): Promise<AuthUiModule | undefined> {
  let catalog: { schemaVersion: number; defaultProviderId?: string; providers: Record<string, string> };
  try {
    catalog = await request("/auth-adapters.json");
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
  if (
    catalog.schemaVersion !== 1 ||
    !catalog.providers ||
    typeof catalog.providers !== "object" ||
    Array.isArray(catalog.providers)
  ) {
    throw new Error("auth_ui_catalog_invalid");
  }
  const selected = providerId ?? catalog.defaultProviderId;
  const url =
    selected && Object.hasOwn(catalog.providers, selected) ? catalog.providers[selected] : undefined;
  if (!url) return undefined;
  if (!/^\/adapter-assets\/[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9_-]+\.mjs$/.test(url))
    throw new Error("auth_ui_module_path_invalid");
  const module = await importModule(url);
  if (module.apiVersion !== 1) throw new Error("auth_ui_module_incompatible");
  return module;
}

export async function loadAuthUiExtension(
  providerId: string | undefined,
  importModule?: (url: string) => Promise<AuthUiModule>,
): Promise<AuthUiExtension> {
  const module = await loadAuthUiModule(providerId, importModule);
  // 旧模块继续交给显式 legacy 宿主处理，通用入口不调用兼容工厂。
  if (!module?.createAuthUi) return {};
  if (typeof module.createAuthUi !== "function") throw new Error("auth_ui_module_incompatible");
  const extension = module.createAuthUi(authUiHost);
  if (!extension || typeof extension !== "object") throw new Error("auth_ui_extension_invalid");
  return { views: extension.views };
}
