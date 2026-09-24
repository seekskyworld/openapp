const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api[_-]?key|refresh[_-]?token|access[_-]?token/iu;

/** Removes credential-shaped values before they can enter durable admin records. */
export function redactSensitiveMetadata(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? sanitizeSensitiveText(value) : value;
  }
  if (depth >= 8) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveMetadata(item, depth + 1, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitiveMetadata(item, depth + 1, seen);
  }
  return result;
}

export function sanitizeSensitiveText(value: string, maximum = 2_000): string {
  return value
    .replace(/(bearer\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/([?&](?:access_?token|refresh_?token|token|api[_-]?key|key|secret|password)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/("?(?:authorization|cookie|access_?token|refresh_?token|token|api[_-]?key|secret|password)"?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1[REDACTED]")
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, maximum) || "unknown_error";
}
