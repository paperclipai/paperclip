import { redactCommandText } from "@paperclipai/adapter-utils";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*`;

const SECRET_PAYLOAD_KEY_RE = new RegExp(SECRET_FIELD_NAME_PATTERN, "i");
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

function isError(value: unknown): value is Error {
  return value instanceof Error;
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
  if (!maybeContainsSecretText(input)) return input;
  return redactCommandText(
    input
      .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`),
    REDACTED_EVENT_VALUE,
  );
}

function redactSensitiveLogValueInternal(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object") return value;
  if (depth > 12) return "[Truncated]";

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveLogValueInternal(entry, seen, depth + 1));
  }

  if (value instanceof Date) return value;

  if (isError(value)) {
    const serialized: Record<string, unknown> = {
      type: value.constructor?.name ?? "Error",
      message: redactSensitiveText(value.message),
      stack: value.stack ? redactSensitiveText(value.stack) : undefined,
    };
    for (const [key, entry] of Object.entries(value as Error & Record<string, unknown>)) {
      if (key in serialized) continue;
      serialized[key] = SECRET_PAYLOAD_KEY_RE.test(key)
        ? REDACTED_EVENT_VALUE
        : redactSensitiveLogValueInternal(entry, seen, depth + 1);
    }
    const cause = (value as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      serialized.cause = redactSensitiveLogValueInternal(cause, seen, depth + 1);
    }
    return serialized;
  }

  if (!isPlainObject(value)) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SECRET_PAYLOAD_KEY_RE.test(key)
      ? REDACTED_EVENT_VALUE
      : redactSensitiveLogValueInternal(entry, seen, depth + 1);
  }
  return redacted;
}

export function redactSensitiveLogValue<T>(value: T): T {
  return redactSensitiveLogValueInternal(value, new WeakSet<object>(), 0) as T;
}
