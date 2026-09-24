import { runtimeReservedEnvironmentNames } from "@openapp/container-runtime";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppAuthHandoffError } from "./auth/app-auth-handoff.js";
import { PortalAuthError, type PortalLoginResult } from "./auth/portal-auth.js";
import { HttpError, readJsonBody, sendJson } from "./http-response.js";
import { assertWriteOrigin, safeRequestPath } from "./http-security.js";
import { InstanceLifecycleError, isLifecycleCapacityError } from "./instance-lifecycle.js";
import {
  IMAGE_REFERENCE_PATTERN,
  InstancePolicyError,
  provisioningPolicyEffect,
  updateProvisioningPolicy,
} from "./instance-policy.js";
import {
  AppCatalogError,
  ConfigRevisionConflictError,
  UserRoleUpdateError,
  type AuthenticatedUser,
  type Container,
} from "./models.js";
import type { PortalContext } from "./portal-context-core.js";
import { createReadinessProbe } from "./portal-readiness.js";
import { servePortalStatic } from "./portal-static.js";
import { ProxyError } from "./proxy.js";
import { ReleaseInspectionError } from "./release-inspection.js";
import { isManagementRole } from "./user-role-policy.js";

import { handleAdminMonitoringRoute } from "./admin-monitoring-routes.js";
import {
  AdminOperationConflictError,
  AdminOperationTaskError,
  sanitizeOperationError,
} from "./admin-operations.js";
import { paginateAdminList } from "./admin-pagination.js";
import { AppImageUpdateError } from "./app-image-updates.js";
import { ArtifactOperationError } from "./artifact-provider.js";
import type { ExternalAuthProviderDescription } from "./auth/provider-registry.js";
import {
  BuildPackageUploadError,
  receiveBuildPackageSlotUpload,
  receiveBuildPackageUpload,
} from "./build-package-upload.js";
import { ImageBuildExecutionError } from "./build-strategies.js";
import {
  ConfigRevisionService,
  ConfigRevisionServiceError,
  type ConfigRevisionKind,
} from "./config-revisions.js";
import { ProviderOperationError } from "./execution-provider.js";
import { ForwardingPolicyError } from "./forwarding-policy.js";
import { ImageBuildError } from "./image-builds.js";
import { InstanceAccessError, WorkspaceAccessCoordinator } from "./instance-access.js";
import { InstanceActivityAdmissionError } from "./instance-upgrade-activity.js";
import { createOperationContext, formatDiagnosticContext } from "./operation-context.js";
import { PortalMaintenanceCoordinator } from "./portal-maintenance.js";
import { readProviderHealthStatus } from "./provider-observability.js";
import { QuotaAdmissionError } from "./quota-admission.js";
import { ResourceCleanupError } from "./resource-cleanup.js";
import {
  upgradeInstanceLeaseName,
  UpgradeRolloutConflictError,
  type UpgradeRollout,
  type UpgradeRolloutDetail,
  type UpgradeRolloutItem,
  type UpgradeRolloutTaskKind,
} from "./upgrade-rollouts.js";
import { cleanupStaleUploadArtifacts } from "./upload-artifact-cleanup.js";
import { assertAccessTargetEnvironment, resolveWorkspaceAccessTarget } from "./workspace-access-target.js";
import { WorkspaceAuthorizationService } from "./workspace-authorization.js";
import { WorkspaceExecutionStateError } from "./workspace-execution-manager.js";
import { WorkspaceGateway } from "./workspace-gateway.js";
import { resolveWorkspaceHealthPath, workspaceHealthUrl } from "./workspace-health.js";

export interface PortalApplication {
  server: http.Server;
  start(): Promise<http.Server>;
  stopMaintenance(): Promise<void>;
}

