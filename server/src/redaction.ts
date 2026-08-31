import { redactCommandText } from "@paperclipai/adapter-utils";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|passphrase|credential|webhook|jwt|private[-_]?key|cookie|connection[-_]?string|browser[-_]?code|login[-_]?url)[A-Za-z0-9_-]*`;

const SECRET_PAYLOAD_KEY_RE = new RegExp(SECRET_FIELD_NAME_PATTERN, "i");
// Authorization reasons are policy decision codes, not credentials. They must
// remain visible in audit receipts even though the field name contains
// "authorization". JWT-shaped values are still caught by the value guard below.
const AUDIT_REASON_PAYLOAD_KEY_RE = /^authorizationReason$/;
const AUDIT_SURFACE_PAYLOAD_KEY_RE = /^surface$/;
/**
 * Cleanup counts on a connection-removal receipt (PAP-17119). Their names name
 * the thing they counted — secrets, bindings, tokens — so the key guard above
 * would blank the whole receipt and leave the operator unable to see what a
 * revocation actually tore down. They pass only while the value really is a
 * finite number, so nothing that could carry material rides through on the
 * strength of a familiar key name.
 */
const AUDIT_COUNT_PAYLOAD_KEYS = new Set([
  "secretsRevoked",
  "secretsRetainedShared",
  "credentialRefsCleared",
  "secretBindingsRemoved",
  "tokenIssuanceHashesCleared",
  "gatewayTokensRevoked",
]);

function isAuditCountField(key: string, value: unknown): boolean {
  return AUDIT_COUNT_PAYLOAD_KEYS.has(key) && typeof value === "number" && Number.isFinite(value);
}
const COMMAND_PAYLOAD_KEY_RE =
  /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const CLI_SECRET_FLAG_RE = new RegExp(String.raw`^-{1,2}${SECRET_FIELD_NAME_PATTERN}$`, "i");
const JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:"|')?${SECRET_FIELD_NAME_PATTERN}(?:"|')?\s*:\s*(?:"|'))[^"'` + "`" + String.raw`\r\n]+((?:"|'))`,
  "gi",
);
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:\\")?${SECRET_FIELD_NAME_PATTERN}(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))`,
  "gi",
);
const SECRET_ENV_ASSIGNMENT_RE = new RegExp(
  String.raw`(\b${SECRET_FIELD_NAME_PATTERN}\s*=\s*)(?:(["'])([^"'` + "`" + String.raw`\r\n]*)\2|([^\s"'` + "`" + String.raw`]+))`,
  "gi",
);
const CONNECTION_STRING_RE =
  /\b(?:postgres(?:ql)?|mysql|redis(?:s)?|mongodb(?:\+srv)?):\/\/[^\s<>"'`]+/gi;
const AUTHORIZATION_HEADER_RE = /(\bAuthorization\s*:\s*)[^\r\n]+/gi;
const GITHUB_FINE_GRAINED_TOKEN_RE = /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g;
const COOLIFY_TOKEN_RE = /\bops_[A-Za-z0-9_-]{12,}\b/g;
const COOLIFY_NUMERIC_TOKEN_RE = /\b\d+\|[A-Za-z0-9_-]{12,}\b/g;
const COOLIFY_NUMERIC_TOKEN_HINT_RE = /\b\d+\|[A-Za-z0-9_-]{12,}\b/;
const TAILNET_AUTH_KEY_RE = /\btskey-[A-Za-z0-9_-]{12,}\b/g;
const SECRET_SHAPED_VALUE_RE = /[A-Za-z0-9+/_=-]{32,}/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_DIGEST_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SECRET_TEXT_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "webhook",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "ops_",
  "tskey-",
  "postgres://",
  "postgresql://",
  "mysql://",
  "redis://",
  "mongodb://",
] as const;
export const REDACTED_EVENT_VALUE = "***REDACTED***";
export const REDACTED_UNCLASSIFIED_COMMENT_VALUE =
  "[redacted: unclassified secret-shaped value]";

function maybeContainsSecretText(input: string) {
  const lower = input.toLowerCase();
  return SECRET_TEXT_HINTS.some((hint) => lower.includes(hint))
    || input.includes(".")
    || COOLIFY_NUMERIC_TOKEN_HINT_RE.test(input);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isUserSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isUserSecretRefBinding(value: unknown): value is { type: "user_secret_ref"; key: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "user_secret_ref" && typeof value.key === "string";
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
    if (
      SECRET_PAYLOAD_KEY_RE.test(key)
      && !AUDIT_REASON_PAYLOAD_KEY_RE.test(key)
      && !isAuditCountField(key, value)
    ) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isUserSecretRefBinding(value)) {
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
    if (typeof value === "string" && JWT_VALUE_RE.test(value) && !AUDIT_SURFACE_PAYLOAD_KEY_RE.test(key)) {
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
  if (!maybeContainsSecretText(input)) return input;
  return redactCommandText(
    input
      .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(
        SECRET_ENV_ASSIGNMENT_RE,
        (_match, prefix: string, quote: string | undefined) =>
          quote
            ? `${prefix}${quote}${REDACTED_EVENT_VALUE}${quote}`
            : `${prefix}${REDACTED_EVENT_VALUE}`,
      )
      .replace(AUTHORIZATION_HEADER_RE, `$1${REDACTED_EVENT_VALUE}`)
      .replace(CONNECTION_STRING_RE, REDACTED_EVENT_VALUE)
      .replace(GITHUB_FINE_GRAINED_TOKEN_RE, REDACTED_EVENT_VALUE)
      .replace(COOLIFY_TOKEN_RE, REDACTED_EVENT_VALUE)
      .replace(COOLIFY_NUMERIC_TOKEN_RE, REDACTED_EVENT_VALUE)
      .replace(TAILNET_AUTH_KEY_RE, REDACTED_EVENT_VALUE),
    REDACTED_EVENT_VALUE,
  );
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isUnclassifiedSecretShapedValue(value: string): boolean {
  if (UUID_RE.test(value) || HEX_DIGEST_RE.test(value)) return false;
  const characterClasses = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[+/_=-]/.test(value)]
    .filter(Boolean).length;
  return characterClasses >= 3 && shannonEntropy(value) >= 4.2;
}

/**
 * Sanitize a would-be issue comment at the final persistence boundary.
 *
 * Classified credential forms are replaced in place. If a line still contains
 * an opaque, high-entropy value after classified redaction, the whole line is
 * dropped so an unknown credential format cannot pass through by accident.
 */
export function sanitizeIssueCommentBody(input: string): string {
  const classified = redactSensitiveText(input);
  return classified
    .split("\n")
    .map((line) => {
      SECRET_SHAPED_VALUE_RE.lastIndex = 0;
      for (const match of line.matchAll(SECRET_SHAPED_VALUE_RE)) {
        if (isUnclassifiedSecretShapedValue(match[0])) {
          return REDACTED_UNCLASSIFIED_COMMENT_VALUE;
        }
      }
      return line;
    })
    .join("\n");
}
