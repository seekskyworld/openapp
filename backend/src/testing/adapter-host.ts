/** 版本化的集成测试宿主；不属于生产入口，不包含产品实现。 */
import { fileURLToPath } from 'node:url';
import * as module0 from "../admin-monitoring.js";
import * as module1 from "../admin-monitoring-routes.js";
import * as module2 from "../persistence/memory.js";
import * as module3 from "../instance-policy.js";
import * as module4 from "../docker-provider-adapter.js";
import * as module5 from "../app-catalog.js";
import * as module6 from "../models.js";
import * as module7 from "../app-image-updates.js";
import * as module8 from "../build-strategies.js";
import * as module9 from "../image-build-executor.js";
import * as module10 from "../image-builds.js";
import * as module11 from "../portal-app.js";
import * as module12 from "../auth/public.js";
import * as module13 from "../auth/app-auth-handoff.js";
import * as module14 from "../testing/memory-persistence.js";
import * as module15 from "../auth/local-password.js";
import * as module16 from "../auth/portal-auth.js";
import * as module17 from "../auth/provider-registry.js";
import * as module18 from "../build-package-upload.js";
import * as module19 from "../release-inspection.js";
import * as module20 from "../release-contract.js";
import * as module21 from "../artifact-provider.js";
import * as module24 from "../instance-access.js";
import * as module25 from "../workspace-execution.js";
import * as module26 from "../runtime.js";
import * as module27 from "@openapp/container-runtime";
import * as module28 from "../config-revisions.js";
import * as module29 from "../forwarding-policy.js";
import * as module30 from "../persistence/factory.js";
import * as module31 from "../persistence/postgres.js";
import * as module32 from "../instance-lifecycle.js";
import * as module33 from "../workspace-execution-model.js";
import * as module34 from "../quota-admission.js";
import * as module35 from "../instance-upgrade-activity.js";
import * as module36 from "../auth/provider-compatibility.js";
import * as module37 from "./mock-auth-provider.js";
import * as module38 from "../config-defaults.js";
import * as module39 from "../config-core.js";
import * as module40 from "../portal-context-core.js";
import * as module41 from "../external-adapter.js";
import * as module42 from "../platform-plugins.js";
import * as module43 from "../stores-core.js";
import * as module44 from "../upgrade-rollouts.js";
import * as module46 from "../portal-context-generic.js";
import * as module47 from "../contract-provider-adapter.js";
import * as module48 from "../execution-provider-registry.js";
import * as module49 from "../portal-compatibility.js";
import * as module50 from "../resource-cleanup.js";
import * as module51 from "../testing/container-runtime-stub.js";
import * as module52 from "../execution-provider.js";
// 示例只由测试宿主显式加载，不进入生产依赖图。
const samplePlugin = await import(new URL('../../../examples/plain-web/plugin.mjs', import.meta.url).href);
export const apiVersion = 1;
export const backendDirectory = fileURLToPath(new URL('../../', import.meta.url));
export const entrypoints = { server: fileURLToPath(new URL('../server.js', import.meta.url)), migration: fileURLToPath(new URL('../migrate.js', import.meta.url)) };
export const modules = {
  "examples/plain-web": samplePlugin,
  "admin-monitoring": module0,
  "admin-monitoring-routes": module1,
  "persistence/memory": module2,
  "instance-policy": module3,
  "docker-provider-adapter": module4,
  "app-catalog": module5,
  "models": module6,
  "app-image-updates": module7,
  "build-strategies": module8,
  "image-build-executor": module9,
  "image-builds": module10,
  "portal-app": module11,
  "auth/public": module12,
  "auth/app-auth-handoff": module13,
  "testing/memory-persistence": module14,
  "auth/local-password": module15,
  "auth/portal-auth": module16,
  "auth/provider-registry": module17,
  "build-package-upload": module18,
  "release-inspection": module19,
  "release-contract": module20,
  "artifact-provider": module21,
  "instance-access": module24,
  "workspace-execution": module25,
  "runtime": module26,
  "container-runtime": module27,
  "config-revisions": module28,
  "forwarding-policy": module29,
  "persistence/factory": module30,
  "persistence/postgres": module31,
  "instance-lifecycle": module32,
  "workspace-execution-model": module33,
  "quota-admission": module34,
  "instance-upgrade-activity": module35,
  "auth/provider-compatibility": module36,
  "auth/mock-provider": module37,
  "config-defaults": module38,
  "config-core": module39,
  "portal-context-core": module40,
  "external-adapter": module41,
  "platform-plugins": module42,
  "stores-core": module43,
  "upgrade-rollouts": module44,
  "portal-context-generic": module46,
  "contract-provider-adapter": module47,
  "execution-provider-registry": module48,
  "portal-compatibility": module49,
  "resource-cleanup": module50,
  "testing/container-runtime-stub": module51,
  "execution-provider": module52,
};