export function createPortalApp(context: PortalContext): PortalApplication {
  let stopping = false;
  const ready = createReadinessProbe(async () => {
    if (context.stores.checkReady) await context.stores.checkReady();
    else await context.stores.catalog.listApps();
  });
  const {
    config,
    compatibilityMode,
    portalCompatibilityBoundary,
    runtimeProfile,
    providerId,
    artifacts,
    providerHealth,
    accessTargetResolver,
    stores,
    auth,
    authProviders,
    portalAuth,
    appAuthHandoff,
    catalog,
    lifecycle,
    forwarding,
    monitoring,
    operations,
    imageBuilds,
    imageBuildExecutor,
    buildPackageStorage,
    appImageUpdates,
    resourceCleanup,
    activityTracker,
    executionManager,
    upgradeRollouts,
    upgradeRolloutWorker,
    plugins,
    tenantMembership,
  } = context;

  async function resolveDefaultBuildStrategyId(appId?: string): Promise<string> {
    const selectedAppId =
      appId?.trim().toLowerCase() || (await stores.admin.getProvisioningPolicy()).defaultAppId;
    const strategyId = plugins.defaultBuildStrategyId(selectedAppId);
    if (!strategyId) {
      throw new ImageBuildError("build_strategy_not_found", 404);
    }
    return strategyId;
  }
  function assertAppBuildStrategy(appId: string, strategyId: string): void {
    if (!plugins.supportsBuildStrategy(appId, strategyId)) {
      throw new ImageBuildError("build_strategy_app_mismatch", 409);
    }
  }
  const configRevisions = new ConfigRevisionService({
    admin: stores.admin,
    forwarding,
    supportsApp: (appId) => appAuthHandoff.supportsAppAsync(appId),
    validateInstancePolicy: async (policy) => {
      await catalog.launchTarget(policy.defaultAppId);
    },
  });
  const MAX_POLICY_BODY_BYTES = 384 * 1024;
  const ACTIVITY_TOUCH_INTERVAL_MS = 15_000;
  const activityTouchAt = new Map<string, number>();
  const workspaceHealthPath = resolveWorkspaceHealthPath(runtimeProfile);
  const instanceAccess = new WorkspaceAccessCoordinator({
    lifecycle,
    getPolicy: () => stores.admin.getProvisioningPolicy(),
    touch: touchContainerActivity,
    probe: async (endpoint, signal) => {
      const health = await fetch(workspaceHealthUrl(endpoint, workspaceHealthPath), { signal });
      return health.ok;
    },
    probeCurrent: async (container, signal) => {
      const target = await resolveWorkspaceAccessTarget(accessTargetResolver, {
        workspaceId: container.id,
        expectedOwnerId: container.userId,
        logicalService: "workspace_ui",
        signal,
      });
      assertAccessTargetEnvironment(target, container.runtimeId);
      const healthUrl = workspaceHealthUrl(target.url, workspaceHealthPath);
      const headers = new Headers(target.headers);
      if (target.authority) headers.set("host", target.authority);
      const health = await fetch(healthUrl, { signal, headers });
      return health.ok;
    },
  });
  const workspaceAuthorization = new WorkspaceAuthorizationService(stores.instances, tenantMembership);
  const workspaceGateway = new WorkspaceGateway({
    forwarding,
    portalAuth,
    authorization: workspaceAuthorization,
    access: instanceAccess,
    reader: lifecycle,
    targets: accessTargetResolver,
    activity: activityTracker,
    appAuthHandoff,
    sandboxOrigin: config.mcpAppSandboxOrigin,
    secureCookies: config.secureCookies,
    preparePortalResponse: applyCors,
    mapUpgradeError(error) {
      const status = errorStatus(error);
      return {
        status,
        code:
          error instanceof InstanceAccessError
            ? error.code
            : error instanceof ProviderOperationError
              ? error.code
              : status >= 500
                ? "internal_error"
                : sanitizeOperationError(error),
      };
    },
    reportFailure(error, failure) {
      const diagnostic = sanitizeOperationError(error);
      const requestId = failure.requestId ?? failure.phase;
      const workspace = failure.instanceId ?? "unresolved";
      const context = createOperationContext({
        requestId,
        workspaceId: failure.instanceId,
        phase: failure.phase,
      });
      const log = `[OpenApp gateway ${requestId}] ${failure.method} ${failure.path} (${failure.kind}, ${workspace}) -> ${failure.status ?? 500}: ${diagnostic} context=${formatDiagnosticContext(context)}`;
      if ((failure.status ?? 500) >= 500) console.error(log);
      else console.warn(log);
    },
  });

  async function recordImageBuildCompletionAudit(
    actorUserId: string,
    buildId: string,
    metadata: unknown,
  ): Promise<void> {
    try {
      await stores.admin.recordAudit(actorUserId, "image.build.complete", "image-build", buildId, metadata);
    } catch (error) {
      console.error("image build completion audit failed", sanitizeOperationError(error));
    }
  }

  /**
   * 审计是旁路记录，不能阻塞批次创建或人工干预的业务响应。
   * 失败只写入已脱敏日志，后台 worker 仍会继续处理持久化的批次。
   */
  async function recordUpgradeAudit(
    actorUserId: string,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata?: unknown,
  ): Promise<void> {
    try {
      await stores.admin.recordAudit(actorUserId, action, resourceType, resourceId, metadata);
    } catch (error) {
      console.error("upgrade rollout audit failed", sanitizeOperationError(error));
    }
  }

  async function containerCatalogMetadata(container: Container): Promise<{
    appName: string;
    appVersionId: string | null;
    appVersion: string | null;
    appRevision: number | null;
  }> {
    const [app, version] = await Promise.all([
      catalog.getApp(container.appId),
      container.appVersionId ? catalog.getVersion(container.appVersionId) : Promise.resolve(null),
    ]);
    // A stale or corrupt version id must never make a version from another App
    // appear to belong to this instance. Keep the instance usable and omit only
    // the unverifiable snapshot metadata.
    const matchingVersion = version?.appId === container.appId ? version : null;
    return {
      appName: app?.name ?? container.appId,
      appVersionId: matchingVersion?.id ?? null,
      appVersion: matchingVersion?.version ?? null,
      appRevision: matchingVersion?.revision ?? null,
    };
  }

  function containerFields(container: Container, appVersionId: string | null) {
    return {
      id: container.id,
      ownerId: container.userId,
      appId: container.appId,
      appVersionId,
      status: container.status,
      stopReason: container.stopReason,
      createdAt: container.createdAt,
      updatedAt: container.updatedAt,
      lastActivityAt: container.lastActivityAt,
    };
  }

  async function userContainer(container: Container) {
    const metadata = await containerCatalogMetadata(container);
    return {
      ...containerFields(container, metadata.appVersionId),
      appName: metadata.appName,
      appVersion: metadata.appVersion,
      appRevision: metadata.appRevision,
    };
  }

  async function adminContainer(container: Container) {
    return {
      ...(await userContainer(container)),
      imageArtifactId: container.imageArtifactId ?? null,
      imageReference: container.imageReference ?? null,
    };
  }

  async function loginCookies(request: IncomingMessage, result: PortalLoginResult): Promise<string[]> {
    // 平台独立运行时本地身份不依赖用户历史应用的下游会话实现。
    if (config.controlPlaneOnly) {
      if (result.provider !== "local" || result.credentialGrant)
        throw new HttpError(409, "external_auth_unavailable");
      return [result.setCookie];
    }
    const instanceIds = await loginInstanceIds(request, result.user.id);
    try {
      const handoffCookies = await appAuthHandoff.onLoginForUser(result.user.id, {
        cookieHeader: request.headers.cookie,
        credentialGrant: result.credentialGrant,
        sessionId: randomUUID(),
        secureCookies: config.secureCookies,
        instanceIds,
        revokeCredentialGrant: async (grant, reason) => {
          try {
            await authProviders.revokeCredentialGrant(grant.provider, grant);
          } catch (error) {
            // 旧 Provider handoff 仍会通过 revokeRefreshSession 兜底；这里保留原始
            // Provider 错误，避免把通用回滚误报成成功。
            console.warn(`[OpenApp auth] credential grant revocation failed during ${reason}`);
            throw error;
          }
        },
        // 只有旧兼容入口才允许把 grant 投影为 refresh session；通用 App
        // 必须由 Provider 自己处理不透明 grant，避免 Core 绑定旧协议。
        ...(compatibilityMode ? { revokeRefreshSession: revokeExternalSession } : {}),
      });
      return [result.setCookie, ...handoffCookies];
    } catch (error) {
      try {
        await portalAuth.revokeIssuedSession(result.setCookie);
      } catch {
        console.warn("[OpenApp auth] Portal session rollback failed after App handoff error");
      }
      throw error;
    }
  }

  async function authorizeAppCreation(
    request: IncomingMessage,
    user: AuthenticatedUser,
    appId: string,
  ): Promise<void> {
    if (!(await appAuthHandoff.supportsAppAsync(appId))) throw new HttpError(409, "unsupported_app_auth");
    if (
      user.authMethod !== "local" &&
      user.authMethod !== "cli" &&
      appAuthHandoff.supportsCredentialedApp(appId) &&
      !appAuthHandoff.hasAppSession(appId, request.headers.cookie)
    ) {
      throw new HttpError(409, "app_auth_reauthentication_required");
    }
  }

  async function loginInstanceIds(request: IncomingMessage, userId: string): Promise<string[]> {
    let previousUser: AuthenticatedUser | null = null;
    try {
      previousUser = await portalAuth.session(request);
    } catch {
      console.warn("[OpenApp auth] previous session lookup failed during login cleanup");
    }
    const userIds = [...new Set([previousUser?.id, userId].filter((id): id is string => Boolean(id)))];
    return instanceIdsForUsers(userIds, "login");
  }

  async function instanceIdsForUsers(
    userIds: readonly string[],
    reason: "login" | "logout",
  ): Promise<string[]> {
    const records = await Promise.allSettled(userIds.map((id) => stores.instances.getContainerForUser(id)));
    if (records.some((record) => record.status === "rejected")) {
      console.warn(`[OpenApp auth] instance lookup failed during ${reason} cleanup`);
    }
    return records.flatMap((record) =>
      record.status === "fulfilled" && record.value ? [record.value.id] : [],
    );
  }

  async function revokeExternalSession(
    refreshToken: string,
    reason: "login_replaced" | "logout" | "materialize_failed",
  ): Promise<void> {
    if (!auth.revokeSession) return;
    try {
      await auth.revokeSession(refreshToken);
    } catch {
      console.warn(`[OpenApp auth] external session revocation failed during ${reason}`);
    }
  }

  function errorStatus(error: unknown): number {
    if (error instanceof HttpError) return error.status;
    if (error instanceof PortalAuthError) return error.status;
    if (error instanceof AppAuthHandoffError) {
      return new Set(["app_auth_handoff_not_registered", "app_auth_credential_app_mismatch"]).has(error.code)
        ? 409
        : 500;
    }
    if (error instanceof ProxyError) return error.status;
    if (error instanceof InstancePolicyError) return error.status;
    if (error instanceof ForwardingPolicyError) return error.status;
    if (error instanceof ConfigRevisionConflictError) return 409;
    if (error instanceof ConfigRevisionServiceError) return error.status;
    if (error instanceof AdminOperationConflictError) return 409;
    if (error instanceof UserRoleUpdateError) {
      return error.code === "super_admin_required" ||
        error.code === "target_role_not_manageable" ||
        error.code === "self_role_change_forbidden"
        ? 403
        : 409;
    }
    if (error instanceof ReleaseInspectionError) return error.status;
    if (error instanceof AppCatalogError) return error.status;
    if (error instanceof ImageBuildError) return error.status;
    if (error instanceof ImageBuildExecutionError) return 409;
    if (error instanceof BuildPackageUploadError) return error.status;
    if (error instanceof AppImageUpdateError) return error.status;
    if (error instanceof ResourceCleanupError) return error.status;
    if (error instanceof InstanceAccessError) return error.status;
    if (error instanceof ArtifactOperationError) return error.status;
    if (error instanceof WorkspaceExecutionStateError) {
      return error.code === "workspace_not_found" ? 404 : 409;
    }
    if (error instanceof ProviderOperationError) return 503;
    if (error instanceof QuotaAdmissionError) return error.status;
    if (error instanceof InstanceActivityAdmissionError) return error.status;
    if (error instanceof UpgradeRolloutConflictError) return error.status;
    if (error instanceof InstanceLifecycleError) {
      if (error.code === "container_not_found") return 404;
      if (error.code === "runtime_observation_unavailable") return 503;
      return 409;
    }
    return 500;
  }

  const server = http.createServer(async (request, response) => {
    const requestIdHeader = request.headers["x-request-id"];
    const requestedRequestId = (
      Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader
    )?.trim();
    const requestId =
      requestedRequestId && requestedRequestId.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(requestedRequestId)
        ? requestedRequestId
        : randomUUID();
    request.headers["x-request-id"] = requestId;
    response.setHeader("x-request-id", requestId);
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (!config.controlPlaneOnly && (await workspaceGateway.handleHttp(request, response, url))) return;
      applyCors(request, response);
      if (request.method === "OPTIONS") {
        response.writeHead(forwarding.isPortalOriginAllowed(request.headers.origin) ? 204 : 403);
        response.end();
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        assertWriteOrigin(request, (origin) => forwarding.isPortalOriginAllowed(origin));
        await handleApi(request, response, url);
        return;
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        (await servePortalStatic(config.staticDir, url.pathname, response, request.method === "HEAD"))
      ) {
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status = errorStatus(error);
      const diagnostic = sanitizeOperationError(error);
      const context = createOperationContext({ requestId, phase: "http" });
      const requestLog = `[OpenApp request ${requestId}] ${request.method} ${safeRequestPath(request.url)} -> ${status}: ${diagnostic} context=${formatDiagnosticContext(context)}`;
      if (status >= 500) console.error(requestLog);
      else if (status >= 400) console.warn(requestLog);
      const retryAfterMs =
        error instanceof ProviderOperationError
          ? error.retryAfterMs
          : error instanceof InstanceAccessError && error.status >= 500
            ? 1_000
            : undefined;
      if (retryAfterMs !== undefined)
        response.setHeader("retry-after", String(Math.ceil(retryAfterMs / 1_000)));
      sendJson(response, status, {
        error:
          error instanceof InstanceAccessError
            ? error.code
            : error instanceof ArtifactOperationError
              ? error.code
              : error instanceof ProviderOperationError
                ? error.code
                : error instanceof QuotaAdmissionError
                  ? error.code
                  : error instanceof AppCatalogError && error.code === "runtime_image_contract_unsupported"
                    ? error.code
                    : status >= 500
                      ? "internal_error"
                      : diagnostic,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(error instanceof ResourceCleanupError && error.blockers.length > 0
          ? { blockers: error.blockers }
          : {}),
      });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    if (config.controlPlaneOnly) {
      socket.destroy();
      return;
    }
    void workspaceGateway.handleUpgrade(request, socket, head);
  });

  let startPromise: Promise<http.Server> | undefined;
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let lastOperationRecoveryAt = 0;
  const maintenance = new PortalMaintenanceCoordinator({
    async runUpgradeRolloutWorker() {
      await upgradeRolloutWorker.runOnce();
    },
    async sweepIdleContainers() {
      const result = await stores.admin.withMaintenanceLease("idle-sweep", () =>
        lifecycle.sweepIdleContainers(),
      );
      if (result && result.errors > 0) console.error(`idle sweep completed with ${result.errors} error(s)`);
    },
    onError(task, error) {
      if (task === "upgrade-rollout-worker") {
        console.error("upgrade rollout worker failed", sanitizeOperationError(error));
        return;
      }
      console.error("idle sweep failed", error);
    },
  });

  function start(): Promise<http.Server> {
    if (!startPromise) {
      startPromise = startPortalOnce().catch((error: unknown) => {
        startPromise = undefined;
        throw error;
      });
    }
    return startPromise;
  }

  async function startPortalOnce(): Promise<http.Server> {
    await stores.initialize({
      legacyPackageColumns: plugins.legacyPackageColumns(),
      strategyDefinitions: plugins.buildStrategyDefinitions(),
      provisioningPolicyDefaults: plugins.provisioningPolicyDefaults(),
      defaultAuthProvider: auth.provider,
      // 由组合根显式决定初始化模式；不能因为传入插件定义就误把旧数据库
      // 当成全新通用库，也不能让通用部署重新启用产品默认值。
      legacyCompatibility: context.compatibilityMode,
    });
    if (!config.controlPlaneOnly) {
      await startWorkloadMaintenance();
    }
    await forwarding.get();
    return listenPortal();
  }

  /** 只有装配工作负载能力后才恢复任务、清理制品并启动维护周期。 */
  async function startWorkloadMaintenance(): Promise<void> {
    await catalog.initialize();
    await imageBuilds.initialize();
    await recoverInterruptedWork();
    try {
      const cleanup = await stores.admin.withMaintenanceLease("upload-artifact-cleanup", async () =>
        cleanupStaleUploadArtifacts({
          releaseRoot: config.releaseDir,
          buildPackages: await buildPackageStorage.list(),
          cleanupProfile: portalCompatibilityBoundary.uploadArtifactCleanup,
        }),
      );
      if (cleanup && cleanup.errors > 0)
        console.error(`upload artifact cleanup completed with ${cleanup.errors} error(s)`);
    } catch (error) {
      console.error("upload artifact cleanup failed", sanitizeOperationError(error));
    }
    maintenanceTimer = setInterval(() => {
      if (Date.now() - lastOperationRecoveryAt >= 60_000) {
        lastOperationRecoveryAt = Date.now();
        recoverInterruptedWork().catch((error: unknown) =>
          console.error("operation recovery failed", sanitizeOperationError(error)),
        );
      }
      void maintenance.requestMaintenanceCycle();
    }, 30_000);
    maintenanceTimer.unref();
  }

  async function listenPortal(): Promise<http.Server> {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          console.log(`OpenApp Portal listening on http://${config.host}:${config.port}`);
          resolve();
        });
      });
    } catch (error) {
      if (maintenanceTimer) {
        clearInterval(maintenanceTimer);
        maintenanceTimer = undefined;
      }
      throw error;
    }
    if (!config.controlPlaneOnly) {
      monitoring.start();
      kickUpgradeRolloutWorker();
    }
    return server;
  }

  function kickUpgradeRolloutWorker(): void {
    void maintenance.requestUpgradeRun();
  }

  async function recoverInterruptedWork(): Promise<void> {
    await operations.recoverInterrupted();
    await imageBuilds.recoverInterrupted();
  }

  async function sendExternalEmailCodeResponse(
    request: IncomingMessage,
    response: ServerResponse,
    providerId: string,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const result = await portalAuth.sendExternalEmailCode(providerId, body.email);
    const legacyFields = portalCompatibilityBoundary.projectEmailCodeResponse?.(providerId, result);
    // 通用结果优先，兼容投影只能补字段，不能覆盖已校验结果或成功标记。
    sendJson(response, 200, { ...legacyFields, ...result, ok: true });
  }

  async function resolveEntryAppId(request: IncomingMessage): Promise<string> {
    const session = await portalAuth.session(request);
    return session
      ? await appAuthHandoff.resolveAppIdForUser(session.id)
      : (await stores.admin.getProvisioningPolicy()).defaultAppId;
  }

  async function assertEntryAuthProvider(request: IncomingMessage, providerId: string): Promise<string> {
    const normalizedProviderId = providerId.trim().toLowerCase();
    if (!normalizedProviderId || !authProviders.has(normalizedProviderId)) {
      throw new HttpError(404, "auth_provider_not_found");
    }
    const appId = await resolveEntryAppId(request);
    const allowed = plugins
      .authProviderIdsForApp(appId)
      .some((candidate) => candidate.trim().toLowerCase() === normalizedProviderId);
    // Provider 注册表是平台级能力池，manifest 才是当前 App 的授权边界。
    // 不泄露“已注册但未授权”的 Provider，统一返回 404，避免跨 App 探测。
    if (!allowed) throw new HttpError(404, "auth_provider_not_found");
    return normalizedProviderId;
  }

  server.on("close", () => {
    monitoring.stop();
    if (maintenanceTimer) {
      clearInterval(maintenanceTimer);
      maintenanceTimer = undefined;
    }
  });

  async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method === "GET" && url.pathname === "/api/ready") {
      const ok = !stopping && (await ready());
      sendJson(response, ok ? 200 : 503, { ok, status: ok ? "ready" : "unavailable" });
      return;
    }
    // 未加载应用时不推进旧应用任务或接受新的工作负载变更，保留原库业务记录。
    if (
      config.controlPlaneOnly &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "") &&
      !url.pathname.startsWith("/api/auth/") &&
      !url.pathname.startsWith("/api/admin/users")
    ) {
      throw new HttpError(409, "control_plane_only_operation_unavailable");
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, service: "openapp-portal", authMode: config.authMode });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/email-codes") {
      await assertEntryAuthProvider(request, config.authProvider);
      await sendExternalEmailCodeResponse(request, response, config.authProvider);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const providerId = await assertEntryAuthProvider(request, config.authProvider);
      const result = await portalAuth.loginExternal(providerId, await readJsonBody(request));
      response.setHeader("set-cookie", await loginCookies(request, result));
      sendJson(response, 200, {
        user: result.user,
        isNewUser: result.isNewUser,
        provider: result.provider,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/methods") {
      const appProviderIds = config.controlPlaneOnly
        ? []
        : plugins.authProviderIdsForApp(await resolveEntryAppId(request));
      const external = authProviders
        .list(appProviderIds)
        .map((provider) => (compatibilityMode ? legacyAuthMethodDescription(provider) : provider));
      const configuredExternalProvider =
        config.authProvider !== "none" && external.some((provider) => provider.id === config.authProvider)
          ? config.authProvider
          : external[0]?.id;
      sendJson(response, 200, {
        local: { enabled: true, label: "OpenApp 账号" },
        external,
        ...(configuredExternalProvider ? { authProviderId: configuredExternalProvider } : {}),
        compatibilityMode,
        admin: { localOnly: false },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/local/register") {
      const result = await portalAuth.registerLocal(await readJsonBody(request), localAuthSource(request));
      response.setHeader("set-cookie", await loginCookies(request, result));
      sendJson(response, 201, { user: result.user, isNewUser: true, provider: result.provider });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/local/login") {
      const result = await portalAuth.loginLocal(await readJsonBody(request), localAuthSource(request));
      response.setHeader("set-cookie", await loginCookies(request, result));
      sendJson(response, 200, { user: result.user, isNewUser: false, provider: result.provider });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/local/admin-login") {
      const result = await portalAuth.loginLocalAdmin(await readJsonBody(request), localAuthSource(request));
      response.setHeader("set-cookie", await loginCookies(request, result));
      sendJson(response, 200, { user: result.user, isNewUser: false, provider: result.provider });
      return;
    }
    const compatibilityAuthRoute = portalCompatibilityBoundary.resolveAuthRoute(url.pathname);
    if (request.method === "POST" && compatibilityAuthRoute) {
      const providerId = await assertEntryAuthProvider(request, compatibilityAuthRoute.providerId);
      if (compatibilityAuthRoute.operation === "email-code") {
        await sendExternalEmailCodeResponse(request, response, providerId);
        return;
      }
      const result = await portalAuth.loginExternal(providerId, await readJsonBody(request));
      response.setHeader("set-cookie", await loginCookies(request, result));
      sendJson(response, 200, { user: result.user, isNewUser: result.isNewUser, provider: result.provider });
      return;
    }
    if (request.method === "POST" && portalCompatibilityBoundary.isAuthNamespacePath?.(url.pathname)) {
      throw new HttpError(404, "not_found");
    }
    const externalEmailCodeRoute = url.pathname.match(/^\/api\/auth\/external\/([^/]+)\/email-codes$/u);
    if (request.method === "POST" && externalEmailCodeRoute) {
      const providerId = await assertEntryAuthProvider(
        request,
        decodeURIComponent(externalEmailCodeRoute[1]!),
      );
      await sendExternalEmailCodeResponse(request, response, providerId);
      return;
    }
    const externalLoginRoute = url.pathname.match(/^\/api\/auth\/external\/([^/]+)\/login$/u);
    if (request.method === "POST" && externalLoginRoute) {
      const providerId = await assertEntryAuthProvider(request, decodeURIComponent(externalLoginRoute[1]!));
      const result = await portalAuth.loginExternal(providerId, await readJsonBody(request));
      response.setHeader("set-cookie", await loginCookies(request, result));
      sendJson(response, 200, { user: result.user, isNewUser: result.isNewUser, provider: result.provider });
      return;
    }
    if (
      request.method === "GET" &&
      (url.pathname === "/api/auth/session" || url.pathname === "/api/auth/me" || url.pathname === "/api/me")
    ) {
      const user = await portalAuth.session(request);
      if (!user) {
        sendJson(response, 200, { authenticated: false, status: "unauthenticated" });
        return;
      }
      sendJson(response, 200, { authenticated: true, status: "authenticated", user });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      let user: AuthenticatedUser | null = null;
      try {
        user = await portalAuth.session(request);
      } catch {
        console.warn("[OpenApp auth] Portal session lookup failed during logout");
      }
      let portalCookie: string;
      try {
        portalCookie = await portalAuth.logout(request);
      } catch {
        console.warn("[OpenApp auth] Portal session revocation failed during logout");
        portalCookie = portalAuth.clearSessionCookie();
      }
      const instanceIds = await instanceIdsForUsers(user ? [user.id] : [], "logout");
      const handoffCookies = await appAuthHandoff.onLogoutAll({
        cookieHeader: request.headers.cookie,
        secureCookies: config.secureCookies,
        instanceIds,
        revokeCredentialGrant: async (grant, reason) => {
          try {
            await authProviders.revokeCredentialGrant(grant.provider, grant);
          } catch (error) {
            console.warn(`[OpenApp auth] credential grant revocation failed during ${reason}`);
            throw error;
          }
        },
        // 登出也遵循同一边界，旧 refresh session 只在显式兼容模式启用。
        ...(compatibilityMode ? { revokeRefreshSession: revokeExternalSession } : {}),
      });
      response.setHeader("set-cookie", [portalCookie, ...handoffCookies]);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/password/setup") {
      const user = await portalAuth.requireAuthenticated(request);
      const result = await portalAuth.setupPassword(
        user,
        await readJsonBody(request),
        localAuthSource(request),
      );
      response.setHeader("set-cookie", result.setCookie);
      sendJson(response, 200, { user: result.user });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/password/change") {
      const user = await portalAuth.requireAuthenticated(request);
      const result = await portalAuth.changePassword(
        user,
        await readJsonBody(request),
        localAuthSource(request),
      );
      response.setHeader("set-cookie", result.setCookie);
      sendJson(response, 200, { user: result.user });
      return;
    }
    const externalPasswordCodeRoute = url.pathname.match(
      /^\/api\/auth\/password\/external\/([^/]+)\/email-codes$/u,
    );
    if (request.method === "POST" && externalPasswordCodeRoute) {
      const user = await portalAuth.requireAuthenticated(request);
      const providerId = await assertEntryAuthProvider(
        request,
        decodeURIComponent(externalPasswordCodeRoute[1]!),
      );
      await portalAuth.sendExternalPasswordCode(user, providerId, localAuthSource(request));
      sendJson(response, 200, { ok: true });
      return;
    }
    const externalPasswordChangeRoute = url.pathname.match(
      /^\/api\/auth\/password\/external\/([^/]+)\/change$/u,
    );
    if (request.method === "POST" && externalPasswordChangeRoute) {
      const user = await portalAuth.requireAuthenticated(request);
      const providerId = await assertEntryAuthProvider(
        request,
        decodeURIComponent(externalPasswordChangeRoute[1]!),
      );
      const result = await portalAuth.changePasswordWithExternal(
        user,
        providerId,
        await readJsonBody(request),
        localAuthSource(request),
      );
      response.setHeader("set-cookie", result.setCookie);
      sendJson(response, 200, { user: result.user });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/entry/manifest") {
      if (plugins.list().length === 0) throw new HttpError(409, "adapter_not_configured");
      const appId = await resolveEntryAppId(request);
      const app = await catalog.getApp(appId);
      const manifest = plugins.workspaceEntryManifest(appId, app?.name);
      if (!manifest) throw new HttpError(409, "app_not_available");
      sendJson(response, 200, {
        ...manifest,
        compatibilityMode,
        // 目录名称是管理员可见的权威值，其他入口元数据仍由插件声明。
        appName: app?.name ?? manifest.appName,
      });
      return;
    }

    const user = url.pathname.startsWith("/api/admin/")
      ? await portalAuth.requireAdmin(request)
      : await portalAuth.requireUser(request);
    if (request.method === "GET" && url.pathname === "/api/apps") {
      const items = (await catalog.listLaunchableApps()).map((item) => {
        const versions = item.versions.map(publicAppVersion);
        return { app: publicApp(item.app), versions, activeVersion: publicAppVersion(item.activeVersion) };
      });
      sendJson(response, 200, { apps: items });
      return;
    }
    const configRevisionRoute = url.pathname.match(
      /^\/api\/admin\/config-revisions\/(instance-policy|forwarding)(?:\/(\d+)\/rollback)?$/u,
    );
    if (isManagementRole(user.role) && configRevisionRoute) {
      const kind = configRevisionRoute[1] as ConfigRevisionKind;
      const targetRevision = configRevisionRoute[2];
      if (request.method === "GET" && !targetRevision) {
        const history = await configRevisions.history(kind, configRevisionLimit(url));
        const search = url.searchParams.get("search");
        const revisions = history.revisions.filter((revision) =>
          matchesSearch(
            search,
            String(revision.revision),
            revision.updatedBy,
            revision.effect,
            JSON.stringify(revision.payload),
          ),
        );
        const page = paginateAdminList(revisions, url);
        sendJson(response, 200, { ...history, revisions: page.items, pagination: page.pagination });
        return;
      }
      if (request.method === "POST" && targetRevision) {
        const current = await stores.admin.getConfigRevision(
          kind === "forwarding" ? "forwarding:default" : "instance-policy",
        );
        const expected = expectedRevision(request, current?.revision ?? 0);
        const result = await configRevisions.rollback(kind, Number(targetRevision), user.id, expected);
        if (result.kind === "instance-policy") {
          sendJson(response, 200, {
            policy: result.policy,
            revision: result.revision,
            effect: result.effect,
            rolledBackFrom: result.rolledBackFrom,
          });
        } else {
          sendJson(response, 200, {
            forwarding: result.forwarding,
            revision: result.revision,
            effect: result.effect,
            rolledBackFrom: result.rolledBackFrom,
          });
        }
        return;
      }
    }
    if (
      isManagementRole(user.role) &&
      (await handleAdminMonitoringRoute(request, response, url, monitoring, operations, async () => {
        try {
          await portalAuth.requireAdmin(request);
          return true;
        } catch {
          return false;
        }
      }))
    ) {
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/containers") {
      const records = await stores.admin.listContainers(user.id);
      sendJson(response, 200, { containers: await Promise.all(records.map(userContainer)) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/containers") {
      const body = await readJsonBody(request);
      const requestedAppId = typeof body.appId === "string" ? body.appId.trim().toLowerCase() : "";
      const existing = await stores.instances.getContainerForUser(user.id);
      if (existing) {
        if (requestedAppId && existing.appId !== requestedAppId)
          throw new HttpError(409, "one_app_instance_limit");
        const provisioned = await lifecycle.provisionForUser(user, existing.appId, { startExisting: false });
        await tenantMembership.ensureWorkspaceBinding(provisioned.container.id, user.id);
        sendJson(response, 200, {
          container: await userContainer(provisioned.container),
          created: false,
        });
        return;
      }
      // An explicit catalog selection must not depend on resolving the default
      // App (which may be archived or temporarily unavailable). Resolve the
      // user's/default App only when the request leaves the choice unspecified.
      const appId = requestedAppId || (await appAuthHandoff.resolveAppIdForUser(user.id));
      const app = await catalog.getApp(appId);
      if (!app || app.status !== "active") throw new HttpError(409, "app_not_available");
      await catalog.launchTarget(appId);
      const provisioned = await lifecycle.provisionForUser(user, appId, {
        startExisting: false,
        authorizeApp: (targetAppId) => authorizeAppCreation(request, user, targetAppId),
      });
      await tenantMembership.ensureWorkspaceBinding(provisioned.container.id, user.id);
      sendJson(response, provisioned.created ? 201 : 200, {
        container: await userContainer(provisioned.container),
        created: provisioned.created,
      });
      return;
    }
    if (isManagementRole(user.role) && request.method === "GET" && url.pathname === "/api/admin/users") {
      const all = await stores.admin.listUsers();
      const search = url.searchParams.get("search")?.trim().toLowerCase();
      const role = url.searchParams.get("role");
      const filtered = all.filter(
        (item) =>
          (!search || [item.id, item.email].some((value) => value.toLowerCase().includes(search))) &&
          (!role || item.role === role),
      );
      const page = paginateAdminList(filtered, url);
      sendJson(response, 200, { users: page.items, pagination: page.pagination });
      return;
    }
    if (isManagementRole(user.role) && request.method === "POST" && url.pathname === "/api/admin/users") {
      portalAuth.requireInteractiveAdmin(user);
      const body = await readJsonBody(request);
      const email = normalizeEmail(body.email);
      if (!email) throw new HttpError(400, "valid_email_required");
      const role =
        body.role === "super_admin" || body.role === "admin" || body.role === "user" ? body.role : "";
      if (!role) throw new HttpError(400, "invalid_role");
      if (role !== "user") portalAuth.requireSuperAdmin(user);
      const prepared = await portalAuth.prepareLocalCredential(email, body.password);
      const created = await stores.admin.createManagedLocalUser({
        actorUserId: user.id,
        email: prepared.email,
        passwordHash: prepared.passwordHash,
        role,
      });
      if (!created) throw new HttpError(409, "account_exists");
      sendJson(response, 201, { user: created });
      return;
    }
    const roleRoute = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/role$/u);
    if (isManagementRole(user.role) && request.method === "PATCH" && roleRoute) {
      portalAuth.requireSuperAdmin(user);
      const body = await readJsonBody(request);
      const role =
        body.role === "super_admin" || body.role === "admin" || body.role === "user" ? body.role : "";
      if (!role) throw new HttpError(400, "invalid_role");
      const expectedRole =
        body.expectedRole === "super_admin" || body.expectedRole === "admin" || body.expectedRole === "user"
          ? body.expectedRole
          : "";
      if (!expectedRole) throw new HttpError(400, "expected_role_required");
      const targetKey = decodeURIComponent(roleRoute[1]!);
      const currentUsers = await stores.admin.listUsers();
      const target = currentUsers.find(
        (item) => item.id === targetKey || item.email === targetKey.toLowerCase(),
      );
      if (!target) throw new HttpError(404, "user_not_found");
      const prepared =
        body.password === undefined
          ? undefined
          : await portalAuth.prepareLocalCredential(target.email, body.password);
      const updated = await stores.admin.changeUserRole({
        actorUserId: user.id,
        targetUserId: target.id,
        expectedRole,
        role,
        ...(prepared ? { passwordHash: prepared.passwordHash } : {}),
      });
      if (!updated) throw new HttpError(404, "user_not_found");
      sendJson(response, 200, { user: updated });
      return;
    }
    if (isManagementRole(user.role) && request.method === "GET" && url.pathname === "/api/admin/containers") {
      const search = url.searchParams.get("search");
      const all = (await Promise.all((await stores.admin.listContainers()).map(adminContainer))).filter(
        (item) =>
          matchesSearch(search, item.id, item.ownerId, item.appId, item.appVersionId, item.imageReference),
      );
      const page = paginateAdminList(all, url);
      sendJson(response, 200, { containers: page.items, pagination: page.pagination });
      return;
    }
    if (isManagementRole(user.role) && url.pathname === "/api/admin/overview" && request.method === "GET") {
      sendJson(response, 200, {
        users: (await stores.admin.listUsers()).length,
        containers: (await stores.admin.listContainers()).length,
        authProvider: `local + ${config.authProvider}`,
      });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/build-strategies" &&
      request.method === "GET"
    ) {
      const strategies = (await imageBuilds.listStrategies()).map((strategy) => {
        const reason = config.controlPlaneOnly
          ? "control_plane_only"
          : strategy.status !== "active"
            ? "strategy_archived"
            : imageBuilds.strategyRegistry.supports(strategy.id, strategy.revision)
              ? null
              : imageBuilds.strategyRegistry.has(strategy.id)
                ? "adapter_version_mismatch"
                : "adapter_not_loaded";
        return {
          ...strategy,
          appIds: plugins.appIdsForBuildStrategy(strategy.id),
          executable: reason === null,
          unavailableReason: reason,
        };
      });
      sendJson(response, 200, { strategies });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/build-packages" &&
      request.method === "GET"
    ) {
      const strategyId = url.searchParams.get("strategyId")?.trim().toLowerCase() || undefined;
      const key = url.searchParams.get("key")?.trim().toLowerCase() || undefined;
      const packages = await buildPackageStorage.list(strategyId, key, 10_000);
      const search = url.searchParams.get("search");
      const page = paginateAdminList(
        packages
          .map(publicBuildPackage)
          .filter((item) =>
            matchesSearch(
              search,
              item.id,
              item.key,
              item.originalName,
              item.uploadedBy,
              item.sourceVersion,
              item.sourceBuildId,
            ),
          ),
        url,
      );
      sendJson(response, 200, { packages: page.items, pagination: page.pagination });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/build-packages" &&
      request.method === "POST"
    ) {
      const strategyId =
        url.searchParams.get("strategyId")?.trim().toLowerCase() || (await resolveDefaultBuildStrategyId());
      const key = url.searchParams.get("key")?.trim().toLowerCase() || "";
      if (!key) throw new BuildPackageUploadError("build_package_key_required");
      const strategy = await imageBuilds.requireExecutableStrategy(strategyId);
      const upload = await receiveBuildPackageSlotUpload(request, config.releaseDir, strategy, key);
      try {
        const uploaded = upload.packages[0];
        if (!uploaded) throw new BuildPackageUploadError("build_package_upload_failed", 500);
        const inspected = await imageBuilds.strategyRegistry.inspectPackage(
          strategy.id,
          strategy.revision,
          uploaded.key,
          uploaded.path,
        );
        const [pkg] = await buildPackageStorage.persist(strategy, user.id, {
          cleanup: upload.cleanup,
          packages: [
            {
              ...uploaded,
              sourceVersion: inspected.sourceVersion ?? null,
              sourceBuildId: inspected.sourceBuildId ?? null,
              inspectedAt: new Date().toISOString(),
            },
          ],
        });
        if (!pkg) throw new BuildPackageUploadError("build_package_upload_failed", 500);
        await stores.admin.recordAudit(user.id, "build.package.upload", "build-package", pkg.id, {
          strategyId: pkg.strategyId,
          key: pkg.key,
          sha256: pkg.artifact.sha256,
          size: pkg.artifact.size,
        });
        sendJson(response, 201, { package: publicBuildPackage(pkg) });
        return;
      } finally {
        await upload.cleanup();
      }
    }
    const buildPackageDeleteRoute = url.pathname.match(/^\/api\/admin\/build-packages\/([^/]+)$/u);
    if (isManagementRole(user.role) && buildPackageDeleteRoute && request.method === "DELETE") {
      const id = decodeURIComponent(buildPackageDeleteRoute[1]!);
      const deleted = await resourceCleanup.deleteBuildPackage(id);
      await stores.admin.recordAudit(user.id, "build.package.delete", "build-package", deleted.id, {
        storageRemoved: deleted.storageRemoved,
      });
      sendJson(response, 200, { deleted });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/image-builds" &&
      request.method === "GET"
    ) {
      const strategyId = url.searchParams.get("strategyId")?.trim() || undefined;
      const status = url.searchParams.get("status");
      const search = url.searchParams.get("search");
      const builds = (await imageBuilds.listBuilds(strategyId, 10_000)).filter(
        (build) =>
          (!status || build.status === status) &&
          matchesSearch(
            search,
            build.id,
            build.strategyId,
            build.sourceAppVersionId,
            build.requestedBy,
            build.operationId,
          ),
      );
      const page = paginateAdminList(builds, url);
      sendJson(response, 200, { builds: page.items, pagination: page.pagination });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/image-builds" &&
      request.method === "POST"
    ) {
      if (isJsonRequest(request)) {
        const body = await readJsonBody(request);
        const strategyId =
          typeof body.strategyId === "string" && body.strategyId.trim()
            ? body.strategyId.trim().toLowerCase()
            : await resolveDefaultBuildStrategyId();
        const strategy = await imageBuilds.requireExecutableStrategy(strategyId);
        const packageIds = Array.isArray(body.packageIds) ? body.packageIds : [];
        const selected = await buildPackageStorage.resolveSelection(strategy, packageIds);
        const operation = await operations.start(
          {
            type: "image.build",
            actorUserId: user.id,
            resourceType: "image-build",
            resourceId: strategyId,
            requestId: request.headers["x-request-id"]?.toString(),
            idempotencyKey: requestIdempotencyKey(request),
            requestFingerprint: operationFingerprint([
              strategyId,
              String(strategy.revision),
              ...selected.packages.flatMap((pkg) => [pkg.id, pkg.artifact.sha256]),
            ]),
            cancellable: true,
          },
          async ({ operationId, report, signal, commitPoint }) => {
            await report(10, "validating_packages");
            const build = await imageBuilds.createBuild({
              strategyId,
              strategyRevision: strategy.revision,
              operationId,
              requestedBy: user.id,
              packages: selected.packages.map((pkg) => ({
                key: pkg.key,
                packageId: pkg.id,
                artifact: pkg.artifact,
              })),
            });
            const built = await imageBuildExecutor.execute(build.id, {
              signal,
              report,
              commitPoint,
              standaloneSource: { packagePaths: selected.packagePaths },
            });
            await recordImageBuildCompletionAudit(user.id, build.id, {
              strategyId,
              packageIds: selected.packages.map((pkg) => pkg.id),
              imageId: built.record.artifact?.imageId,
            });
            return { build: built.record.build, artifact: built.record.artifact };
          },
        );
        sendJson(response, 202, { operationId: operation.id, operation });
        return;
      }
      const strategyId =
        url.searchParams.get("strategyId")?.trim().toLowerCase() || (await resolveDefaultBuildStrategyId());
      const strategy = await imageBuilds.requireExecutableStrategy(strategyId);
      const upload = await receiveBuildPackageUpload(request, config.releaseDir, strategy);
      let handedOff = false;
      try {
        const packageHashes = await Promise.all(upload.packages.map((item) => sha256File(item.path)));
        const operation = await operations.start(
          {
            type: "image.build",
            actorUserId: user.id,
            resourceType: "image-build",
            resourceId: strategyId,
            requestId: request.headers["x-request-id"]?.toString(),
            idempotencyKey: requestIdempotencyKey(request),
            requestFingerprint: operationFingerprint([
              strategyId,
              String(strategy.revision),
              ...packageHashes,
            ]),
            cancellable: true,
          },
          async ({ operationId, report, signal, commitPoint }) => {
            try {
              await report(10, "validating_packages");
              const stored = await buildPackageStorage.persist(strategy, user.id, upload);
              const selected = await buildPackageStorage.resolveSelection(
                strategy,
                stored.map((pkg) => pkg.id),
              );
              const build = await imageBuilds.createBuild({
                strategyId,
                strategyRevision: strategy.revision,
                operationId,
                requestedBy: user.id,
                packages: selected.packages.map((pkg) => ({
                  key: pkg.key,
                  packageId: pkg.id,
                  artifact: pkg.artifact,
                })),
              });
              const built = await imageBuildExecutor.execute(build.id, {
                signal,
                report,
                commitPoint,
                standaloneSource: { packagePaths: selected.packagePaths },
              });
              await recordImageBuildCompletionAudit(user.id, build.id, {
                strategyId,
                packageIds: selected.packages.map((pkg) => pkg.id),
                imageId: built.record.artifact?.imageId,
              });
              return { build: built.record.build, artifact: built.record.artifact };
            } finally {
              await upload.cleanup();
            }
          },
          { onExisting: upload.cleanup },
        );
        handedOff = true;
        sendJson(response, 202, { operationId: operation.id, operation });
        return;
      } finally {
        if (!handedOff) await upload.cleanup();
      }
    }
    const imageBuildRoute = url.pathname.match(/^\/api\/admin\/image-builds\/([^/]+)$/u);
    if (isManagementRole(user.role) && imageBuildRoute && request.method === "GET") {
      sendJson(response, 200, await imageBuilds.getBuild(decodeURIComponent(imageBuildRoute[1]!)));
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/image-artifacts" &&
      request.method === "GET"
    ) {
      const search = url.searchParams.get("search");
      const artifacts = (await imageBuilds.listArtifacts(10_000)).filter((artifact) =>
        matchesSearch(search, artifact.id, artifact.buildId, artifact.imageReference, artifact.imageId),
      );
      const page = paginateAdminList(artifacts, url);
      sendJson(response, 200, { artifacts: page.items, pagination: page.pagination });
      return;
    }
    const imageArtifactDeleteRoute = url.pathname.match(/^\/api\/admin\/image-artifacts\/([^/]+)$/u);
    if (isManagementRole(user.role) && imageArtifactDeleteRoute && request.method === "DELETE") {
      const id = decodeURIComponent(imageArtifactDeleteRoute[1]!);
      const deleted = await resourceCleanup.deleteImageArtifact(id);
      await stores.admin.recordAudit(user.id, "image.artifact.delete", "image-artifact", deleted.id, {
        runtimeImageRemoved: deleted.runtimeImageRemoved,
      });
      sendJson(response, 200, { deleted });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/resource-cleanup" &&
      request.method === "GET"
    ) {
      const keepPrevious = url.searchParams.get("keepPrevious");
      const preview = await resourceCleanup.preview(keepPrevious === null ? 1 : Number(keepPrevious));
      const search = url.searchParams.get("search");
      const filterItems = <T extends { id: string }>(items: T[]) =>
        items.filter((item) => matchesSearch(search, item.id));
      const buildPackages = filterItems(preview.buildPackages);
      const imageArtifacts = filterItems(preview.imageArtifacts);
      sendJson(response, 200, {
        preview: {
          ...preview,
          buildPackages,
          imageArtifacts,
          candidates: [...buildPackages, ...imageArtifacts]
            .filter((item) => item.blockers.length === 0)
            .map((item) => ({ kind: item.kind, id: item.id })),
        },
        pagination: {
          buildPackages: paginateAdminList(buildPackages, url).pagination,
          imageArtifacts: paginateAdminList(imageArtifacts, url).pagination,
        },
      });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/resource-cleanup" &&
      request.method === "POST"
    ) {
      const body = await readJsonBody(request);
      const keepPrevious = body.keepPrevious === undefined ? 1 : Number(body.keepPrevious);
      const result = await stores.admin.withReleaseActivationLock(() => resourceCleanup.prune(keepPrevious));
      await stores.admin.recordAudit(user.id, "resource.cleanup.run", "resource-cleanup", null, result);
      sendJson(response, 200, { result, preview: await resourceCleanup.preview(keepPrevious) });
      return;
    }
    if (isManagementRole(user.role) && url.pathname === "/api/admin/apps" && request.method === "GET") {
      const search = url.searchParams.get("search");
      const status = url.searchParams.get("status");
      const items = (await catalog.listApps()).filter(
        (app) =>
          (!status || app.status === status) && matchesSearch(search, app.id, app.name, app.description),
      );
      const page = paginateAdminList(items, url);
      sendJson(response, 200, {
        apps: page.items.map((app) => app.id),
        items: page.items.map((app) => ({
          ...app,
          canImportImage:
            !config.controlPlaneOnly &&
            app.status === "active" &&
            Boolean(
              plugins.get(app.id)?.manifest.executionContracts?.some((contract) => contract !== "none"),
            ),
        })),
        pagination: page.pagination,
      });
      return;
    }
    if (isManagementRole(user.role) && url.pathname === "/api/admin/apps" && request.method === "POST") {
      const body = await readJsonBody(request);
      const app = await catalog.createApp({ id: body.id, name: body.name, description: body.description });
      await stores.admin.recordAudit(user.id, "app.create", "app", app.id, {
        name: app.name,
        authAdapterId: app.authAdapterId,
      });
      sendJson(response, 201, { app });
      return;
    }
    const appRoute = url.pathname.match(/^\/api\/admin\/apps\/([^/]+)$/u);
    if (isManagementRole(user.role) && appRoute && request.method === "PATCH") {
      const appId = decodeURIComponent(appRoute[1]!);
      const body = await readJsonBody(request);
      const app = await stores.admin.withReleaseActivationLock(async () => {
        if (
          body.status === "archived" &&
          (await stores.admin.getProvisioningPolicy()).defaultAppId === appId.trim().toLowerCase()
        ) {
          throw new HttpError(409, "default_app_cannot_be_archived");
        }
        return catalog.updateApp(appId, body);
      });
      await stores.admin.recordAudit(user.id, "app.update", "app", app.id, { status: app.status });
      sendJson(response, 200, { app });
      return;
    }
    const appImageUpdateBindRoute = url.pathname.match(
      /^\/api\/admin\/apps\/([^/]+)\/image-updates\/([^/]+)\/bind$/u,
    );
    if (isManagementRole(user.role) && appImageUpdateBindRoute && request.method === "POST") {
      const appId = decodeURIComponent(appImageUpdateBindRoute[1]!);
      const revisionId = decodeURIComponent(appImageUpdateBindRoute[2]!);
      const body = await readJsonBody(request);
      const revision = await appImageUpdates.bindCandidate(appId, revisionId, Number(body.expectedRevision));
      await stores.admin.recordAudit(user.id, "app.image.bind", "app-revision", revision.id, {
        appId: revision.appId,
        revision: revision.revision,
        imageArtifactId: revision.imageArtifactId ?? null,
        imageReference: revision.imageReference,
      });
      sendJson(response, 200, { revision });
      return;
    }
    const uploadSchemaRoute = url.pathname.match(/^\/api\/admin\/apps\/([^/]+)\/upload-schema$/u);
    if (isManagementRole(user.role) && uploadSchemaRoute && request.method === "GET") {
      const inspector = plugins.releaseInspectorForApp(decodeURIComponent(uploadSchemaRoute[1]!));
      if (!inspector?.inspectUpload || !inspector.uploadRequirements)
        throw new ImageBuildError("adapter_release_inspector_missing", 409);
      sendJson(response, 200, { requirements: inspector.uploadRequirements });
      return;
    }
    const appImageImportRoute = url.pathname.match(/^\/api\/admin\/apps\/([^/]+)\/image-imports$/u);
    if (isManagementRole(user.role) && appImageImportRoute && request.method === "POST") {
      const appId = decodeURIComponent(appImageImportRoute[1]!);
      const body = await readJsonBody(request);
      if (!plugins.get(appId)?.manifest.executionContracts?.some((contract) => contract !== "none"))
        throw new HttpError(409, "runtime_image_contract_unsupported");
      const reference = typeof body.imageReference === "string" ? body.imageReference.trim() : "";
      if (!reference) throw new HttpError(400, "invalid_image_reference");
      const operation = await operations.start(
        {
          type: "app.image.import",
          actorUserId: user.id,
          resourceType: "app",
          resourceId: appId,
          requestId: request.headers["x-request-id"]?.toString(),
          idempotencyKey: requestIdempotencyKey(request),
          requestFingerprint: operationFingerprint([appId, reference]),
          cancellable: false,
        },
        async ({ report, commitPoint }) => {
          await report(10, "validating_image");
          const revision = await catalog.importImage(appId, reference, async () => {
            await report(90, "saving_candidate");
            await commitPoint();
          });
          await stores.admin.recordAudit(user.id, "app.image.import", "app-revision", revision.id, {
            appId,
            imageReference: revision.imageReference,
          });
          return { revision };
        },
      );
      sendJson(response, 202, { operationId: operation.id, operation });
      return;
    }
    const appImageUpdatesRoute = url.pathname.match(/^\/api\/admin\/apps\/([^/]+)\/image-updates$/u);
    if (isManagementRole(user.role) && appImageUpdatesRoute && request.method === "POST") {
      const appId = decodeURIComponent(appImageUpdatesRoute[1]!);
      const body = await readJsonBody(request);
      const strategyId =
        typeof body.strategyId === "string" && body.strategyId.trim()
          ? body.strategyId.trim().toLowerCase()
          : await resolveDefaultBuildStrategyId(appId);
      const expectedAppRevision = Number(body.expectedRevision);
      assertAppBuildStrategy(appId, strategyId);
      await imageBuilds.requireExecutableStrategy(strategyId);
      const replacementFingerprint = stableStringRecord(body.replacementPackageIds);
      const operation = await operations.start(
        {
          type: "app.image.update",
          actorUserId: user.id,
          resourceType: "app",
          resourceId: appId,
          requestId: request.headers["x-request-id"]?.toString(),
          idempotencyKey: requestIdempotencyKey(request),
          requestFingerprint: operationFingerprint([
            appId,
            strategyId,
            String(expectedAppRevision),
            ...replacementFingerprint,
          ]),
          cancellable: true,
        },
        async ({ operationId, report, signal, commitPoint }) => {
          const candidate = await appImageUpdates.createCandidate({
            appId,
            strategyId,
            expectedRevision: expectedAppRevision,
            replacementPackageIds: body.replacementPackageIds,
            requestedBy: user.id,
            operationId,
            signal,
            report,
            commitPoint,
          });
          await recordImageBuildCompletionAudit(user.id, candidate.build.id, {
            appId: candidate.revision.appId,
            revisionId: candidate.revision.id,
            revision: candidate.revision.revision,
            strategyId,
            imageId: candidate.artifact.imageId,
            inheritedSlots: candidate.inheritedSlots,
            replacedSlots: candidate.replacedSlots,
            removedSlots: candidate.removedSlots,
          });
          return candidate;
        },
      );
      sendJson(response, 202, { operationId: operation.id, operation });
      return;
    }
    const appVersionsRoute = url.pathname.match(/^\/api\/admin\/apps\/([^/]+)\/versions$/u);
    if (isManagementRole(user.role) && appVersionsRoute && request.method === "GET") {
      const appId = decodeURIComponent(appVersionsRoute[1]!);
      const status = url.searchParams.get("status");
      const search = url.searchParams.get("search");
      const versions = (await catalog.listVersions(appId)).filter(
        (version) =>
          (!status || version.status === status) &&
          matchesSearch(search, version.id, version.version, version.buildId, version.imageReference),
      );
      const page = paginateAdminList(versions, url);
      sendJson(response, 200, { versions: page.items, pagination: page.pagination });
      return;
    }
    if (isManagementRole(user.role) && appVersionsRoute && request.method === "POST") {
      const appId = decodeURIComponent(appVersionsRoute[1]!);
      if (isJsonRequest(request)) {
        const body = await readJsonBody(request);
        const strategyId =
          typeof body.strategyId === "string" && body.strategyId.trim()
            ? body.strategyId.trim().toLowerCase()
            : await resolveDefaultBuildStrategyId(appId);
        assertAppBuildStrategy(appId, strategyId);
        const strategy = await imageBuilds.requireExecutableStrategy(strategyId);
        const packageIds = Array.isArray(body.packageIds) ? body.packageIds : [];
        const selected = await buildPackageStorage.resolveSelection(strategy, packageIds);
        const operation = await operations.start(
          {
            type: "app.version.upload",
            actorUserId: user.id,
            resourceType: "app-version",
            resourceId: appId,
            requestId: request.headers["x-request-id"]?.toString(),
            idempotencyKey: requestIdempotencyKey(request),
            requestFingerprint: operationFingerprint([
              appId,
              strategyId,
              String(strategy.revision),
              ...selected.packages.flatMap((pkg) => [pkg.id, pkg.artifact.sha256]),
            ]),
          },
          async ({ report }) => {
            await report(15, "validating");
            const inspected = await imageBuildExecutor.inspectPackages(strategy.id, strategy.revision, {
              packagePaths: selected.packagePaths,
            });
            const packageByKey = new Map(selected.packages.map((pkg) => [pkg.key, pkg]));
            if (
              inspected.packages.length !== selected.packages.length ||
              inspected.packages.some((pkg) => {
                const selectedPackage = packageByKey.get(pkg.key);
                return (
                  !selectedPackage ||
                  selectedPackage.artifact.sha256 !== pkg.artifact.sha256 ||
                  selectedPackage.artifact.size !== pkg.artifact.size
                );
              })
            ) {
              throw new ImageBuildExecutionError("build_strategy_package_inspection_mismatch");
            }
            const saved = await catalog.uploadInspectedVersion(appId, {
              ...inspected,
              packages: inspected.packages.map((pkg) => ({
                ...pkg,
                packageId: packageByKey.get(pkg.key)!.id,
              })),
            });
            await stores.admin.recordAudit(user.id, "app.version.upload", "app-version", saved.id, {
              appId: saved.appId,
              version: saved.version,
              buildId: saved.buildId,
              packageIds: selected.packages.map((pkg) => pkg.id),
            });
            return { version: saved };
          },
        );
        sendJson(response, 202, { operationId: operation.id, operation });
        return;
      }
      const inspector = plugins.releaseInspectorForApp(appId);
      if (!inspector?.uploadRequirements || !inspector.inspectUpload)
        throw new ImageBuildError("adapter_release_inspector_missing", 409);
      const upload = await receiveBuildPackageUpload(request, config.releaseDir, {
        id: appId,
        revision: 1,
        name: appId,
        description: "",
        runtimeContract: "none",
        packageRequirements: inspector.uploadRequirements.map((item) => ({
          ...item,
          acceptedExtensions: [...item.acceptedExtensions],
        })),
        status: "active",
        createdAt: "",
        updatedAt: "",
      });
      let handedOff = false;
      try {
        const operation = await operations.start(
          {
            type: "app.version.upload",
            actorUserId: user.id,
            resourceType: "app-version",
            resourceId: appId,
            requestId: request.headers["x-request-id"]?.toString(),
            idempotencyKey: requestIdempotencyKey(request),
            requestFingerprint: operationFingerprint([
              ...(await Promise.all(upload.packages.map((item) => sha256File(item.path)))),
            ]),
          },
          async ({ report }) => {
            try {
              await report(15, "validating");
              const inspected = await inspector.inspectUpload!(
                Object.fromEntries(upload.packages.map((item) => [item.key, item.path])),
                appId,
              );
              const version = await catalog.uploadInspectedVersion(appId, inspected);
              await stores.admin.recordAudit(user.id, "app.version.upload", "app-version", version.id, {
                appId: version.appId,
                version: version.version,
                buildId: version.buildId,
              });
              return { version };
            } finally {
              await upload.cleanup();
            }
          },
          { onExisting: upload.cleanup },
        );
        handedOff = true;
        sendJson(response, 202, { operationId: operation.id, operation });
        return;
      } finally {
        if (!handedOff) await upload.cleanup();
      }
    }
    const appVersionBuildRoute = url.pathname.match(
      /^\/api\/admin\/apps\/([^/]+)\/versions\/([^/]+)\/builds$/u,
    );
    if (isManagementRole(user.role) && appVersionBuildRoute && request.method === "POST") {
      const appId = decodeURIComponent(appVersionBuildRoute[1]!);
      const versionId = decodeURIComponent(appVersionBuildRoute[2]!);
      const body = await readJsonBody(request);
      const strategyId =
        typeof body.strategyId === "string" && body.strategyId.trim()
          ? body.strategyId.trim().toLowerCase()
          : await resolveDefaultBuildStrategyId(appId);
      assertAppBuildStrategy(appId, strategyId);
      const strategy = await imageBuilds.requireExecutableStrategy(strategyId);
      const operation = await operations.start(
        {
          type: "image.build",
          actorUserId: user.id,
          resourceType: "app-version",
          resourceId: versionId,
          requestId: request.headers["x-request-id"]?.toString(),
          idempotencyKey: requestIdempotencyKey(request),
          requestFingerprint: operationFingerprint([appId, versionId, strategyId, String(strategy.revision)]),
          cancellable: true,
        },
        async ({ operationId, report, signal, commitPoint }) => {
          const version = await catalog.getVersion(versionId);
          if (!version || version.appId !== appId.trim().toLowerCase()) {
            throw new ImageBuildError("app_version_not_found", 404);
          }
          await report(10, "creating_image_build");
          const build = await imageBuilds.createVersionBuild({
            strategyId,
            strategyRevision: strategy.revision,
            operationId,
            sourceAppVersionId: version.id,
            requestedBy: user.id,
          });
          const built = await imageBuildExecutor.execute(build.id, { signal, report, commitPoint });
          await recordImageBuildCompletionAudit(user.id, build.id, {
            appId: version.appId,
            versionId: version.id,
            strategyId,
            imageId: built.record.artifact?.imageId,
          });
          return { build: built.record.build, artifact: built.record.artifact };
        },
      );
      sendJson(response, 202, { operationId: operation.id, operation });
      return;
    }
    const appVersionArtifactRoute = url.pathname.match(
      /^\/api\/admin\/apps\/([^/]+)\/versions\/([^/]+)\/artifact$/u,
    );
    if (isManagementRole(user.role) && appVersionArtifactRoute && request.method === "POST") {
      const appId = decodeURIComponent(appVersionArtifactRoute[1]!);
      const versionId = decodeURIComponent(appVersionArtifactRoute[2]!);
      const body = await readJsonBody(request);
      const artifactId = typeof body.artifactId === "string" ? body.artifactId.trim() : "";
      if (!artifactId) throw new ImageBuildError("image_artifact_required");
      const artifact = await stores.builds.getArtifact(artifactId);
      const sourceBuild = artifact ? await stores.builds.getBuild(artifact.buildId) : null;
      if (!sourceBuild) throw new ImageBuildError("image_artifact_not_found", 404);
      assertAppBuildStrategy(appId, sourceBuild.strategyId);
      const version = await stores.admin.withReleaseActivationLock(() =>
        imageBuilds.bindRelease(appId, versionId, artifactId),
      );
      await stores.admin.recordAudit(user.id, "app.version.artifact.bind", "app-version", version.id, {
        appId,
        artifactId,
        imageReference: version.imageReference,
      });
      sendJson(response, 200, { version });
      return;
    }
    const appVersionImageRoute = url.pathname.match(
      /^\/api\/admin\/apps\/([^/]+)\/versions\/([^/]+)\/image$/u,
    );
    if (isManagementRole(user.role) && appVersionImageRoute && request.method === "POST") {
      const appId = decodeURIComponent(appVersionImageRoute[1]!);
      const versionId = decodeURIComponent(appVersionImageRoute[2]!);
      const body = await readJsonBody(request);
      const reference = typeof body.reference === "string" ? body.reference.trim() : "";
      const version = await catalog.attachImage(appId, versionId, reference);
      await stores.admin.recordAudit(user.id, "app.version.image.attach", "app-version", version.id, {
        appId,
        imageReference: version.imageReference,
        requestedReference: reference,
      });
      sendJson(response, 200, { version });
      return;
    }
    const appVersionActivateRoute = url.pathname.match(
      /^\/api\/admin\/apps\/([^/]+)\/versions\/([^/]+)\/activate$/u,
    );
    if (isManagementRole(user.role) && appVersionActivateRoute && request.method === "POST") {
      const appId = decodeURIComponent(appVersionActivateRoute[1]!);
      const versionId = decodeURIComponent(appVersionActivateRoute[2]!);
      const version = await catalog.activateVersion(appId, versionId);
      await stores.admin.recordAudit(user.id, "app.version.activate", "app-version", version.id, {
        appId,
        version: version.version,
        imageReference: version.imageReference,
      });
      sendJson(response, 200, { version });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/instance-policy" &&
      request.method === "GET"
    ) {
      const [policy, revision] = await Promise.all([
        stores.admin.getProvisioningPolicy(),
        stores.admin.getConfigRevision("instance-policy"),
      ]);
      sendJson(response, 200, { policy, revision });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/instance-policy" &&
      request.method === "PATCH"
    ) {
      const body = await readJsonBody(request, MAX_POLICY_BODY_BYTES);
      const result = await stores.admin.withReleaseActivationLock(async () => {
        const previous = await stores.admin.getProvisioningPolicy();
        const currentRevision = await stores.admin.getConfigRevision("instance-policy");
        const expected = expectedRevision(request, currentRevision?.revision ?? 0);
        const policy = updateProvisioningPolicy(previous, body, {
          additionalReservedEnvironment: runtimeProfile
            ? runtimeReservedEnvironmentNames(runtimeProfile)
            : undefined,
        });
        if (!(await appAuthHandoff.supportsAppAsync(policy.defaultAppId)))
          throw new InstancePolicyError("unsupported_default_app");
        await catalog.launchTarget(policy.defaultAppId);
        const effect = provisioningPolicyEffect(previous, policy);
        await stores.admin.saveProvisioningPolicy(policy, {
          updatedBy: user.id,
          effect,
          effectiveAt: effect === "immediate" ? new Date().toISOString() : null,
          expectedRevision: expected,
          payload: policy,
        });
        const revision = await stores.admin.getConfigRevision("instance-policy");
        return { policy, effect, revision };
      });
      const { policy, effect, revision } = result;
      await stores.admin.recordAudit(user.id, "instance-policy.update", "policy", "default", {
        autoCreateOnFirstVisit: policy.autoCreateOnFirstVisit,
        autoStartOnEnter: policy.autoStartOnEnter,
        autoWakeOnRequest: policy.autoWakeOnRequest,
        blockAutoWakeAfterManualStop: policy.blockAutoWakeAfterManualStop,
        defaultAppId: policy.defaultAppId,
        idleStopMinutes: policy.idleStopMinutes,
        detectNetworkActivity: policy.detectNetworkActivity,
        detectComputeActivity: policy.detectComputeActivity,
        maxTotalInstances: policy.maxTotalInstances,
        maxRunningInstances: policy.maxRunningInstances,
      });
      sendJson(response, 200, { policy, revision, effect });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/containers/ensure-default") {
      try {
        const result = await lifecycle.ensureDefault(user, (appId) =>
          authorizeAppCreation(request, user, appId),
        );
        if (result.container) await tenantMembership.ensureWorkspaceBinding(result.container.id, user.id);
        sendJson(response, result.created ? 201 : 200, {
          ...result,
          container: result.container ? await userContainer(result.container) : null,
        });
      } catch (error) {
        if (!isLifecycleCapacityError(error)) throw error;
        sendJson(response, 200, { container: null, created: false, reason: error.code });
      }
      return;
    }
    if (
      isManagementRole(user.role) &&
      request.method === "POST" &&
      url.pathname === "/api/admin/maintenance/sweep"
    ) {
      const operation = await operations.start(
        {
          type: "maintenance.sweep",
          actorUserId: user.id,
          resourceType: "maintenance",
          resourceId: "idle",
          requestId: request.headers["x-request-id"]?.toString(),
          idempotencyKey: requestIdempotencyKey(request),
          retryable: true,
        },
        async ({ report }) => {
          await report(10, "scanning");
          const result = await stores.admin.withMaintenanceLease("idle-sweep", () =>
            lifecycle.sweepIdleContainers(),
          );
          if (!result) throw new Error("maintenance_busy");
          await report(100, "completed");
          return result;
        },
      );
      sendJson(response, 202, { operationId: operation.id, operation });
      return;
    }
    if (isManagementRole(user.role) && url.pathname === "/api/admin/config" && request.method === "GET") {
      const [runtimeStatus, policyRevision, forwardingRevision] = await Promise.all([
        readProviderHealthStatus(providerHealth, providerId),
        stores.admin.getConfigRevision("instance-policy"),
        stores.admin.getConfigRevision("forwarding:default"),
      ]);
      const authProviderDescription = authProviders
        .list()
        .find((candidate) => candidate.id === config.authProvider);
      const authProviderConfigured = config.authProvider === "none" || authProviders.has(config.authProvider);
      sendJson(response, 200, {
        config: {
          authProvider: config.authProvider,
          authProviderLabel:
            config.authProvider === "none"
              ? "无外部 Provider"
              : (authProviderDescription?.label ?? config.authProvider),
          authProviderConfigured,
          databaseConfigured: Boolean(config.databaseUrl),
          // 旧控制台仍读取该字段；新控制台使用上面的通用状态。
          ...portalCompatibilityBoundary.projectAdminConfig({
            authProvider: config.authProvider,
            authProviderBaseUrl: config.authProviderBaseUrl,
            runtimeImageConfigured: portalCompatibilityBoundary.isRuntimeImageConfigured(process.env),
          }),
          cookieSecure: config.secureCookies,
          runtimeImageConfigured: portalCompatibilityBoundary.isRuntimeImageConfigured(process.env),
          adminCliTokenConfigured: Boolean(config.adminCliToken),
          publicBaseUrl: config.publicBaseUrl,
          staticDir: config.staticDir,
          releaseDir: config.releaseDir,
          provider: runtimeStatus,
          ...(portalCompatibilityBoundary.mode === "legacy"
            ? { runtime: portalCompatibilityBoundary.projectRuntimeStatus(runtimeStatus) }
            : {}),
          revisions: { instancePolicy: policyRevision, forwarding: forwardingRevision },
          restartRequiredFor: [
            "runtime",
            "databaseUrl",
            "authProviderBaseUrl",
            "staticDir",
            "releaseDir",
            "cookieSecurity",
          ],
        },
      });
      return;
    }
    if (isManagementRole(user.role) && url.pathname === "/api/admin/runtime" && request.method === "GET") {
      const status = await readProviderHealthStatus(providerHealth, providerId);
      sendJson(response, 200, {
        status: portalCompatibilityBoundary.projectRuntimeStatus(status),
      });
      return;
    }
    if (isManagementRole(user.role) && url.pathname === "/api/admin/images" && request.method === "GET") {
      const search = url.searchParams.get("search");
      const page = paginateAdminList(
        (await artifacts.listImages()).filter((image) =>
          matchesSearch(search, image.reference, image.id, image.size),
        ),
        url,
      );
      sendJson(response, 200, { images: page.items, pagination: page.pagination });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/images/pull" &&
      request.method === "POST"
    ) {
      const body = await readJsonBody(request);
      const reference = typeof body.reference === "string" ? body.reference.trim() : "";
      if (!IMAGE_REFERENCE_PATTERN.test(reference)) throw new HttpError(400, "invalid_image_reference");
      const operation = await operations.start(
        {
          type: "image.pull",
          actorUserId: user.id,
          resourceType: "image",
          resourceId: reference,
          requestId: request.headers["x-request-id"]?.toString(),
          idempotencyKey: requestIdempotencyKey(request),
          retryable: true,
        },
        async ({ report }) => {
          await report(10, "pulling");
          await artifacts.pullImage(reference);
          await stores.admin.recordAudit(user.id, "image.pull", "image", reference);
          await report(100, "completed");
          return { reference };
        },
      );
      sendJson(response, 202, { ok: true, reference, operationId: operation.id, operation });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/images/load" &&
      request.method === "POST"
    ) {
      const reference = String(request.headers["x-image-reference"] ?? "").trim();
      if (!reference || !IMAGE_REFERENCE_PATTERN.test(reference))
        throw new HttpError(400, "invalid_image_reference");
      const declaredLength = Number(request.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > 512 * 1024 * 1024)
        throw new HttpError(413, "image_archive_too_large");
      // 临时目录属于 Portal 控制面；旧前缀仍由启动清理器兼容回收。
      const dir = await mkdtemp(join(tmpdir(), "openapp-image-"));
      const path = join(dir, "image.tar");
      let total = 0;
      let operationOwnsArchive = false;
      const archiveHash = createHash("sha256");
      try {
        const file = await open(path, "w");
        try {
          for await (const chunk of request) {
            const buffer = Buffer.from(chunk as Uint8Array);
            total += buffer.length;
            if (total > 512 * 1024 * 1024) throw new HttpError(413, "image_archive_too_large");
            archiveHash.update(buffer);
            await file.write(buffer);
          }
        } finally {
          await file.close();
        }
        const operation = await operations.start(
          {
            type: "image.load",
            actorUserId: user.id,
            resourceType: "image",
            resourceId: reference,
            requestId: request.headers["x-request-id"]?.toString(),
            idempotencyKey: requestIdempotencyKey(request),
            requestFingerprint: operationFingerprint([reference, archiveHash.digest("hex")]),
          },
          async ({ report }) => {
            try {
              await report(10, "loading");
              await artifacts.loadImage(path, reference);
              await stores.admin.recordAudit(user.id, "image.load", "image", reference, { bytes: total });
              await report(100, "completed");
              return { reference, bytes: total };
            } finally {
              await rm(dir, { recursive: true, force: true });
            }
          },
          {
            onExisting: async () => {
              await rm(dir, { recursive: true, force: true });
            },
          },
        );
        operationOwnsArchive = true;
        sendJson(response, 202, { ok: true, reference, bytes: total, operationId: operation.id, operation });
        return;
      } finally {
        if (!operationOwnsArchive) await rm(dir, { recursive: true, force: true });
      }
    }
    if (isManagementRole(user.role) && url.pathname === "/api/admin/forwarding" && request.method === "GET") {
      const [policy, revision] = await Promise.all([
        forwarding.get(),
        stores.admin.getConfigRevision("forwarding:default"),
      ]);
      sendJson(response, 200, { forwarding: policy, revision });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/forwarding" &&
      request.method === "PATCH"
    ) {
      const body = await readJsonBody(request);
      const currentRevision = await stores.admin.getConfigRevision("forwarding:default");
      const expected = expectedRevision(request, currentRevision?.revision ?? 0);
      const policy = await forwarding.update(body, user.id, expected);
      await stores.admin.recordAudit(user.id, "forwarding.update", "forwarding", "default", {
        allowedHosts: policy.allowedHosts,
        enabled: policy.enabled,
      });
      sendJson(response, 200, {
        forwarding: policy,
        revision: await stores.admin.getConfigRevision("forwarding:default"),
      });
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/forwarding/test" &&
      request.method === "POST"
    ) {
      const policy = await forwarding.get();
      const body = await readJsonBody(request);
      if (body.targetBaseUrl !== undefined && typeof body.targetBaseUrl !== "string") {
        throw new HttpError(400, "invalid_forwarding_target");
      }
      const targetBaseUrl =
        typeof body.targetBaseUrl === "string" ? body.targetBaseUrl.trim() : policy.targetBaseUrl;
      forwarding.validateTargetBaseUrl(targetBaseUrl);
      const startedAt = Date.now();
      let status = 0;
      let error: string | null = null;
      try {
        const health = await fetch(`${targetBaseUrl}/api/health`, { signal: AbortSignal.timeout(3_000) });
        status = health.status;
        if (!health.ok) error = `upstream_status_${health.status}`;
      } catch (reason) {
        error = sanitizeOperationError(reason);
      }
      const check = { ok: !error, status, latencyMs: Date.now() - startedAt, error, targetBaseUrl };
      await stores.admin.recordAudit(user.id, "forwarding.test", "forwarding", "default", {
        ok: check.ok,
        status,
        latencyMs: check.latencyMs,
      });
      sendJson(response, check.ok ? 200 : 503, { check });
      return;
    }

    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/upgrade-rollouts" &&
      request.method === "POST"
    ) {
      const body = await readJsonBody(request);
      const taskKind = parseUpgradeRolloutTaskKind(body.taskKind);
      const detail = await upgradeRollouts.create({
        actorUserId: user.id,
        instanceIds: Array.isArray(body.instanceIds) ? body.instanceIds : [],
        taskKind,
        useLatestVersion: taskKind === "image_upgrade",
        idempotencyKey: requestIdempotencyKey(request),
      });
      void recordUpgradeAudit(user.id, "upgrade.rollout.create", "upgrade-rollout", detail.rollout.id, {
        requested: detail.rollout.requested,
      });
      sendJson(response, 202, publicUpgradeRolloutDetail(detail, true));
      kickUpgradeRolloutWorker();
      return;
    }
    if (
      isManagementRole(user.role) &&
      url.pathname === "/api/admin/upgrade-rollouts" &&
      request.method === "GET"
    ) {
      const search = url.searchParams.get("search");
      const status = url.searchParams.get("status");
      const page = paginateAdminList(
        (await upgradeRollouts.list(10_000))
          .map(publicUpgradeRollout)
          .filter(
            (rollout) =>
              (!status || rollout.status === status) && matchesSearch(search, rollout.id, rollout.status),
          ),
        url,
      );
      sendJson(response, 200, { rollouts: page.items, pagination: page.pagination });
      return;
    }
    const upgradeRolloutItemActionRoute = url.pathname.match(
      /^\/api\/admin\/upgrade-rollouts\/([^/]+)\/items\/([^/]+)\/(force|continue|revalidate|cancel)$/u,
    );
    if (isManagementRole(user.role) && upgradeRolloutItemActionRoute && request.method === "POST") {
      const rolloutId = decodeURIComponent(upgradeRolloutItemActionRoute[1]!);
      const instanceId = decodeURIComponent(upgradeRolloutItemActionRoute[2]!);
      const action = upgradeRolloutItemActionRoute[3]!;
      const detail =
        action === "force"
          ? await upgradeRollouts.force(rolloutId, instanceId)
          : action === "continue"
            ? await upgradeRollouts.continueWaiting(rolloutId, instanceId)
            : action === "revalidate"
              ? await upgradeRollouts.revalidateFirstStart(rolloutId, instanceId)
              : await upgradeRollouts.cancel(rolloutId, instanceId);
      void recordUpgradeAudit(user.id, `upgrade.rollout.item.${action}`, "container", instanceId, {
        rolloutId,
      });
      sendJson(response, 200, publicUpgradeRolloutDetail(detail, true));
      if (action !== "cancel") kickUpgradeRolloutWorker();
      return;
    }
    const upgradeRolloutItemRoute = url.pathname.match(
      /^\/api\/admin\/upgrade-rollouts\/([^/]+)\/items\/([^/]+)$/u,
    );
    if (isManagementRole(user.role) && upgradeRolloutItemRoute && request.method === "GET") {
      const rolloutId = decodeURIComponent(upgradeRolloutItemRoute[1]!);
      const instanceId = decodeURIComponent(upgradeRolloutItemRoute[2]!);
      const item = await upgradeRollouts.getItem(rolloutId, instanceId);
      if (!item) throw new UpgradeRolloutConflictError("upgrade_rollout_item_not_found");
      sendJson(response, 200, { item: publicUpgradeRolloutItem(item, true) });
      return;
    }
    const upgradeRolloutRoute = url.pathname.match(/^\/api\/admin\/upgrade-rollouts\/([^/]+)$/u);
    if (isManagementRole(user.role) && upgradeRolloutRoute && request.method === "GET") {
      const detail = await upgradeRollouts.get(decodeURIComponent(upgradeRolloutRoute[1]!));
      if (!detail) throw new UpgradeRolloutConflictError("upgrade_rollout_not_found");
      const search = url.searchParams.get("search");
      const status = url.searchParams.get("status");
      const blocker = url.searchParams.get("blocker");
      const filtered = detail.items.filter(
        (item) =>
          (!status || item.status === status) &&
          (!blocker || item.blocker === blocker) &&
          matchesSearch(
            search,
            item.instanceId,
            item.userId,
            item.appId,
            item.targetAppVersionId,
            item.status,
            item.blocker,
          ),
      );
      const page = paginateAdminList(filtered, url);
      sendJson(response, 200, {
        rollout: publicUpgradeRollout(detail.rollout),
        items: page.items.map((item) => publicUpgradeRolloutItem(item, true)),
        pagination: page.pagination,
      });
      return;
    }

    if (
      isManagementRole(user.role) &&
      request.method === "POST" &&
      url.pathname === "/api/admin/containers/actions"
    ) {
      const body = await readJsonBody(request);
      const ids = Array.isArray(body.ids)
        ? [
            ...new Set(
              body.ids
                .filter((id): id is string => typeof id === "string")
                .map((id) => id.trim())
                .filter(Boolean),
            ),
          ]
        : [];
      const action =
        body.action === "start" || body.action === "stop" || body.action === "rebuild" ? body.action : null;
      const useLatestVersion = body.useLatestVersion === true;
      if (!action || ids.length === 0 || ids.length > 100)
        throw new HttpError(400, "invalid_batch_container_action");
      if (action === "rebuild") {
        const legacyKey = requestIdempotencyKey(request);
        const taskKind =
          body.taskKind === undefined
            ? useLatestVersion
              ? "image_upgrade"
              : "rebuild_same_image"
            : parseUpgradeRolloutTaskKind(body.taskKind);
        const detail = await upgradeRollouts.create({
          actorUserId: user.id,
          instanceIds: ids,
          taskKind,
          useLatestVersion: taskKind === "image_upgrade",
          idempotencyKey: legacyKey,
        });
        void recordUpgradeAudit(user.id, "upgrade.rollout.create", "upgrade-rollout", detail.rollout.id, {
          requested: detail.rollout.requested,
          source: "legacy-container-action",
        });
        sendJson(response, 202, publicUpgradeRolloutDetail(detail, true));
        kickUpgradeRolloutWorker();
        return;
      }
      const operation = await operations.start(
        {
          type: `container.batch.${action}`,
          actorUserId: user.id,
          resourceType: "container",
          resourceId: null,
          requestId: request.headers["x-request-id"]?.toString(),
          idempotencyKey: requestIdempotencyKey(request),
          requestFingerprint: operationFingerprint([action, ...[...ids].sort()]),
          cancellable: true,
          retryable: true,
        },
        async ({ report, signal }) => {
          const results: Array<{ id: string; ok: boolean; error?: string }> = [];
          for (let index = 0; index < ids.length; index += 1) {
            if (signal.aborted) break;
            const id = ids[index]!;
            try {
              await requireOwnedContainer(id, user, true);
              await withInstanceMaintenance(
                id,
                async (maintenanceSignal) => {
                  if (action === "start")
                    await lifecycle.start(id, { maintenanceLeaseHeld: true, signal: maintenanceSignal });
                  else
                    await lifecycle.stop(id, "manual_admin", {
                      maintenanceLeaseHeld: true,
                      signal: maintenanceSignal,
                    });
                },
                signal,
              );
              results.push({ id, ok: true });
            } catch (error) {
              results.push({ id, ok: false, error: sanitizeOperationError(error) });
            }
            try {
              await report(
                Math.round(((index + 1) / ids.length) * 99),
                `${action}:${index + 1}/${ids.length}`,
              );
            } catch (error) {
              if (!signal.aborted) throw error;
              break;
            }
          }
          await stores.admin.recordAudit(user.id, `container.batch.${action}`, "container", null, {
            requested: ids.length,
            completed: results.length,
            succeeded: results.filter((result) => result.ok).length,
            failed: results.filter((result) => !result.ok).length,
            cancelled: signal.aborted,
          });
          const summary = {
            results,
            requested: ids.length,
            completed: results.length,
            succeeded: results.filter((result) => result.ok).length,
            failed: results.filter((result) => !result.ok).length,
            cancelled: signal.aborted,
          };
          if (summary.failed > 0 && !signal.aborted) {
            throw new AdminOperationTaskError("batch_operation_failed", summary);
          }
          return summary;
        },
      );
      sendJson(response, 202, { operationId: operation.id, operation });
      return;
    }

    const deleteRoute = url.pathname.match(/^\/api\/(admin\/)?containers\/([^/]+)$/u);
    if (request.method === "DELETE" && deleteRoute) {
      const adminRoute = Boolean(deleteRoute[1]);
      if (adminRoute && !isManagementRole(user.role)) throw new HttpError(403, "admin_required");
      const id = decodeURIComponent(deleteRoute[2]!);
      await requireOwnedWorkspaceForDeletion(id, user, adminRoute);
      await withWorkspaceDeletionMaintenance(id, (signal) =>
        lifecycle.remove(id, user.id, {
          maintenanceLeaseHeld: true,
          signal,
        }),
      );
      activityTouchAt.delete(id);
      sendJson(response, 200, { ok: true });
      return;
    }

    const actionRoute =
      url.pathname.match(/^\/api\/containers\/([^/]+)\/(start|stop|enter)$/u) ??
      url.pathname.match(/^\/api\/admin\/containers\/([^/]+)\/(start|stop|rebuild)$/u);
    if (request.method === "POST" && actionRoute) {
      const adminRoute = url.pathname.startsWith("/api/admin/");
      if (adminRoute && !isManagementRole(user.role)) throw new HttpError(403, "admin_required");
      const id = decodeURIComponent(actionRoute[1]!);
      const action = actionRoute[2]!;
      const record = await requireOwnedContainer(id, user, adminRoute);
      if (!adminRoute && record.status === "failed" && (action === "start" || action === "enter")) {
        const detail = await upgradeRollouts.createRecovery({
          actorUserId: user.id,
          instanceId: record.id,
          idempotencyKey: `instance-recovery:${record.id}`,
        });
        void recordUpgradeAudit(user.id, "upgrade.rollout.recovery.create", "container", record.id, {
          rolloutId: detail.rollout.id,
        });
        sendJson(response, 202, {
          ...publicRecoveryState(detail),
        });
        kickUpgradeRolloutWorker();
        return;
      }
      if (action === "enter") {
        const current = await withInstanceMaintenance(record.id, (signal) =>
          instanceAccess.acquire(record.id, "enter", { maintenanceLeaseHeld: true, signal }),
        );
        const publicBaseUrl = (await forwarding.get()).targetBaseUrl;
        sendJson(response, 200, { url: `${publicBaseUrl}/instances/${encodeURIComponent(current.id)}/ui/` });
        return;
      }
      const actionBody = action === "rebuild" ? await readJsonBody(request) : {};
      const updated = await withInstanceMaintenance(record.id, (signal) =>
        action === "start"
          ? lifecycle.start(record.id, { maintenanceLeaseHeld: true, signal })
          : action === "rebuild"
            ? lifecycle.rebuild(record.id, user.id, {
                useLatestVersion: actionBody.useLatestVersion === true,
                maintenanceLeaseHeld: true,
                signal,
              })
            : lifecycle.stop(record.id, adminRoute ? "manual_admin" : "manual_user", {
                maintenanceLeaseHeld: true,
                signal,
              }),
      );
      sendJson(response, 200, {
        container: await (adminRoute ? adminContainer(updated) : userContainer(updated)),
      });
      return;
    }

    const recoveryStatusRoute = url.pathname.match(/^\/api\/containers\/([^/]+)\/recovery$/u);
    if (request.method === "GET" && recoveryStatusRoute) {
      const id = decodeURIComponent(recoveryStatusRoute[1]!);
      await requireOwnedContainer(id, user, false);
      const detail = await upgradeRollouts.getRecovery(user.id, id);
      if (!detail) throw new HttpError(404, "recovery_not_found");
      sendJson(response, 200, publicRecoveryState(detail));
      return;
    }
    throw new HttpError(404, "not_found");
  }

  /**
   * The legacy /control contract predates provider field/capability metadata.
   * Keep that response shape stable while the generic entry receives the full
   * provider-owned presentation from the same registry.
   */
  function legacyAuthMethodDescription(
    provider: ExternalAuthProviderDescription,
  ): ExternalAuthProviderDescription {
    return {
      id: provider.id,
      label: provider.label,
      iconUrl: provider.iconUrl,
      challenge: provider.challenge,
    };
  }

  async function withInstanceMaintenance<T>(
    id: string,
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const result = await stores.admin.withMaintenanceLease(
      upgradeInstanceLeaseName(id),
      async (leaseSignal) => {
        const signal = callerSignal ? AbortSignal.any([leaseSignal, callerSignal]) : leaseSignal;
        signal.throwIfAborted();
        if (await stores.activity.isInstanceDraining(id, new Date().toISOString())) {
          throw new UpgradeRolloutConflictError("instance_upgrade_in_progress");
        }
        signal.throwIfAborted();
        return operation(signal);
      },
    );
    if (result === null) throw new UpgradeRolloutConflictError("instance_maintenance_busy");
    return result;
  }

  async function withWorkspaceDeletionMaintenance<T>(
    id: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const result = await stores.admin.withMaintenanceLease(upgradeInstanceLeaseName(id), operation);
    if (result === null) throw new UpgradeRolloutConflictError("instance_maintenance_busy");
    return result;
  }

  async function requireOwnedWorkspaceForDeletion(
    id: string,
    user: AuthenticatedUser,
    adminRoute: boolean,
  ): Promise<void> {
    let projection;
    try {
      projection = await executionManager.getProjection(id);
    } catch (error) {
      if (error instanceof WorkspaceExecutionStateError && error.code === "workspace_not_found") {
        throw new HttpError(404, "container_not_found");
      }
      throw error;
    }
    if (!(adminRoute && isManagementRole(user.role)) && projection.workspace.ownerId !== user.id) {
      throw new HttpError(404, "container_not_found");
    }
  }

  async function requireOwnedContainer(
    id: string,
    user: AuthenticatedUser,
    adminRoute = false,
  ): Promise<Container> {
    if (!(adminRoute && isManagementRole(user.role))) {
      return workspaceAuthorization.requireOwned(id, user.id);
    }
    const record = await stores.admin.getContainer(id);
    if (!record) throw new HttpError(404, "container_not_found");
    return record;
  }

  function publicApp(app: import("./models.js").AppDefinition) {
    return {
      id: app.id,
      name: app.name,
      description: app.description,
      status: app.status,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    };
  }

  function publicAppVersion(version: import("./models.js").AppVersion) {
    return {
      id: version.id,
      appId: version.appId,
      revision: version.revision ?? null,
      version: version.version,
      status: version.status,
      createdAt: version.createdAt,
      activatedAt: version.activatedAt,
    };
  }

  function publicUpgradeRollout(rollout: UpgradeRollout) {
    return {
      id: rollout.id,
      status: rollout.status,
      taskKind: rollout.taskKind,
      useLatestVersion: rollout.useLatestVersion,
      requested: rollout.requested,
      completed: rollout.completed,
      succeeded: rollout.succeeded,
      failed: rollout.failed,
      waiting: rollout.waiting,
      upgrading: rollout.upgrading,
      needsAttention: rollout.needsAttention,
      createdAt: rollout.createdAt,
      updatedAt: rollout.updatedAt,
      finishedAt: rollout.finishedAt,
    };
  }

  function parseUpgradeRolloutTaskKind(value: unknown): UpgradeRolloutTaskKind {
    if (value === undefined || value === "image_upgrade") return "image_upgrade";
    if (value === "rebuild_same_image" || value === "apply_resource_policy") return value;
    throw new UpgradeRolloutConflictError("invalid_upgrade_rollout_task_kind");
  }

  function publicUpgradeRolloutItem(item: UpgradeRolloutItem, includeDiagnostics = false) {
    return {
      rolloutId: item.rolloutId,
      instanceId: item.instanceId,
      position: item.position,
      userId: item.userId,
      appId: item.appId,
      sourceStatus: item.sourceStatus,
      desiredState: item.desiredState,
      sourceAppVersionId: item.sourceAppVersionId,
      targetAppVersionId: item.targetAppVersionId,
      targetResources: { ...item.launchProfile.resources },
      status: item.status,
      blocker: item.blocker,
      error: item.error ? sanitizeOperationError(item.error) : null,
      ...(item.recovery ? { recovery: true } : {}),
      ...(includeDiagnostics && item.diagnostics ? { diagnostics: item.diagnostics } : {}),
      forceRequested: item.forceRequested,
      attemptCount: item.attemptCount,
      nextAttemptAt: item.nextAttemptAt,
      lastCheckedAt: item.lastCheckedAt,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  function publicUpgradeRolloutDetail(detail: UpgradeRolloutDetail, includeDiagnostics = false) {
    return {
      rollout: publicUpgradeRollout(detail.rollout),
      items: detail.items.map((item) => publicUpgradeRolloutItem(item, includeDiagnostics)),
    };
  }

  function publicRecoveryState(detail: UpgradeRolloutDetail) {
    const item = detail.items[0];
    return {
      recovery: true,
      rolloutId: detail.rollout.id,
      status: detail.rollout.status,
      itemStatus: item?.status ?? "queued",
    };
  }

  function publicBuildPackage(pkg: import("./models.js").BuildPackage) {
    return {
      id: pkg.id,
      strategyId: pkg.strategyId,
      key: pkg.key,
      artifact: pkg.artifact,
      originalName: pkg.originalName,
      uploadedBy: pkg.uploadedBy,
      sourceVersion: pkg.sourceVersion ?? null,
      sourceBuildId: pkg.sourceBuildId ?? null,
      inspectedAt: pkg.inspectedAt ?? null,
      createdAt: pkg.createdAt,
    };
  }

  async function touchContainerActivity(id: string): Promise<void> {
    const now = Date.now();
    const previous = activityTouchAt.get(id) ?? 0;
    if (now - previous < ACTIVITY_TOUCH_INTERVAL_MS) return;
    await stores.admin.touchContainer(id, new Date(now));
    activityTouchAt.set(id, now);
  }

  function normalizeEmail(value: unknown): string {
    const email = typeof value === "string" ? value.trim().toLowerCase() : "";
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : "";
  }

  function expectedRevision(request: IncomingMessage, current: number): number {
    const header = request.headers["if-match"];
    if (header === undefined) return current;
    const value = Array.isArray(header) ? header[0] : header;
    const expected = Number(value?.replace(/^W\//u, "").replace(/^"|"$/gu, ""));
    if (!Number.isSafeInteger(expected) || expected < 0) throw new HttpError(400, "invalid_config_revision");
    if (expected !== current) throw new HttpError(409, "config_revision_conflict");
    return expected;
  }

  function configRevisionLimit(url: URL): number {
    const value = url.searchParams.get("limit");
    if (value === null || value === "") return 50;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
      throw new HttpError(400, "invalid_revision_limit");
    }
    return parsed;
  }

  function matchesSearch(search: string | null, ...values: readonly unknown[]): boolean {
    const normalized = search?.trim().toLowerCase();
    if (!normalized) return true;
    return values.some((value) => typeof value === "string" && value.toLowerCase().includes(normalized));
  }

  function requestIdempotencyKey(request: IncomingMessage): string | undefined {
    const header = request.headers["idempotency-key"];
    if (header === undefined) return undefined;
    const value = (Array.isArray(header) ? header[0] : header)?.trim() ?? "";
    if (!value || value.length > 128 || !/^[\x21-\x7e]+$/u.test(value)) {
      throw new HttpError(400, "invalid_idempotency_key");
    }
    return value;
  }

  function isJsonRequest(request: IncomingMessage): boolean {
    const header = request.headers["content-type"];
    const contentType = (Array.isArray(header) ? header[0] : header)?.toLowerCase() ?? "";
    return contentType.startsWith("application/json");
  }

  function operationFingerprint(parts: readonly string[]): string {
    const hash = createHash("sha256");
    for (const part of parts) {
      hash
        .update(String(Buffer.byteLength(part)))
        .update(":")
        .update(part)
        .update(";");
    }
    return hash.digest("hex");
  }

  function stableStringRecord(value: unknown): string[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [String(value)];
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, entry]) => [key, typeof entry === "string" ? entry : String(entry)]);
  }

  async function sha256File(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  }

  function localAuthSource(request: IncomingMessage): string {
    if (config.trustProxy) {
      const forwarded = request.headers["x-forwarded-for"];
      const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const client = value?.split(",", 1)[0]?.trim();
      if (client) return client;
    }
    return request.socket.remoteAddress ?? "unknown";
  }

  function applyCors(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (origin && forwarding.isPortalOriginAllowed(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("vary", "origin");
    }
    response.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    response.setHeader(
      "access-control-allow-headers",
      "content-type,authorization,x-openapp-admin-token,x-image-reference,if-match,x-request-id,idempotency-key",
    );
  }

  return {
    server,
    start,
    async stopMaintenance() {
      stopping = true;
      monitoring.stop();
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      maintenanceTimer = undefined;
      await maintenance.stop();
    },
  };
}
