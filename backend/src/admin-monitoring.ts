import { randomUUID } from "node:crypto";
import { DEFAULT_GENERIC_PROVISIONING_POLICY, type ProvisioningPolicy } from "./instance-policy.js";
import type { AdminStore } from "./stores-contracts.js";
import type { Container, ForwardingPolicy } from "./models.js";
import type { ContainerActivityMetrics } from "./runtime.js";
import type { ProviderHealthPort, ProviderMetricsPort } from "./execution-provider.js";
import { readProviderHealthStatus, readProviderMetrics } from "./provider-observability.js";
import type {
  AdminDashboard,
  AdminDashboardAlert,
  AdminInstanceDetails,
  AdminInstanceMetrics,
  AdminMonitorInstance,
  AdminResourceMetrics,
  AuditEvent,
  AuditEventFilter,
  HealthCheck,
  RuntimeSample,
} from "./monitoring-types.js";
import { redactSensitiveMetadata, sanitizeSensitiveText } from "./sensitive-data.js";

const DEFAULT_SAMPLE_INTERVAL_MS = 20_000;
const DEFAULT_STALE_AFTER_MS = 60_000;
const DEFAULT_HISTORY_LIMIT = 60;
const MAX_HISTORY_LIMIT = 500;
const MAX_INSTANCE_LIST_LIMIT = 10_000;
const SAMPLE_CONCURRENCY = 4;

export interface AdminMonitoringOptions {
  admin: AdminStore;
  metrics: ProviderMetricsPort;
  health: ProviderHealthPort;
  providerId: string;
  healthProviders?: ReadonlyArray<{ providerId: string; health: ProviderHealthPort }>;
  forwarding?: () => Promise<ForwardingPolicy>;
  now?: () => Date;
  sampleIntervalMs?: number;
  staleAfterMs?: number;
}

export interface MonitoringSweepResult {
  checked: number;
  sampled: number;
  unsupported: number;
  errors: number;
  sampledAt: string;
}

/**
 * Runtime observability owned by the control plane. It deliberately keeps the
 * HTTP layer out of this class so CLI, SSE and REST consumers share one view.
 * Persistence is optional: a short in-memory history keeps local development
 * useful when PostgreSQL has not been configured yet.
 */
export class AdminMonitoring {
  readonly #admin: AdminStore;
  readonly #metrics: ProviderMetricsPort;
  readonly #providerId: string;
  readonly #healthProviders: ReadonlyArray<{ providerId: string; health: ProviderHealthPort }>;
  readonly #forwarding?: () => Promise<ForwardingPolicy>;
  readonly #now: () => Date;
  readonly #sampleIntervalMs: number;
  readonly #staleAfterMs: number;
  readonly #samples = new Map<string, RuntimeSample[]>();
  readonly #healthChecks = new Map<string, HealthCheck[]>();
  #samplingPromise: Promise<MonitoringSweepResult> | undefined;
  readonly #instanceSampling = new Map<string, Promise<RuntimeSample>>();
  #timer: NodeJS.Timeout | undefined;
  #persistenceDegraded = false;
  readonly #providerHealth = new Map<string, { check: HealthCheck; checkedAt: number }>();

