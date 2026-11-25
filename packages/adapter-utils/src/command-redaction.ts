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

const SECRET_NAME_WORDS = String.raw`(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization(?:[-_]?code)?|bearer|secrets?|passwd|passwords?|credentials?|jwt|private[-_]?key|cookie|connectionstring)(?:[-_]?(?:value|header|prod(?:uction)?|dev(?:elopment)?|test|staging|primary|secondary))*`;
const SECRET_NAME_PATTERN = String.raw`[A-Za-z0-9_-]*${SECRET_NAME_WORDS}`;
const SECRET_NAME_START = String.raw`(?<![A-Za-z0-9_-])`;
const SECRET_OPTION_NAME_PATTERN = String.raw`(?:[A-Za-z0-9_]|-(?!-))*${SECRET_NAME_WORDS}`;

const COMMAND_CLI_SECRET_OPTION_RE = new RegExp(
  String.raw`(\B-{1,2}${SECRET_OPTION_NAME_PATTERN}(?:\s+|=)(["']?))[^\s"'` +
    "`" +
    String.raw`]+(\2)`,
  "gi",
);
const COMMAND_ENV_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`(${SECRET_NAME_START}${SECRET_NAME_PATTERN}\s*=\s*)(?:(\\["'])([\s\S]*?)\2|(["'])([^"'` +
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
  /\b(?<![A-Za-z0-9_]-*)[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){2}(?:\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})?\b/g;
/** Recognize encoded JSON headers, without treating dotted identifiers as tokens. */
export function looksLikeCredentialJwt(value: string): boolean {
  const segments = value.split(".");
  if (![3, 5].includes(segments.length)) return false;
  if (segments.some((part, index) => {
    // Compact JWE direct encryption has no encrypted-key value.
    if (segments.length === 5 && index === 1 && part === "") return false;
    return !/^[A-Za-z0-9_-]+$/.test(part);
  })) return false;
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
    command.includes(".")
  );
}

// An AWS SigV4 presigned URL is a short-lived capability for one operation on
// one object, which a tool returns on purpose (for example a receipt upload
// link). Its `X-Amz-Credential` (access key ID and scope) and
// `X-Amz-Security-Token` (an STS session token, unusable without the secret
// key) match the secret-name rule, and the unquoted value then hides the rest
// of the URL, so the link cannot be used. Inside a complete SigV4 query only,
// these two parameters are set aside before redaction and put back after it.
// Every other parameter is redacted as before, and a URL that is itself the
// value of a secret-named assignment or option is still hidden whole.
const PRESIGNED_URL_RE = /https:\/\/(?:[^\s"'`<>\\]|\\{1,2}u0026)+/gi;
const PRESIGNED_URL_TRAILING_DELIMITERS_RE = /[)\]}.,;]+$/;
const PRESIGNED_QUERY_SEPARATOR_RE = /(&|\\{1,2}u0026)/i;
const SIGV4_CREDENTIAL_PARAM_RE =
  /^X-Amz-Credential=(?:[A-Za-z0-9._~+-]|%(?!2[Ff])[0-9A-Fa-f]{2})+(?:%2F|\/)\d{8}(?:%2F|\/)[A-Za-z0-9_-]+(?:%2F|\/)[A-Za-z0-9_-]+(?:%2F|\/)aws4_request$/i;
const SIGV4_SECURITY_TOKEN_PARAM_RE =
  /^X-Amz-Security-Token=(?:[A-Za-z0-9+/._~-]|%[0-9A-Fa-f]{2})+=*$/i;
const STANDALONE_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/;
const STANDALONE_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/;
// Private-use placeholders. Text that already contains them is left to the normal rules.
const KEPT_START = String.fromCharCode(0xe000);
const KEPT_END = String.fromCharCode(0xe001);
const KEPT_PLACEHOLDER_RE = new RegExp(`${KEPT_START}(\\d+)${KEPT_END}`, "g");

function containsStandaloneSecretToken(value: string): boolean {
  if (STANDALONE_OPENAI_KEY_RE.test(value) || STANDALONE_GITHUB_TOKEN_RE.test(value)) {
    return true;
  }
  const jwtMatches = value.match(COMMAND_JWT_RE);
  return jwtMatches !== null && jwtMatches.some(looksLikeCredentialJwt);
}

function isSigV4PresignedQuery(parameters: string[]): boolean {
  return (
    parameters.some((part) => /^X-Amz-Algorithm=AWS4-HMAC-SHA256$/i.test(part)) &&
    parameters.some((part) => SIGV4_CREDENTIAL_PARAM_RE.test(part)) &&
    parameters.some((part) => /^X-Amz-Date=\d{8}T\d{6}Z$/i.test(part)) &&
    parameters.some((part) => /^X-Amz-Expires=\d+$/i.test(part)) &&
    parameters.some((part) => /^X-Amz-SignedHeaders=[^=&\s]+$/i.test(part)) &&
    parameters.some((part) => /^X-Amz-Signature=[0-9a-f]{64}$/i.test(part))
  );
}

