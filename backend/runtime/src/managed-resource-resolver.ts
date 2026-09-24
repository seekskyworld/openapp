/**
 * Provider 中性的受管资源身份合同。
 *
 * Docker 的名称是部署配置的一部分，升级配置或迁移部署目录后可能改变；
 * 标签中的 Workspace/Owner/Role 才是资源的稳定身份。解析器只在身份完整、
 * 隔离属性满足且候选唯一时返回引用，避免按名称猜测并误用其他租户资源。
 */

export const OPENAPP_RESOURCE_LABEL_PREFIX = "io.openapp.portal";
export const RESOURCE_LABEL_PREFIXES = [OPENAPP_RESOURCE_LABEL_PREFIX] as const;

export type ManagedResourceKind = "container" | "network" | "volume";
export type ManagedNetworkRole = "private" | "egress";

export interface ManagedResourceIdentity {
  readonly instanceId: string;
  readonly ownerId: string;
  readonly networkRole?: ManagedNetworkRole;
  readonly storageId?: string;
  readonly allowLegacyStorageRef?: boolean;
  /** 允许缺失 storage-ref 的旧资源名称；发现到的任意自定义资源不能借此绕过校验。 */
  readonly legacyStorageNames?: readonly string[];
  /** 当部署要求所有新资源使用当前 scheme 时打开；旧资源仍可被 preflight 识别。 */
  readonly requireCurrentScheme?: string;
  /** 当前 Runtime 使用的标签命名空间；省略时读取新旧兼容命名空间。 */
  readonly labelPrefixes?: readonly string[];
}

export interface ManagedResourceCandidate {
  readonly kind: ManagedResourceKind;
  readonly name: string;
  readonly id?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly internal?: boolean;
  readonly options?: Readonly<Record<string, string>>;
}

export interface ManagedResourceRef extends ManagedResourceCandidate {
  readonly scheme: string;
  readonly legacy: boolean;
  readonly migrationRequired: boolean;
}

export type ManagedResourceResolutionCode =
  | "provider_resource_missing"
  | "resource_identity_mismatch"
  | "resource_identity_ambiguous"
  | "resource_migration_required";

export class ManagedResourceResolutionError extends Error {
  readonly code: ManagedResourceResolutionCode;
  readonly kind: ManagedResourceKind;
  readonly instanceId: string;
  readonly ownerId: string;
  readonly candidateNames: readonly string[];

  constructor(
    code: ManagedResourceResolutionCode,
    identity: ManagedResourceIdentity,
    kind: ManagedResourceKind,
    candidateNames: readonly string[] = [],
  ) {
    // 兼容命名空间的错误短语需要保持稳定；通用 Runtime 则只暴露中性提示，
    // 避免把产品名称泄漏到新 App 的诊断界面。
    super(`${code}: refusing to use a managed resource without matching ownership labels`);
    this.name = "ManagedResourceResolutionError";
    this.code = code;
    this.kind = kind;
    this.instanceId = identity.instanceId;
    this.ownerId = identity.ownerId;
    this.candidateNames = [...candidateNames];
  }
}

interface NormalizedLabels {
  managed?: string;
  instanceId?: string;
  ownerId?: string;
  storageRef?: string;
  role?: string;
  scheme?: string;
}

/** 返回两个命名空间中一致的值；冲突值使用特殊标记让选择器 fail closed。 */
function readLabel(
  labels: Readonly<Record<string, string>> | undefined,
  suffix: string,
  prefixes: readonly string[] = RESOURCE_LABEL_PREFIXES,
): string | undefined {
  const values = prefixes
    .map((prefix) => labels?.[`${prefix}.${suffix}`])
    .filter((value): value is string => value !== undefined);
  if (values.length === 0) return undefined;
  const unique = new Set(values);
  return unique.size === 1 ? values[0] : "__conflicting_label_values__";
}

function normalizeLabels(
  labels: Readonly<Record<string, string>> | undefined,
  prefixes: readonly string[] = RESOURCE_LABEL_PREFIXES,
): NormalizedLabels {
  const normalized: NormalizedLabels = {};
  const fields: Array<[keyof NormalizedLabels, string | undefined]> = [
    ["managed", readLabel(labels, "managed", prefixes)],
    ["instanceId", readLabel(labels, "instance-id", prefixes)],
    ["ownerId", readLabel(labels, "owner-id", prefixes)],
    ["storageRef", readLabel(labels, "storage-ref", prefixes)],
    ["role", readLabel(labels, "resource-role", prefixes) ?? readLabel(labels, "network-role", prefixes)],
    ["scheme", readLabel(labels, "resource-scheme", prefixes)],
  ];
  for (const [key, value] of fields) if (value !== undefined) normalized[key] = value;
  return normalized;
}

export function inferManagedNetworkRole(
  candidate: ManagedResourceCandidate,
  labelPrefixes: readonly string[] = RESOURCE_LABEL_PREFIXES,
): ManagedNetworkRole | undefined {
  const labels = normalizeLabels(candidate.labels, labelPrefixes);
  if (labels.role === "private" || labels.role === "egress") return labels.role;
  if (candidate.name.endsWith("-egress")) return "egress";
  if (candidate.internal === true) return "private";
  if (
    candidate.internal === false
    && candidate.options?.["com.docker.network.bridge.enable_icc"] === "false"
  ) return "egress";
  return undefined;
}