  constructor(options: AdminMonitoringOptions) {
    this.#admin = options.admin;
    this.#metrics = options.metrics;
    this.#providerId = options.providerId;
    this.#healthProviders = normalizeHealthProviders(options.healthProviders ?? [{
      providerId: options.providerId,
      health: options.health,
    }]);
    this.#forwarding = options.forwarding;
    this.#now = options.now ?? (() => new Date());
    this.#sampleIntervalMs = normalizeDuration(options.sampleIntervalMs, DEFAULT_SAMPLE_INTERVAL_MS);
    this.#staleAfterMs = normalizeDuration(options.staleAfterMs, Math.max(DEFAULT_STALE_AFTER_MS, this.#sampleIntervalMs * 3));
  }

  get sampleIntervalMs(): number {
    return this.#sampleIntervalMs;
  }

  get staleAfterMs(): number {
    return this.#staleAfterMs;
  }

  /** Starts best-effort sampling. The timer is unref'd so CLI/tests can exit. */
  start(): void {
    if (this.#timer) return;
    this.sampleRunningContainers().catch(() => undefined);
    this.#timer = setInterval(() => {
      this.sampleRunningContainers().catch(() => undefined);
    }, this.#sampleIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async sampleRunningContainers(): Promise<MonitoringSweepResult> {
    if (this.#samplingPromise) return this.#samplingPromise;
    const skippedAt = this.#now().toISOString();
    const sampling = this.#admin.withMaintenanceLease("runtime-sampling", () => this.#sampleRunningContainers())
      .then((result) => result ?? { checked: 0, sampled: 0, unsupported: 0, errors: 0, sampledAt: skippedAt });
    this.#samplingPromise = sampling;
    try {
      return await sampling;
    } finally {
      if (this.#samplingPromise === sampling) this.#samplingPromise = undefined;
    }
  }

  async #sampleRunningContainers(): Promise<MonitoringSweepResult> {
    const sampledAt = this.#now().toISOString();
    const containers = await this.#admin.listContainers();
    const currentInstanceIds = new Set(containers.map((container) => container.id));
    for (const instanceId of this.#samples.keys()) {
      if (!currentInstanceIds.has(instanceId)) this.#samples.delete(instanceId);
    }
    const running = containers.filter((container) => container.status === "running");
    let sampled = 0;
    let unsupported = 0;
    let errors = 0;
    await forEachConcurrent(running, SAMPLE_CONCURRENCY, async (container) => {
      try {
        // The sweep already holds the distributed process-wide lease. Avoid
        // taking a second PostgreSQL lease per worker so sampling can remain
        // concurrent instead of serializing behind a tiny connection pool.
        const result = await this.#sampleOne(container.id, false);
        if (result.capabilityStatus === "unsupported") unsupported += 1;
        else if (result.error) errors += 1;
        else sampled += 1;
      } catch {
        errors += 1;
      }
    });
    return { checked: running.length, sampled, unsupported, errors, sampledAt };
  }

  async sampleInstance(instanceId: string): Promise<RuntimeSample> {
    return this.#sampleOne(instanceId, true);
  }

  async #sampleOne(instanceId: string, withLease: boolean): Promise<RuntimeSample> {
    const existing = this.#instanceSampling.get(instanceId);
    if (existing) return existing;
    const sampling = (withLease
      ? this.#admin.withMaintenanceLease(`runtime-sampling:${instanceId}`, () => this.#sampleInstanceUnleased(instanceId))
      : this.#sampleInstanceUnleased(instanceId)
    ).then((result) => {
      if (!result) throw new MonitoringError("sampling_busy", 409);
      return result;
    });
    this.#instanceSampling.set(instanceId, sampling);
    try {
      return await sampling;
    } finally {
      if (this.#instanceSampling.get(instanceId) === sampling) this.#instanceSampling.delete(instanceId);
    }
  }

  async #sampleInstanceUnleased(instanceId: string): Promise<RuntimeSample> {
    const container = await this.#admin.getContainer(instanceId);
    if (!container) throw new MonitoringError("container_not_found", 404);
    const sampledAt = this.#now().toISOString();
    let sample: RuntimeSample;
    if (container.status !== "running") {
      sample = emptySample(container, sampledAt, null);
    } else {
      try {
        const result = await readProviderMetrics(this.#metrics, instanceId);
        if (result.status === "unsupported") {
          sample = emptySample(container, sampledAt, "provider_metrics_unsupported", "unsupported");
        } else if (result.status === "unavailable") {
          sample = emptySample(container, sampledAt, safeError(result.error), "unavailable");
        } else {
          validateMetrics(result.value);
          sample = metricsSample(container, sampledAt, result.value);
        }
      } catch (error) {
        sample = emptySample(container, sampledAt, safeError(error), "unavailable");
      }
    }
    await this.#rememberSample(sample);
    return sample;
  }

  async instanceMetrics(instanceId: string, limit = DEFAULT_HISTORY_LIMIT): Promise<AdminInstanceMetrics> {
    let instance: Container | null;
    try {
      instance = await this.#admin.getContainer(instanceId);
    } catch {
      this.#persistenceDegraded = true;
      throw new MonitoringError("persistence_unavailable", 503);
    }
    if (!instance) throw new MonitoringError("container_not_found", 404);
    // A detail view asks for one fresh point. A dashboard list uses the
    // background sampler and therefore does not fan out runtime calls.
    const latest = instance.status === "running" ? await this.sampleInstance(instanceId) : null;
    const samples = await this.#listSamples(instanceId, limit);
    const current = instance.status === "running" ? latest ?? samples[0] ?? null : null;
    return {
      instance: instanceDetails(instance),
      latest: current,
      samples,
      stale: instance.status === "running" && this.#isStale(current?.sampledAt),
    };
  }

  async listInstances(options: {
    status?: string;
    userId?: string;
    appId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AdminMonitorInstance[]> {
    const normalizedSearch = options.search?.trim().toLowerCase();
    let storedContainers: Container[];
    try {
      storedContainers = await this.#admin.listContainers();
    } catch {
      this.#persistenceDegraded = true;
      throw new MonitoringError("persistence_unavailable", 503);
    }
    const containers = storedContainers
      .filter((item) => !options.status || item.status === options.status)
      .filter((item) => !options.userId || item.userId === options.userId)
      .filter((item) => !options.appId || item.appId === options.appId)
      .filter((item) => !normalizedSearch || item.id.toLowerCase().includes(normalizedSearch) || item.userId.toLowerCase().includes(normalizedSearch))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const offset = clampOffset(options.offset);
    const limit = clampInstanceLimit(options.limit ?? 100);
    const page = containers.slice(offset, offset + limit);
    const latestById = new Map((await this.#latestSamples(page.map((instance) => instance.id))).map((sample) => [sample.instanceId, sample]));
    return page.map((instance) => {
      const latest = latestById.get(instance.id) ?? null;
      const running = instance.status === "running";
      return {
        id: instance.id,
        ownerId: instance.userId,
        appId: instance.appId,
        appVersionId: instance.appVersionId ?? null,
        imageReference: instance.imageReference ?? null,
        status: instance.status,
        stopReason: instance.stopReason,
        runtimeId: instance.runtimeId,
        createdAt: instance.createdAt,
        updatedAt: instance.updatedAt,
        lastActivityAt: instance.lastActivityAt,
        metrics: running && latest ? sampleMetrics(latest) : null,
        latestSampleAt: running ? latest?.sampledAt ?? null : null,
        lastError: running ? latest?.error ?? null : null,
        metricsCapabilityStatus: running && latest ? sampleCapabilityStatus(latest) : null,
        stale: running && this.#isStale(latest?.sampledAt),
      };
    });
  }

  async dashboard(): Promise<AdminDashboard> {
    // Report the health of this snapshot, not a failure that may have recovered
    // since an earlier sampling pass.
    this.#persistenceDegraded = false;
    const results = await Promise.allSettled([
      this.#admin.listUsers(),
      this.#admin.listContainers(),
      this.#admin.getProvisioningPolicy(),
      this.checkProviders(),
      this.#getForwarding(),
    ]);
    if (results.slice(0, 3).some((result) => result.status === "rejected")) {
      this.#persistenceDegraded = true;
      throw new MonitoringError("persistence_unavailable", 503);
    }
    const users = resultValue(results[0], [] as Awaited<ReturnType<AdminStore["listUsers"]>>);
    const containers = resultValue(results[1], [] as Awaited<ReturnType<AdminStore["listContainers"]>>);
    const policy = resultValue(results[2], DEFAULT_GENERIC_PROVISIONING_POLICY);
    const providerHealth = resultValue(results[3], [unavailableHealth(this.#now(), this.#providerId)]);
    const runtime = providerHealth[0] ?? unavailableHealth(this.#now(), this.#providerId);
    const forwarding = resultValue(results[4], null);
    if (results.some((result) => result.status === "rejected")) this.#persistenceDegraded = true;
    const runningContainers = containers.filter((container) => container.status === "running");
    const latestSamples = await this.#latestSamples(runningContainers.map((container) => container.id));
    const latestByInstance = new Map(latestSamples.map((sample) => [sample.instanceId, sample]));
    const samples = runningContainers.flatMap((container) => {
      const sample = latestByInstance.get(container.id);
      return sample ? [sample] : [];
    });
    const sampleCoverageComplete = samples.length === runningContainers.length;
    const byStatus = {
      creating: containers.filter((item) => item.status === "creating").length,
      running: containers.filter((item) => item.status === "running").length,
      stopped: containers.filter((item) => item.status === "stopped").length,
      failed: containers.filter((item) => item.status === "failed").length,
    };
    const latestSampleAt = samples.map((sample) => sample.sampledAt).sort().at(-1) ?? null;
    const aggregateSamples = sampleCoverageComplete ? samples : [];
    const resources = {
      cpuPercent: aggregateMetric(aggregateSamples, "cpuPercent"),
      memoryWorkingSetBytes: aggregateMetric(aggregateSamples, "memoryWorkingSetBytes"),
      networkRxBytes: aggregateMetric(aggregateSamples, "networkRxBytes"),
      networkTxBytes: aggregateMetric(aggregateSamples, "networkTxBytes"),
      pids: aggregateMetric(aggregateSamples, "pids"),
      gpuUtilizationPercent: aggregateMetric(aggregateSamples, "gpuUtilizationPercent"),
    };
    const stale = runningContainers.length === 0
      ? this.#isStale(latestSampleAt)
      : !sampleCoverageComplete || samples.some((sample) => this.#isStale(sample.sampledAt));
    const totalPercent = percent(containers.length, policy.maxTotalInstances);
    const runningPercent = percent(byStatus.running + byStatus.creating, policy.maxRunningInstances);
    const metricsUnsupported = samples.some((sample) => sampleCapabilityStatus(sample) === "unsupported");
    const metricsFailed = samples.some((sample) => sampleCapabilityStatus(sample) === "unavailable");
    const alerts: AdminDashboardAlert[] = [
      ...providerHealth.flatMap(providerHealthAlerts),
      ...(runningPercent >= 90 ? [{ id: "running-capacity-critical", severity: "critical" as const, message: `运行实例容量已使用 ${runningPercent}%`, createdAt: this.#now().toISOString() }] : runningPercent >= 80 ? [{ id: "running-capacity-warning", severity: "warning" as const, message: `运行实例容量已使用 ${runningPercent}%`, createdAt: this.#now().toISOString() }] : []),
      ...(totalPercent >= 90 ? [{ id: "total-capacity-critical", severity: "critical" as const, message: `总实例容量已使用 ${totalPercent}%`, createdAt: this.#now().toISOString() }] : totalPercent >= 80 ? [{ id: "total-capacity-warning", severity: "warning" as const, message: `总实例容量已使用 ${totalPercent}%`, createdAt: this.#now().toISOString() }] : []),
      ...(byStatus.running > 0 && stale ? [{ id: "metrics-stale", severity: "warning" as const, message: "运行中实例的监测数据已过期", createdAt: this.#now().toISOString() }] : []),
      ...(metricsUnsupported ? [{ id: "provider-metrics-unsupported", severity: "warning" as const, message: "当前 Provider 不提供实例指标", createdAt: this.#now().toISOString() }] : []),
      ...(metricsFailed ? [{ id: "metrics-errors", severity: "warning" as const, message: "部分实例指标采集失败", createdAt: this.#now().toISOString() }] : []),
      ...(!sampleCoverageComplete || samples.some((sample) => [sample.cpuPercent, sample.memoryWorkingSetBytes, sample.networkRxBytes, sample.networkTxBytes, sample.pids].some((value) => value === null))
        ? [{ id: "metrics-incomplete", severity: "warning" as const, message: "部分实例指标不可用，资源汇总已标记为不完整", createdAt: this.#now().toISOString() }]
        : []),
    ];
    return {
      generatedAt: this.#now().toISOString(),
      freshness: {
        sampleIntervalMs: this.#sampleIntervalMs,
        staleAfterMs: this.#staleAfterMs,
        latestSampleAt,
        stale,
        persistenceDegraded: this.#persistenceDegraded,
      },
      users: { total: users.length },
      containers: { total: containers.length, byStatus },
      capacity: {
        maxTotalInstances: policy.maxTotalInstances,
        maxRunningInstances: policy.maxRunningInstances,
        totalUsed: containers.length,
        runningUsed: byStatus.running + byStatus.creating,
        totalPercent,
        runningPercent,
      },
      resources,
      alerts,
      runtime,
      providerHealth,
      forwarding: forwarding ? {
        enabled: forwarding.enabled,
        targetBaseUrl: forwarding.targetBaseUrl,
        updatedAt: forwarding.updatedAt,
      } : null,
    };
  }

  async checkRuntime(force = false): Promise<HealthCheck> {
    return (await this.checkProviders(force))[0] ?? unavailableHealth(this.#now(), this.#providerId);
  }

  async checkProviders(force = false): Promise<HealthCheck[]> {
    return Promise.all(this.#healthProviders.map((source) => this.#checkProvider(source, force)));
  }

  async #checkProvider(
    source: { providerId: string; health: ProviderHealthPort },
    force: boolean,
  ): Promise<HealthCheck> {
    const now = this.#now().getTime();
    const cached = this.#providerHealth.get(source.providerId);
    if (!force && cached && now - cached.checkedAt < 30_000) return cached.check;
    const started = this.#now().getTime();
    let check: HealthCheck;
    try {
      const status = await readProviderHealthStatus(source.health, source.providerId);
      check = {
        id: randomUUID(),
        target: `provider:${status.providerId}`,
        checkedAt: this.#now().toISOString(),
        healthy: status.available,
        latencyMs: elapsedMs(started, this.#now().getTime()),
        error: status.available ? null : status.error ?? "runtime_unavailable",
        capabilityStatus: status.capabilityStatus,
      };
    } catch (error) {
      check = {
        id: randomUUID(),
        target: `provider:${source.providerId}`,
        checkedAt: this.#now().toISOString(),
        healthy: false,
        latencyMs: elapsedMs(started, this.#now().getTime()),
        error: safeError(error),
        capabilityStatus: "unavailable",
      };
    }
    await this.#rememberHealthCheck(check);
    this.#providerHealth.set(source.providerId, { check, checkedAt: this.#now().getTime() });
    return check;
  }

  async audit(filter: AuditEventFilter = {}): Promise<AuditEvent[]> {
    if (this.#admin.listAuditEvents) {
      try {
        return (await this.#admin.listAuditEvents(filter)).map((event) => ({
          ...event,
          metadata: redactSensitiveMetadata(event.metadata),
        }));
      } catch {
        this.#persistenceDegraded = true;
      }
    }
    return [];
  }

  async healthChecks(target?: string, limit = DEFAULT_HISTORY_LIMIT): Promise<HealthCheck[]> {
    if (this.#admin.listHealthChecks) {
      try {
        return await this.#admin.listHealthChecks(target, clampLimit(limit));
      } catch {
        this.#persistenceDegraded = true;
      }
    }
    const values = target ? (this.#healthChecks.get(target) ?? []) : [...this.#healthChecks.values()].flat();
    return values.slice(0, clampLimit(limit));
  }

  async #getForwarding(): Promise<ForwardingPolicy | null> {
    if (!this.#forwarding) return null;
    try {
      return await this.#forwarding();
    } catch {
      return null;
    }
  }

  async #listSamples(instanceId: string, limit: number): Promise<RuntimeSample[]> {
    if (this.#admin.listRuntimeSamples) {
      try {
        const values = await this.#admin.listRuntimeSamples(instanceId, clampLimit(limit));
        if (values.length > 0) return values;
      } catch {
        this.#persistenceDegraded = true;
      }
    }
    return (this.#samples.get(instanceId) ?? []).slice(0, clampLimit(limit));
  }

  async #latestSamples(instanceIds: readonly string[]): Promise<RuntimeSample[]> {
    if (this.#admin.listLatestRuntimeSamples) {
      try {
        const values = await this.#admin.listLatestRuntimeSamples(instanceIds);
        if (values.length > 0 || instanceIds.length === 0) return values;
      } catch {
        this.#persistenceDegraded = true;
      }
    }
    const values = await mapConcurrent(instanceIds, SAMPLE_CONCURRENCY, async (instanceId) => (await this.#listSamples(instanceId, 1))[0] ?? null);
    return values.filter((sample): sample is RuntimeSample => Boolean(sample));
  }

  async #rememberSample(sample: RuntimeSample): Promise<void> {
    const values = this.#samples.get(sample.instanceId) ?? [];
    values.unshift(sample);
    values.splice(120);
    this.#samples.set(sample.instanceId, values);
    if (this.#admin.recordRuntimeSample) {
      try {
        await this.#admin.recordRuntimeSample(sample);
      } catch {
        this.#persistenceDegraded = true;
      }
    }
  }

  async #rememberHealthCheck(check: HealthCheck): Promise<void> {
    const values = this.#healthChecks.get(check.target) ?? [];
    values.unshift(check);
    values.splice(120);
    this.#healthChecks.set(check.target, values);
    if (this.#admin.recordHealthCheck) {
      try {
        await this.#admin.recordHealthCheck(check);
      } catch {
        this.#persistenceDegraded = true;
      }
    }
  }

  #isStale(sampledAt: string | null | undefined): boolean {
    if (!sampledAt) return true;
    const age = this.#now().getTime() - Date.parse(sampledAt);
    return !Number.isFinite(age) || age > this.#staleAfterMs;
  }
}

export class MonitoringError extends Error {
  constructor(readonly code: string, readonly status = 500) {
    super(code);
  }
}

function metricsSample(container: Container, sampledAt: string, metrics: ContainerActivityMetrics): RuntimeSample {
  return {
    id: randomUUID(),
    instanceId: container.id,
    sampledAt,
    state: container.status,
    networkRxBytes: metrics.networkRxBytes,
    networkTxBytes: metrics.networkTxBytes,
    cpuPercent: metrics.cpuPercent,
    memoryWorkingSetBytes: metrics.memoryWorkingSetBytes,
    pids: metrics.pids,
    gpuUtilizationPercent: metrics.gpuUtilizationPercent ?? null,
    error: null,
    capabilityStatus: "supported",
  };
}

function instanceDetails(container: Container): AdminInstanceDetails {
  return {
    id: container.id,
    ownerId: container.userId,
    appId: container.appId,
    status: container.status,
    stopReason: container.stopReason,
    runtimeId: container.runtimeId,
    endpoint: null,
    createdAt: container.createdAt,
    updatedAt: container.updatedAt,
    lastActivityAt: container.lastActivityAt,
  };
}

function emptySample(
  container: Container,
  sampledAt: string,
  error: string | null,
  capabilityStatus?: RuntimeSample["capabilityStatus"],
): RuntimeSample {
  return {
    id: randomUUID(),
    instanceId: container.id,
    sampledAt,
    state: container.status,
    networkRxBytes: null,
    networkTxBytes: null,
    cpuPercent: null,
    memoryWorkingSetBytes: null,
    pids: null,
    gpuUtilizationPercent: null,
    error,
    ...(capabilityStatus ? { capabilityStatus } : {}),
  };
}

function sampleMetrics(sample: RuntimeSample): AdminResourceMetrics {
  return {
    networkRxBytes: sample.networkRxBytes,
    networkTxBytes: sample.networkTxBytes,
    cpuPercent: sample.cpuPercent,
    memoryWorkingSetBytes: sample.memoryWorkingSetBytes,
    pids: sample.pids,
    gpuUtilizationPercent: sample.gpuUtilizationPercent,
  };
}

function aggregateMetric(samples: readonly RuntimeSample[], key: "cpuPercent" | "memoryWorkingSetBytes" | "networkRxBytes" | "networkTxBytes" | "pids" | "gpuUtilizationPercent"): number | null {
  if (samples.length === 0 || samples.some((sample) => sample[key] === null)) return null;
  return samples.reduce((total, sample) => total + (sample[key] ?? 0), 0);
}

function validateMetrics(metrics: ContainerActivityMetrics): void {
  const numbers = [metrics.networkRxBytes, metrics.networkTxBytes, metrics.cpuPercent, metrics.memoryWorkingSetBytes, metrics.pids];
  if (numbers.some((value) => !Number.isFinite(value) || value < 0) || !Number.isSafeInteger(metrics.pids)) {
    throw new Error("runtime returned invalid activity metrics");
  }
  if (metrics.gpuUtilizationPercent !== undefined && (!Number.isFinite(metrics.gpuUtilizationPercent) || metrics.gpuUtilizationPercent < 0)) {
    throw new Error("runtime returned invalid gpu metrics");
  }
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return sanitizeSensitiveText(value, 500);
}

function resultValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

function unavailableHealth(now: Date, providerId = "unknown"): HealthCheck {
  return {
    id: randomUUID(),
    target: `provider:${providerId}`,
    checkedAt: now.toISOString(),
    healthy: false,
    latencyMs: null,
    error: "runtime_check_failed",
    capabilityStatus: "unavailable",
  };
}

function sampleCapabilityStatus(sample: RuntimeSample): NonNullable<RuntimeSample["capabilityStatus"]> {
  if (sample.capabilityStatus) return sample.capabilityStatus;
  return sample.error === "provider_metrics_unsupported" ? "unsupported" : sample.error ? "unavailable" : "supported";
}

function providerHealthAlerts(check: HealthCheck): AdminDashboardAlert[] {
  const providerId = check.target.replace(/^provider:/u, "") || "unknown";
  if (check.capabilityStatus === "unsupported") {
    return [{
      id: `provider-health-unsupported:${providerId}`,
      severity: "warning",
      message: `Provider ${providerId} 不支持健康检查`,
      createdAt: check.checkedAt,
    }];
  }
  if (!check.healthy) {
    return [{
      id: `provider-unavailable:${providerId}`,
      severity: "critical",
      message: `Provider ${providerId} 不可用`,
      createdAt: check.checkedAt,
    }];
  }
  return [];
}

function normalizeHealthProviders(
  providers: ReadonlyArray<{ providerId: string; health: ProviderHealthPort }>,
): ReadonlyArray<{ providerId: string; health: ProviderHealthPort }> {
  const unique = new Map<string, ProviderHealthPort>();
  for (const source of providers) {
    const providerId = source.providerId.trim();
    if (!providerId || unique.has(providerId)) throw new Error("provider_health_source_invalid");
    unique.set(providerId, source.health);
  }
  if (unique.size === 0) throw new Error("provider_health_source_missing");
  return [...unique].map(([providerId, health]) => ({ providerId, health }));
}

function normalizeDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1_000, Math.floor(value)) : fallback;
}

function clampLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(value))) : DEFAULT_HISTORY_LIMIT;
}

function clampInstanceLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_INSTANCE_LIST_LIMIT, Math.floor(value))) : 100;
}

function clampOffset(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function percent(value: number, maximum: number): number {
  return maximum > 0 ? Math.round((value / maximum) * 10000) / 100 : 0;
}

function elapsedMs(started: number, ended: number): number | null {
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null;
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  await forEachConcurrent(values, concurrency, async (value, index) => {
    results[index] = await operation(value);
  });
  return results;
}

async function forEachConcurrent<T>(values: readonly T[], concurrency: number, operation: (value: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      const value = values[index];
      if (value !== undefined) await operation(value, index);
    }
  });
  await Promise.all(workers);
}
