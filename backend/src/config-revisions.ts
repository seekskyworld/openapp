import {
  normalizeProvisioningPolicyWithFallback,
  provisioningPolicyEffect,
  type ProvisioningPolicy,
} from "./instance-policy.js";
import type {
  ConfigEffect,
  ConfigRevision,
  ConfigRevisionSnapshot,
  ForwardingPolicy,
} from "./models.js";
import type { AdminStore } from "./stores-contracts.js";
import type { ForwardingPolicyManager } from "./forwarding-policy.js";

export type ConfigRevisionKind = "instance-policy" | "forwarding";

export interface ConfigRevisionHistory {
  key: string;
  current: ConfigRevision | null;
  revisions: ConfigRevisionSnapshot[];
}

export interface InstancePolicyRollbackResult {
  kind: "instance-policy";
  policy: ProvisioningPolicy;
  revision: ConfigRevision;
  effect: ConfigEffect;
  rolledBackFrom: number;
}

export interface ForwardingPolicyRollbackResult {
  kind: "forwarding";
  forwarding: ForwardingPolicy;
  revision: ConfigRevision;
  effect: "immediate";
  rolledBackFrom: number;
}

export type ConfigRollbackResult = InstancePolicyRollbackResult | ForwardingPolicyRollbackResult;

export class ConfigRevisionServiceError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

/** Owns revision history reads and append-only rollback semantics for admin settings. */
export class ConfigRevisionService {
  readonly #admin: AdminStore;
  readonly #forwarding: ForwardingPolicyManager;
  readonly #supportsApp: (appId: string) => boolean | Promise<boolean>;
  readonly #validateInstancePolicy?: (policy: ProvisioningPolicy) => void | Promise<void>;

  constructor(options: {
    admin: AdminStore;
    forwarding: ForwardingPolicyManager;
    supportsApp: (appId: string) => boolean | Promise<boolean>;
    validateInstancePolicy?: (policy: ProvisioningPolicy) => void | Promise<void>;
  }) {
    this.#admin = options.admin;
    this.#forwarding = options.forwarding;
    this.#supportsApp = options.supportsApp;
    this.#validateInstancePolicy = options.validateInstancePolicy;
  }

  async history(kind: ConfigRevisionKind, limit = 50): Promise<ConfigRevisionHistory> {
    const key = revisionKey(kind);
    const [current, revisions] = await Promise.all([
      this.#admin.getConfigRevision(key),
      this.#admin.listConfigRevisions(key, limit),
    ]);
    return { key, current, revisions: revisions.map((snapshot) => ({ ...snapshot, payload: publicSnapshotPayload(kind, snapshot.payload) })) };
  }

