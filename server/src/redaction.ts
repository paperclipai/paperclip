import { redactCommandText } from "@paperclipai/adapter-utils";

const SECRET_PAYLOAD_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const COMMAND_PAYLOAD_KEY_RE =
  /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const CLI_SECRET_FLAG_RE =
  /^-{1,2}(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)$/i;
const JSON_SECRET_FIELD_TEXT_RE =
  /((?:"|')?(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)(?:"|')?\s*:\s*(?:"|'))[^"'`\r\n]+((?:"|'))/gi;
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE =
  /((?:\\")?(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))/gi;
export const REDACTED_EVENT_VALUE = "***REDACTED***";
// `secret: status` is common prose, so colon-form redaction is deliberately
// narrower than equals-form redaction. Uppercase environment-style names are
// always treated as secret assignments; other colon forms need an opaque
// credential shape before they are redacted.
const TEXT_ENV_SECRET_ASSIGNMENT_RE =
  /(\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTHORIZATION|JWT)[A-Z0-9_]*\s*[:=]\s*["']?)[^\s"'`]+/g;
const TEXT_NAMED_SECRET_EQUALS_RE =
  /((?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)\s*=\s*["']?)[^\s"'`]+/gi;
const TEXT_CLEAR_SECRET_COLON_RE =
  /((?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)\s*:\s*["']?)[^\s"'`]+/gi;
const TEXT_AMBIGUOUS_SECRET_COLON_RE =
  /(secret\s*:\s*["']?)(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?|[A-Za-z0-9+/=_-]{32,})/gi;
// A bare `Bearer` prefix is common in copied headers, but ordinary prose such
// as "bearer tokens" must stay readable. Redact only a single opaque token:
// a known provider shape, JWT, or 24+ character URL-safe/base64-like value.
const TEXT_BARE_BEARER_CREDENTIAL_RE =
  /(\bbearer\s+)(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?|[A-Za-z0-9+/=_-]{24,})(?=$|[^A-Za-z0-9+/=_-])/gi;
// Userinfo is credentials only when it includes a password (`user:password@`).
// This deliberately leaves normal URLs, ports, and username-only URLs intact.
const TEXT_URL_EMBEDDED_CREDENTIAL_RE =
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#:@]+:[^\s/?#@]+@/gi;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
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

function sanitizeCommandArgs(args: unknown[]): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_EVENT_VALUE;
    }
    if (typeof arg !== "string") return sanitizeValue(arg);
    if (CLI_SECRET_FLAG_RE.test(arg.trim())) {
      redactNext = true;
      return arg;
    }
    return redactSensitiveText(arg);
  });
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
      redacted[key] = sanitizeCommandArgs(value);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
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
    if (typeof value === "string" && JWT_VALUE_RE.test(value)) {
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

export function redactSensitiveText(input: string): string {
  return redactCommandText(input, REDACTED_EVENT_VALUE)
    .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
    .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
    .replace(TEXT_ENV_SECRET_ASSIGNMENT_RE, `$1${REDACTED_EVENT_VALUE}`)
    .replace(TEXT_NAMED_SECRET_EQUALS_RE, `$1${REDACTED_EVENT_VALUE}`)
    .replace(TEXT_CLEAR_SECRET_COLON_RE, `$1${REDACTED_EVENT_VALUE}`)
    .replace(TEXT_AMBIGUOUS_SECRET_COLON_RE, `$1${REDACTED_EVENT_VALUE}`)
    .replace(TEXT_BARE_BEARER_CREDENTIAL_RE, `$1${REDACTED_EVENT_VALUE}`)
    .replace(TEXT_URL_EMBEDDED_CREDENTIAL_RE, `$1${REDACTED_EVENT_VALUE}@`);
}
