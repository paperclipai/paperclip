import { redactSensitiveText, sanitizeRecord } from "./redaction.js";

/**
 * Pre-persistence sanitization boundary.
 *
 * The redaction helpers in `redaction.ts` are applied at egress points
 * (response serialization, live events, request logging). Values that reach a
 * DB insert/update or an on-disk log append before one of those egress points
 * runs are persisted verbatim, so credential-shaped values written into
 * comment bodies, run log chunks, run event messages, or activity payloads
 * survive at rest and resurface through any read path (including backups).
 *
 * These helpers wrap the existing redaction primitives so persistence sites
 * can sanitize once, before the write, instead of relying on every read path
 * to redact. Sanitization is deterministic and idempotent: already-redacted
 * or non-sensitive values pass through unchanged.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Sanitize free text (comment bodies, log chunks, event messages) before it is persisted. */
export function sanitizeTextForPersistence(input: string): string {
  return redactSensitiveText(input);
}

function deepRedactStrings(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(deepRedactStrings);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = deepRedactStrings(entry);
  }
  return out;
}

/**
 * Sanitize an arbitrary JSON-like value (string, array, or nested object)
 * before it is persisted.
 *
 * Plain objects first go through the key-aware `sanitizeRecord` pass (secret
 * field names, secret bindings, command args, JWT-shaped values), then every
 * remaining string leaf goes through the text-level pass so credential-shaped
 * values embedded in free-text fields are also caught. Non-JSON values
 * (dates, buffers, class instances) are returned unchanged.
 */
export function sanitizeForPersistence<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => sanitizeForPersistence(entry)) as T;
  if (isPlainObject(value)) return deepRedactStrings(sanitizeRecord(value)) as T;
  return value;
}
