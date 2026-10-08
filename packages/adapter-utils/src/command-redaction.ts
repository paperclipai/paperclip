export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

// Public Executor helper addresses retained for callers of this predicate.
// Dotted addresses alone do not meet the JWT credential heuristic.
const PUBLIC_EXECUTOR_TOOL_SELECTORS = new Set([
  "executor.coreTools.integrations.list",
  "executor.coreTools.connections.list",
  "executor.coreTools.policies.list",
]);
export function isPublicExecutorToolSelector(value: string): boolean {
  return PUBLIC_EXECUTOR_TOOL_SELECTORS.has(value);
}

const SECRET_NAME_PATTERN = String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization(?:[-_]?code)?|bearer|secrets?|passwd|passwords?|credentials?|jwt|private[-_]?key|cookie|connectionstring)(?:[-_]?(?:value|header|prod(?:uction)?|dev(?:elopment)?|test|staging|primary|secondary))*`;

const COMMAND_CLI_SECRET_OPTION_RE = new RegExp(
  String.raw`(\B-{1,2}${SECRET_NAME_PATTERN}(?:\s+|=)(["']?))[^\s"'` +
    "`" +
    String.raw`]+(\2)`,
  "gi",
);
const COMMAND_ENV_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`(\b${SECRET_NAME_PATTERN}\s*=\s*)(?:(\\["'])([\s\S]*?)\2|(["'])([^"'` +
    "`" +
    String.raw`\r\n]*)\4|([^\s"'` +
    "`" +
    String.raw`]+))`,
  "gi",
);
const COMMAND_AUTHORIZATION_BEARER_RE =
  /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const CONNECTION_CREDENTIAL_ENV_KEY =
  String.raw`(?:DATABASE(?:_MIGRATION)?_URL|CONNECTION_STRING|DSN)(?:_[A-Za-z0-9_]+)?`;
const CONNECTION_ENV_ASSIGNMENT_RE = new RegExp(
  String.raw`(\b${CONNECTION_CREDENTIAL_ENV_KEY}\s*=\s*)(?:(\\["'])([\s\S]*?)\2|(["'])([^"'` +
    "`" +
    String.raw`\r\n]*)\4|([^\s"'` +
    "`" +
    String.raw`]+))`,
  "gi",
);
const URL_WITH_USERINFO_RE =
  /([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s?#:@]+)(?::[^/\s?#@]*)?@/gi;
const ESCAPED_NEWLINE_CONNECTION_ENV_RE = new RegExp(
  String.raw`\\n(${CONNECTION_CREDENTIAL_ENV_KEY}\s*=\s*)([^\s\\]*)`,
  "gi",
);
const COMMAND_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){2}(?:\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})?\b/g;
/** Recognize encoded JSON headers, without treating dotted identifiers as tokens. */
export function looksLikeCredentialJwt(value: string): boolean {
  const segments = value.split(".");
  if (![3, 5].includes(segments.length) || segments.some((part) => !/^[A-Za-z0-9_-]{8,}$/.test(part))) return false;
  if (segments[0].startsWith("eyJ")) return true;
  try {
    const header = JSON.parse(atob(segments[0].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof header === "object" && header !== null && typeof header.alg === "string";
  } catch {
    return false;
  }
}

const COMMAND_SECRET_HINTS = [
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

function maybeContainsSecretText(command: string) {
  const lower = command.toLowerCase();
  return (
    COMMAND_SECRET_HINTS.some((hint) => lower.includes(hint)) ||
    command.includes(".") ||
    (command.includes("://") && command.includes("@")) ||
    lower.includes("database_url")
  );
}

function redactUrlUserinfoAndConnectionAssignments(
  command: string,
  redactedValue: string,
) {
  return command
    .replace(
      CONNECTION_ENV_ASSIGNMENT_RE,
      (
        _match,
        prefix: string,
        escapedQuote: string | undefined,
        _escapedValue: string | undefined,
        rawQuote: string | undefined,
      ) => {
        const quote = escapedQuote ?? rawQuote;
        return quote
          ? `${prefix}${quote}${redactedValue}${quote}`
          : `${prefix}${redactedValue}`;
      },
    )
    .replace(URL_WITH_USERINFO_RE, `$1${redactedValue}@`)
    .replace(
      ESCAPED_NEWLINE_CONNECTION_ENV_RE,
      (_match, prefix: string) => `\\n${prefix}${redactedValue}`,
    );
}

export function redactCommandText(
  command: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  if (!maybeContainsSecretText(command)) return command;
  const withConnectionAssignments = redactUrlUserinfoAndConnectionAssignments(
    command,
    redactedValue,
  );
  return withConnectionAssignments
    .replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`)
    .replace(COMMAND_CLI_SECRET_OPTION_RE, `$1${redactedValue}$3`)
    .replace(
      COMMAND_ENV_SECRET_ASSIGNMENT_RE,
      (
        _match,
        prefix: string,
        escapedQuote: string | undefined,
        _escapedValue: string | undefined,
        rawQuote: string | undefined,
      ) => {
        const quote = escapedQuote ?? rawQuote;
        return quote
          ? `${prefix}${quote}${redactedValue}${quote}`
          : `${prefix}${redactedValue}`;
      },
    )
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_JWT_RE, (match) => looksLikeCredentialJwt(match) ? redactedValue : match);
}

// A JSON secret field is a key/value pair such as `"token":"opaque-value"`. The
// command redaction handles shell `KEY=value` syntax only. A sandbox diagnostic
// can also carry a serialized JSON error, so the sanitizer must redact the JSON
// form too. The value body consumes JSON escape sequences. An escaped quote
// (`\"`) inside the value does not end the match early.
const JSON_SECRET_FIELD_RE = new RegExp(
  String.raw`("(?:${SECRET_NAME_PATTERN})"\s*:\s*")(?:\\[\s\S]|[^"\\])*(")`,
  "gi",
);
// An escaped JSON secret field is the same pair inside a JSON string. The double
// quote appears as `\"` and a backslash appears as `\\`. The value body
// consumes the doubled escape sequences. An escaped quote inside the value does
// not end the match early. The value ends at the next unescaped `\"`.
const JSON_ESCAPED_SECRET_FIELD_RE = new RegExp(
  String.raw`(\\"(?:${SECRET_NAME_PATTERN})\\"\s*:\s*\\")(?:\\\\\\\\|\\\\\\"|\\\\[\s\S]|[^\\"])*(\\")`,
  "gi",
);

/**
 * Redact secrets from an untrusted diagnostic string.
 *
 * The function first runs the command redaction. The command redaction handles
 * shell `KEY=value` assignments, CLI secret options, bearer headers, and common
 * token shapes. The function then redacts JSON and escaped-JSON secret fields,
 * because a sandbox diagnostic can carry a serialized JSON error such as
 * `{"token":"opaque-value"}`. The caller must still bound the length after this
 * step.
 */
export function redactDiagnosticText(
  text: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  return redactCommandText(text, redactedValue)
    .replace(JSON_ESCAPED_SECRET_FIELD_RE, `$1${redactedValue}$2`)
    .replace(JSON_SECRET_FIELD_RE, `$1${redactedValue}$2`);
}
