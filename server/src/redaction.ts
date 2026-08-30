import { redactCommandText } from "@paperclipai/adapter-utils";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|browser[-_]?code|login[-_]?url)[A-Za-z0-9_-]*`;

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
const SECRET_TEXT_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
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
] as const;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function maybeContainsSecretText(input: string) {
  const lower = input.toLowerCase();
  return SECRET_TEXT_HINTS.some((hint) => lower.includes(hint)) || input.includes(".");
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

/**
 * Redact arbitrary JSON-like output before it crosses a durable or live
 * boundary. Unlike event-payload redaction, adapter results often place
 * unstructured process output under neutral keys such as `result` or `stderr`.
 */
export function redactSensitiveValue<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry)) as T;
  if (isSecretRefBinding(value) || isUserSecretRefBinding(value)) return value;
  if (!isPlainObject(value)) return value;

  const keySanitized = sanitizeRecord(value);
  return Object.fromEntries(
    Object.entries(keySanitized).map(([key, entry]) => [key, redactSensitiveValue(entry)]),
  ) as T;
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
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`),
    REDACTED_EVENT_VALUE,
  );
}

const DEFAULT_STREAM_REDACTION_PENDING_CHARS = 64 * 1024;
const OVERSIZED_STREAM_FRAME_MARKER =
  "[paperclip omitted oversized unterminated run log line]\n";
const SENSITIVE_STREAM_TAIL_MARKER =
  "[paperclip omitted potentially sensitive unterminated run log line]";

export type SensitiveTextStreamRedactor = {
  /**
   * Accept an arbitrary process-output chunk and return only complete,
   * sanitized logical-line frames that are safe to publish or persist.
   */
  push(chunk: string): string[];
  /** Flush a final unterminated frame without ever returning raw secret material. */
  flush(): string[];
};

/**
 * Frame process output before redaction so a credential split across arbitrary
 * adapter chunk boundaries cannot cross an irreversible log boundary.
 *
 * The current secret grammars are single-line, so LF is the safe commit point.
 * An oversized unterminated line is omitted and drained through its next LF to
 * keep retained raw state bounded. A sensitive-looking final tail that the
 * complete-text sanitizer cannot prove safe is omitted on flush.
 */
export function createSensitiveTextStreamRedactor(options: {
  sanitize: (frame: string) => string;
  maxPendingChars?: number;
}): SensitiveTextStreamRedactor {
  const maxPendingChars = Math.max(
    1,
    Math.floor(options.maxPendingChars ?? DEFAULT_STREAM_REDACTION_PENDING_CHARS),
  );
  let pending = "";
  let droppingOversizedLine = false;

  const push = (chunk: string): string[] => {
    if (chunk.length === 0) return [];
    const frames: string[] = [];
    let remaining = chunk;

    if (droppingOversizedLine) {
      const newlineIndex = remaining.indexOf("\n");
      if (newlineIndex < 0) return frames;
      droppingOversizedLine = false;
      remaining = remaining.slice(newlineIndex + 1);
      if (remaining.length === 0) return frames;
    }

    const combined = pending + remaining;
    const lastNewlineIndex = combined.lastIndexOf("\n");
    if (lastNewlineIndex >= 0) {
      const completeLines = combined.slice(0, lastNewlineIndex + 1);
      pending = combined.slice(lastNewlineIndex + 1);
      frames.push(options.sanitize(completeLines));
    } else {
      pending = combined;
    }

    if (pending.length > maxPendingChars) {
      pending = "";
      droppingOversizedLine = true;
      frames.push(OVERSIZED_STREAM_FRAME_MARKER);
    }
    return frames;
  };

  const flush = (): string[] => {
    if (droppingOversizedLine) {
      droppingOversizedLine = false;
      pending = "";
      return [];
    }
    if (pending.length === 0) return [];

    const finalFrame = pending;
    pending = "";
    const secretSanitized = redactSensitiveText(finalFrame);
    if (maybeContainsSecretText(finalFrame) && secretSanitized === finalFrame) {
      return [SENSITIVE_STREAM_TAIL_MARKER];
    }
    return [options.sanitize(finalFrame)];
  };

  return { push, flush };
}
