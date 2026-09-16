export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

const SECRET_KEYWORD_PATTERN = String.raw`(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)`;

const SECRET_NAME_RE = new RegExp(SECRET_KEYWORD_PATTERN, "i");
const COMMAND_CLI_HEADER_RE = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)(?:\s+|=)/g;
const COMMAND_CLI_VALUE_RE = new RegExp(
  String.raw`(["']?)[^\s"'` + "`" + String.raw`]+(\1)`,
  "y",
);
const COMMAND_ENV_HEADER_RE = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)\s*=\s*/g;
const COMMAND_ENV_VALUE_RE = new RegExp(
  String.raw`(?:(\\["'])([\s\S]*?)\1|(["'])([^"'` +
    "`" +
    String.raw`\r\n]*)\3|([^\s"'` + "`" + String.raw`]+))`,
  "y",
);
const COMMAND_AUTHORIZATION_BEARER_RE =
  /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const COMMAND_JWT_RE =
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
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
  return redactNamedValues(
    redactNamedValues(
      command.replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`),
      COMMAND_CLI_HEADER_RE,
      COMMAND_CLI_VALUE_RE,
      (match) => `${match[1]}${redactedValue}${match[1]}`,
      isSecretOption,
    ),
    COMMAND_ENV_HEADER_RE,
    COMMAND_ENV_VALUE_RE,
    (match) => {
      const quote = match[1] ?? match[3];
      return quote ? `${quote}${redactedValue}${quote}` : redactedValue;
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
const JSON_FIELD_HEADER_RE = /"([A-Za-z0-9_-]+)"\s*:\s*"/g;
const JSON_FIELD_VALUE_RE = /(?:\\[\s\S]|[^"\\])*(")/y;
const JSON_ESCAPED_FIELD_HEADER_RE = /\\"([A-Za-z0-9_-]+)\\"\s*:\s*\\"/g;
const JSON_ESCAPED_FIELD_VALUE_RE = /(?:\\\\\\\\|\\\\\\"|\\\\[\s\S]|[^\\"])*(\\")/y;

function isSecretOption(identifier: string): boolean {
  // Preserve the old non-word CLI boundary, including diagnostics such as
  // prefix---token. Inspect the identifier once instead of trying each dash
  // as another unbounded regexp start.
  for (let index = 0; index < identifier.length; index += 1) {
    if (identifier[index] === "-" && (index === 0 || identifier[index - 1] === "-")) {
      return SECRET_NAME_RE.test(identifier.slice(index + 1));
    }
  }
  return false;
}

// Consume each field/option identifier once. Classifying a keyword between
// unbounded identifier wildcards can retry every suffix of an encoded payload.
// Leave ordinary values searchable: they may contain nested secret diagnostics.
function redactNamedValues(
  input: string,
  header: RegExp,
  value: RegExp,
  replacement: (match: RegExpExecArray) => string,
  isSecretField: (key: string) => boolean = (key) => SECRET_NAME_RE.test(key),
): string {
  header.lastIndex = 0;
  const parts: string[] = [];
  let copiedThrough = 0;
  let field: RegExpExecArray | null;
  while ((field = header.exec(input)) !== null) {
    if (!isSecretField(field[1])) continue;
    value.lastIndex = header.lastIndex;
    const match = value.exec(input);
    if (!match) continue;
    parts.push(input.slice(copiedThrough, header.lastIndex), replacement(match));
    copiedThrough = value.lastIndex;
    header.lastIndex = value.lastIndex;
  }
  if (copiedThrough === 0) return input;
  parts.push(input.slice(copiedThrough));
  return parts.join("");
}

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
  return redactNamedValues(
    redactNamedValues(
      redactCommandText(text, redactedValue),
      JSON_ESCAPED_FIELD_HEADER_RE,
      JSON_ESCAPED_FIELD_VALUE_RE,
      (match) => `${redactedValue}${match[1]}`,
    ),
    JSON_FIELD_HEADER_RE,
    JSON_FIELD_VALUE_RE,
    (match) => `${redactedValue}${match[1]}`,
  );
}
