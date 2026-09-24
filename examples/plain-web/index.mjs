/** 独立 HTTP 示例通过公开 manifest 注册运行约定，不读取 Core 私有模块。 */
import profile from './runtime/profile.json' with { type: 'json' };
export default function createAdapter() {
  return { manifest: {
    id: 'plain-web', apiVersion: 'v2', version: '1.0.0', name: 'Plain Web', description: 'Minimal application integration example',
    entry: { id: 'plain-web', label: 'Plain Web', logoUrl: '/openapp-logo.png', challenge: 'none', defaultWorkspace: 'personal' },
    capabilities: { websocket: false, downstreamSession: false },
    auth: { providerId: 'none', protocol: 'none', fields: [] },
    workload: { runtimeContract: profile.contract, environmentKind: 'container', workloadClass: 'web', accessMode: 'http', healthPath: '/health', runtime: profile },
    catalogBootstrap: { version: '1.0.0', imageReference: 'plain-web:1.0.0', runtimeContract: profile.contract },
  }, authHandoff: {
    appId: 'plain-web', managedCookieNames: [],
    acceptsCredentialGrant() { return false; },
    async onLogin(input) {
      if (input.credentialGrant) throw new Error('credential_grant_not_supported');
      return [];
    },
    async onLogout() { return []; },
    proxyOptions() { return { stripRequestCookies: true }; },
  } };
}
