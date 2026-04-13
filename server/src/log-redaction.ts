import os from "node:os";

export const CURRENT_USER_REDACTION_TOKEN = "*";
export const RUN_LOG_CREDENTIAL_REDACTION_TOKEN = "[REDACTED]";

export interface CurrentUserRedactionOptions {
  enabled?: boolean;
  replacement?: string;
  userNames?: string[];
  homeDirs?: string[];
}

type CurrentUserCandidates = {
  userNames: string[];
  homeDirs: string[];
  replacement: string;
};

const RUN_LOG_KEY_PATTERN = String.raw`[A-Za-z_][A-Za-z0-9_-]*`;
const SENSITIVE_RUN_LOG_ASSIGNMENT_RE = new RegExp(
  String.raw`\b((?:(?:export|declare\s+-x)\s+)?(${RUN_LOG_KEY_PATTERN})\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s#;]+)`,
  "gi",
);
const SENSITIVE_RUN_LOG_PROPERTY_RE = new RegExp(
  String.raw`(["'])(${RUN_LOG_KEY_PATTERN})\1\s*:\s*(["'])([^"'\\\r\n]*)\3`,
  "gi",
);
const AUTHORIZATION_BEARER_RE = /\b(Authorization\s*[:=]\s*["']?Bearer\s+)([^\s"'`,;\\]+)/gi;
const JWT_LIKE_SEGMENT_PATTERN = String.raw`[A-Za-z0-9_-]{8,}`;
const JWT_LIKE_VALUE_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])${JWT_LIKE_SEGMENT_PATTERN}\.${JWT_LIKE_SEGMENT_PATTERN}\.${JWT_LIKE_SEGMENT_PATTERN}(?:\.${JWT_LIKE_SEGMENT_PATTERN})?(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])`,
  "g",
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function splitPathSegments(value: string) {
  return value.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
}

function replaceLastPathSegment(pathValue: string, replacement: string) {
  const normalized = pathValue.replace(/[\\/]+$/, "");
  const lastSeparator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSeparator < 0) return replacement;
  return `${normalized.slice(0, lastSeparator + 1)}${replacement}`;
}

export function maskUserNameForLogs(value: string, fallback = CURRENT_USER_REDACTION_TOKEN) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return `${trimmed[0]}${"*".repeat(Math.max(1, Array.from(trimmed).length - 1))}`;
}

function defaultUserNames() {
  const candidates = [
    process.env.USER,
    process.env.LOGNAME,
    process.env.USERNAME,
  ];

  try {
    candidates.push(os.userInfo().username);
  } catch {
    // Some environments do not expose userInfo; env vars are enough fallback.
  }

  return uniqueNonEmpty(candidates);
}

function defaultHomeDirs(userNames: string[]) {
  const candidates: Array<string | null | undefined> = [
    process.env.HOME,
    process.env.USERPROFILE,
  ];

  try {
    candidates.push(os.homedir());
  } catch {
    // Ignore and fall back to env hints below.
  }

  for (const userName of userNames) {
    candidates.push(`/Users/${userName}`);
    candidates.push(`/home/${userName}`);
    candidates.push(`C:\\Users\\${userName}`);
  }

  return uniqueNonEmpty(candidates);
}

let cachedCurrentUserCandidates: CurrentUserCandidates | null = null;

function getDefaultCurrentUserCandidates(): CurrentUserCandidates {
  if (cachedCurrentUserCandidates) return cachedCurrentUserCandidates;
  const userNames = defaultUserNames();
  cachedCurrentUserCandidates = {
    userNames,
    homeDirs: defaultHomeDirs(userNames),
    replacement: CURRENT_USER_REDACTION_TOKEN,
  };
  return cachedCurrentUserCandidates;
}

function resolveCurrentUserCandidates(opts?: CurrentUserRedactionOptions) {
  const defaults = getDefaultCurrentUserCandidates();
  const userNames = uniqueNonEmpty(opts?.userNames ?? defaults.userNames);
  const homeDirs = uniqueNonEmpty(opts?.homeDirs ?? defaults.homeDirs);
  const replacement = opts?.replacement?.trim() || defaults.replacement;
  return { userNames, homeDirs, replacement };
}

export function redactCurrentUserText(input: string, opts?: CurrentUserRedactionOptions) {
  if (!input) return input;
  if (opts?.enabled === false) return input;

  const { userNames, homeDirs, replacement } = resolveCurrentUserCandidates(opts);
  let result = input;

  for (const homeDir of [...homeDirs].sort((a, b) => b.length - a.length)) {
    const lastSegment = splitPathSegments(homeDir).pop() ?? "";
    const replacementDir = lastSegment
      ? replaceLastPathSegment(homeDir, maskUserNameForLogs(lastSegment, replacement))
      : replacement;
    result = result.split(homeDir).join(replacementDir);
  }

  for (const userName of [...userNames].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(userName)}(?![A-Za-z0-9._-])`, "g");
    result = result.replace(pattern, maskUserNameForLogs(userName, replacement));
  }

  return result;
}

export function redactCurrentUserValue<T>(value: T, opts?: CurrentUserRedactionOptions): T {
  if (typeof value === "string") {
    return redactCurrentUserText(value, opts) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCurrentUserValue(entry, opts)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactCurrentUserValue(entry, opts);
  }
  return redacted as T;
}

function redactedValueForMatchedText(rawValue: string) {
  const quote = rawValue[0] === "\"" || rawValue[0] === "'" ? rawValue[0] : "";
  return quote ? `${quote}${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}${quote}` : RUN_LOG_CREDENTIAL_REDACTION_TOKEN;
}

function isSensitiveRunLogKey(key: string) {
  const normalized = key.replace(/-/g, "_").toUpperCase();
  return /(^|_)(API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|COOKIE)($|_)/.test(
    normalized,
  );
}

export function redactRunLogCredentialsText(input: string) {
  if (!input) return input;
  return input
    .replace(AUTHORIZATION_BEARER_RE, (_match, prefix: string) => `${prefix}${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`)
    .replace(SENSITIVE_RUN_LOG_ASSIGNMENT_RE, (match: string, prefix: string, key: string) => {
      if (!isSensitiveRunLogKey(key)) return match;
      const rawValue = match.slice(prefix.length);
      return `${prefix}${redactedValueForMatchedText(rawValue)}`;
    })
    .replace(
      SENSITIVE_RUN_LOG_PROPERTY_RE,
      (_match, keyQuote: string, key: string, valueQuote: string) =>
        isSensitiveRunLogKey(key)
          ? `${keyQuote}${key}${keyQuote}: ${valueQuote}${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}${valueQuote}`
          : _match,
    )
    .replace(JWT_LIKE_VALUE_RE, RUN_LOG_CREDENTIAL_REDACTION_TOKEN);
}

export function redactRunLogCredentialsValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactRunLogCredentialsText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactRunLogCredentialsValue(entry)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactRunLogCredentialsValue(entry);
  }
  return redacted as T;
}