function isKeptSigV4Parameter(part: string): boolean {
  if (!SIGV4_CREDENTIAL_PARAM_RE.test(part) && !SIGV4_SECURITY_TOKEN_PARAM_RE.test(part)) {
    return false;
  }
  const value = part.slice(part.indexOf("=") + 1);
  return !containsStandaloneSecretToken(value);
}

function setAsidePresignedUrlParameters(text: string) {
  const kept: string[] = [];
  if (!/X-Amz-Signature=/i.test(text) || text.includes(KEPT_START) || text.includes(KEPT_END)) {
    return { text, kept };
  }
  const protectedText = text.replace(PRESIGNED_URL_RE, (match) => {
    const trailingMatch = PRESIGNED_URL_TRAILING_DELIMITERS_RE.exec(match);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    const queryStart = url.indexOf("?");
    if (queryStart < 0) return match;
    // The capture group keeps each separator at an odd index.
    const parts = url.slice(queryStart + 1).split(PRESIGNED_QUERY_SEPARATOR_RE);
    if (!isSigV4PresignedQuery(parts.filter((_, index) => index % 2 === 0))) return match;
    return (
      url.slice(0, queryStart + 1) +
      parts
        .map((part, index) =>
          index % 2 === 0 && isKeptSigV4Parameter(part)
            ? `${KEPT_START}${kept.push(part) - 1}${KEPT_END}`
            : part,
        )
        .join("") +
      trailing
    );
  });
  return { text: protectedText, kept };
}

export function redactCommandText(
  command: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  if (!maybeContainsSecretText(command)) return command;
  const { text, kept } = setAsidePresignedUrlParameters(command);
  const redacted = redactSetAsideCommandText(text, redactedValue);
  return kept.length === 0
    ? redacted
    : redacted.replace(KEPT_PLACEHOLDER_RE, (match, index: string) => kept[Number(index)] ?? match);
}

function redactSetAsideCommandText(command: string, redactedValue: string): string {
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

const PUBLIC_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG",
  "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "NODE_ENV",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "PWD", "OLDPWD", "INIT_CWD", "SHLVL", "_", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM",
  "NPM_LIFECYCLE_EVENT", "NPM_COMMAND", "NPM_EXEC_PATH", "NPM_EXECPATH", "NPM_NODE_EXECPATH",
  "NPM_PACKAGE_NAME", "NPM_PACKAGE_VERSION", "NPM_PACKAGE_JSON", "NPM_CONFIG_USER_AGENT",
  "XPC_SERVICE_NAME", "VITEST_POOL_ID", "VITEST_WORKER_ID",
  "REGION", "AWS_REGION", "AWS_DEFAULT_REGION", "KEYBOARD_LAYOUT", "PUBLIC_KEY_PATH", "PUBLIC_KEY",
  "SORT_KEY", "CACHE_KEY", "ROUTING_KEY", "PARTITION_KEY", "IDEMPOTENCY_KEY",
  "PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_TASK_ID",
]);
const PUBLIC_BOOLEAN_ENV_KEYS = new Set([
  "OPENCODE_ALLOW_ALL_MODELS", "CLAUDE_CODE_USE_BEDROCK", "GOOGLE_GENAI_USE_GCA",
  "CI", "NO_COLOR", "FORCE_COLOR",
  "VITEST", "MALLOCNANOZONE", "CODEX_CI", "CODEX_SHELL", "CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE",
  "DEV", "PROD", "SSR", "PAPERCLIP_REQUIRE_SENTRY_TEST_SDK",
  "PAPERCLIP_DB_BACKUP_ENABLED", "PAPERCLIP_WORKSPACE_COMPACTION_ENABLED", "PAPERCLIP_AUTH_DISABLE_SIGN_UP", "PAPERCLIP_ENABLE_COMPANY_DELETION",
  "PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE", "PAPERCLIP_SECRETS_STRICT_MODE",
  "SERVE_UI", "PAPERCLIP_UI_DEV_MIDDLEWARE", "HEARTBEAT_SCHEDULER_ENABLED", "PAPERCLIP_ANNOUNCEMENTS_ENABLED",
  "GITHUB_ACTIONS", "GITHUB_REF_PROTECTED", "RUNNER_DEBUG", "ACTIONS_RUNNER_DEBUG", "ACTIONS_STEP_DEBUG",
]);
const PUBLIC_NUMBER_ENV_KEYS = new Set([
  "PORT", "PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES", "PAPERCLIP_DB_BACKUP_RETENTION_DAYS",
  "PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "PAPERCLIP_WORKSPACE_COMPACTION_DELAY_HOURS",
  "HEARTBEAT_SCHEDULER_INTERVAL_MS",
  "GITHUB_RUN_ATTEMPT", "GITHUB_RUN_NUMBER", "GITHUB_RUN_ID", "GITHUB_RETENTION_DAYS",
]);

