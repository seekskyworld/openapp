import type { IncomingMessage, ServerResponse } from "node:http";
import { AdminMonitoring, MonitoringError } from "./admin-monitoring.js";
import { AdminOperationManager, sanitizeOperationError, type AdminOperationStatus } from "./admin-operations.js";
import { HttpError, sendJson } from "./http-response.js";
import type { ContainerStatus } from "./models.js";
import { paginateAdminList } from "./admin-pagination.js";

/** Thin REST adapter; all monitoring behavior remains in AdminMonitoring. */
export async function handleAdminMonitoringRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  monitoring: AdminMonitoring,
  operations?: AdminOperationManager,
  authorize?: () => Promise<boolean>,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/admin/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    let snapshotPromise: Promise<void> | undefined;
    const writeSnapshot = async () => {
      if (closed || response.destroyed || response.writableEnded || snapshotPromise) return;
      snapshotPromise = (async () => {
        try {
          if (authorize && !await authorize()) {
            closed = true;
            clearInterval(timer);
            response.end();
            return;
          }
          const payload = {
            generatedAt: new Date().toISOString(),
            dashboard: await monitoring.dashboard(),
            operations: operations ? await operations.list({ limit: 100 }) : [],
          };
          if (!closed && !response.destroyed && !response.writableEnded) response.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`);
        } catch (error) {
          if (!closed && !response.destroyed && !response.writableEnded) response.write(`event: error\ndata: ${JSON.stringify({ message: sanitizeOperationError(error) })}\n\n`);
        }
      })().finally(() => {
        snapshotPromise = undefined;
      });
      await snapshotPromise;
    };
    void writeSnapshot();
    const timer = setInterval(() => void writeSnapshot(), 10_000);
    timer.unref();
    const close = () => {
      closed = true;
      clearInterval(timer);
    };
    request.once("close", close);
    response.once("close", close);
    return true;
  }
  if (request.method === "GET" && (url.pathname === "/api/admin/dashboard" || url.pathname === "/api/admin/monitor/summary")) {
    sendJson(response, 200, { dashboard: await invoke(() => monitoring.dashboard()) });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/admin/monitor/instances") {
    const instances = await invoke(() => monitoring.listInstances({
      status: monitorStatusQuery(url),
      userId: optional(url.searchParams.get("userId")),
      appId: optional(url.searchParams.get("appId")),
      search: optional(url.searchParams.get("search")),
      limit: 10_000,
      offset: 0,
    }));
    const page = paginateAdminList(instances, url);
    sendJson(response, 200, { instances: page.items, pagination: page.pagination });
    return true;
  }
  const metricsRoute = url.pathname.match(/^\/api\/admin\/monitor\/instances\/([^/]+)\/metrics$/u);
  if (request.method === "GET" && metricsRoute) {
    const metrics = await invoke(() => monitoring.instanceMetrics(
      decodeURIComponent(metricsRoute[1]!),
      integerQuery(url, "limit", 60),
    ));
    sendJson(response, 200, metrics);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/admin/monitor/health") {
    const checks = await invoke(() => monitoring.healthChecks(
      optional(url.searchParams.get("target")),
      integerQuery(url, "limit", 60),
    ));
    sendJson(response, 200, { checks });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/admin/audit") {
    const events = await invoke(() => monitoring.audit({
      actorUserId: optional(url.searchParams.get("actorUserId")),
      action: optional(url.searchParams.get("action")),
      resourceType: optional(url.searchParams.get("resourceType")),
      resourceId: optional(url.searchParams.get("resourceId")),
      from: dateQuery(url, "from"),
      to: dateQuery(url, "to"),
      limit: 10_000,
      offset: integerQuery(url, "offset", 0),
    }));
    const search = optional(url.searchParams.get("search"))?.toLowerCase();
    const filtered = search
      ? events.filter((event) => [event.id, event.actorUserId, event.action, event.resourceType, event.resourceId].some((value) => value?.toLowerCase().includes(search)))
      : events;
    const page = paginateAdminList(filtered, url);
    sendJson(response, 200, { events: page.items, pagination: page.pagination });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/runtime/check") {
    sendJson(response, 200, { check: await invoke(() => monitoring.checkRuntime(true)) });
    return true;
  }
  if (operations && request.method === "GET" && url.pathname === "/api/admin/operations") {
    const values = await operations.list({
      status: operationStatusQuery(url),
      type: optional(url.searchParams.get("type")),
      limit: 10_000,
    });
    const search = optional(url.searchParams.get("search"))?.toLowerCase();
    const filtered = search
      ? values.filter((operation) => [operation.id, operation.type, operation.resourceType, operation.resourceId, operation.actorUserId, operation.stage].some((value) => value?.toLowerCase().includes(search)))
      : values;
    const page = paginateAdminList(filtered, url);
    sendJson(response, 200, { operations: page.items, pagination: page.pagination });
    return true;
  }
  const operationRoute = url.pathname.match(/^\/api\/admin\/operations\/([^/]+)(?:\/(cancel|retry))?$/u);
  if (operations && operationRoute) {
    const id = decodeURIComponent(operationRoute[1]!);
    const action = operationRoute[2];
    if (request.method === "GET" && !action) {
      const operation = await operations.get(id);
      if (!operation) throw new HttpError(404, "operation_not_found");
      sendJson(response, 200, { operation });
      return true;
    }
    if (request.method === "POST" && action === "cancel") {
      let operation;
      try { operation = await operations.cancel(id); }
      catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "operation_cancel_failed"); }
      if (!operation) throw new HttpError(404, "operation_not_found");
      sendJson(response, operation.stage === "cancelling" ? 202 : 200, { operation });
      return true;
    }
    if (request.method === "POST" && action === "retry") {
      try {
        sendJson(response, 202, { operation: await operations.retry(id) });
      } catch (error) {
        throw new HttpError(error instanceof Error && error.message === "operation_not_found" ? 404 : 409, error instanceof Error ? error.message : "operation_retry_failed");
      }
      return true;
    }
  }
  return false;
}

async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MonitoringError) throw new HttpError(error.status, error.code);
    throw error;
  }
}

function optional(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function integerQuery(url: URL, key: string, fallback: number): number {
  const value = url.searchParams.get(key);
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, `invalid_${key}`);
  return parsed;
}

function dateQuery(url: URL, key: string): Date | undefined {
  const value = url.searchParams.get(key);
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new HttpError(400, `invalid_${key}`);
  return parsed;
}

function operationStatusQuery(url: URL): AdminOperationStatus | undefined {
  const status = optional(url.searchParams.get("status"));
  if (!status) return undefined;
  if (status === "queued" || status === "running" || status === "succeeded" || status === "failed" || status === "cancelled") return status;
  throw new HttpError(400, "invalid_status");
}

function monitorStatusQuery(url: URL): ContainerStatus | undefined {
  const status = optional(url.searchParams.get("status"));
  if (!status) return undefined;
  if (status === "creating" || status === "running" || status === "stopped" || status === "failed") return status;
  throw new HttpError(400, "invalid_status");
}
