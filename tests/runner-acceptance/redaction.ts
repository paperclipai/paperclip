import { redactDiagnosticText } from "../../packages/adapter-utils/src/command-redaction.js";

const SECRET_SHAPES = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bopenrouter[-_]?(?:api)?[-_]?key["'=:\s]+[A-Za-z0-9._-]{12,}\b/gi,
] as const;
const SENSITIVE_KEY = /(?:authorization|api.?key|token|password|secret|credential|private.?key)/i;

export function normalizedSensitiveValues(
  values: readonly (string | undefined)[],
) {
  return [...new Set(
    values
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  )].sort((left, right) => right.length - left.length);
}

function redactKnownValuesAndShapes(
  value: string,
  sensitiveValues: readonly string[],
) {
  let redacted = value;
  for (const sensitiveValue of normalizedSensitiveValues(sensitiveValues)) {
    redacted = redacted.split(sensitiveValue).join("[REDACTED]");
  }
  for (const pattern of SECRET_SHAPES) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[REDACTED_SECRET_SHAPE]");
  }
  return redacted;
}

export function redactText(
  value: string,
  sensitiveValues: readonly string[] = [],
) {
  return redactKnownValuesAndShapes(
    redactDiagnosticText(value, "[REDACTED]"),
    sensitiveValues,
  );
}

export function findSensitiveValue(
  value: string | Buffer,
  sensitiveValues: readonly string[] = [],
): string | null {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  for (const sensitiveValue of normalizedSensitiveValues(sensitiveValues)) {
    if (text.includes(sensitiveValue)) return "exact sensitive value";
  }
  for (const pattern of SECRET_SHAPES) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return "secret-shaped value";
  }
  return null;
}

export function findSensitiveJsonValue(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): string | null {
  if (typeof value === "string") return findSensitiveValue(value, sensitiveValues);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const leak = findSensitiveJsonValue(entry, sensitiveValues);
      if (leak) return leak;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (
        SENSITIVE_KEY.test(key)
        && entry !== null
        && entry !== undefined
        && entry !== "[REDACTED]"
        && entry !== "[REDACTED_SECRET_SHAPE]"
      ) {
        return `sensitive field ${key}`;
      }
      const leak = findSensitiveJsonValue(entry, sensitiveValues);
      if (leak) return leak;
    }
  }
  return null;
}

export function sanitizeJson(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): unknown {
  if (typeof value === "string") return redactText(value, sensitiveValues);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJson(entry, sensitiveValues));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) && entry !== null && entry !== undefined
          ? "[REDACTED]"
          : sanitizeJson(entry, sensitiveValues),
      ]),
    );
  }
  return value;
}

export function assertSensitiveValueFree(
  value: string | Buffer,
  sensitiveValues: readonly string[],
  label: string,
) {
  const leak = findSensitiveValue(value, sensitiveValues);
  if (leak) throw new Error(`Secret leak in ${label}: ${leak}`);
}
