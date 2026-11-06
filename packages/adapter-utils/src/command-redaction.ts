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
  String.raw`(\\"(?:${SECRET_NAME_PATTERN})\\"\s*:\s*\\")(?=((?:\\\\\\\\|\\\\\\"|\\\\[\s\S]|[^\\"])*))\2(\\")`,
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
    .replace(JSON_ESCAPED_SECRET_FIELD_RE, `$1${redactedValue}$3`)
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

/** Select private values while preserving explicit ordinary process settings. */
export function collectDiagnosticEnvironmentSecrets(
  env: unknown,
  secretKeys: Iterable<string> = [],
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
      !isOrdinaryDiagnosticEnvSetting(key, value)) {
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
