import os from "node:os";

export const CURRENT_USER_REDACTION_TOKEN = "[]";

interface CurrentUserRedactionOptions {
  replacement?: string;
  userNames?: string[];
  homeDirs?: string[];
}

type CurrentUserCandidates = {
  userNames: string[];
  homeDirs: string[];
  replacement: string;
};

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

  const { userNames, homeDirs, replacement } = resolveCurrentUserCandidates(opts);
  let result = input;

  for (const homeDir of [...homeDirs].sort((a, b) => b.length - a.length)) {
    const lastSegment = splitPathSegments(homeDir).pop() ?? "";
    const replacementDir = userNames.includes(lastSegment)
      ? replaceLastPathSegment(homeDir, replacement)
      : replacement;
    result = result.split(homeDir).join(replacementDir);
  }

  for (const userName of [...userNames].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(userName)}(?![A-Za-z0-9._-])`, "g");
    result = result.replace(pattern, replacement);
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
