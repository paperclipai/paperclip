export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

const COMMAND_CLI_SECRET_OPTION_RE =
  /(\B-{1,2}(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)(?:\s+|=)(["']?))[^\s"'`]+(\2)/gi;
const COMMAND_ENV_SECRET_ASSIGNMENT_RE =
  /(\b[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTHORIZATION|JWT)[A-Za-z0-9_]*\s*=\s*)[^\s"'`]+/gi;
const COMMAND_AUTHORIZATION_BEARER_RE = /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
const COMMAND_SECRET_KEY_VALUE_RE =
  /(\b(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTHORIZATION|JWT)[A-Za-z0-9_]*)\s*[:=]\s*)(["']?)[^\s"'`,;}\]]+(\2)/gi;
const COMMAND_URL_PASSWORD_RE = /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s/]+(@)/g;
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const COMMAND_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
// Slack tokens (xoxb / xapp / xoxa / xoxp / xoxr / xoxs / xoxe variants) - EXPAAAA-772
const COMMAND_SLACK_TOKEN_RE =
  /\b(?:xox[abeprs]|xapp)-[A-Za-z0-9_-]{30,}\b/g;
// Supabase project access token (sbp_ shape, e.g. SUPABASE_ACCESS_TOKEN) - EXPAAAA-772
const COMMAND_SUPABASE_TOKEN_RE = /\bsbp_[A-Za-z0-9]{40,}\b/g;

export function redactCommandText(command: string, redactedValue = REDACTED_COMMAND_TEXT_VALUE): string {
  return command
    .replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`)
    .replace(COMMAND_CLI_SECRET_OPTION_RE, `$1${redactedValue}$3`)
    .replace(COMMAND_ENV_SECRET_ASSIGNMENT_RE, `$1${redactedValue}`)
    .replace(COMMAND_SECRET_KEY_VALUE_RE, `$1$2${redactedValue}$3`)
    .replace(COMMAND_URL_PASSWORD_RE, `$1${redactedValue}$2`)
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_JWT_RE, redactedValue)
    .replace(COMMAND_SLACK_TOKEN_RE, redactedValue)
    .replace(COMMAND_SUPABASE_TOKEN_RE, redactedValue);
}
