/** 只声明已有镜像的接入合同；账号、授权与工作区调度由 Core 提供。 */
import type { OpenAppAdapterFactory } from "@openapp/contracts";
import profile from "./profile.json" with { type: "json" };

const createAdapter: OpenAppAdapterFactory = () => ({
  manifest: {
    id: "notes-demo",
    apiVersion: "v2",
    version: "1.0.0",
    name: "独立笔记",
    description: "为每位用户提供自己的持久笔记",
    entry: {
      id: "notes-demo",
      label: "独立笔记",
      logoUrl: "/openapp-logo.png",
      challenge: "none",
      defaultWorkspace: "personal",
    },
    capabilities: { websocket: false, downstreamSession: false },
    auth: { providerId: "none", protocol: "none", fields: [] },
    workload: {
      runtimeContract: profile.contract,
      environmentKind: "container",
      workloadClass: "web",
      accessMode: "http",
      healthPath: profile.healthPath,
      runtime: profile,
    },
    catalogBootstrap: {
      version: "1.0.0",
      imageReference: profile.defaultImage,
      runtimeContract: profile.contract,
    },
  },
  authHandoff: {
    appId: "notes-demo",
    managedCookieNames: [],
    acceptsCredentialGrant() {
      return false;
    },
    async onLogin(input) {
      if (input.credentialGrant) throw Error("credential_grant_not_supported");
      return [];
    },
    async onLogout() {
      return [];
    },
    proxyOptions() {
      return { stripRequestCookies: true };
    },
  },
});
export default createAdapter;
