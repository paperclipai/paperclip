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
// A header value is the rest of its shell word, so a multi-part credential
// stays covered end to end. A shell word concatenates segments: an unquoted
// run, a double-quoted part, a single-quoted part, an ANSI-C `$'...'` part, and
// a backslash escape pair all join into one argument, and the rule consumes
// every segment of the word before it writes one placeholder. Whitespace and a
// shell metacharacter end the word, so the following argument survives. A
// quoted segment that opens the value may also end at a line break or at the
// end of the input, because a truncated run log writes an argument whose
// closing quote never arrives. The first segment of an unquoted value is a raw
// token: it may open on an escape pair but never on an escaped quote, which
// leaves an opener such as `Authorization: \"Bearer ...\"` to the caller's own
// rules, and a metacharacter inside it is a credential byte rather than a
// separator. Only a continuation segment stops at one. The unquoted
// branch also declines a name preceded by another name character or by an
// unescaped quote: such a name sits inside a longer name or inside a quoted
// argument that the quoted branches already own.
//
// An unquoted value may instead open as a comma-separated `key=value` list, the
// shape a `Digest`, `Concealed`, or `AWS4-HMAC-SHA256` credential takes. A
// parameter written as an HTTP quoted-string carries quoted-pairs and still
// rejects a raw line break. A continuation parameter must itself carry an `=`,
// so a bare word after the last parameter (`... response="r" status=401`)
// survives.
//
// An optional auth scheme stays in the output. The scheme is not a secret, and
// it tells a reader which credential form the command used. This also makes the
// rule agree with the bearer rule above for a well-formed bearer header, so
// `Authorization: Bearer <value>` produces the same output as before.
//
// Each branch treats the backslash the way its quoting context does. A
// double-quoted value consumes escape pairs, so an escaped quote inside the
// argument (`"X-API-Key: abc\"def"`) does not end the value early, and neither
// does a backslash-newline line continuation. Its opening quote must itself be
// unescaped. A serialized command writes that same argument with escaped
// quotes, so a fourth branch mirrors the double-quoted one over `\"`
// delimiters: it opens at an unescaped `\"`, consumes the doubled escape
// sequences an embedded `\"` or `\\` becomes, and closes at the next bare
// `\"`. A multi-part credential in a serialized diagnostic is therefore covered
// end to end, not truncated at its first escape. A single-quoted value takes a
// backslash literally, because a shell single quote has no escapes, while an
// ANSI-C value has escapes of its own. A quoted value must open with a
// non-blank character, so an empty header argument such as `-H "X-API-Key: "`
// stays as it is.
//
// The scheme list follows the IANA HTTP Authentication Scheme Registry as of
// the RFC 9729 `Concealed` addition, plus `AWS4-HMAC-SHA256`, `Hawk`, and
// `Token`, which are widely used but unregistered. A longer alternative
// precedes a shorter one that shares its prefix.
const COMMAND_AUTH_SCHEMES = [
  "AWS4-HMAC-SHA256",
  "Basic",
  "Bearer",
  "Concealed",
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
  String.raw`\\,=]+=(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s"'` +
  "`" +
  String.raw`\\,]*)`;
const COMMAND_SECRET_HEADER_PARAM_LIST_PATTERN =
  COMMAND_SECRET_HEADER_PARAM_PATTERN +
  String.raw`(?:[ \t]*,[ \t]*${COMMAND_SECRET_HEADER_PARAM_PATTERN})*`;
// The segments a shell word concatenates. A double-quoted part keeps its escape
// pairs and line continuations, a single-quoted part takes every byte
// literally, an ANSI-C `$'...'` part has its own escapes, a lone escape pair
// carries one character, and a plain run carries the rest.
const COMMAND_SHELL_QUOTED_SEGMENT_PATTERNS = [
  String.raw`"(?:\\\r?\n|\\.|[^"\\\r\n])*"`,
  String.raw`'[^'\r\n]*'`,
  String.raw`\$'(?:\\.|[^'\\\r\n])*'`,
] as const;
const COMMAND_SHELL_ESCAPE_PAIR_PATTERN = String.raw`\\[^\r\n]`;
// An opening escape pair carries the first byte of an unquoted value, as in
// `X-API-Key:\ abc`. It excludes the escaped quote, so a serialized `\"`
// opener stays with the caller's own rules.
const COMMAND_SHELL_OPENING_ESCAPE_PAIR_PATTERN = String.raw`\\[^"\r\n]`;
// The first segment of an unquoted value is a raw token, bounded only by
// whitespace, a quote, a backtick, or a backslash. A raw HTTP diagnostic
// carries an opaque credential the same way, so a `;`, `|`, or `&` inside it
// is a credential byte rather than a command separator.
const COMMAND_SHELL_RAW_TOKEN_PATTERN =
  String.raw`[^\s"'` + "`" + String.raw`\\]+`;
// A continuation segment follows a closing quote inside one shell word, where
// a metacharacter does end the word. Stopping there keeps a redaction from
// swallowing a separator, a redirection, or the next command.
const COMMAND_SHELL_PLAIN_SEGMENT_PATTERN =
  String.raw`[^\s"'` + "`" + String.raw`\\;|&<>()]+`;
const COMMAND_SHELL_SEGMENT_PATTERN = `(?:${[
  ...COMMAND_SHELL_QUOTED_SEGMENT_PATTERNS,
  COMMAND_SHELL_ESCAPE_PAIR_PATTERN,
  COMMAND_SHELL_PLAIN_SEGMENT_PATTERN,
].join("|")})`;
const COMMAND_SHELL_FIRST_SEGMENT_PATTERN = `(?:${[
  ...COMMAND_SHELL_QUOTED_SEGMENT_PATTERNS,
  COMMAND_SHELL_OPENING_ESCAPE_PAIR_PATTERN,
  COMMAND_SHELL_RAW_TOKEN_PATTERN,
].join("|")})`;
const COMMAND_SECRET_HEADER_CONTINUATION_PATTERN = `${COMMAND_SHELL_SEGMENT_PATTERN}*`;
const COMMAND_SECRET_HEADER_UNQUOTED_VALUE_PATTERN = `(?:${COMMAND_SECRET_HEADER_PARAM_LIST_PATTERN}|${COMMAND_SHELL_FIRST_SEGMENT_PATTERN})`;
// The escape units a serialized command writes inside an escaped-quoted
// argument: an escaped backslash followed by another escape (an embedded
// `\"` or `\\`), an escaped backslash followed by a plain character, or an
// ordinary escape such as `\n`. A bare `\"` is not a unit, so it closes the
// argument.
const COMMAND_SECRET_HEADER_JSON_ESCAPE_PATTERN = String.raw`\\\\\\.|\\\\[^\\]|\\[^"\\]`;
const COMMAND_SECRET_HEADER_RE = new RegExp(
  String.raw`(?<!\\)("${COMMAND_SECRET_HEADER_PREFIX_PATTERN})(?:\\.|[^\s"\\])(?:\\\r?\n|\\.|[^"\\\r\n])*\\?(?:(")|(?=[\r\n]|$))${COMMAND_SECRET_HEADER_CONTINUATION_PATTERN}` +
    String.raw`|('${COMMAND_SECRET_HEADER_PREFIX_PATTERN})[^\s'][^'\r\n]*(?:(')|(?=[\r\n]|$))${COMMAND_SECRET_HEADER_CONTINUATION_PATTERN}` +
    String.raw`|(\$'${COMMAND_SECRET_HEADER_PREFIX_PATTERN})(?:\\.|[^\s'\\])(?:\\.|[^'\\\r\n])*\\?(?:(')|(?=[\r\n]|$))${COMMAND_SECRET_HEADER_CONTINUATION_PATTERN}` +
    String.raw`|(?<!\\)(\\"${COMMAND_SECRET_HEADER_PREFIX_PATTERN})` +
    String.raw`(?:${COMMAND_SECRET_HEADER_JSON_ESCAPE_PATTERN}|[^\s"\\])` +
    String.raw`(?:${COMMAND_SECRET_HEADER_JSON_ESCAPE_PATTERN}|[^"\\\r\n])*(\\")` +
    String.raw`|(?<![A-Za-z0-9_-])(?<!(?<!\\)["'])(\b${COMMAND_SECRET_HEADER_PREFIX_PATTERN})${COMMAND_SECRET_HEADER_UNQUOTED_VALUE_PATTERN}${COMMAND_SECRET_HEADER_CONTINUATION_PATTERN}`,
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
        ansiCQuotedPrefix: string | undefined,
        ansiCQuoteClose: string | undefined,
        serializedPrefix: string | undefined,
        serializedClose: string | undefined,
        unquotedPrefix: string | undefined,
      ) => {
        // Exactly one branch matches, so exactly one prefix is defined.
        const prefix =
          doubleQuotedPrefix ??
          singleQuotedPrefix ??
          ansiCQuotedPrefix ??
          serializedPrefix ??
          unquotedPrefix ??
          "";
        const closingQuote =
          doubleQuoteClose ??
          singleQuoteClose ??
          ansiCQuoteClose ??
          serializedClose ??
          "";
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
