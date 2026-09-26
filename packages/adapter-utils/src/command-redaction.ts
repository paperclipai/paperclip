export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

// These exact public Executor helper addresses resemble dotted bearer tokens.
// Do not exempt arbitrary provider paths, prefixes, or user-defined selectors.
const PUBLIC_EXECUTOR_TOOL_SELECTORS = new Set([
  "executor.coreTools.integrations.list",
  "executor.coreTools.connections.list",
  "executor.coreTools.policies.list",
]);
export function isPublicExecutorToolSelector(value: string): boolean {
  return PUBLIC_EXECUTOR_TOOL_SELECTORS.has(value);
}

const SECRET_NAME_PATTERN = String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*`;

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
// Credential-bearing remotes and non-Bearer Authorization schemes. Git prints
// `https://<token>@github.com/...` on `git push -u` / clone failures. Known
// `ghp_`/`ghu_` prefixes were already scrubbed; opaque userinfo and
// `github_pat_` were not.
const COMMAND_AUTHORIZATION_SCHEME_RE =
  /(\bAuthorization\s*:\s*(?:Bearer|Basic|token)\s+)[^\s"'`]+/gi;
const COMMAND_URL_USERINFO_RE =
  /\b(https?:(?:\\*\/){2})([^/\s@\\]+)@/gi;
// A range or a truncated line can end after `https://<token>` and before `@`.
// A dotted host such as `https://github.com` is left alone. A single DNS label
// (no underscore, at most 63 characters) is also a hostname, not userinfo.
const COMMAND_URL_OPEN_USERINFO_RE =
  /\b(https?:(?:\\*\/){2})([A-Za-z0-9_-]{20,})$/g;
const COMMAND_URL_OPEN_USER_TOKEN_RE =
  /\b(https?:(?:\\*\/){2}[^/\s@\\]*:)([A-Za-z0-9_]{20,})$/g;
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{16,})\b/g;
const COMMAND_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
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
  "github_pat_",
] as const;

/**
 * Strip credential-bearing URL userinfo and Authorization header values.
 *
 * This is the narrow scanner safe to run again when reading a log that was
 * stored before the write-path gate existed. It does not apply the broader
 * JWT or JSON-field heuristics.
 */
export function redactTransportCredentials(
  text: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  if (!text) return text;
  const lower = text.toLowerCase();
  if (
    !text.includes("@") &&
    !lower.includes("authorization") &&
    !lower.includes("https://") &&
    !lower.includes("http://") &&
    !lower.includes("github_pat_") &&
    !lower.includes("ghp_") &&
    !lower.includes("gho_") &&
    !lower.includes("ghu_") &&
    !lower.includes("ghs_") &&
    !lower.includes("ghr_")
  ) {
    return text;
  }
  return text
    .replace(COMMAND_URL_USERINFO_RE, `$1${redactedValue}@`)
    .replace(COMMAND_URL_OPEN_USER_TOKEN_RE, `$1${redactedValue}`)
    .replace(COMMAND_URL_OPEN_USERINFO_RE, (match, prefix: string, label: string) =>
      isPlausibleHostnameLabel(label) ? match : `${prefix}${redactedValue}`,
    )
    .replace(COMMAND_AUTHORIZATION_SCHEME_RE, `$1${redactedValue}`)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue);
}

/** DNS label: letters, digits, and hyphens, 1–63 chars, no underscore. */
function isPlausibleHostnameLabel(label: string): boolean {
  if (label.length < 1 || label.length > 63 || label.includes("_")) return false;
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label);
}

function maybeContainsSecretText(command: string) {
  const lower = command.toLowerCase();
  return (
    COMMAND_SECRET_HINTS.some((hint) => lower.includes(hint)) ||
    command.includes(".")
  );
}

export function redactCommandText(
  command: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  if (!maybeContainsSecretText(command) && !command.includes("@")) return command;
  return redactTransportCredentials(command, redactedValue)
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
    .replace(COMMAND_JWT_RE, (match, offset: number, source: string) => {
      // The JWT heuristic may match only the first three segments; inspect the
      // complete address so a longer secret sharing a prefix stays redacted.
      const address = source.slice(offset).match(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/)?.[0];
      return address && isPublicExecutorToolSelector(address) ? match : redactedValue;
    });
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