// A setting name and a bounded value must agree before it is public. Unknown
// opaque values remain private; declared bindings always override these rules.
function isOrdinaryDiagnosticEnvSetting(key: string, value: string): boolean {
  const name = key.toUpperCase();
  if (PUBLIC_ENV_KEYS.has(name)) return true;
  if ((PUBLIC_BOOLEAN_ENV_KEYS.has(name) || /(?:^|_)(?:FLAG|ENABLED|DISABLED|DEBUG)$/.test(name)) &&
    /^(?:0|1|true|false)$/i.test(value)) return true;
  if ((PUBLIC_NUMBER_ENV_KEYS.has(name) || /(?:^|_)(?:COUNT|WORKERS|PORT|MAX_TOKENS)$/.test(name)) &&
    /^\d+$/.test(value)) return true;
  return (name === "BASE_URL" && value === "/") ||
    (/(?:^|_)MODE$/.test(name) && /^(?:test|development|production|safe)$/.test(value)) ||
    (name === "PAPERCLIP_SENTRY_RUN_FAILURES" && /^(?:off|unexpected|all)$/.test(value));
}

/** In the host process environment, an undeclared value under an
 * unrecognized name is redacted as a substring only if it could be a
 * credential: at least 8 characters, and not a bare number, hex number or
 * boolean-like word. Shorter values ("vi", "RUN") are redacted only as whole
 * tokens (`collectHostEnvironmentTokenSecrets`): as substrings they corrupted
 * unrelated report text ("service" became "ser***REDACTED***ce"). Declared,
 * secret-named and credential-shaped values are always substring-private. An
 * agent's configured environment keeps the fail-closed substring rule. */
function plausibleUndeclaredCredential(key: string, value: string): boolean {
  if (credentialNameSegments(key)) return true;
  return value.length >= 8 && !/^(?:\d+|0x[0-9a-f]+|true|false|on|off|yes|no)$/i.test(value);
}

const CREDENTIAL_SEGMENTS = new Set(["TOKEN", "TOKENS", "SECRET", "SECRETS", "PASSWORD", "PASSWD", "PASSPHRASE",
  "CREDENTIAL", "CREDENTIALS", "PRIVATE", "BEARER", "AUTHORIZATION", "APIKEY"]);

/** A name with a credential segment (AWS_SECRET_ACCESS_KEY, AWS_BEARER_TOKEN_BEDROCK),
 * or a KEY segment that is last or followed only by ID (KEY, AWS_ACCESS_KEY_ID).
 * Such a value stays private whatever its length. */
function credentialNameSegments(key: string): boolean {
  const segments = key.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  return segments.some((segment, index) => CREDENTIAL_SEGMENTS.has(segment) ||
    (segment === "KEY" && (index === segments.length - 1 || (index === segments.length - 2 && segments[index + 1] === "ID"))));
}

const BOOLEAN_WORD = /^(?:true|false|on|off|yes|no)$/i;

/**
 * Host process values under unknown names that are too short or too plain to
 * redact as substrings (see `plausibleUndeclaredCredential`). They are still
 * private: callers redact them where they appear as a whole token, numbers
 * included. Only flag values are exempt (boolean words, and `0` or `1`): they
 * cannot hold a credential, and as tokens they would erase ordinary words
 * ("on", "no") and exit codes from every report.
 */
export function collectHostEnvironmentTokenSecrets(env: unknown): string[] {
  if (!env || typeof env !== "object") return [];
  const substringValues = new Set(collectDiagnosticEnvironmentSecrets(env, [], { hostProcess: true }));
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || !value.trim() || substringValues.has(value)) continue;
    if (isOrdinaryDiagnosticEnvSetting(key, value) || BOOLEAN_WORD.test(value) || /^[01]$/.test(value)) continue;
    values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Select private values while preserving explicit ordinary process settings. */
export function collectDiagnosticEnvironmentSecrets(
  env: unknown,
  secretKeys: Iterable<string> = [],
  options: { hostProcess?: boolean } = {},
): string[] {
  if (!env || typeof env !== "object") return [];
  const declared = new Set(secretKeys);
  const secretName = new RegExp(`^(?:${SECRET_NAME_PATTERN})$`, "i");
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || !value) continue;
    if (declared.has(key) || secretName.test(key) ||
      redactDiagnosticText(value) !== value || looksLikeCredentialJwt(value) ||
      /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(value) ||
      (!isOrdinaryDiagnosticEnvSetting(key, value) && (!options.hostProcess || plausibleUndeclaredCredential(key, value)))) {
      values.add(value);
    }
    try {
      const url = new URL(value);
      if (url.password) {
        values.add(value);
        values.add(url.password);
        values.add(decodeURIComponent(url.password));
      }
    } catch { /* ordinary settings and malformed URLs need no URL projection */ }
  }
  return [...values].sort((a, b) => b.length - a.length);
}
