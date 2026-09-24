/** 最小声明工厂；具体运行镜像与认证能力由应用开发者补充。 */
import type { OpenAppAdapterFactory } from "@openapp/contracts";
const createAdapter: OpenAppAdapterFactory = () => ({
  manifest: {
    id: "sample-app",
    apiVersion: "v2",
    version: "1.0.0",
    name: "Sample App",
    description: "Independent Adapter template",
    entry: {
      id: "sample-app",
      label: "Sample App",
      logoUrl: "/openapp-logo.png",
      challenge: "none",
      defaultWorkspace: "personal",
    },
    capabilities: { websocket: false, downstreamSession: false },
    auth: { providerId: "none", protocol: "none", fields: [] },
    workload: {
      runtimeContract: "sample-app-v1",
      environmentKind: "container",
      workloadClass: "web",
      accessMode: "http",
      healthPath: "/health",
    },
  },
});
export default createAdapter;