function candidateMatchesIdentity(
  candidate: ManagedResourceCandidate,
  identity: ManagedResourceIdentity,
): { matches: boolean; identityMismatch: boolean } {
  const labels = normalizeLabels(candidate.labels, identity.labelPrefixes);
  const hasRelevantLabels = labels.managed !== undefined
    || labels.instanceId !== undefined
    || labels.ownerId !== undefined
    || labels.storageRef !== undefined;
  if (!hasRelevantLabels) return { matches: false, identityMismatch: false };

  const identityMismatch = labels.managed === "__conflicting_label_values__"
    || labels.instanceId === "__conflicting_label_values__"
    || labels.ownerId === "__conflicting_label_values__"
    || labels.storageRef === "__conflicting_label_values__"
    || labels.managed !== "true"
    || labels.instanceId !== identity.instanceId
    || labels.ownerId !== identity.ownerId;
  if (identityMismatch) return { matches: false, identityMismatch: true };

  if (identity.networkRole !== undefined && candidate.kind === "network") {
    const role = inferManagedNetworkRole(candidate, identity.labelPrefixes);
    if (role !== identity.networkRole) return { matches: false, identityMismatch: true };
    if (identity.networkRole === "private" && candidate.internal !== true) {
      return { matches: false, identityMismatch: true };
    }
    if (
      identity.networkRole === "egress"
      && (candidate.internal === true
        || candidate.options?.["com.docker.network.bridge.enable_icc"] !== "false")
    ) {
      return { matches: false, identityMismatch: true };
    }
  }

  if (identity.storageId !== undefined) {
    const storageMatches = labels.storageRef === identity.storageId
      || (identity.allowLegacyStorageRef === true
        && labels.storageRef === undefined
        && (identity.legacyStorageNames === undefined
          || identity.legacyStorageNames.includes(candidate.name)));
    if (!storageMatches) return { matches: false, identityMismatch: true };
  }
  return { matches: true, identityMismatch: false };
}

function candidateScheme(
  candidate: ManagedResourceCandidate,
  labelPrefixes?: readonly string[],
): { scheme: string; legacy: boolean } {
  const scheme = normalizeLabels(candidate.labels, labelPrefixes).scheme;
  if (scheme && scheme !== "__conflicting_label_values__") {
    return { scheme, legacy: false };
  }
  return { scheme: "legacy", legacy: true };
}

/**
 * 从已 inspect 的候选中选择唯一受管资源。该函数不执行任何副作用，便于
 * Runtime、preflight 和迁移工具共享同一套身份判定。
 */
export function selectManagedResource(
  candidates: readonly ManagedResourceCandidate[],
  identity: ManagedResourceIdentity,
  kind: ManagedResourceKind,
): ManagedResourceRef {
  const sameKind = candidates.filter((candidate) => candidate.kind === kind);
  const matches: ManagedResourceCandidate[] = [];
  let identityMismatch = false;
  for (const candidate of sameKind) {
    const result = candidateMatchesIdentity(candidate, identity);
    if (result.matches) matches.push(candidate);
    else if (result.identityMismatch) identityMismatch = true;
  }

  if (matches.length === 0) {
    throw new ManagedResourceResolutionError(
      identityMismatch ? "resource_identity_mismatch" : "provider_resource_missing",
      identity,
      kind,
      sameKind.map((candidate) => candidate.name),
    );
  }
  if (matches.length > 1) {
    throw new ManagedResourceResolutionError(
      "resource_identity_ambiguous",
      identity,
      kind,
      matches.map((candidate) => candidate.name),
    );
  }
  const selected = matches[0]!;
  const metadata = candidateScheme(selected, identity.labelPrefixes);
  const migrationRequired = identity.requireCurrentScheme !== undefined
    && metadata.scheme !== identity.requireCurrentScheme;
  if (migrationRequired) {
    throw new ManagedResourceResolutionError(
      "resource_migration_required",
      identity,
      kind,
      [selected.name],
    );
  }
  return {
    ...selected,
    ...metadata,
    migrationRequired,
  };
}

export function resourceLabelArgs(
  identity: Pick<ManagedResourceIdentity, "instanceId" | "ownerId">,
  scheme: string,
  role?: string,
  prefixes: readonly string[] = RESOURCE_LABEL_PREFIXES,
): string[] {
  const values: Array<[string, string]> = [
    ["managed", "true"],
    ["instance-id", identity.instanceId],
    ["owner-id", identity.ownerId],
    ["resource-scheme", scheme],
  ];
  if (role) values.push(["resource-role", role]);
  return prefixes.flatMap((prefix) => values.flatMap(([key, value]) => [
    "--label",
    `${prefix}.${key}=${value}`,
  ]));
}

export function resourceLabel(
  labels: Readonly<Record<string, string>> | undefined,
  suffix: string,
  prefixes: readonly string[] = RESOURCE_LABEL_PREFIXES,
): string | undefined {
  const value = readLabel(labels, suffix, prefixes);
  return value === "__conflicting_label_values__" ? undefined : value;
}
