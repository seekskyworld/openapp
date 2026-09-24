import { randomUUID } from "node:crypto";

/**
 * 请求上下文只携带跨层排障所需的稳定标识。它是日志和诊断的防腐层，
 * 不允许把 Cookie、Token、Provider endpoint 或临时 Environment 标识带出领域边界。
 */
export type OperationPhase =
  | "http"
  | "auth"
  | "workspace"
  | "execution"
  | "reconcile"
  | "rollout"
  | "build"
  | "storage"
  | "access"
  | "activity"
  | "upgrade"
  | "proxy"
  | "diagnose"
  | "delete"
  | "health"
  | "unknown";

export interface OperationContext {
  readonly requestId: string;
  readonly operationId?: string;
  readonly workspaceId?: string;
  readonly attemptId?: string;
  readonly providerId?: string;
  readonly phase: OperationPhase;
}

export interface OperationContextInput {
  readonly [key: string]: unknown;
  requestId?: unknown;
  operationId?: unknown;
  workspaceId?: unknown;
  attemptId?: unknown;
  providerId?: unknown;
  phase?: unknown;
}

export interface OperationContextPatch {
  requestId?: unknown;
  operationId?: unknown | null;
  workspaceId?: unknown | null;
  attemptId?: unknown | null;
  providerId?: unknown | null;
  phase?: unknown;
}

const PHASES = new Set<OperationPhase>([
  "http",
  "auth",
  "workspace",
  "execution",
  "reconcile",
  "rollout",
  "build",
  "storage",
  "access",
  "activity",
  "upgrade",
  "proxy",
  "diagnose",
  "delete",
  "health",
  "unknown",
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * 创建脱敏上下文。非法或过长的外部 request id 会被替换为本地 UUID，
 * 其他非法关联字段直接省略，避免诊断日志成为任意字符串的回显通道。
 */
export function createOperationContext(input: OperationContextInput = {}): OperationContext {
  const requestId = safeIdentifier(input.requestId) ?? randomUUID();
  const operationId = safeIdentifier(input.operationId);
  const workspaceId = safeIdentifier(input.workspaceId);
  const attemptId = safeIdentifier(input.attemptId);
  const providerId = safeIdentifier(input.providerId);
  const phase = normalizePhase(input.phase);
  return {
    requestId,
    ...(operationId ? { operationId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(providerId ? { providerId } : {}),
    phase,
  };
}

/** 合并跨层上下文；null 明确清除一个关联字段，未提供的字段沿用原值。 */
export function mergeOperationContext(
  base: OperationContext,
  patch: OperationContextPatch,
): OperationContext {
  return createOperationContext({
    requestId: patch.requestId === undefined ? base.requestId : patch.requestId,
    operationId: patch.operationId === undefined ? base.operationId : patch.operationId,
    workspaceId: patch.workspaceId === undefined ? base.workspaceId : patch.workspaceId,
    attemptId: patch.attemptId === undefined ? base.attemptId : patch.attemptId,
    providerId: patch.providerId === undefined ? base.providerId : patch.providerId,
    phase: patch.phase === undefined ? base.phase : patch.phase,
  });
}

/** 返回可直接写入结构化日志的字段白名单。 */
export function diagnosticContext(context: OperationContext): Readonly<Record<string, string>> {
  return {
    requestId: context.requestId,
    ...(context.operationId ? { operationId: context.operationId } : {}),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.attemptId ? { attemptId: context.attemptId } : {}),
    ...(context.providerId ? { providerId: context.providerId } : {}),
    phase: context.phase,
  };
}

/** 以固定字段顺序序列化上下文，便于日志检索和快照测试。 */
export function formatDiagnosticContext(context: OperationContext): string {
  return JSON.stringify(diagnosticContext(context));
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return SAFE_IDENTIFIER.test(normalized) ? normalized : undefined;
}

function normalizePhase(value: unknown): OperationPhase {
  if (typeof value === "string" && PHASES.has(value as OperationPhase)) return value as OperationPhase;
  return "unknown";
}
