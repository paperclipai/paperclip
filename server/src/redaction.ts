import os from "node:os";

const SECRET_PAYLOAD_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const SENSITIVE_TEXT_ASSIGNMENT_RE =
  /(^|[\r\n])([A-Za-z0-9_.-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_.-]*)\s*=\s*([^\r\n]+)/gi;
const SENSITIVE_TEXT_JSON_RE =
  /(["'](?:[^"'\n]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[^"'\n]*)["']\s*:\s*["'])([^"'\n]+)(["'])/gi;
const SENSITIVE_TEXT_BEARER_RE = /(Authorization\s*:\s*Bearer\s+)([^\s"'`]+)/gi;
export const REDACTED_EVENT_VALUE = "***REDACTED***";
const HOME_DIR_CANDIDATES = Array.from(
  new Set(
    [os.homedir(), process.env.HOME, process.env.USERPROFILE]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  ),
);
const CURRENT_USERNAME = (() => {
  try {
    return os.userInfo().username.trim() || null;
  } catch {
    return null;
  }
})();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

export function redactSensitiveText(value: string): string {
  // Transcript payloads are often plain text, so secret-bearing substrings need
  // redaction even when the surrounding payload shape is otherwise harmless.
  let redacted = value
    .replace(
      SENSITIVE_TEXT_ASSIGNMENT_RE,
      (_match, prefix: string, key: string) => `${prefix}${key}=${REDACTED_EVENT_VALUE}`,
    )
    .replace(
      SENSITIVE_TEXT_JSON_RE,
      (_match, prefix: string, _value: string, suffix: string) =>
        `${prefix}${REDACTED_EVENT_VALUE}${suffix}`,
    )
    .replace(SENSITIVE_TEXT_BEARER_RE, `$1${REDACTED_EVENT_VALUE}`);

  // Keep operator-facing logs readable by collapsing the local home directory
  // into a shell-style hint instead of exposing the machine-specific path.
  for (const homeDir of HOME_DIR_CANDIDATES) {
    const normalized = homeDir.replace(/\\/g, "/");
    const variants = new Set<string>([homeDir, normalized]);
    if (!normalized.endsWith("/")) {
      variants.add(`${normalized}/`);
    }
    for (const variant of variants) {
      redacted = redacted.split(variant).join(variant.endsWith("/") ? "~/" : "~");
    }
  }

  if (CURRENT_USERNAME) {
    const escaped = CURRENT_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(new RegExp(`\\b${escaped}\\b`, "g"), "current-user");
  }

  return redacted;
}

function sanitizeString(value: string): string {
  const redactedText = redactSensitiveText(value);
  if (JWT_VALUE_RE.test(redactedText)) return REDACTED_EVENT_VALUE;
  return redactedText;
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeValue(value);
  }
  return redacted;
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}