  async rollback(
    kind: ConfigRevisionKind,
    targetRevision: number,
    actorUserId: string,
    expectedRevision?: number,
  ): Promise<ConfigRollbackResult> {
    if (!Number.isSafeInteger(targetRevision) || targetRevision < 1) {
      throw new ConfigRevisionServiceError("invalid_target_revision");
    }
    return this.#admin.withReleaseActivationLock(async () => {
      const key = revisionKey(kind);
      const snapshot = await this.#admin.getConfigRevisionSnapshot(key, targetRevision);
      if (!snapshot) throw new ConfigRevisionServiceError("config_revision_not_found", 404);
      const current = await this.#admin.getConfigRevision(key);
      const expected = expectedRevision ?? current?.revision ?? 0;
      if (kind === "instance-policy") {
        return this.#rollbackInstancePolicy(snapshot, actorUserId, expected);
      }
      return this.#rollbackForwarding(snapshot, actorUserId, expected);
    });
  }

  async #rollbackInstancePolicy(
    snapshot: ConfigRevisionSnapshot,
    actorUserId: string,
    expectedRevision: number,
  ): Promise<InstancePolicyRollbackResult> {
    if (!snapshot.payload || typeof snapshot.payload !== "object" || Array.isArray(snapshot.payload)) {
      throw new ConfigRevisionServiceError("invalid_instance_policy_snapshot");
    }
    const previous = await this.#admin.getProvisioningPolicy();
    // 历史快照可能缺少后来新增的字段；以当前已验证策略作为补全基线，
    // 避免全局兼容默认值把回滚目标悄悄改成某个产品。
    const policy = normalizeProvisioningPolicyWithFallback(snapshot.payload, previous);
    if (!await this.#supportsApp(policy.defaultAppId)) {
      throw new ConfigRevisionServiceError("unsupported_default_app");
    }
    await this.#validateInstancePolicy?.(policy);
    const effect = provisioningPolicyEffect(previous, policy);
    await this.#admin.saveProvisioningPolicy(policy, {
      expectedRevision,
      updatedBy: actorUserId,
      effect,
      effectiveAt: effect === "immediate" ? new Date().toISOString() : null,
      payload: policy,
    });
    const revision = await this.#admin.getConfigRevision("instance-policy");
    if (!revision) throw new ConfigRevisionServiceError("config_revision_missing", 500);
    await this.#admin.recordAudit(actorUserId, "instance-policy.rollback", "policy", "default", {
      rolledBackFrom: snapshot.revision,
      revision: revision.revision,
      effect,
    });
    return { kind: "instance-policy", policy, revision, effect, rolledBackFrom: snapshot.revision };
  }

  async #rollbackForwarding(
    snapshot: ConfigRevisionSnapshot,
    actorUserId: string,
    expectedRevision: number,
  ): Promise<ForwardingPolicyRollbackResult> {
    const payload = forwardingPayload(snapshot.payload);
    const forwarding = await this.#forwarding.update(payload, actorUserId, expectedRevision);
    const revision = await this.#admin.getConfigRevision("forwarding:default");
    if (!revision) throw new ConfigRevisionServiceError("config_revision_missing", 500);
    await this.#admin.recordAudit(actorUserId, "forwarding.rollback", "forwarding", "default", {
      rolledBackFrom: snapshot.revision,
      revision: revision.revision,
    });
    return {
      kind: "forwarding",
      forwarding,
      revision,
      effect: "immediate",
      rolledBackFrom: snapshot.revision,
    };
  }
}

export function revisionKey(kind: ConfigRevisionKind): string {
  return kind === "forwarding" ? "forwarding:default" : "instance-policy";
}

function forwardingPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigRevisionServiceError("invalid_forwarding_snapshot");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.targetBaseUrl !== "string"
    || typeof record.enabled !== "boolean"
    || !Array.isArray(record.allowedHosts)
    || record.allowedHosts.some((host) => typeof host !== "string")
  ) {
    throw new ConfigRevisionServiceError("invalid_forwarding_snapshot");
  }
  return {
    targetBaseUrl: record.targetBaseUrl,
    enabled: record.enabled,
    allowedHosts: [...record.allowedHosts],
  };
}

/** History is an admin-facing view; do not send environment/config-file values to browsers. */
function publicSnapshotPayload(kind: ConfigRevisionKind, value: unknown): unknown {
  if (kind === "forwarding") return forwardingPayload(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const resources = source.resources && typeof source.resources === "object" && !Array.isArray(source.resources)
    ? source.resources as Record<string, unknown>
    : {};
  return {
    autoCreateOnFirstVisit: source.autoCreateOnFirstVisit,
    defaultAppId: source.defaultAppId,
    autoStartOnEnter: source.autoStartOnEnter,
    autoWakeOnRequest: source.autoWakeOnRequest,
    blockAutoWakeAfterManualStop: source.blockAutoWakeAfterManualStop,
    idleStopMinutes: source.idleStopMinutes,
    detectNetworkActivity: source.detectNetworkActivity,
    detectComputeActivity: source.detectComputeActivity,
    maxTotalInstances: source.maxTotalInstances,
    maxRunningInstances: source.maxRunningInstances,
    resources: {
      memory: resources.memory,
      cpus: resources.cpus,
      pidsLimit: resources.pidsLimit,
    },
  };
}
