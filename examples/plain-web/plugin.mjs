
/**
 * 普通 Web 单体的最小插件合同。它只复用 OpenApp 的 Portal 身份，不把
 * Portal/下游凭证转发给下游，因此可以作为第二个 App 的通用契约样例。
 */

export const PLAIN_WEB_APP_ID = "plain-web";

export function createPlainWebPlugin(options = {}) {
  const appId = options.appId?.trim().toLowerCase() || PLAIN_WEB_APP_ID;
  const label = options.label?.trim() || "Plain Web";
  const entryExperience = {
    id: "generic-workspace",
    label,
    logoUrl: options.logoUrl?.trim() || "/openapp-logo.png",
    // 没有外部认证 Provider 时明确声明 none，入口不会伪造邮箱验证码流程。
    challenge: "none",
    defaultWorkspace: "personal",
  };
  const capabilities = {
    ...options.capabilities,
    // 示例不转发凭据，附加能力不能覆盖这一安全边界。
    downstreamSession: false,
    emailCodeEntry: false,
    websocket: true,
  };
  return {
    appId,
    manifest: {
      id: appId,
      apiVersion: "v2",
      version: options.version?.trim() || "1.0.0",
      authProviders: [],
      appIntegrations: [appId],
      buildStrategies: [],
      executionContracts: ["none"],
      entryExperience: entryExperience.id,
      capabilities,
    },
    entryExperience,
  };
}
