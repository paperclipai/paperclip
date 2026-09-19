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
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_STRIPE_KEY_RE = /\bsk_(?:live|test)_[A-Za-z0-9]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const COMMAND_AWS_ACCESS_KEY_ID_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const COMMAND_AWS_SECRET_ACCESS_KEY_RE = new RegExp(
  String.raw`(\b(?:aws[ _-]?secret[ _-]?(?:access[ _-]?)?key|secretaccesskey)\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(["']?)`,
  "gi",
);
// AWS secret access keys have no provider prefix. Limit bare-value matching to
// the documented 40-character base64 shape with mixed case and a '/' or '+';
// context-labelled values remain covered even when they are entirely alphanumeric.
const COMMAND_AWS_SECRET_ACCESS_KEY_SHAPE_RE =
  /(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=]))(?=[A-Za-z0-9/+=]{0,39}[+/])(?=[A-Za-z0-9/+=]{0,39}[a-z])(?=[A-Za-z0-9/+=]{0,39}[A-Z])[A-Za-z0-9/+=]{40}/g;
const COMMAND_INLINE_DSN_PASSWORD_RE =
  /(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^:\s/@]+:)[^@\s]+(@)/gi;
const COMMAND_PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
// Paperclip-issued bearer credentials. Minted in server/src/services/board-auth.ts as
// `pcp_board_<48 hex>` and `pcp_cli_auth_<48 hex>`; the prefix segment is matched
// generically so a future `pcp_<kind>_` credential is covered without another edit.
// These are value-shaped: they leak as bare tokens in process stdout and in HTTP
// header dumps, where no adjacent `key=` or `--flag` gives the name-based rules a handle.
const COMMAND_PAPERCLIP_TOKEN_RE = /\bpcp_[a-z][a-z0-9_]*_[0-9a-f]{24,}\b/gi;
// Slack tokens: bot (xoxb), user (xoxp), app (xoxa/xoxr), refresh (xoxs), and
// app-level (xapp).
const COMMAND_SLACK_TOKEN_RE = /\b(?:xox[abprs]|xapp)-[A-Za-z0-9-]{10,}\b/g;
const COMMAND_JWT_CANDIDATE_RE =
  /\b[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){2,}\b/g;
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
  "sk_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  // Value-prefix hints. Without these, a chunk carrying a bare `pcp_board_...` or
  // `xoxb-...` and nothing else can short-circuit out of redactCommandText before
  // the patterns above ever run.
  "pcp_",
  "xox",
  "xapp-",
  "akia",
  "asia",
  "postgres://",
  "postgresql://",
  "mysql://",
  "mariadb://",
  "mongodb://",
  "mongodb+srv://",
  "redis://",
  "rediss://",
  "amqp://",
  "amqps://",
] as const;

function maybeContainsSecretText(command: string) {
  const lower = command.toLowerCase();
  COMMAND_AWS_SECRET_ACCESS_KEY_SHAPE_RE.lastIndex = 0;
  const hasAwsSecretKeyShape = COMMAND_AWS_SECRET_ACCESS_KEY_SHAPE_RE.test(command);
  COMMAND_AWS_SECRET_ACCESS_KEY_SHAPE_RE.lastIndex = 0;
  return (
    COMMAND_SECRET_HINTS.some((hint) => lower.includes(hint)) ||
    command.includes(".") ||
    hasAwsSecretKeyShape
  );
}

function hasJwtAlgorithmHeader(candidate: string): boolean {
  const [encodedHeader] = candidate.split(".");
  if (!encodedHeader) return false;
  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as {
      alg?: unknown;
    };
    return Boolean(
      header &&
      typeof header === "object" &&
      typeof header.alg === "string" &&
      header.alg.length > 0,
    );
  } catch {
    return false;
  }
}

function redactJwtCandidate(candidate: string, redactedValue: string): string {
  const segments = candidate.split(".");
  const headerIndex = segments.findIndex((segment) => hasJwtAlgorithmHeader(segment));
  const remainingSegments = segments.length - headerIndex;
  if (headerIndex < 0 || remainingSegments < 3) return candidate;

  // A compact JWS has three segments and a compact JWE has five. Redact at
  // most five segments from the validated header, preserving any dotted
  // identifier prefix or suffix that the broad candidate matcher included.
  const tokenSegmentCount = Math.min(5, remainingSegments);
  const prefix = segments.slice(0, headerIndex);
  const suffix = segments.slice(headerIndex + tokenSegmentCount);
  return [...prefix, redactedValue, ...suffix].join(".");
}

export function redactCommandText(
  command: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  if (!maybeContainsSecretText(command)) return command;
  return command
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
    .replace(COMMAND_STRIPE_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_PAPERCLIP_TOKEN_RE, redactedValue)
    .replace(COMMAND_SLACK_TOKEN_RE, redactedValue)
    .replace(COMMAND_AWS_ACCESS_KEY_ID_RE, redactedValue)
    .replace(COMMAND_AWS_SECRET_ACCESS_KEY_RE, `$1${redactedValue}$2`)
    .replace(COMMAND_AWS_SECRET_ACCESS_KEY_SHAPE_RE, redactedValue)
    .replace(COMMAND_INLINE_DSN_PASSWORD_RE, `$1${redactedValue}$2`)
    .replace(COMMAND_PRIVATE_KEY_BLOCK_RE, redactedValue)
    .replace(
      COMMAND_JWT_CANDIDATE_RE,
      (candidate) => redactJwtCandidate(candidate, redactedValue),
    );
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

export interface DiagnosticRedactionResult {
  text: string;
  redactionCount: number;
}

/**
 * Redact a bounded diagnostic string and report how many replacement markers
 * were introduced. The marker is selected so source text cannot be mistaken
 * for a hit, and overlapping rules collapse to the single surviving marker.
 */
export function redactDiagnosticTextWithStats(
  text: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): DiagnosticRedactionResult {
  let marker = "\u0000paperclip-redaction-hit\u0000";
  while (text.includes(marker)) marker += "\u0000";
  const marked = redactDiagnosticText(text, marker);
  const parts = marked.split(marker);
  return {
    text: parts.join(redactedValue),
    redactionCount: parts.length - 1,
  };
}
