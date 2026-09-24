import type { AuthCompatibility } from '../../../auth-i18n';
import { authUiHost, loadAuthUiModule, type AuthUiModule } from '../auth-ui';

/** Only the deployment-owned, same-origin catalog can select executable UI extensions. */
export async function loadLegacyAuthCompatibility(
  providerId: string | undefined,
  importModule: (url: string) => Promise<AuthUiModule> = (url) => import(/* @vite-ignore */ url),
): Promise<AuthCompatibility> {
  const module = await loadAuthUiModule(providerId, importModule);
  if (!module) return {};
  if (typeof module.createAuthCompatibility !== 'function') {
    throw new Error('auth_ui_module_incompatible');
  }
  return module.createAuthCompatibility(authUiHost);
}
