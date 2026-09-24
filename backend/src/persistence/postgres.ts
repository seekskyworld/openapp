import { randomUUID } from "node:crypto";
import pg from "pg";
import type { AdminOperation, AdminOperationFilter } from "../admin-operations.js";
import { APP_ID_PATTERN } from "../app-id.js";
import type { AuthProviderId } from "../auth/types.js";
import {
  genericProvisioningPolicy,
  normalizeProvisioningPolicyWithFallback,
  type ProvisioningPolicy,
  provisioningPolicyFromDefaults,
} from "../instance-policy.js";
import type { InstanceActivityLease, InstanceDrainRequest } from "../instance-upgrade-activity.js";
import {
  leaseRetryDelayMs,
  leaseWaitMs,
  type MaintenanceLeaseOptions,
  waitForLeaseRetry,
} from "../maintenance-lease.js";
import type {
  AccountAuthState,
  AppDefinition,
  AppVersion,
  AuthenticatedUser,
  AuthMethod,
  BuildPackage,
  BuildStrategy,
  ConfigRevision,
  ConfigRevisionInput,
  ConfigRevisionSnapshot,
  Container,
  ForwardingPolicy,
  ImageArtifact,
  ImageBuild,
  ImageBuildStatus,
  ManagedLocalUserCreateInput,
  Tenant,
  TenantMembership,
  User,
  UserRoleChangeInput,
  WorkspaceTenantBinding,
} from "../models.js";
import { ConfigRevisionConflictError, UserRoleUpdateError } from "../models.js";
import type { AuditEvent, AuditEventFilter, HealthCheck, RuntimeSample } from "../monitoring-types.js";
import { redactSensitiveMetadata } from "../sensitive-data.js";
import { personalTenantId } from "../tenant-membership.js";
import type {
  UpgradeRollout,
  UpgradeRolloutDetail,
  UpgradeRolloutItem,
  UpgradeRolloutTargetReference,
} from "../upgrade-rollouts.js";
import { assertCanCreateManagedUser, assertCanGovernUserRoles } from "../user-role-policy.js";
import {
  assertWorkspaceExecutionTransition,
  projectContainerToWorkspaceExecution,
  projectWorkspaceExecutionToContainer,
  WorkspaceExecutionCasRequiredError,
} from "../workspace-execution-model.js";
import { type WorkspaceExecutionProjection } from "../workspace-execution.js";
import type {
  Persistence,
  PersistenceCompatibilityDefaults,
  PersistenceInitializeOptions,
} from "./contracts.js";
import {
  type AdminOperationRow,
  appVersionColumns,
  appVersionInsert,
  type AppVersionRow,
  appVersionSelect,
  appVersionValues,
  type AuditEventRow,
  type BuildPackageRow,
  buildPackageSelect,
  type BuildStrategyRow,
  clampLimit,
  clampOffset,
  type ConfigRevisionRow,
  type ConfigRevisionSnapshotRow,
  containerColumns,
  type ContainerRow,
  containerSelect,
  containerWriteValues,
  type HealthCheckRow,
  type ImageArtifactRow,
  imageArtifactSelect,
  imageBuildColumns,
  type ImageBuildRow,
  imageBuildSelect,
  imageBuildValues,
  type InstanceActivityLeaseRow,
  isPostgresForeignKeyViolation,
  isPostgresUniqueViolation,
  mapApp,
  mapAppVersion,
  mapAuditEvent,
  mapBuildPackage,
  mapBuildStrategy,
  mapConfigRevision,
  mapConfigRevisionSnapshot,
  mapContainer,
  mapHealthCheck,
  mapImageArtifact,
  mapImageBuild,
  mapInstanceActivityLease,
  mapOperation,
  mapRuntimeSample,
  mapTenant,
  mapTenantMembership,
  mapUpgradeRollout,
  mapUpgradeRolloutItem,
  mapWorkspaceExecutionProjection,
  mapWorkspaceTenantBinding,
  normalizeAuthProvider,
  normalizeOptionalAppId,
  numberedSqlValues,
  operationInsertValues,
  type RuntimeSampleRow,
  sqlStringLiteral,
  type TenantRow,
  UPGRADE_ROLLOUT_COLUMNS,
  UPGRADE_ROLLOUT_ITEM_COLUMNS,
  UPGRADE_ROLLOUT_ITEM_COLUMNS_QUALIFIED,
  upgradeRolloutInsertValues,
  upgradeRolloutItemInsertValues,
  type UpgradeRolloutItemRow,
  type UpgradeRolloutRow,
  workspaceExecutionUpdateValues,
  type WorkspaceTenantBindingRow,
} from "./postgres-records.js";
import { initializeCoreSchema } from "./postgres-schema.js";

const { Pool } = pg;

async function rollbackTransactionAndRethrow(
  client: Pick<pg.PoolClient, "query">,
  primaryError: unknown,
): Promise<never> {
  try {
    await client.query("rollback");
  } catch (rollbackError) {
    throw new AggregateError([primaryError, rollbackError], "postgres_transaction_rollback_failed", {
      cause: primaryError,
    });
  }
  throw primaryError;
}

function upgradeRolloutWriteError(error: unknown): unknown {
  return error;
}

/** PostgreSQL adapter used by deployed Portals. */
export class PostgresPersistence implements Persistence {
  readonly pool: pg.Pool;
  readonly #capacityLockPool: pg.Pool;
  readonly #releaseLockPool: pg.Pool;
  readonly #maintenanceLockPool: pg.Pool;
  #lastMonitoringPruneAt = 0;
  #legacyPackageColumns: Readonly<Record<string, Readonly<Record<string, string>>>> = {};
  #defaultAuthProvider: AuthProviderId | "local" = "external";
  #defaultAppId: string | undefined;
  #provisioningPolicyFallback: ProvisioningPolicy | undefined;
  readonly #strategyDefinitions: readonly BuildStrategy[];

