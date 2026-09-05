export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

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
// A secret-bearing header names a credential in its own header name. The public
// Paperclip API documents `X-API-Key`, and a run log can also carry `Api-Key`,
// `X-Auth-Token`, `X-Paperclip-Api-Key`, or a bare `Authorization`. This rule
// redacts the value of such a header wherever it appears in command text.
//
// A header name is either a hyphenated or underscored word carrying an api-key,
// token, secret, or auth hint, or one of the bare names `authorization` and
// `apikey`. Requiring the hinted form to open with an alphanumeric run and then
// a `-` or `_` keeps the rule off prose and paths that merely contain a hint
// word, such as `GET /v1/tokens:list` or `auth: failed`, and keeps a match from
// opening at the hyphen inside a longer name. `www-authenticate` and
// `proxy-authenticate` are excluded: they are response headers whose
// `error="invalid_token"` parameters are diagnostics worth keeping.
//
// The value is bounded by its context, so a multi-part credential stays covered
// end to end. Inside a double- or single-quoted shell argument the value runs to
// the closing quote. Unquoted, the value is either a comma-separated `key=value`
// list, the shape a `Digest` or `AWS4-HMAC-SHA256` credential takes, or a single
// whitespace-delimited token. A continuation parameter must itself carry an `=`,
// so a bare word after the last parameter (`... response="r" status=401`)
// survives.
//
// An optional auth scheme stays in the output. The scheme is not a secret, and
// it tells a reader which credential form the command used. This also makes the
// rule agree byte for byte with the bearer rule above, so
// `Authorization: Bearer <value>` produces the same output as before.
//
// Each branch treats the backslash the way its quoting context does. A
// double-quoted value consumes escape pairs, so an escaped quote inside the
// argument (`"X-API-Key: abc\"def"`) does not end the value early. Its opening
// quote must itself be unescaped, which keeps the branch off a serialized
// diagnostic such as `\"X-API-Key: ...\"`, where the closing `\"` must survive.
// A single-quoted value takes a backslash literally, because a shell single
// quote has no escapes. Only the unquoted branch stops at a backslash, so an
// escaped-quote opener such as `Authorization: \"Bearer ...\"` is left to the
// caller's own authorization rules. A quoted value must open with a non-blank
// character, so an empty header argument such as `-H "X-API-Key: "` stays as it
// is.
//
// The schemes come from the IANA HTTP Authentication Scheme Registry, plus
// `AWS4-HMAC-SHA256` and `Token`, which are widely used but unregistered. A
// longer alternative precedes a shorter one that shares its prefix.
const COMMAND_AUTH_SCHEMES = [
  "AWS4-HMAC-SHA256",
  "Basic",
  "Bearer",
  "Digest",
  "DPoP",
  "GNAP",
  "Hawk",
  "HOBA",
  "Mutual",
  "Negotiate",
  "OAuth",
  "PrivateToken",
  "SCRAM-SHA-256",
  "SCRAM-SHA-1",
  "Token",
  "vapid",
] as const;
const COMMAND_SECRET_HEADER_HINT_PATTERN = String.raw`(?:api[-_]?key|token|secret|auth)`;
const COMMAND_SECRET_HEADER_NAME_PATTERN =
  String.raw`(?!(?:www|proxy)-authenticate\b)(?:(?=[A-Za-z0-9]+[-_])[A-Za-z0-9_-]*${COMMAND_SECRET_HEADER_HINT_PATTERN}[A-Za-z0-9_-]*|authorization|apikey)`;
const COMMAND_SECRET_HEADER_PREFIX_PATTERN =
  COMMAND_SECRET_HEADER_NAME_PATTERN +
  String.raw`[ \t]*:[ \t]*(?:(?:${COMMAND_AUTH_SCHEMES.join("|")})[ \t]+)?`;
const COMMAND_SECRET_HEADER_PARAM_PATTERN =
  String.raw`[^\s"'` +
  "`" +
  String.raw`\\,=]+=(?:"[^"\\\r\n]*"|'[^'\\\r\n]*'|[^\s"'` +
  "`" +
  String.raw`\\,]*)`;
const COMMAND_SECRET_HEADER_UNQUOTED_VALUE_PATTERN =
  String.raw`(?:${COMMAND_SECRET_HEADER_PARAM_PATTERN}(?:[ \t]*,[ \t]*${COMMAND_SECRET_HEADER_PARAM_PATTERN})*|[^\s\\"'` +
  "`" +
  String.raw`]+)`;
const COMMAND_SECRET_HEADER_RE = new RegExp(
  String.raw`(?<!\\)("${COMMAND_SECRET_HEADER_PREFIX_PATTERN})(?:\\.|[^\s"\\])(?:\\.|[^"\\\r\n])*(")` +
    String.raw`|('${COMMAND_SECRET_HEADER_PREFIX_PATTERN})[^\s'][^'\r\n]*(')` +
    String.raw`|(\b${COMMAND_SECRET_HEADER_PREFIX_PATTERN})${COMMAND_SECRET_HEADER_UNQUOTED_VALUE_PATTERN}`,
  "gi",
);
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
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
] as const;

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
  if (!maybeContainsSecretText(command)) return command;
  return command
    .replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`)
    .replace(
      COMMAND_SECRET_HEADER_RE,
      (
        _match,
        doubleQuotedPrefix: string | undefined,
        doubleQuoteClose: string | undefined,
        singleQuotedPrefix: string | undefined,
        singleQuoteClose: string | undefined,
        unquotedPrefix: string | undefined,
      ) => {
        const prefix =
          doubleQuotedPrefix ?? singleQuotedPrefix ?? unquotedPrefix ?? "";
        const closingQuote = doubleQuoteClose ?? singleQuoteClose ?? "";
        return `${prefix}${redactedValue}${closingQuote}`;
      },
    )
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
    .replace(COMMAND_JWT_RE, redactedValue);
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
