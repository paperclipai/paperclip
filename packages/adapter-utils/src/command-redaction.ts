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
const COMMAND_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){2}(?:\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})?\b/g;
const POSTGRES_URL_WITH_USERINFO_RE =
  /(postgres(?:ql)?:\/\/)[^@/\s"`\\?#]+@/gi;
const POSTGRES_URL_SCHEME_RE = /postgres(?:ql)?:\/\//gi;
const POSTGRES_URL_SCHEMES = ["postgres://", "postgresql://"];
const MAX_PENDING_POSTGRES_USERINFO_CHARS = 8192;

function isConfirmedPostgresHost(value: string): boolean {
  // A path ends the authority. A dotted hostname (or localhost) followed by
  // whitespace is also a complete credential-free URL. Keep ambiguous
  // `user:password` prefixes hidden if a stream ends before its final @.
  return value.includes("/") ||
    (!value.includes(":") && (value.includes(".") || value === "localhost"));
}

/** Keep the URI scheme and host useful in diagnostics, but never expose userinfo. */
export function redactPostgresUrlUserinfo(
  text: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  return text.replace(
    POSTGRES_URL_WITH_USERINFO_RE,
    (_match, scheme: string) => `${scheme}${redactedValue}@`,
  );
}

/** Hold possible URI userinfo until its final `@`, even when output is split. */
export function createPostgresUrlStreamRedactor(
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
) {
  type State = { prefix: string; userinfo: string | null; overflow: boolean };
  const streams = new Map<string, State>();
  const getState = (stream: string) => {
    let state = streams.get(stream);
    if (!state) {
      state = { prefix: "", userinfo: null, overflow: false };
      streams.set(stream, state);
    }
    return state;
  };

  return {
    chunk(stream: string, chunk: string): string {
      const state = getState(stream);
      const input = state.prefix + chunk;
      state.prefix = "";
      let output = "";
      let index = 0;
      while (index < input.length) {
        if (state.userinfo !== null) {
          let boundary = index;
          while (boundary < input.length && !/[@\s"`<>\\]/.test(input[boundary])) boundary += 1;
          if (!state.overflow) {
            state.userinfo += input.slice(index, boundary);
            if (state.userinfo.length > MAX_PENDING_POSTGRES_USERINFO_CHARS) {
              state.userinfo = "";
              state.overflow = true;
            }
          }
          if (boundary === input.length) break;
          // A path before @ proves that this authority had no userinfo.
          // Keep ordinary host/database URLs useful in diagnostics.
          output += !state.overflow && input[boundary] !== "@" && isConfirmedPostgresHost(state.userinfo)
            ? state.userinfo
            : redactedValue;
          if (input[boundary] === "@") output += "@";
          else output += input[boundary];
          state.userinfo = null;
          state.overflow = false;
          index = boundary + 1;
          continue;
        }

        POSTGRES_URL_SCHEME_RE.lastIndex = index;
        const match = POSTGRES_URL_SCHEME_RE.exec(input);
        if (match) {
          output += input.slice(index, match.index) + match[0];
          index = POSTGRES_URL_SCHEME_RE.lastIndex;
          state.userinfo = "";
          continue;
        }
        const rest = input.slice(index);
        let prefixLength = 0;
        for (const scheme of POSTGRES_URL_SCHEMES) {
          for (let length = 1; length < Math.min(rest.length + 1, scheme.length); length += 1) {
            if (rest.slice(-length).toLowerCase() === scheme.slice(0, length)) {
              prefixLength = Math.max(prefixLength, length);
            }
          }
        }
        output += rest.slice(0, rest.length - prefixLength);
        state.prefix = rest.slice(rest.length - prefixLength);
        break;
      }
      return output;
    },
    finish(stream: string): string {
      const state = streams.get(stream);
      streams.delete(stream);
      if (!state) return "";
      return state.prefix + (state.userinfo === null ? "" :
        !state.overflow && isConfirmedPostgresHost(state.userinfo) && state.userinfo.includes("/")
          ? state.userinfo
          : redactedValue);
    },
  };
}
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
    lower.includes("postgres://") ||
    lower.includes("postgresql://") ||
    command.includes(".")
  );
}

export function redactCommandText(
  command: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  if (!maybeContainsSecretText(command)) return command;
  return redactPostgresUrlUserinfo(command, redactedValue)
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