  constructor(
    connectionString: string,
    options: {
      /** @deprecated 保留旧调用方参数；不会再改变任何产品默认值。 */
      legacyCompatibility?: boolean;
      defaultAuthProvider?: AuthProviderId | "local";
      compatibilityDefaults?: PersistenceCompatibilityDefaults;
      strategyDefinitions?: readonly BuildStrategy[];
      provisioningPolicyFallback?: ProvisioningPolicy;
    } = {},
  ) {
    this.#defaultAuthProvider = normalizeAuthProvider(
      options.compatibilityDefaults?.authProvider ?? options.defaultAuthProvider ?? "external",
    );
    this.#defaultAppId = normalizeOptionalAppId(options.compatibilityDefaults?.appId);
    this.#strategyDefinitions = (options.strategyDefinitions ?? []).map((strategy) =>
      structuredClone(strategy),
    );
    this.#provisioningPolicyFallback = options.provisioningPolicyFallback
      ? structuredClone(options.provisioningPolicyFallback)
      : undefined;
    this.pool = new Pool({ connectionString, max: 10 });
    this.#capacityLockPool = new Pool({ connectionString, max: 1 });
    this.#releaseLockPool = new Pool({ connectionString, max: 1 });
    // One sweep holds a process-wide lease while its workers sample in
    // parallel; leave enough connections for those workers and ad-hoc health
    // requests without serializing the configured sampling concurrency.
    this.#maintenanceLockPool = new Pool({ connectionString, max: 8 });
  }

  /** 迁移命令结束时关闭所有连接池，避免 Node 进程因空闲 socket 挂起。 */
  async close(): Promise<void> {
    await Promise.all([
      this.pool.end(),
      this.#capacityLockPool.end(),
      this.#releaseLockPool.end(),
      this.#maintenanceLockPool.end(),
    ]);
  }

  async checkReady(): Promise<void> {
    await this.pool.query("select 1");
  }

  async initialize(options?: PersistenceInitializeOptions): Promise<void> {
    this.#legacyPackageColumns = options?.legacyPackageColumns ?? this.#legacyPackageColumns;
    for (const [appId, columns] of Object.entries(this.#legacyPackageColumns)) {
      if (!APP_ID_PATTERN.test(appId) || new Set(Object.values(columns)).size !== Object.keys(columns).length)
        throw new Error("legacy_package_column_invalid");
      for (const [slot, column] of Object.entries(columns)) {
        if (
          !/^[a-z][a-z0-9_]{0,62}$/u.test(column) ||
          !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(slot) ||
          [
            "id",
            "app_id",
            "revision",
            "version",
            "build_id",
            "packages",
            "image_artifact_id",
            "image_reference",
            "runtime_contract",
            "status",
            "created_at",
            "activated_at",
            "source_kind",
          ].includes(column)
        )
          throw new Error("legacy_package_column_invalid");
      }
    }
    if (options?.compatibilityDefaults?.authProvider !== undefined) {
      this.#defaultAuthProvider = normalizeAuthProvider(options.compatibilityDefaults.authProvider);
    } else if (options?.defaultAuthProvider !== undefined) {
      this.#defaultAuthProvider = normalizeAuthProvider(options.defaultAuthProvider);
    }
    if (options?.compatibilityDefaults?.appId !== undefined) {
      this.#defaultAppId = normalizeOptionalAppId(options.compatibilityDefaults.appId);
    }
    if (
      options?.provisioningPolicyDefaults !== undefined &&
      Object.keys(options.provisioningPolicyDefaults).length > 0
    ) {
      this.#provisioningPolicyFallback = provisioningPolicyFromDefaults(options.provisioningPolicyDefaults);
    }
    await initializeCoreSchema(this.pool);
    // 保留旧列供旧程序回读；产品列名来自 Adapter，普通安装不创建这些列。
    for (const [appId, columns] of Object.entries(this.#legacyPackageColumns)) {
      for (const [slot, column] of Object.entries(columns)) {
        await this.pool.query(`alter table app_versions add column if not exists "${column}" jsonb`);
        await this.pool.query(
          `update app_versions set packages=packages || jsonb_build_array(jsonb_build_object('key',$1::text,'artifact',"${column}"))
        where app_id=$2 and jsonb_typeof("${column}")='object' and not exists(select 1 from jsonb_array_elements(packages) item where item->>'key'=$1)`,
          [slot, appId],
        );
      }
    }
    // Existing databases keep all rows; only the default for future rows follows
    // the selected composition mode. The value is validated before interpolation.
    await this.pool.query(
      `alter table sessions alter column auth_method set default ${sqlStringLiteral(this.#defaultAuthProvider)}`,
    );
    // 只有组合根显式提供 App ID 时才为未来容器保留数据库默认值；
    // 通用数据库没有默认 App，避免把某个产品写进 Core schema。
    await this.pool.query(
      this.#defaultAppId
        ? `alter table containers alter column app_id set default ${sqlStringLiteral(this.#defaultAppId)}`
        : "alter table containers alter column app_id drop default",
    );
    const strategyDefinitions = options?.strategyDefinitions;
    // The no-argument path is retained for old migration callers. Production
    // composition passes plugin-owned definitions explicitly; an empty list
    // therefore creates no product strategy but leaves old rows untouched.
    const seeds = strategyDefinitions ?? this.#strategyDefinitions;
    for (const strategy of seeds) {
      if (!(await this.getBuildStrategy(strategy.id))) await this.saveBuildStrategy(strategy);
    }
    if (
      options?.provisioningPolicyDefaults !== undefined &&
      Object.keys(options.provisioningPolicyDefaults).length > 0
    ) {
      const policy = provisioningPolicyFromDefaults(options.provisioningPolicyDefaults);
      this.#provisioningPolicyFallback = structuredClone(policy);
      await this.pool.query(
        `insert into provisioning_policy(id,policy) values('default',$1)
         on conflict(id) do nothing`,
        [JSON.stringify(policy)],
      );
    }
  }

  async getProvisioningPolicy(): Promise<ProvisioningPolicy> {
    const result = await this.pool.query<{ policy: unknown }>(
      `select policy from provisioning_policy where id='default'`,
    );
    if (result.rows[0]) {
      const fallback = this.#policyFallbackFor(result.rows[0].policy);
      return normalizeProvisioningPolicyWithFallback(result.rows[0].policy, fallback);
    }
    // 组合根显式提供的 fallback 对 generic 与 legacy 都有效；模式只决定
    // 默认值来源，不应让已注入的通用策略在无数据库行时失效。
    if (!this.#provisioningPolicyFallback) {
      throw new Error("provisioning_policy_not_initialized");
    }
    return structuredClone(this.#provisioningPolicyFallback);
  }

  async saveProvisioningPolicy(
    policy: ProvisioningPolicy,
    revision: ConfigRevisionInput = {},
  ): Promise<ProvisioningPolicy> {
    const snapshot = structuredClone(policy);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into provisioning_policy(id,policy) values('default',$1)
         on conflict(id) do update set policy=excluded.policy,updated_at=now()`,
        [JSON.stringify(snapshot)],
      );
      await this.#writeConfigRevision(client, "instance-policy", { ...revision, payload: snapshot });
      await client.query("commit");
      this.#provisioningPolicyFallback ??= structuredClone(snapshot);
      return snapshot;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getConfigRevision(key: string): Promise<ConfigRevision | null> {
    const result = await this.pool.query<ConfigRevisionRow>(
      `select key, revision::text as revision, updated_by as "updatedBy", effect,
         effective_at as "effectiveAt", updated_at as "updatedAt"
       from config_revisions where key=$1`,
      [key],
    );
    return result.rows[0] ? mapConfigRevision(result.rows[0]) : null;
  }

  async saveConfigRevision(key: string, input: ConfigRevisionInput = {}): Promise<ConfigRevision> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const revision = await this.#writeConfigRevision(client, key, input);
      await client.query("commit");
      return revision;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listConfigRevisions(key: string, limit = 50): Promise<ConfigRevisionSnapshot[]> {
    const result = await this.pool.query<ConfigRevisionSnapshotRow>(
      `select key,revision::text as revision,updated_by as "updatedBy",effect,
         effective_at as "effectiveAt",payload,created_at as "updatedAt"
       from config_revision_history where key=$1 order by revision desc limit $2`,
      [key, clampLimit(limit)],
    );
    return result.rows.map(mapConfigRevisionSnapshot);
  }

  async getConfigRevisionSnapshot(key: string, revision: number): Promise<ConfigRevisionSnapshot | null> {
    const result = await this.pool.query<ConfigRevisionSnapshotRow>(
      `select key,revision::text as revision,updated_by as "updatedBy",effect,
         effective_at as "effectiveAt",payload,created_at as "updatedAt"
       from config_revision_history where key=$1 and revision=$2`,
      [key, revision],
    );
    return result.rows[0] ? mapConfigRevisionSnapshot(result.rows[0]) : null;
  }

  async touchContainer(id: string, at = new Date()): Promise<void> {
    await this.pool.query(
      `update containers set last_activity_at=$2 where id=$1 and workspace_status='active'`,
      [id, at.toISOString()],
    );
  }

  async markUserAppInitialized(id: string): Promise<void> {
    await this.pool.query(
      `update users set app_initialized_at=coalesce(app_initialized_at,now()) where id=$1`,
      [id],
    );
  }

  async getUser(id: string): Promise<User | null> {
    const result = await this.pool.query<User>(
      `select id,email,role,created_at as "createdAt",app_initialized_at as "appInitializedAt"
       from users where id=$1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async withInstanceCapacityLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.#withAdvisoryLock(this.#capacityLockPool, "openapp:instance-capacity", operation);
  }

  async withReleaseActivationLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.#withAdvisoryLock(this.#releaseLockPool, "openapp:release-activation", operation);
  }

  async withMaintenanceLease<T>(
    name: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options: MaintenanceLeaseOptions = {},
  ): Promise<T | null> {
    const client = await this.#maintenanceLockPool.connect();
    const key = `openapp:maintenance:${name}`;
    const controller = new AbortController();
    const leaseLost = (cause?: Error): void => {
      if (!controller.signal.aborted) {
        controller.abort(cause ?? new Error("maintenance_lease_lost"));
      }
    };
    client.on("error", leaseLost);
    client.on("end", leaseLost);
    let acquired = false;
    try {
      const deadline = Date.now() + leaseWaitMs(options.waitMs);
      let lock: { rows: Array<{ acquired: boolean }> };
      do {
        options.signal?.throwIfAborted();
        lock = await client.query<{ acquired: boolean }>(
          `select pg_try_advisory_lock(hashtext($1)) as acquired`,
          [key],
        );
        if (lock.rows[0]?.acquired) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await waitForLeaseRetry(Math.min(leaseRetryDelayMs(options.retryDelayMs), remaining), options.signal);
      } while (true);
      acquired = true;
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      return await operation(signal);
    } finally {
      try {
        if (acquired && !controller.signal.aborted) {
          await client.query(`select pg_advisory_unlock(hashtext($1))`, [key]);
        }
      } finally {
        client.off("error", leaseLost);
        client.off("end", leaseLost);
        const reason =
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("maintenance_lease_lost");
        client.release(controller.signal.aborted ? reason : undefined);
      }
    }
  }

  async listApps(): Promise<AppDefinition[]> {
    const result = await this.pool.query<AppDefinition>(
      `select id,name,description,auth_adapter_id as "authAdapterId",status,
         created_at as "createdAt",updated_at as "updatedAt" from apps order by name`,
    );
    return result.rows.map(mapApp);
  }

  async getApp(appId: string): Promise<AppDefinition | null> {
    const result = await this.pool.query<AppDefinition>(
      `select id,name,description,auth_adapter_id as "authAdapterId",status,
         created_at as "createdAt",updated_at as "updatedAt" from apps where id=$1`,
      [appId.trim().toLowerCase()],
    );
    return result.rows[0] ? mapApp(result.rows[0]) : null;
  }

  async createApp(app: AppDefinition): Promise<AppDefinition | null> {
    const result = await this.pool.query<AppDefinition>(
      `insert into apps(id,name,description,auth_adapter_id,status,created_at,updated_at)
       values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do nothing
       returning id,name,description,auth_adapter_id as "authAdapterId",status,
         created_at as "createdAt",updated_at as "updatedAt"`,
      [app.id, app.name, app.description, app.authAdapterId, app.status, app.createdAt, app.updatedAt],
    );
    return result.rows[0] ? mapApp(result.rows[0]) : null;
  }

  async updateApp(app: AppDefinition): Promise<AppDefinition | null> {
    const result = await this.pool.query<AppDefinition>(
      `update apps set name=$2,description=$3,auth_adapter_id=$4,status=$5,updated_at=$6 where id=$1
       returning id,name,description,auth_adapter_id as "authAdapterId",status,
         created_at as "createdAt",updated_at as "updatedAt"`,
      [app.id, app.name, app.description, app.authAdapterId, app.status, app.updatedAt],
    );
    return result.rows[0] ? mapApp(result.rows[0]) : null;
  }

  async listAppVersions(appId: string): Promise<AppVersion[]> {
    const result = await this.pool.query<AppVersionRow>(
      appVersionSelect("where app_id=$1 order by revision desc"),
      [appId.trim().toLowerCase()],
    );
    return result.rows.map(mapAppVersion);
  }

  async getAppVersion(id: string): Promise<AppVersion | null> {
    const result = await this.pool.query<AppVersionRow>(appVersionSelect("where id=$1"), [id]);
    return result.rows[0] ? mapAppVersion(result.rows[0]) : null;
  }

  async saveAppVersion(version: AppVersion): Promise<AppVersion | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const app = await client.query<{ id: string }>(`select id from apps where id=$1 for update`, [
        version.appId,
      ]);
      if (!app.rows[0]) throw new Error("app_not_found");
      await this.#lockBuildPackages(
        client,
        version.packages?.flatMap((item) => (item.packageId ? [item.packageId] : [])) ?? [],
        true,
      );
      const existing = await client.query<{ appId: string; revision: string | number }>(
        `select app_id as "appId",revision::text as revision from app_versions where id=$1`,
        [version.id],
      );
      const nextRevision =
        existing.rows[0]?.appId === version.appId
          ? Number(existing.rows[0].revision)
          : Number(
              (
                await client.query<{ revision: string }>(
                  `select (coalesce(max(revision),0)+1)::text as revision from app_versions where app_id=$1`,
                  [version.appId],
                )
              ).rows[0]!.revision,
            );
      const result = await client.query<AppVersionRow>(
        `${appVersionInsert()} on conflict(id) do update set app_id=excluded.app_id,version=excluded.version,
           build_id=excluded.build_id,packages=excluded.packages,
           image_artifact_id=excluded.image_artifact_id,image_reference=excluded.image_reference,
           runtime_contract=excluded.runtime_contract,source_kind=excluded.source_kind,
           status=excluded.status,created_at=excluded.created_at,activated_at=excluded.activated_at
         where not exists(select 1 from app_versions existing where existing.app_id=excluded.app_id
           and existing.version=excluded.version and existing.id<>excluded.id)
         returning ${appVersionColumns()}`,
        appVersionValues(version, nextRevision),
      );
      for (const [slot, column] of Object.entries(this.#legacyPackageColumns[version.appId] ?? {})) {
        const artifact = version.packages?.find((item) => item.key === slot)?.artifact ?? null;
        await client.query(`update app_versions set "${column}"=$2::jsonb where id=$1`, [
          version.id,
          artifact ? JSON.stringify(artifact) : null,
        ]);
      }
      if (!result.rows[0]) {
        await client.query("rollback");
        return null;
      }
      await client.query("commit");
      return mapAppVersion(result.rows[0]);
    } catch (error) {
      await client.query("rollback");
      // Concurrent uploads can race after both callers pass the catalog lookup.
      // The database uniqueness constraint remains authoritative.
      if (isPostgresUniqueViolation(error)) return null;
      throw error;
    } finally {
      client.release();
    }
  }

  async activateAppVersion(
    appId: string,
    versionId: string,
    expectedCurrentVersionId?: string | null,
  ): Promise<AppVersion | null> {
    const client = await this.pool.connect();
    const normalizedAppId = appId.trim().toLowerCase();
    try {
      await client.query("begin");
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [
        `openapp:app-version-activation:${normalizedAppId}`,
      ]);
      const target = await client.query<AppVersionRow>(
        appVersionSelect("where id=$1 and app_id=$2 for update"),
        [versionId, normalizedAppId],
      );
      if (!target.rows[0]) {
        await client.query("rollback");
        return null;
      }
      const current = await client.query<{ id: string }>(
        `select id from app_versions where app_id=$1 and status in ('active','legacy')
         order by case status when 'active' then 0 else 1 end,revision desc limit 1 for update`,
        [normalizedAppId],
      );
      const currentVersionId = current.rows[0]?.id ?? null;
      if (expectedCurrentVersionId !== undefined && expectedCurrentVersionId !== currentVersionId) {
        await client.query("rollback");
        return null;
      }
      await client.query(
        `update app_versions
         set status=case when image_reference is not null then 'image_ready' else 'uploaded' end,
             activated_at=null
         where app_id=$1 and status='active' and id<>$2`,
        [normalizedAppId, versionId],
      );
      await client.query(
        `update app_versions set status='active',activated_at=now() where app_id=$1 and id=$2`,
        [normalizedAppId, versionId],
      );
      const result = await client.query<AppVersionRow>(appVersionSelect("where id=$1"), [versionId]);
      await client.query("commit");
      return result.rows[0] ? mapAppVersion(result.rows[0]) : null;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listBuildStrategies(): Promise<BuildStrategy[]> {
    const result = await this.pool.query<BuildStrategyRow>(
      `select id,revision,name,description,runtime_contract as "runtimeContract",package_requirements as "packageRequirements",status,
         created_at as "createdAt",updated_at as "updatedAt" from build_strategies order by name`,
    );
    return result.rows.map(mapBuildStrategy);
  }

  async getBuildStrategy(id: string): Promise<BuildStrategy | null> {
    const result = await this.pool.query<BuildStrategyRow>(
      `select id,revision,name,description,runtime_contract as "runtimeContract",package_requirements as "packageRequirements",status,
         created_at as "createdAt",updated_at as "updatedAt" from build_strategies where id=$1`,
      [id.trim().toLowerCase()],
    );
    return result.rows[0] ? mapBuildStrategy(result.rows[0]) : null;
  }

  async saveBuildStrategy(strategy: BuildStrategy): Promise<BuildStrategy> {
    const result = await this.pool.query<BuildStrategyRow>(
      `insert into build_strategies(id,revision,name,description,runtime_contract,package_requirements,status,created_at,updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict(id) do update set revision=excluded.revision,name=excluded.name,description=excluded.description,
         runtime_contract=excluded.runtime_contract,package_requirements=excluded.package_requirements,
         status=excluded.status,updated_at=excluded.updated_at
       returning id,revision,name,description,runtime_contract as "runtimeContract",package_requirements as "packageRequirements",status,
         created_at as "createdAt",updated_at as "updatedAt"`,
      [
        strategy.id.trim().toLowerCase(),
        strategy.revision,
        strategy.name,
        strategy.description,
        strategy.runtimeContract,
        JSON.stringify(strategy.packageRequirements),
        strategy.status,
        strategy.createdAt,
        strategy.updatedAt,
      ],
    );
    return mapBuildStrategy(result.rows[0]!);
  }

  async listBuildPackages(strategyId?: string, key?: string, limit?: number): Promise<BuildPackage[]> {
    const result = await this.pool.query<BuildPackageRow>(
      `${buildPackageSelect(
        "where ($1::text is null or strategy_id=$1) and ($2::text is null or slot_key=$2) order by created_at desc limit $3",
      )}`,
      [
        strategyId?.trim().toLowerCase() || null,
        key?.trim().toLowerCase() || null,
        limit === undefined ? null : clampLimit(limit),
      ],
    );
    return result.rows.map(mapBuildPackage);
  }

  async getBuildPackage(id: string): Promise<BuildPackage | null> {
    const result = await this.pool.query<BuildPackageRow>(buildPackageSelect("where id=$1"), [id]);
    return result.rows[0] ? mapBuildPackage(result.rows[0]) : null;
  }

  async createBuildPackage(pkg: BuildPackage): Promise<BuildPackage | null> {
    const result = await this.pool.query<BuildPackageRow>(
      `insert into build_packages(id,strategy_id,slot_key,artifact,original_name,storage_key,uploaded_by,
         source_version,source_build_id,inspected_at,created_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(id) do nothing
       returning id,strategy_id as "strategyId",slot_key as "key",artifact,original_name as "originalName",
         storage_key as "storageKey",uploaded_by as "uploadedBy",source_version as "sourceVersion",
         source_build_id as "sourceBuildId",inspected_at as "inspectedAt",created_at as "createdAt"`,
      [
        pkg.id,
        pkg.strategyId,
        pkg.key,
        JSON.stringify(pkg.artifact),
        pkg.originalName,
        pkg.storageKey,
        pkg.uploadedBy,
        pkg.sourceVersion ?? null,
        pkg.sourceBuildId ?? null,
        pkg.inspectedAt ?? null,
        pkg.createdAt,
      ],
    );
    return result.rows[0] ? mapBuildPackage(result.rows[0]) : null;
  }

  async deleteBuildPackageIfUnreferenced(id: string): Promise<BuildPackage | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.#lockBuildPackages(client, [id], false);
      const result = await client.query<BuildPackageRow>(
        `delete from build_packages as package where package.id=$1
         and not exists(
           select 1 from app_versions as version
           cross join lateral jsonb_array_elements(version.packages) as item
           where item->>'packageId'=$1
         )
         and not exists(
           select 1 from image_builds as build
           cross join lateral jsonb_array_elements(build.packages) as item
           where item->>'packageId'=$1
         )
       returning id,strategy_id as "strategyId",slot_key as "key",artifact,original_name as "originalName",
         storage_key as "storageKey",uploaded_by as "uploadedBy",source_version as "sourceVersion",
         source_build_id as "sourceBuildId",inspected_at as "inspectedAt",created_at as "createdAt"`,
        [id],
      );
      await client.query("commit");
      return result.rows[0] ? mapBuildPackage(result.rows[0]) : null;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listImageBuilds(strategyId?: string, limit?: number): Promise<ImageBuild[]> {
    const result = await this.pool.query<ImageBuildRow>(
      `${imageBuildSelect("where ($1::text is null or strategy_id=$1) order by created_at desc limit $2")}`,
      [strategyId?.trim().toLowerCase() || null, limit === undefined ? null : clampLimit(limit)],
    );
    return result.rows.map(mapImageBuild);
  }

  async getImageBuild(id: string): Promise<ImageBuild | null> {
    const result = await this.pool.query<ImageBuildRow>(imageBuildSelect("where id=$1"), [id]);
    return result.rows[0] ? mapImageBuild(result.rows[0]) : null;
  }

  async createImageBuild(build: ImageBuild): Promise<ImageBuild | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.#lockBuildPackages(
        client,
        build.packages.flatMap((item) => (item.packageId ? [item.packageId] : [])),
        true,
      );
      const result = await client.query<ImageBuildRow>(
        `insert into image_builds(id,strategy_id,strategy_snapshot,operation_id,source_app_version_id,requested_by,packages,status,error,
         created_at,started_at,finished_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(id) do nothing
       returning ${imageBuildColumns()}`,
        imageBuildValues(build),
      );
      await client.query("commit");
      return result.rows[0] ? mapImageBuild(result.rows[0]) : null;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateImageBuild(build: ImageBuild, expectedStatus: ImageBuildStatus): Promise<ImageBuild | null> {
    const result = await this.pool.query<ImageBuildRow>(
      `update image_builds set strategy_id=$2,strategy_snapshot=$3,operation_id=$4,source_app_version_id=$5,requested_by=$6,
         packages=$7,status=$8,error=$9,created_at=$10,started_at=$11,finished_at=$12
       where id=$1 and status=$13 returning ${imageBuildColumns()}`,
      [...imageBuildValues(build), expectedStatus],
    );
    return result.rows[0] ? mapImageBuild(result.rows[0]) : null;
  }

  async recoverInterruptedImageBuilds(finishedAt: string): Promise<number> {
    const result = await this.pool.query(
      `update image_builds set status='failed',error='image_build_interrupted',finished_at=$1
       where status in ('queued','building')
         and (operation_id is null or exists(
           select 1 from operation_runs where id=image_builds.operation_id
             and status in ('succeeded','failed','cancelled')
         ))`,
      [finishedAt],
    );
    return result.rowCount ?? 0;
  }

  async completeImageBuild(
    build: ImageBuild,
    artifact: ImageArtifact,
    expectedStatus: ImageBuildStatus,
  ): Promise<{ build: ImageBuild; artifact: ImageArtifact } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query<ImageBuildRow>(
        `update image_builds set status=$2,error=$3,started_at=$4,finished_at=$5
         where id=$1 and status=$6 returning ${imageBuildColumns()}`,
        [build.id, build.status, build.error, build.startedAt, build.finishedAt, expectedStatus],
      );
      if (!updated.rows[0] || artifact.buildId !== build.id) {
        await client.query("rollback");
        return null;
      }
      const inserted = await client.query<ImageArtifactRow>(
        `insert into image_artifacts(id,build_id,image_reference,image_id,runtime_contract,created_at)
         values($1,$2,$3,$4,$5,$6) on conflict do nothing
         returning id,build_id as "buildId",image_reference as "imageReference",image_id as "imageId",
           runtime_contract as "runtimeContract",created_at as "createdAt"`,
        [
          artifact.id,
          artifact.buildId,
          artifact.imageReference,
          artifact.imageId,
          artifact.runtimeContract,
          artifact.createdAt,
        ],
      );
      if (!inserted.rows[0]) {
        await client.query("rollback");
        return null;
      }
      await client.query("commit");
      return { build: mapImageBuild(updated.rows[0]), artifact: mapImageArtifact(inserted.rows[0]) };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getImageArtifact(id: string): Promise<ImageArtifact | null> {
    const result = await this.pool.query<ImageArtifactRow>(imageArtifactSelect("where id=$1"), [id]);
    return result.rows[0] ? mapImageArtifact(result.rows[0]) : null;
  }

  async getImageArtifactForBuild(buildId: string): Promise<ImageArtifact | null> {
    const result = await this.pool.query<ImageArtifactRow>(imageArtifactSelect("where build_id=$1"), [
      buildId,
    ]);
    return result.rows[0] ? mapImageArtifact(result.rows[0]) : null;
  }

  async listImageArtifacts(limit?: number): Promise<ImageArtifact[]> {
    const result = await this.pool.query<ImageArtifactRow>(
      imageArtifactSelect("order by created_at desc limit $1"),
      [limit === undefined ? null : clampLimit(limit)],
    );
    return result.rows.map(mapImageArtifact);
  }

  async deleteImageArtifactIfUnreferenced(id: string): Promise<ImageArtifact | null> {
    try {
      const result = await this.pool.query<ImageArtifactRow>(
        `delete from image_artifacts as artifact where artifact.id=$1
           and not exists(select 1 from app_versions where image_artifact_id=$1)
           and not exists(select 1 from containers where image_artifact_id=$1)
           and not exists(
             select 1 from upgrade_rollout_items as rollout_item
             where rollout_item.status not in ('succeeded','superseded','cancelled')
               and (rollout_item.source_image_artifact_id=$1
                 or rollout_item.source_image_reference=artifact.image_reference
                 or rollout_item.source_image_reference=artifact.image_id
                 or rollout_item.target_image_artifact_id=$1
                 or rollout_item.target_image_reference=artifact.image_reference
                 or rollout_item.target_image_reference=artifact.image_id)
           )
         returning id,build_id as "buildId",image_reference as "imageReference",image_id as "imageId",
           runtime_contract as "runtimeContract",created_at as "createdAt"`,
        [id],
      );
      return result.rows[0] ? mapImageArtifact(result.rows[0]) : null;
    } catch (error) {
      if (isPostgresForeignKeyViolation(error)) return null;
      throw error;
    }
  }

  async bindAppVersionArtifact(
    appId: string,
    versionId: string,
    artifactId: string,
  ): Promise<AppVersion | null> {
    const result = await this.pool.query<AppVersionRow>(
      `update app_versions set image_artifact_id=$3,
         image_reference=(select image_id from image_artifacts where id=$3),
         runtime_contract=(select runtime_contract from image_artifacts where id=$3),status='image_ready'
       where app_id=$1 and id=$2 and status='uploaded'
         and exists(select 1 from apps where id=$1 and status='active')
         and exists(select 1 from image_artifacts where id=$3)
       returning ${appVersionColumns()}`,
      [appId.trim().toLowerCase(), versionId, artifactId],
    );
    return result.rows[0] ? mapAppVersion(result.rows[0]) : null;
  }

  async upsertForwardingPolicy(
    policy: Omit<ForwardingPolicy, "updatedAt">,
    revision: ConfigRevisionInput = {},
  ): Promise<ForwardingPolicy> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<ForwardingPolicy>(
        `insert into forwarding_policies(id,name,target_base_url,allowed_hosts,enabled,updated_by)
         values($1,$2,$3,$4,$5,$6)
         on conflict(id) do update set name=excluded.name,target_base_url=excluded.target_base_url,
           allowed_hosts=excluded.allowed_hosts,enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=now()
         returning id,name,target_base_url as "targetBaseUrl",allowed_hosts as "allowedHosts",enabled,
           updated_by as "updatedBy",updated_at as "updatedAt"`,
        [policy.id, policy.name, policy.targetBaseUrl, policy.allowedHosts, policy.enabled, policy.updatedBy],
      );
      await this.#writeConfigRevision(client, `forwarding:${policy.id}`, {
        ...revision,
        updatedBy: policy.updatedBy,
        effect: "immediate",
        payload: {
          targetBaseUrl: policy.targetBaseUrl,
          allowedHosts: policy.allowedHosts,
          enabled: policy.enabled,
        },
      });
      await client.query("commit");
      return result.rows[0]!;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listForwardingPolicies(): Promise<ForwardingPolicy[]> {
    const result = await this.pool.query<ForwardingPolicy>(
      `select id,name,target_base_url as "targetBaseUrl",allowed_hosts as "allowedHosts",enabled,
         updated_by as "updatedBy",updated_at as "updatedAt"
       from forwarding_policies order by name`,
    );
    return result.rows.map((policy) => ({
      ...policy,
      allowedHosts: Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [],
    }));
  }

  async recordAudit(
    actorUserId: string | null,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata: unknown = {},
  ): Promise<void> {
    await this.pool.query(
      `insert into audit_events(id,actor_user_id,action,resource_type,resource_id,metadata)
       values($1,$2,$3,$4,$5,$6)`,
      [
        randomUUID(),
        actorUserId,
        action,
        resourceType,
        resourceId,
        JSON.stringify(redactSensitiveMetadata(metadata)),
      ],
    );
  }

  async recordRuntimeSample(sample: RuntimeSample): Promise<void> {
    await this.pool.query(
      `insert into runtime_samples(
         id,instance_id,sampled_at,state,network_rx_bytes,network_tx_bytes,cpu_percent,
         memory_working_set_bytes,pids,gpu_utilization_percent,error
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict(id) do nothing`,
      [
        sample.id,
        sample.instanceId,
        sample.sampledAt,
        sample.state,
        sample.networkRxBytes,
        sample.networkTxBytes,
        sample.cpuPercent,
        sample.memoryWorkingSetBytes,
        sample.pids,
        sample.gpuUtilizationPercent,
        sample.error,
      ],
    );
    await this.#pruneMonitoringIfDue();
  }

  async listRuntimeSamples(instanceId: string, limit = 60): Promise<RuntimeSample[]> {
    const result = await this.pool.query<RuntimeSampleRow>(
      `select id,instance_id as "instanceId",sampled_at as "sampledAt",state,
         network_rx_bytes as "networkRxBytes",network_tx_bytes as "networkTxBytes",
         cpu_percent as "cpuPercent",memory_working_set_bytes as "memoryWorkingSetBytes",
         pids,gpu_utilization_percent as "gpuUtilizationPercent",error
       from runtime_samples where instance_id=$1 order by sampled_at desc limit $2`,
      [instanceId, clampLimit(limit)],
    );
    return result.rows.map(mapRuntimeSample);
  }

  async listLatestRuntimeSamples(instanceIds: readonly string[]): Promise<RuntimeSample[]> {
    if (instanceIds.length === 0) return [];
    const result = await this.pool.query<RuntimeSampleRow>(
      `select distinct on (instance_id) id,instance_id as "instanceId",sampled_at as "sampledAt",state,
         network_rx_bytes as "networkRxBytes",network_tx_bytes as "networkTxBytes",
         cpu_percent as "cpuPercent",memory_working_set_bytes as "memoryWorkingSetBytes",
         pids,gpu_utilization_percent as "gpuUtilizationPercent",error
       from runtime_samples where instance_id = any($1::text[])
       order by instance_id, sampled_at desc`,
      [instanceIds],
    );
    return result.rows.map(mapRuntimeSample);
  }

  async recordHealthCheck(check: HealthCheck): Promise<void> {
    await this.pool.query(
      `insert into health_checks(id,target,checked_at,healthy,latency_ms,error)
       values($1,$2,$3,$4,$5,$6) on conflict(id) do nothing`,
      [check.id, check.target, check.checkedAt, check.healthy, check.latencyMs, check.error],
    );
    await this.#pruneMonitoringIfDue();
  }

  async listHealthChecks(target?: string, limit = 60): Promise<HealthCheck[]> {
    const result = await this.pool.query<HealthCheckRow>(
      `select id,target,checked_at as "checkedAt",healthy,latency_ms as "latencyMs",error
       from health_checks ${target ? "where target=$1" : ""} order by checked_at desc limit $${target ? 2 : 1}`,
      target ? [target, clampLimit(limit)] : [clampLimit(limit)],
    );
    return result.rows.map(mapHealthCheck);
  }

  async listAuditEvents(filter: AuditEventFilter = {}): Promise<AuditEvent[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      conditions.push(`${sql}=$${values.length}`);
    };
    if (filter.actorUserId) add("actor_user_id", filter.actorUserId);
    if (filter.action) add("action", filter.action);
    if (filter.resourceType) add("resource_type", filter.resourceType);
    if (filter.resourceId) add("resource_id", filter.resourceId);
    if (filter.from) {
      values.push(filter.from);
      conditions.push(`created_at >= $${values.length}`);
    }
    if (filter.to) {
      values.push(filter.to);
      conditions.push(`created_at <= $${values.length}`);
    }
    const limit = clampLimit(filter.limit ?? 100);
    const offset = clampOffset(filter.offset);
    values.push(limit);
    const limitParam = values.length;
    values.push(offset);
    const offsetParam = values.length;
    const result = await this.pool.query<AuditEventRow>(
      `select id,actor_user_id as "actorUserId",action,resource_type as "resourceType",
         resource_id as "resourceId",metadata,created_at as "createdAt"
       from audit_events ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
       order by created_at desc limit $${limitParam} offset $${offsetParam}`,
      values,
    );
    return result.rows.map(mapAuditEvent);
  }

  async saveOperation(operation: AdminOperation): Promise<void> {
    await this.pool.query(
      `insert into operation_runs(
         id,revision,type,status,progress,stage,actor_user_id,resource_type,resource_id,request_id,
         idempotency_key,request_fingerprint,retry_of,cancellable,retryable,result,error,created_at,started_at,heartbeat_at,finished_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       on conflict(id) do update set revision=excluded.revision,status=excluded.status,progress=excluded.progress,
         stage=excluded.stage,result=excluded.result,error=excluded.error,
         request_fingerprint=excluded.request_fingerprint,
         cancellable=excluded.cancellable,retryable=excluded.retryable,
         started_at=excluded.started_at,heartbeat_at=excluded.heartbeat_at,finished_at=excluded.finished_at`,
      operationInsertValues(operation),
    );
  }

  async createOperation(operation: AdminOperation): Promise<{ operation: AdminOperation; created: boolean }> {
    const result = await this.pool.query<AdminOperationRow>(
      `insert into operation_runs(
         id,revision,type,status,progress,stage,actor_user_id,resource_type,resource_id,request_id,
         idempotency_key,request_fingerprint,retry_of,cancellable,retryable,result,error,created_at,started_at,heartbeat_at,finished_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       on conflict(actor_user_id,idempotency_key) where idempotency_key is not null do nothing
       returning id,revision::text as revision,type,status,progress,stage,
         actor_user_id as "actorUserId",resource_type as "resourceType",resource_id as "resourceId",
         request_id as "requestId",idempotency_key as "idempotencyKey",request_fingerprint as "requestFingerprint",
         retry_of as "retryOf",cancellable,retryable,result,error,created_at as "createdAt",started_at as "startedAt",
         heartbeat_at as "heartbeatAt",finished_at as "finishedAt"`,
      operationInsertValues(operation),
    );
    if (result.rows[0]) return { operation: mapOperation(result.rows[0]), created: true };
    if (!operation.idempotencyKey) throw new Error("operation_create_conflict");
    const existing = await this.findOperationByIdempotencyKey(
      operation.actorUserId,
      operation.idempotencyKey,
    );
    if (!existing) throw new Error("operation_create_conflict");
    return { operation: existing, created: false };
  }

  async compareAndSaveOperation(
    operation: AdminOperation,
    expectedRevision: number,
  ): Promise<AdminOperation | null> {
    const result = await this.pool.query<AdminOperationRow>(
      `update operation_runs set
         status=$2,progress=$3,stage=$4,cancellable=$5,retryable=$6,result=$7,error=$8,
         started_at=$9,heartbeat_at=$10,finished_at=$11,revision=revision + 1
       where id=$1 and revision=$12
       returning id,revision::text as revision,type,status,progress,stage,
         actor_user_id as "actorUserId",resource_type as "resourceType",resource_id as "resourceId",
         request_id as "requestId",idempotency_key as "idempotencyKey",request_fingerprint as "requestFingerprint",retry_of as "retryOf",
         cancellable,retryable,result,error,created_at as "createdAt",started_at as "startedAt",
         heartbeat_at as "heartbeatAt",finished_at as "finishedAt"`,
      [
        operation.id,
        operation.status,
        operation.progress,
        operation.stage,
        operation.cancellable,
        operation.retryable,
        operation.result === null ? null : JSON.stringify(operation.result),
        operation.error,
        operation.startedAt,
        operation.heartbeatAt,
        operation.finishedAt,
        expectedRevision,
      ],
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }

  async recoverStaleOperations(cutoff: string, finishedAt: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `update operation_runs set
         status='failed',stage='interrupted',error='portal_restarted',cancellable=false,retryable=false,
         heartbeat_at=$2,finished_at=$2,revision=revision + 1
       where status in ('queued','running')
         and coalesce(heartbeat_at,started_at,created_at) <= $1
       returning id`,
      [cutoff, finishedAt],
    );
    return result.rows.map((row) => row.id);
  }

  async getOperation(id: string): Promise<AdminOperation | null> {
    const result = await this.pool.query<AdminOperationRow>(
      `select id,revision::text as revision,type,status,progress,stage,actor_user_id as "actorUserId",resource_type as "resourceType",
         resource_id as "resourceId",request_id as "requestId",idempotency_key as "idempotencyKey",
         request_fingerprint as "requestFingerprint",retry_of as "retryOf",cancellable,retryable,result,error,created_at as "createdAt",started_at as "startedAt",heartbeat_at as "heartbeatAt",finished_at as "finishedAt"
       from operation_runs where id=$1`,
      [id],
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }

  async listOperations(filter: AdminOperationFilter = {}): Promise<AdminOperation[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.status) {
      values.push(filter.status);
      conditions.push(`status=$${values.length}`);
    }
    if (filter.type) {
      values.push(filter.type);
      conditions.push(`type=$${values.length}`);
    }
    values.push(clampLimit(filter.limit ?? 100));
    const result = await this.pool.query<AdminOperationRow>(
      `select id,revision::text as revision,type,status,progress,stage,actor_user_id as "actorUserId",resource_type as "resourceType",
         resource_id as "resourceId",request_id as "requestId",idempotency_key as "idempotencyKey",
         request_fingerprint as "requestFingerprint",retry_of as "retryOf",cancellable,retryable,result,error,created_at as "createdAt",started_at as "startedAt",heartbeat_at as "heartbeatAt",finished_at as "finishedAt"
       from operation_runs ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
       order by created_at desc limit $${values.length}`,
      values,
    );
    return result.rows.map(mapOperation);
  }

  async findOperationByIdempotencyKey(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<AdminOperation | null> {
    const result = await this.pool.query<AdminOperationRow>(
      `select id,revision::text as revision,type,status,progress,stage,actor_user_id as "actorUserId",resource_type as "resourceType",
         resource_id as "resourceId",request_id as "requestId",idempotency_key as "idempotencyKey",
         request_fingerprint as "requestFingerprint",retry_of as "retryOf",cancellable,retryable,result,error,created_at as "createdAt",started_at as "startedAt",heartbeat_at as "heartbeatAt",finished_at as "finishedAt"
       from operation_runs where actor_user_id=$1 and idempotency_key=$2
       order by created_at desc limit 1`,
      [actorUserId, idempotencyKey],
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }

  async pruneFinishedOperations(retentionMs = 30 * 24 * 60 * 60 * 1_000): Promise<number> {
    const cutoff = new Date(Date.now() - Math.max(0, retentionMs)).toISOString();
    const result = await this.pool.query(
      `delete from operation_runs
       where status in ('succeeded', 'failed', 'cancelled')
         and coalesce(finished_at, created_at) < $1`,
      [cutoff],
    );
    return result.rowCount ?? 0;
  }

  async createUpgradeRollout(
    rollout: UpgradeRollout,
    items: UpgradeRolloutItem[],
  ): Promise<UpgradeRolloutDetail> {
    const client = await this.pool.connect();
    let existingId: string | undefined;
    try {
      await client.query("begin");
      const inserted = await client.query<{ id: string }>(
        `insert into upgrade_rollouts(
           id,revision,actor_user_id,status,task_kind,use_latest_version,requested,completed,succeeded,superseded,failed,waiting,
           upgrading,needs_attention,idempotency_key,request_fingerprint,created_at,updated_at,finished_at
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         on conflict(actor_user_id,idempotency_key) where idempotency_key is not null do nothing
         returning id`,
        upgradeRolloutInsertValues(rollout),
      );
      if (!inserted.rows[0]) {
        if (!rollout.idempotencyKey) throw new Error("upgrade_rollout_create_conflict");
        const existing = await client.query<{ id: string }>(
          `select id from upgrade_rollouts where actor_user_id=$1 and idempotency_key=$2`,
          [rollout.actorUserId, rollout.idempotencyKey],
        );
        existingId = existing.rows[0]?.id;
        if (!existingId) throw new Error("upgrade_rollout_create_conflict");
      } else {
        for (const item of items) {
          await client.query(
            `insert into upgrade_rollout_items(
               rollout_id,instance_id,position,revision,user_id,app_id,source_status,desired_state,
               source_app_version_id,source_image_artifact_id,source_image_reference,target_app_version_id,target_image_artifact_id,
               target_image_reference,target_runtime_contract,launch_profile,recovery,status,blocker,error,diagnostics,force_requested,
               attempt_id,attempt_count,next_attempt_at,last_checked_at,started_at,finished_at,created_at,updated_at
             ) values(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30
             )`,
            upgradeRolloutItemInsertValues(item),
          );
        }
      }
      await client.query("commit");
    } catch (error) {
      return await rollbackTransactionAndRethrow(client, upgradeRolloutWriteError(error));
    } finally {
      client.release();
    }
    const detail = await this.getUpgradeRollout(existingId ?? rollout.id);
    if (!detail) throw new Error("upgrade_rollout_create_conflict");
    return detail;
  }

  async findUpgradeRolloutByIdempotencyKey(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<UpgradeRolloutDetail | null> {
    const result = await this.pool.query<{ id: string }>(
      `select id from upgrade_rollouts where actor_user_id=$1 and idempotency_key=$2 limit 1`,
      [actorUserId, idempotencyKey],
    );
    return result.rows[0] ? this.getUpgradeRollout(result.rows[0].id) : null;
  }

  async findLatestUpgradeRecovery(
    actorUserId: string,
    instanceId: string,
  ): Promise<UpgradeRolloutDetail | null> {
    const result = await this.pool.query<{ id: string }>(
      `select r.id
       from upgrade_rollouts r
       join upgrade_rollout_items i on i.rollout_id=r.id
       where r.actor_user_id=$1 and r.task_kind='instance_recovery'
         and i.instance_id=$2 and i.recovery=true
       order by r.created_at desc
       limit 1`,
      [actorUserId, instanceId],
    );
    const id = result.rows[0]?.id;
    return id ? this.getUpgradeRollout(id) : null;
  }

  async getUpgradeRollout(id: string): Promise<UpgradeRolloutDetail | null> {
    const [rolloutResult, itemResult] = await Promise.all([
      this.pool.query<UpgradeRolloutRow>(
        `select ${UPGRADE_ROLLOUT_COLUMNS} from upgrade_rollouts where id=$1`,
        [id],
      ),
      this.pool.query<UpgradeRolloutItemRow>(
        `select ${UPGRADE_ROLLOUT_ITEM_COLUMNS} from upgrade_rollout_items where rollout_id=$1 order by position`,
        [id],
      ),
    ]);
    const rollout = rolloutResult.rows[0];
    return rollout
      ? { rollout: mapUpgradeRollout(rollout), items: itemResult.rows.map(mapUpgradeRolloutItem) }
      : null;
  }

  async listUpgradeRollouts(limit = 100): Promise<UpgradeRollout[]> {
    const result = await this.pool.query<UpgradeRolloutRow>(
      `select ${UPGRADE_ROLLOUT_COLUMNS} from upgrade_rollouts order by created_at desc limit $1`,
      [clampLimit(limit)],
    );
    return result.rows.map(mapUpgradeRollout);
  }

  async listActiveUpgradeRolloutTargetReferences(): Promise<UpgradeRolloutTargetReference[]> {
    const result = await this.pool.query<UpgradeRolloutTargetReference>(
      `select rollout_id as "rolloutId",instance_id as "instanceId",app_id as "appId",
         source_app_version_id as "sourceAppVersionId",source_image_artifact_id as "sourceImageArtifactId",
         source_image_reference as "sourceImageReference",
         target_app_version_id as "targetAppVersionId",target_image_artifact_id as "targetImageArtifactId",
         target_image_reference as "targetImageReference",status
       from upgrade_rollout_items
       where status not in ('succeeded','superseded','cancelled')`,
    );
    return result.rows;
  }

  async listDueUpgradeRolloutItems(at: string, limit: number): Promise<UpgradeRolloutItem[]> {
    const result = await this.pool.query<UpgradeRolloutItemRow>(
      `select ${UPGRADE_ROLLOUT_ITEM_COLUMNS_QUALIFIED}
       from upgrade_rollout_items i
       where i.status in ('queued','waiting_for_idle','awaiting_first_start')
         and (i.next_attempt_at is null or i.next_attempt_at <= $1)
       order by coalesce(i.next_attempt_at,i.created_at),
         case when i.status='awaiting_first_start' then 1 else 0 end,
         i.created_at,i.position limit $2`,
      [at, clampLimit(limit)],
    );
    return result.rows.map(mapUpgradeRolloutItem);
  }

  async listLegacyFirstStartProofItems(): Promise<UpgradeRolloutItem[]> {
    const result = await this.pool.query<UpgradeRolloutItemRow>(
      `select ${UPGRADE_ROLLOUT_ITEM_COLUMNS_QUALIFIED}
       from upgrade_rollout_items i
       join upgrade_rollouts r on r.id=i.rollout_id
       where r.task_kind='image_upgrade'
         and i.status='needs_attention'
         and i.blocker='candidate_first_start_proof_missing'
       order by i.created_at,i.position`,
    );
    return result.rows.map(mapUpgradeRolloutItem);
  }

  async compareAndSaveUpgradeRolloutItem(
    item: UpgradeRolloutItem,
    expectedRevision: number,
  ): Promise<UpgradeRolloutItem | null> {
    const result = await this.pool.query<UpgradeRolloutItemRow>(
      `update upgrade_rollout_items set
         desired_state=$3,source_app_version_id=$4,source_image_artifact_id=$5,source_image_reference=$6,
         status=$7,blocker=$8,error=$9,diagnostics=$10,force_requested=$11,attempt_id=$12,attempt_count=$13,next_attempt_at=$14,
         last_checked_at=$15,started_at=$16,finished_at=$17,updated_at=$18,revision=revision + 1
       where rollout_id=$1 and instance_id=$2 and revision=$19
       returning ${UPGRADE_ROLLOUT_ITEM_COLUMNS}`,
      [
        item.rolloutId,
        item.instanceId,
        item.desiredState,
        item.sourceAppVersionId,
        item.sourceImageArtifactId,
        item.sourceImageReference,
        item.status,
        item.blocker,
        item.error,
        item.diagnostics === undefined ? null : JSON.stringify(item.diagnostics),
        item.forceRequested,
        item.attemptId,
        item.attemptCount,
        item.nextAttemptAt,
        item.lastCheckedAt,
        item.startedAt,
        item.finishedAt,
        item.updatedAt,
        expectedRevision,
      ],
    );
    return result.rows[0] ? mapUpgradeRolloutItem(result.rows[0]) : null;
  }

  async supersedeUpgradeDeferredItemsBefore(
    rolloutId: string,
    instanceId: string,
    at: string,
  ): Promise<string[]> {
    const result = await this.pool.query<{ rolloutId: string }>(
      `with current_item as (
         select created_at,rollout_id
         from upgrade_rollout_items
         where rollout_id=$1 and instance_id=$2
       ), superseded as (
         update upgrade_rollout_items older
         set status='superseded',blocker='superseded_by_newer_deployment',error=null,
             attempt_id=null,next_attempt_at=null,finished_at=$3,updated_at=$3,
             revision=older.revision+1
         from current_item current
         where older.instance_id=$2
           and (older.status='awaiting_first_start'
             or (older.status='needs_attention' and older.blocker='candidate_first_start_proof_missing'
               and exists (select 1 from upgrade_rollouts older_rollout
                           where older_rollout.id=older.rollout_id
                             and older_rollout.task_kind='image_upgrade')))
           and (older.created_at < current.created_at
             or (older.created_at=current.created_at and older.rollout_id < current.rollout_id))
         returning older.rollout_id as "rolloutId"
       )
       select distinct "rolloutId" from superseded`,
      [rolloutId, instanceId, at],
    );
    return result.rows.map((row) => row.rolloutId);
  }

  async commitUpgradeDeploymentCheckpoint(
    item: UpgradeRolloutItem,
    expectedRevision: number,
    at: string,
    supersedeEarlier = true,
  ): Promise<{ item: UpgradeRolloutItem; affectedRolloutIds: string[] } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query<UpgradeRolloutItemRow>(
        `update upgrade_rollout_items set
         desired_state=$3,source_app_version_id=$4,source_image_artifact_id=$5,source_image_reference=$6,
         status=$7,blocker=$8,error=$9,diagnostics=$10,force_requested=$11,attempt_id=$12,attempt_count=$13,next_attempt_at=$14,
         last_checked_at=$15,started_at=$16,finished_at=$17,updated_at=$18,revision=revision + 1
         where rollout_id=$1 and instance_id=$2 and revision=$19
         returning ${UPGRADE_ROLLOUT_ITEM_COLUMNS}`,
        [
          item.rolloutId,
          item.instanceId,
          item.desiredState,
          item.sourceAppVersionId,
          item.sourceImageArtifactId,
          item.sourceImageReference,
          item.status,
          item.blocker,
          item.error,
          item.diagnostics === undefined ? null : JSON.stringify(item.diagnostics),
          item.forceRequested,
          item.attemptId,
          item.attemptCount,
          item.nextAttemptAt,
          item.lastCheckedAt,
          item.startedAt,
          item.finishedAt,
          at,
          expectedRevision,
        ],
      );
      if (!current.rows[0]) {
        await client.query("rollback");
        return null;
      }
      const superseded =
        supersedeEarlier && (item.status === "awaiting_first_start" || item.status === "succeeded")
          ? await client.query<{ rollout_id: string }>(
              `update upgrade_rollout_items
           set status='superseded',blocker='superseded_by_newer_deployment',error=null,
               attempt_id=null,next_attempt_at=null,finished_at=$1,updated_at=$1,revision=revision + 1
           where instance_id=$2
             and (status='awaiting_first_start'
               or (status='needs_attention' and blocker='candidate_first_start_proof_missing'
                 and exists (select 1 from upgrade_rollouts older_rollout
                             where older_rollout.id=upgrade_rollout_items.rollout_id
                               and older_rollout.task_kind='image_upgrade')))
             and (created_at < $3 or (created_at = $3 and rollout_id < $4))
           returning rollout_id`,
              [at, item.instanceId, item.createdAt, item.rolloutId],
            )
          : { rows: [] };
      await client.query("commit");
      return {
        item: mapUpgradeRolloutItem(current.rows[0]),
        affectedRolloutIds: [item.rolloutId, ...superseded.rows.map((row) => row.rollout_id)],
      };
    } catch (error) {
      return await rollbackTransactionAndRethrow(client, error);
    } finally {
      client.release();
    }
  }

  async compareAndSaveUpgradeRollout(
    rollout: UpgradeRollout,
    expectedRevision: number,
  ): Promise<UpgradeRollout | null> {
    const result = await this.pool.query<UpgradeRolloutRow>(
      `update upgrade_rollouts set
         status=$2,completed=$3,succeeded=$4,superseded=$5,failed=$6,waiting=$7,upgrading=$8,needs_attention=$9,
         updated_at=$10,finished_at=$11,
         revision=revision + 1
       where id=$1 and revision=$12
       returning ${UPGRADE_ROLLOUT_COLUMNS}`,
      [
        rollout.id,
        rollout.status,
        rollout.completed,
        rollout.succeeded,
        rollout.superseded ?? 0,
        rollout.failed,
        rollout.waiting,
        rollout.upgrading,
        rollout.needsAttention,
        rollout.updatedAt,
        rollout.finishedAt,
        expectedRevision,
      ],
    );
    return result.rows[0] ? mapUpgradeRollout(result.rows[0]) : null;
  }

  async recoverInterruptedUpgradeRolloutItems(cutoff: string, recoveredAt: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update upgrade_rollout_items set
           status=case
             when status in ('rebuilding','verifying') and attempt_id is not null
               then 'awaiting_first_start'
             else 'queued'
           end,
           blocker=case
             when status in ('rebuilding','verifying') and attempt_id is not null
               then 'candidate_recovery_pending'
             else 'portal_restarted'
           end,
           error=null,
           attempt_id=case
             when status in ('rebuilding','verifying') and attempt_id is not null
               then attempt_id
             else null
           end,
           next_attempt_at=$2,finished_at=null,updated_at=$2,revision=revision + 1
         where status in ('assessing','draining','rebuilding','verifying') and updated_at <= $1`,
        [cutoff, recoveredAt],
      );
      await client.query(
        `delete from instance_upgrade_drains d
         where d.expires_at <= $1
            or not exists (
              select 1 from upgrade_rollout_items i
              where i.rollout_id=d.rollout_id and i.instance_id=d.instance_id
                and i.status in ('assessing','draining','rebuilding','verifying')
            )`,
        [recoveredAt],
      );
      await client.query("commit");
      return result.rowCount ?? 0;
    } catch (error) {
      return await rollbackTransactionAndRethrow(client, error);
    } finally {
      client.release();
    }
  }

  async tryOpenInstanceActivityLease(lease: InstanceActivityLease, at: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const instance = await client.query(
        `select id from containers where id=$1 and workspace_status='active' for update`,
        [lease.instanceId],
      );
      if (!instance.rows[0]) throw new Error("container_not_found");
      const drain = await client.query(
        `select 1 from instance_upgrade_drains where instance_id=$1 and expires_at > $2`,
        [lease.instanceId, at],
      );
      if (drain.rows[0]) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        `insert into instance_activity_leases(id,instance_id,kind,opened_at,heartbeat_at,last_activity_at)
         values($1,$2,$3,$4,$5,$6)
         on conflict(id) do update set
           instance_id=excluded.instance_id,kind=excluded.kind,opened_at=excluded.opened_at,
           heartbeat_at=excluded.heartbeat_at,last_activity_at=excluded.last_activity_at`,
        [lease.id, lease.instanceId, lease.kind, lease.openedAt, lease.heartbeatAt, lease.lastActivityAt],
      );
      await client.query(`update containers set last_activity_at=greatest(last_activity_at,$2) where id=$1`, [
        lease.instanceId,
        lease.openedAt,
      ]);
      await client.query("commit");
      return true;
    } catch (error) {
      return await rollbackTransactionAndRethrow(client, error);
    } finally {
      client.release();
    }
  }

  async renewInstanceActivityLease(lease: InstanceActivityLease, at: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const instance = await client.query(
        `select id from containers where id=$1 and workspace_status='active' for update`,
        [lease.instanceId],
      );
      if (!instance.rows[0]) throw new Error("container_not_found");
      const drain = await client.query(
        `select 1 from instance_upgrade_drains where instance_id=$1 and expires_at > $2`,
        [lease.instanceId, at],
      );
      if (drain.rows[0]) {
        await client.query("rollback");
        return false;
      }
      const renewed = await client.query(
        `update instance_activity_leases set
           heartbeat_at=$3,last_activity_at=$4
         where id=$1 and instance_id=$2`,
        [lease.id, lease.instanceId, lease.heartbeatAt, lease.lastActivityAt],
      );
      if ((renewed.rowCount ?? 0) === 1) {
        await client.query(
          `update containers set last_activity_at=greatest(last_activity_at,$2) where id=$1`,
          [lease.instanceId, lease.lastActivityAt],
        );
      }
      await client.query("commit");
      return (renewed.rowCount ?? 0) === 1;
    } catch (error) {
      return await rollbackTransactionAndRethrow(client, error);
    } finally {
      client.release();
    }
  }

  async deleteInstanceActivityLease(id: string): Promise<void> {
    await this.pool.query(`delete from instance_activity_leases where id=$1`, [id]);
  }

  async closeInstanceActivityLease(id: string, instanceId: string, closedAt: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`select id from containers where id=$1 for update`, [instanceId]);
      await client.query(`update containers set last_activity_at=greatest(last_activity_at,$2) where id=$1`, [
        instanceId,
        closedAt,
      ]);
      await client.query(`delete from instance_activity_leases where id=$1 and instance_id=$2`, [
        id,
        instanceId,
      ]);
      await client.query("commit");
    } catch (error) {
      return await rollbackTransactionAndRethrow(client, error);
    } finally {
      client.release();
    }
  }

  async listActiveInstanceActivityLeases(
    instanceId: string,
    heartbeatCutoff: string,
  ): Promise<InstanceActivityLease[]> {
    const result = await this.pool.query<InstanceActivityLeaseRow>(
      `select id,instance_id as "instanceId",kind,opened_at as "openedAt",
         heartbeat_at as "heartbeatAt",last_activity_at as "lastActivityAt"
       from instance_activity_leases
       where instance_id=$1 and heartbeat_at >= $2
       order by opened_at`,
      [instanceId, heartbeatCutoff],
    );
    return result.rows.map(mapInstanceActivityLease);
  }

  async beginInstanceDraining(request: InstanceDrainRequest): Promise<boolean> {
    const {
      instanceId,
      rolloutId,
      attemptId,
      at,
      expiresAt,
      heartbeatCutoff,
      websocketActivityCutoff,
      mode,
    } = request;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const instance = await client.query(`select id from containers where id=$1 for update`, [instanceId]);
      if (!instance.rows[0]) throw new Error("container_not_found");
      if (mode === "graceful") {
        const active = await client.query(
          `select 1 from instance_activity_leases
           where instance_id=$1 and heartbeat_at >= $2
             and (kind='http' or last_activity_at >= $3)
           limit 1`,
          [instanceId, heartbeatCutoff, websocketActivityCutoff],
        );
        if (active.rows[0]) {
          await client.query("rollback");
          return false;
        }
      }
      const existingDrain = await client.query<{ rollout_id: string; attempt_id: string }>(
        `select rollout_id,attempt_id from instance_upgrade_drains where instance_id=$1 and expires_at > $2`,
        [instanceId, at],
      );
      if (
        existingDrain.rows[0] &&
        (existingDrain.rows[0].rollout_id !== rolloutId || existingDrain.rows[0].attempt_id !== attemptId)
      ) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        `insert into instance_upgrade_drains(instance_id,rollout_id,attempt_id,expires_at) values($1,$2,$3,$4)
         on conflict(instance_id) do update set
           rollout_id=excluded.rollout_id,attempt_id=excluded.attempt_id,expires_at=excluded.expires_at`,
        [instanceId, rolloutId, attemptId, expiresAt],
      );
      await client.query("commit");
      return true;
    } catch (error) {
      return await rollbackTransactionAndRethrow(client, error);
    } finally {
      client.release();
    }
  }

  async clearInstanceDraining(instanceId: string, rolloutId: string, attemptId: string): Promise<void> {
    await this.pool.query(
      `delete from instance_upgrade_drains where instance_id=$1 and rollout_id=$2 and attempt_id=$3`,
      [instanceId, rolloutId, attemptId],
    );
  }

  async isInstanceDraining(instanceId: string, at: string): Promise<boolean> {
    const result = await this.pool.query<{ draining: boolean }>(
      `select exists(
         select 1 from instance_upgrade_drains where instance_id=$1 and expires_at > $2
       ) as draining`,
      [instanceId, at],
    );
    return result.rows[0]?.draining === true;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const result = await this.pool.query<User>(
      `select id,email,role,created_at as "createdAt",app_initialized_at as "appInitializedAt"
       from users where email=$1`,
      [email.trim().toLowerCase()],
    );
    return result.rows[0] ?? null;
  }

  async findUserByIdentity(provider: AuthProviderId | "local", subject: string): Promise<User | null> {
    const result = await this.pool.query<User>(
      `select u.id,u.email,u.role,u.created_at as "createdAt",u.app_initialized_at as "appInitializedAt"
       from auth_identities i join users u on u.id=i.user_id where i.provider=$1 and i.subject=$2`,
      [provider, subject.trim()],
    );
    return result.rows[0] ?? null;
  }

  async findOrCreateUser(
    email: string,
    preferredId?: string,
    provider?: AuthProviderId | "local",
  ): Promise<User> {
    const normalizedEmail = email.trim().toLowerCase();
    const subject = preferredId?.trim() || normalizedEmail;
    const identityProvider = provider ?? this.#defaultAuthProvider;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const identity = await client.query<{ userId: string }>(
        `select user_id as "userId" from auth_identities where provider=$1 and subject=$2 for update`,
        [identityProvider, subject],
      );
      let userId = identity.rows[0]?.userId;
      if (!userId) {
        const user = await client.query<{ id: string }>(
          `insert into users(id,email,role) values($1,$2,'user')
           on conflict(email) do update set email=excluded.email returning id`,
          [randomUUID(), normalizedEmail],
        );
        userId = user.rows[0]!.id;
        await client.query(
          `insert into auth_identities(provider,subject,user_id,email_snapshot)
           values($1,$2,$3,$4) on conflict(provider,subject) do update
           set email_snapshot=excluded.email_snapshot,last_authenticated_at=now()`,
          [identityProvider, subject, userId, normalizedEmail],
        );
      } else {
        await client.query(
          `update auth_identities set email_snapshot=$3,last_authenticated_at=now()
           where provider=$1 and subject=$2`,
          [identityProvider, subject, normalizedEmail],
        );
      }
      const result = await client.query<User>(
        `select id,email,role,created_at as "createdAt",app_initialized_at as "appInitializedAt" from users where id=$1`,
        [userId],
      );
      await client.query("commit");
      return result.rows[0]!;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async createLocalUser(email: string, passwordHash: string): Promise<User | null> {
    const normalizedEmail = email.trim().toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<User>(
        `insert into users(id,email,role) values($1,$2,'user')
         on conflict(email) do nothing
         returning id,email,role,created_at as "createdAt",app_initialized_at as "appInitializedAt"`,
        [randomUUID(), normalizedEmail],
      );
      const user = result.rows[0];
      if (!user) {
        await client.query("rollback");
        return null;
      }
      await client.query(
        `insert into auth_identities(provider,subject,user_id,email_snapshot) values('local',$1,$2,$1)`,
        [normalizedEmail, user.id],
      );
      await client.query(`insert into local_credentials(user_id,password_hash) values($1,$2)`, [
        user.id,
        passwordHash,
      ]);
      await client.query("commit");
      return user;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async createManagedLocalUser(input: ManagedLocalUserCreateInput): Promise<User | null> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`select pg_advisory_xact_lock(hashtext('openapp:role-governance'))`);
      const actorResult = await client.query<User>(
        `select id,email,role,created_at as "createdAt",app_initialized_at as "appInitializedAt"
         from users where id=$1 for update`,
        [input.actorUserId],
      );
      const actor = actorResult.rows[0];
      assertCanCreateManagedUser(actor?.role, input.role);
      const result = await client.query<User>(
        `insert into users(id,email,role) values($1,$2,$3)
         on conflict(email) do nothing
         returning id,email,role,created_at as "createdAt",app_initialized_at as "appInitializedAt"`,
        [randomUUID(), normalizedEmail, input.role],
      );
      const user = result.rows[0];
      if (!user) {
        await client.query("rollback");
        return null;
      }
      await client.query(
        `insert into auth_identities(provider,subject,user_id,email_snapshot) values('local',$1,$2,$1)`,
        [normalizedEmail, user.id],
      );
      await client.query(`insert into local_credentials(user_id,password_hash) values($1,$2)`, [
        user.id,
        input.passwordHash,
      ]);
      await client.query(
        `insert into audit_events(id,actor_user_id,action,resource_type,resource_id,metadata)
         values($1,$2,'user.create','user',$3,$4)`,
        [
          randomUUID(),
          actor.id,
          user.id,
          JSON.stringify(
            redactSensitiveMetadata({
              actorRole: actor.role,
              email: user.email,
              role: user.role,
            }),
          ),
        ],
      );
      await client.query("commit");
      return user;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getLocalPasswordHash(userId: string): Promise<string | null> {
    const result = await this.pool.query<{ passwordHash: string }>(
      `select password_hash as "passwordHash" from local_credentials where user_id=$1`,
      [userId],
    );
    return result.rows[0]?.passwordHash ?? null;
  }

  async getAccountAuthState(userId: string): Promise<AccountAuthState> {
    const result = await this.pool.query<AccountAuthState>(
      `select exists(select 1 from local_credentials where user_id=$1) as "hasLocalCredential",
         array(select distinct provider from auth_identities where user_id=$1 and provider<>'local' order by provider) as "externalProviders"
       from users where id=$1`,
      [userId],
    );
    if (!result.rows[0]) throw new Error("user_not_found");
    return result.rows[0];
  }

  async createLocalPasswordHash(userId: string, passwordHash: string): Promise<boolean> {
    return this.#writeLocalPasswordHash(userId, passwordHash, null);
  }

  async replaceLocalPasswordHash(
    userId: string,
    expectedHash: string,
    passwordHash: string,
  ): Promise<boolean> {
    return this.#writeLocalPasswordHash(userId, passwordHash, expectedHash);
  }

  async listUsers(): Promise<User[]> {
    const result = await this.pool.query<User>(
      `select id, email, role, created_at as "createdAt", app_initialized_at as "appInitializedAt"
       from users order by created_at desc`,
    );
    return result.rows;
  }

  async changeUserRole(input: UserRoleChangeInput): Promise<User | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`select pg_advisory_xact_lock(hashtext('openapp:role-governance'))`);
      const actorResult = await client.query<User>(
        `select id,email,role,created_at as "createdAt",app_initialized_at as "appInitializedAt"
         from users where id=$1 for update`,
        [input.actorUserId],
      );
      const actor = actorResult.rows[0];
      assertCanGovernUserRoles(actor?.role);
      const targetResult = await client.query<User>(
        `select id,email,role,created_at as "createdAt",app_initialized_at as "appInitializedAt"
         from users where id=$1 for update`,
        [input.targetUserId],
      );
      const target = targetResult.rows[0];
      if (!target) {
        await client.query("commit");
        return null;
      }
      if (actor.id === target.id) throw new UserRoleUpdateError("self_role_change_forbidden");
      if (target.role !== input.expectedRole) throw new UserRoleUpdateError("role_change_conflict");
      if (target.role === input.role) {
        await client.query("commit");
        return target;
      }
      if (target.role === "super_admin" && input.role !== "super_admin") {
        const count = await client.query<{ count: string }>(
          `select count(*)::text as count from users where role='super_admin'`,
        );
        if (Number(count.rows[0]?.count ?? 0) <= 1) {
          throw new UserRoleUpdateError("last_super_admin_cannot_be_demoted");
        }
      }
      if (input.role !== "user") {
        const credential = await client.query(`select 1 from local_credentials where user_id=$1 for update`, [
          target.id,
        ]);
        if (credential.rowCount && input.passwordHash)
          throw new UserRoleUpdateError("credential_update_conflict");
        if (!credential.rowCount) {
          if (!input.passwordHash) throw new UserRoleUpdateError("local_credentials_required");
          await client.query(`insert into local_credentials(user_id,password_hash) values($1,$2)`, [
            target.id,
            input.passwordHash,
          ]);
          const identity = await client.query(
            `insert into auth_identities(provider,subject,user_id,email_snapshot)
             values('local',$1,$2,$1) on conflict(provider,subject) do update
             set email_snapshot=excluded.email_snapshot,last_authenticated_at=now()
             where auth_identities.user_id=excluded.user_id returning user_id`,
            [target.email, target.id],
          );
          if (identity.rowCount !== 1) throw new UserRoleUpdateError("credential_update_conflict");
          await client.query(`delete from sessions where user_id=$1`, [target.id]);
        }
      }
      const updatedResult = await client.query<User>(
        `update users set role=$2 where id=$1
         returning id,email,role,created_at as "createdAt",app_initialized_at as "appInitializedAt"`,
        [target.id, input.role],
      );
      const updated = updatedResult.rows[0]!;
      await client.query(
        `insert into audit_events(id,actor_user_id,action,resource_type,resource_id,metadata)
         values($1,$2,'user.role.change','user',$3,$4)`,
        [
          randomUUID(),
          actor.id,
          target.id,
          JSON.stringify(
            redactSensitiveMetadata({
              actorRole: actor.role,
              afterRole: updated.role,
              beforeRole: target.role,
            }),
          ),
        ],
      );
      await client.query("commit");
      return updated;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveSession(
    tokenHash: string,
    userId: string,
    expiresAt: Date,
    authMethod: AuthMethod,
  ): Promise<void> {
    await this.pool.query(
      `insert into sessions(token_hash, user_id, expires_at, auth_method) values($1, $2, $3, $4)`,
      [tokenHash, userId, expiresAt, authMethod],
    );
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query(`delete from sessions where token_hash = $1`, [tokenHash]);
  }

  async sessionUser(tokenHash: string): Promise<AuthenticatedUser | null> {
    const result = await this.pool.query<AuthenticatedUser>(
      `select u.id, u.email, u.role, u.created_at as "createdAt", u.app_initialized_at as "appInitializedAt",
         s.auth_method as "authMethod",
         not exists(select 1 from local_credentials c where c.user_id=u.id) as "passwordSetupRequired",
         array(select distinct provider from auth_identities i where i.user_id=u.id and provider<>'local' order by provider) as "linkedProviders"
       from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()`,
      [tokenHash],
    );
    return result.rows[0] ?? null;
  }

  async ensurePersonalTenant(userId: string): Promise<{ tenant: Tenant; membership: TenantMembership }> {
    const client = await this.pool.connect();
    const tenantId = personalTenantId(userId);
    try {
      await client.query("begin");
      const user = await client.query<{ id: string; email: string }>(
        `select id,email from users where id=$1 for update`,
        [userId],
      );
      if (!user.rows[0]) throw new Error("user_not_found");
      await client.query(
        `insert into tenants(id,kind,name) values($1,'personal',$2)
         on conflict(id) do update set name=excluded.name,updated_at=now()`,
        [tenantId, user.rows[0].email],
      );
      await client.query(
        `insert into tenant_memberships(tenant_id,user_id,role) values($1,$2,'owner')
         on conflict(tenant_id,user_id) do nothing`,
        [tenantId, userId],
      );
      const result = await client.query<
        TenantRow & {
          tenantId: string;
          userId: string;
          membershipRole: TenantMembership["role"];
          membershipCreatedAt: Date | string;
          membershipUpdatedAt: Date | string;
        }
      >(
        `select t.id,t.kind,t.name,t.created_at as "createdAt",t.updated_at as "updatedAt",
           m.tenant_id as "tenantId",m.user_id as "userId",m.role as "membershipRole",
           m.created_at as "membershipCreatedAt",m.updated_at as "membershipUpdatedAt"
         from tenants t join tenant_memberships m on m.tenant_id=t.id
         where t.id=$1 and m.user_id=$2`,
        [tenantId, userId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("tenant_membership_missing");
      await client.query("commit");
      return {
        tenant: mapTenant(row),
        membership: mapTenantMembership(row),
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listTenantMemberships(
    userId: string,
  ): Promise<Array<{ tenant: Tenant; membership: TenantMembership }>> {
    const result = await this.pool.query<
      TenantRow & {
        tenantId: string;
        userId: string;
        membershipRole: TenantMembership["role"];
        membershipCreatedAt: Date | string;
        membershipUpdatedAt: Date | string;
      }
    >(
      `select t.id,t.kind,t.name,t.created_at as "createdAt",t.updated_at as "updatedAt",
         m.tenant_id as "tenantId",m.user_id as "userId",m.role as "membershipRole",
         m.created_at as "membershipCreatedAt",m.updated_at as "membershipUpdatedAt"
       from tenants t join tenant_memberships m on m.tenant_id=t.id
       where m.user_id=$1 order by t.created_at`,
      [userId],
    );
    return result.rows.map((row) => ({ tenant: mapTenant(row), membership: mapTenantMembership(row) }));
  }

  async getWorkspaceTenantBinding(workspaceId: string): Promise<WorkspaceTenantBinding | null> {
    const result = await this.pool.query<WorkspaceTenantBindingRow>(
      `select workspace_id as "workspaceId",tenant_id as "tenantId",owner_id as "ownerId",
         created_at as "createdAt",updated_at as "updatedAt"
       from workspace_tenant_bindings where workspace_id=$1`,
      [workspaceId],
    );
    return result.rows[0] ? mapWorkspaceTenantBinding(result.rows[0]) : null;
  }

  async bindWorkspaceToTenant(
    workspaceId: string,
    tenantId: string,
    ownerId: string,
  ): Promise<WorkspaceTenantBinding | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const workspace = await client.query<{ userId: string; status: string }>(
        `select user_id as "userId",workspace_status as status from containers where id=$1 for update`,
        [workspaceId],
      );
      const member = await client.query<{ role: TenantMembership["role"] }>(
        `select role from tenant_memberships where tenant_id=$1 and user_id=$2`,
        [tenantId, ownerId],
      );
      if (
        !workspace.rows[0] ||
        workspace.rows[0].status === "deleted" ||
        workspace.rows[0].userId !== ownerId ||
        !member.rows[0] ||
        (member.rows[0].role !== "owner" && member.rows[0].role !== "admin")
      ) {
        await client.query("rollback");
        return null;
      }
      const existing = await client.query<WorkspaceTenantBindingRow>(
        `select workspace_id as "workspaceId",tenant_id as "tenantId",owner_id as "ownerId",
           created_at as "createdAt",updated_at as "updatedAt"
         from workspace_tenant_bindings where workspace_id=$1 for update`,
        [workspaceId],
      );
      if (
        existing.rows[0] &&
        (existing.rows[0].tenantId !== tenantId || existing.rows[0].ownerId !== ownerId)
      ) {
        await client.query("rollback");
        return null;
      }
      const result = await client.query<WorkspaceTenantBindingRow>(
        `insert into workspace_tenant_bindings(workspace_id,tenant_id,owner_id)
         values($1,$2,$3)
         on conflict(workspace_id) do update set updated_at=now()
         returning workspace_id as "workspaceId",tenant_id as "tenantId",owner_id as "ownerId",
           created_at as "createdAt",updated_at as "updatedAt"`,
        [workspaceId, tenantId, ownerId],
      );
      await client.query("commit");
      return result.rows[0] ? mapWorkspaceTenantBinding(result.rows[0]) : null;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getContainerForUser(userId: string): Promise<Container | null> {
    const result = await this.pool.query<ContainerRow>(
      containerSelect("where user_id = $1 and workspace_status='active' order by updated_at desc limit 1"),
      [userId],
    );
    return result.rows[0] ? mapContainer(result.rows[0]) : null;
  }

  async getContainer(id: string): Promise<Container | null> {
    const result = await this.pool.query<ContainerRow>(
      containerSelect("where id = $1 and workspace_status='active'"),
      [id],
    );
    return result.rows[0] ? mapContainer(result.rows[0]) : null;
  }

  async listContainers(userId?: string): Promise<Container[]> {
    const result = await this.pool.query<ContainerRow>(
      containerSelect(
        userId
          ? "where user_id = $1 and workspace_status='active' order by updated_at desc"
          : "where workspace_status='active' order by updated_at desc",
      ),
      userId ? [userId] : [],
    );
    return result.rows.map(mapContainer);
  }

  async saveContainer(container: Container): Promise<void> {
    const projection = projectContainerToWorkspaceExecution(container);
    const result = await this.pool.query(
      `insert into containers(
         id,user_id,app_id,app_version_id,image_artifact_id,image_reference,runtime_id,status,endpoint,stop_reason,
         created_at,updated_at,last_activity_at,workspace_status,storage_ref_id,active_execution_id,provider_id,
         environment_ref,execution_role,desired_generation,deployed_generation,healthy_generation,transaction_id,
         transaction_status,desired_state,observed_state,desired_app_revision_id,
         desired_launch_artifact_id,desired_launch_artifact_reference,execution_revision,
         execution_image_artifact_id,execution_image_reference,execution_endpoint,execution_model_version,
         deletion_transaction_id,deletion_phase,deletion_failure,deleted_at
       )
       values(${numberedSqlValues(38)})
       on conflict(id) do update set runtime_id = excluded.runtime_id, status = excluded.status,
         app_id = excluded.app_id, app_version_id = excluded.app_version_id,
         image_artifact_id = excluded.image_artifact_id, image_reference = excluded.image_reference,
         endpoint = excluded.endpoint, stop_reason = excluded.stop_reason, updated_at = excluded.updated_at,
         last_activity_at = greatest(containers.last_activity_at, excluded.last_activity_at),
         workspace_status=excluded.workspace_status,storage_ref_id=excluded.storage_ref_id,
         active_execution_id=excluded.active_execution_id,provider_id=excluded.provider_id,
         environment_ref=excluded.environment_ref,execution_role=excluded.execution_role,
         desired_generation=excluded.desired_generation,deployed_generation=excluded.deployed_generation,
         healthy_generation=excluded.healthy_generation,transaction_id=excluded.transaction_id,
         transaction_status=excluded.transaction_status,desired_state=excluded.desired_state,
         observed_state=excluded.observed_state,desired_app_revision_id=excluded.desired_app_revision_id,
         desired_launch_artifact_id=excluded.desired_launch_artifact_id,
         desired_launch_artifact_reference=excluded.desired_launch_artifact_reference,
         execution_revision=excluded.execution_revision,
         execution_image_artifact_id=excluded.execution_image_artifact_id,
         execution_image_reference=excluded.execution_image_reference,execution_endpoint=excluded.execution_endpoint,
         execution_model_version=excluded.execution_model_version,
         deletion_transaction_id=excluded.deletion_transaction_id,
         deletion_phase=excluded.deletion_phase,deletion_failure=excluded.deletion_failure,
         deleted_at=excluded.deleted_at
       where containers.execution_revision=1 and containers.workspace_status='active'
       returning id`,
      containerWriteValues(container, projection),
    );
    if (result.rowCount !== 1) throw new WorkspaceExecutionCasRequiredError();
  }

  async updateContainer(container: Container): Promise<void> {
    const projection = projectContainerToWorkspaceExecution(container);
    const result = await this.pool.query(
      `update containers set app_id = $2, app_version_id = $3, image_artifact_id = $4,
         image_reference = $5, runtime_id = $6, status = $7, endpoint = $8, stop_reason = $9, updated_at = $10,
         last_activity_at = greatest(last_activity_at, $11),workspace_status=$12,storage_ref_id=$13,
         active_execution_id=$14,provider_id=$15,environment_ref=$16,execution_role=$17,
         desired_generation=$18,deployed_generation=$19,healthy_generation=$20,transaction_id=$21,
         transaction_status=$22,desired_state=$23,observed_state=$24,desired_app_revision_id=$25,
         desired_launch_artifact_id=$26,desired_launch_artifact_reference=$27,execution_revision=$28,
         execution_image_artifact_id=$29,execution_image_reference=$30,execution_endpoint=$31,
         execution_model_version=$32,deletion_transaction_id=$33,deletion_phase=$34,
         deletion_failure=$35,deleted_at=$36
       where id = $1 and execution_revision=1 and workspace_status='active' returning id`,
      [
        container.id,
        container.appId,
        container.appVersionId ?? null,
        container.imageArtifactId ?? null,
        container.imageReference ?? null,
        container.runtimeId,
        container.status,
        container.endpoint,
        container.stopReason,
        container.updatedAt,
        container.lastActivityAt,
        ...workspaceExecutionUpdateValues(projection),
      ],
    );
    if (result.rowCount !== 1 && (await this.getWorkspaceExecutionProjection(container.id))) {
      throw new WorkspaceExecutionCasRequiredError();
    }
  }

  async getWorkspaceExecutionProjection(id: string): Promise<WorkspaceExecutionProjection | null> {
    const result = await this.pool.query<ContainerRow>(containerSelect("where id = $1"), [id]);
    return result.rows[0] ? mapWorkspaceExecutionProjection(result.rows[0]) : null;
  }

  async getLiveWorkspaceExecutionForUser(userId: string): Promise<WorkspaceExecutionProjection | null> {
    const result = await this.pool.query<ContainerRow>(
      containerSelect("where user_id=$1 and workspace_status<>'deleted' order by updated_at desc limit 1"),
      [userId],
    );
    return result.rows[0] ? mapWorkspaceExecutionProjection(result.rows[0]) : null;
  }

  async compareAndSaveWorkspaceExecution(
    projection: WorkspaceExecutionProjection,
    expectedRevision: number,
  ): Promise<WorkspaceExecutionProjection | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<ContainerRow>(containerSelect("where id = $1 for update"), [
        projection.workspace.id,
      ]);
      if (!selected.rows[0]) {
        await client.query("rollback");
        return null;
      }
      const current = mapWorkspaceExecutionProjection(selected.rows[0]);
      if (current.execution.revision !== expectedRevision) {
        await client.query("rollback");
        return null;
      }
      assertWorkspaceExecutionTransition(current, projection);
      const updated = structuredClone(projection);
      updated.execution.revision = expectedRevision + 1;
      const container = projectWorkspaceExecutionToContainer(updated);
      const result = await client.query<ContainerRow>(
        `update containers set
           user_id=$2,app_id=$3,app_version_id=$4,image_artifact_id=$5,image_reference=$6,
           runtime_id=$7,status=$8,endpoint=$9,stop_reason=$10,created_at=$11,updated_at=$12,
           last_activity_at=greatest(last_activity_at,$13),workspace_status=$14,storage_ref_id=$15,
           active_execution_id=$16,provider_id=$17,environment_ref=$18,execution_role=$19,
           desired_generation=$20,deployed_generation=$21,healthy_generation=$22,transaction_id=$23,
           transaction_status=$24,desired_state=$25,observed_state=$26,desired_app_revision_id=$27,
           desired_launch_artifact_id=$28,desired_launch_artifact_reference=$29,execution_revision=$30,
           execution_image_artifact_id=$31,execution_image_reference=$32,execution_endpoint=$33,
           execution_model_version=$34,deletion_transaction_id=$35,deletion_phase=$36,
           deletion_failure=$37,deleted_at=$38
         where id=$1 and execution_revision=$39
         returning ${containerColumns()}`,
        [...containerWriteValues(container, updated), expectedRevision],
      );
      if (!result.rows[0]) {
        await client.query("rollback");
        return null;
      }
      await client.query("commit");
      return mapWorkspaceExecutionProjection(result.rows[0]);
    } catch (error) {
      return rollbackTransactionAndRethrow(client, error);
    } finally {
      client.release();
    }
  }

  async countLiveWorkspaceStorageReferences(
    storageRefId: string,
    excludingWorkspaceId: string,
  ): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `select count(*)::text as count from containers
       where storage_ref_id=$1 and id<>$2 and workspace_status<>'deleted'`,
      [storageRefId, excludingWorkspaceId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async deleteContainer(id: string): Promise<void> {
    await this.pool.query(`delete from containers where id = $1`, [id]);
  }

  #policyFallbackFor(value: unknown): ProvisioningPolicy {
    if (this.#provisioningPolicyFallback) return this.#provisioningPolicyFallback;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("provisioning_policy_default_app_required");
    }
    const defaultAppId = (value as Record<string, unknown>).defaultAppId;
    if (typeof defaultAppId !== "string" || !defaultAppId.trim()) {
      throw new Error("provisioning_policy_default_app_required");
    }
    // 已有通用数据库可能缺少新字段；基线只按持久化的 App ID 补全，
    // 绝不回退到某个产品的旧策略。
    return genericProvisioningPolicy(defaultAppId);
  }

  async #writeConfigRevision(
    client: pg.PoolClient,
    key: string,
    input: ConfigRevisionInput,
  ): Promise<ConfigRevision> {
    const result = await client.query<ConfigRevisionRow>(
      `insert into config_revisions(key, revision, updated_by, effect, effective_at)
       select $1, 1, $2, $3, $4
       where $5::bigint is null or $5::bigint=0
          or exists(select 1 from config_revisions where key=$1)
       on conflict(key) do update set revision=config_revisions.revision + 1,
         updated_by=excluded.updated_by, effect=excluded.effect,
         effective_at=excluded.effective_at, updated_at=now()
       where $5::bigint is null or config_revisions.revision=$5::bigint
       returning key, revision::text as revision, updated_by as "updatedBy", effect,
         effective_at as "effectiveAt", updated_at as "updatedAt"`,
      [
        key,
        input.updatedBy?.trim() || "system",
        input.effect ?? "immediate",
        input.effectiveAt === undefined ? new Date() : input.effectiveAt,
        input.expectedRevision ?? null,
      ],
    );
    const revision = result.rows[0] ? mapConfigRevision(result.rows[0]) : null;
    if (!revision) throw new ConfigRevisionConflictError();
    await client.query(
      `insert into config_revision_history(
         key,revision,updated_by,effect,effective_at,payload,created_at
       ) values($1,$2,$3,$4,$5,$6,$7)`,
      [
        revision.key,
        revision.revision,
        revision.updatedBy,
        revision.effect,
        revision.effectiveAt,
        JSON.stringify(input.payload ?? null),
        revision.updatedAt,
      ],
    );
    return revision;
  }

  async #pruneMonitoringIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastMonitoringPruneAt < 15 * 60_000) return;
    this.#lastMonitoringPruneAt = now;
    await this.pool.query(`delete from runtime_samples where sampled_at < now() - interval '72 hours'`);
    await this.pool.query(`delete from health_checks where checked_at < now() - interval '7 days'`);
    await this.pool.query(`delete from audit_events where created_at < now() - interval '180 days'`);
  }

  async #lockBuildPackages(
    client: pg.PoolClient,
    packageIds: readonly string[],
    requireExisting: boolean,
  ): Promise<void> {
    const ids = [...new Set(packageIds)].sort();
    for (const id of ids) {
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`openapp:build-package:${id}`]);
    }
    if (!requireExisting || ids.length === 0) return;
    const existing = await client.query<{ id: string }>(
      `select id from build_packages where id=any($1::text[])`,
      [ids],
    );
    if (existing.rowCount !== ids.length) throw new Error("build_package_not_found");
  }

  async #withAdvisoryLock<T>(pool: pg.Pool, key: string, operation: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`select pg_advisory_lock(hashtext($1))`, [key]);
      return await operation();
    } finally {
      try {
        await client.query(`select pg_advisory_unlock(hashtext($1))`, [key]);
      } finally {
        client.release();
      }
    }
  }

  async #writeLocalPasswordHash(
    userId: string,
    passwordHash: string,
    expectedHash: string | null,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const user = await client.query<{ email: string }>(`select email from users where id=$1 for update`, [
        userId,
      ]);
      if (!user.rows[0]) throw new Error("user_not_found");
      const credential = await client.query(`select 1 from local_credentials where user_id=$1 for update`, [
        userId,
      ]);
      if (Boolean(credential.rowCount) !== (expectedHash !== null)) {
        await client.query("rollback");
        return false;
      }
      if (expectedHash !== null) {
        const updated = await client.query(
          `update local_credentials set password_hash=$3,password_changed_at=now()
           where user_id=$1 and password_hash=$2 returning user_id`,
          [userId, expectedHash, passwordHash],
        );
        if (updated.rowCount !== 1) {
          await client.query("rollback");
          return false;
        }
      } else {
        await client.query(`insert into local_credentials(user_id,password_hash) values($1,$2)`, [
          userId,
          passwordHash,
        ]);
      }
      const identity = await client.query(
        `insert into auth_identities(provider,subject,user_id,email_snapshot)
         values('local',$1,$2,$1) on conflict(provider,subject) do update
         set email_snapshot=excluded.email_snapshot,last_authenticated_at=now()
         where auth_identities.user_id=excluded.user_id returning user_id`,
        [user.rows[0].email, userId],
      );
      if (identity.rowCount !== 1) throw new Error("local_identity_conflict");
      await client.query(`delete from sessions where user_id=$1`, [userId]);
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
