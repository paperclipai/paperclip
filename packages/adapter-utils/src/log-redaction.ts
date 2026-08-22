import type { TranscriptEntry } from "./types.js";

export const REDACTED_HOME_PATH_USER = "*";

export interface HomePathRedactionOptions {
  enabled?: boolean;
}

function maskHomePathUserSegment(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return REDACTED_HOME_PATH_USER;
  return `${trimmed[0]}${"*".repeat(Math.max(1, Array.from(trimmed).length - 1))}`;
}

const HOME_PATH_PATTERNS = [
  {
    regex: /\/Users\/([^/\\\s]+)/g,
    replace: (_match: string, user: string) => `/Users/${maskHomePathUserSegment(user)}`,
  },
  {
    regex: /\/home\/([^/\\\s]+)/g,
    replace: (_match: string, user: string) => `/home/${maskHomePathUserSegment(user)}`,
  },
  {
    regex: /([A-Za-z]:\\Users\\)([^\\/\s]+)/g,
    replace: (_match: string, prefix: string, user: string) => `${prefix}${maskHomePathUserSegment(user)}`,
  },
] as const;

// Runtime counterpart to the S3-sink redactor in report_run.py.
// Applied to child-process stdout/stderr and tool_result *before* those
// bytes are persisted into transcripts. Catches `env | grep`, `printenv`,
// and library errors that quote a DSN as cleartext `NAME=...` lines.
const CONN_STRING_PASSWORD_RE =
  /(postgres(?:ql)?|mysql|mysql2|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/([^:@\s/\\"]+):([^@\s/\\"]+)@/gi;

// Keep in lockstep with report_run.py `_ENV_DUMP_SECRET_NAMES` plus the
// dedicated ENTSOE / GRIDSTATUS name-anchored patterns in that file.
const ENV_DUMP_SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "PAPERCLIP_API_KEY",
  "STANDARD_POWER_API_KEY",
  "GITHUB_TOKEN",
  "K3_API_KEY",
  "OWM_API_KEY",
  "PJM_API_KEY",
  "UKPN_API_KEY",
  "URDB_API_KEY",
  "NORDPOOL_USERNAME",
  "NORDPOOL_PASSWORD",
  "DATABASE_URL",
  "ENTSOE_API_KEY",
  "GRIDSTATUS_API_KEY",
] as const;

// Tokens + connection strings. The NAME anchor is what prevents false positives.
const ENV_DUMP_VALUE_CHARSET = String.raw`[A-Za-z0-9/+=._\-:@?&%~]{4,}`;

// Matches `NAME=value`, `NAME: value`, JSON `"NAME":"value"`, and the
// NDJSON-escaped `\"NAME\": \"value\"` form. Optional backslash + quote
// wrappers must be `\\?` (optional `\`), not `\?` (optional `?`) — the
// latter never matches a bare `NAME=...` env dump.
const ENV_DUMP_PATTERNS: Array<{ re: RegExp; name: string }> = ENV_DUMP_SECRET_NAMES.map(
  (name) => ({
    name,
    re: new RegExp(
      name + String.raw`\\?["']?\s*[=:]\s*\\?["']?` + ENV_DUMP_VALUE_CHARSET + String.raw`\\?["']?`,
      "gi",
    ),
  }),
);

const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9._-]{20,}/g;
const GITHUB_APP_TOKEN_RE = /ghs_[A-Za-z0-9]{20,}/g;

function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(CONN_STRING_PASSWORD_RE, (_m, scheme: string, user: string) =>
    `${scheme}://${user}:<DB_PASSWORD_REDACTED>@`,
  );
  out = out.replace(ANTHROPIC_KEY_RE, "<ANTHROPIC_API_KEY_REDACTED>");
  out = out.replace(GITHUB_APP_TOKEN_RE, "<GITHUB_APP_TOKEN_REDACTED>");
  for (const { re, name } of ENV_DUMP_PATTERNS) {
    out = out.replace(re, `${name}=<${name}_REDACTED>`);
  }
  return out;
}

function redactSecretsInValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsInValue(entry)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactSecretsInValue(entry);
  }
  return redacted as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function redactHomePathUserSegments(text: string, opts?: HomePathRedactionOptions): string {
  if (opts?.enabled === false) return text;
  let result = text;
  for (const pattern of HOME_PATH_PATTERNS) {
    result = result.replace(pattern.regex, pattern.replace);
  }
  return result;
}

export function redactHomePathUserSegmentsInValue<T>(value: T, opts?: HomePathRedactionOptions): T {
  if (typeof value === "string") {
    return redactHomePathUserSegments(value, opts) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactHomePathUserSegmentsInValue(entry, opts)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactHomePathUserSegmentsInValue(entry, opts);
  }
  return redacted as T;
}

/** Redact env dumps and connection-string passwords from free text. */
export function redactSecretsInText(text: string): string {
  return redactSecrets(text);
}

export function redactTranscriptEntryPaths(entry: TranscriptEntry, opts?: HomePathRedactionOptions): TranscriptEntry {
  const redactText = (s: string) => redactSecrets(redactHomePathUserSegments(s, opts));

  switch (entry.kind) {
    case "assistant":
    case "thinking":
    case "user":
    case "stderr":
    case "system":
    case "stdout":
    case "diff":
      return { ...entry, text: redactText(entry.text) };
    case "tool_call":
      return {
        ...entry,
        name: redactHomePathUserSegments(entry.name, opts),
        input: redactSecretsInValue(redactHomePathUserSegmentsInValue(entry.input, opts)),
      };
    case "tool_result":
      return { ...entry, content: redactText(entry.content) };
    case "init":
      return {
        ...entry,
        model: redactHomePathUserSegments(entry.model, opts),
        sessionId: redactHomePathUserSegments(entry.sessionId, opts),
      };
    case "result":
      return {
        ...entry,
        text: redactText(entry.text),
        subtype: redactHomePathUserSegments(entry.subtype, opts),
        errors: entry.errors.map((error) => redactText(error)),
      };
    default:
      return entry;
  }
}
