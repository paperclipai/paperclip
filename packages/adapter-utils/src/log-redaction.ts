import type { TranscriptEntry } from "./types.js";

export const REDACTED_HOME_PATH_USER = "[]";

const HOME_PATH_PATTERNS = [
  {
    regex: /\/Users\/[^/\\\s]+/g,
    replace: `/Users/${REDACTED_HOME_PATH_USER}`,
  },
  {
    regex: /\/home\/[^/\\\s]+/g,
    replace: `/home/${REDACTED_HOME_PATH_USER}`,
  },
  {
    regex: /([A-Za-z]:\\Users\\)[^\\/\s]+/g,
    replace: `$1${REDACTED_HOME_PATH_USER}`,
  },
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function redactHomePathUserSegments(text: string): string {
  let result = text;
  for (const pattern of HOME_PATH_PATTERNS) {
    result = result.replace(pattern.regex, pattern.replace);
  }
  return result;
}

export function redactHomePathUserSegmentsInValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactHomePathUserSegments(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactHomePathUserSegmentsInValue(entry)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactHomePathUserSegmentsInValue(entry);
  }
  return redacted as T;
}

export function redactTranscriptEntryPaths(entry: TranscriptEntry): TranscriptEntry {
  switch (entry.kind) {
    case "assistant":
    case "thinking":
    case "user":
    case "stderr":
    case "system":
    case "stdout":
      return { ...entry, text: redactHomePathUserSegments(entry.text) };
    case "tool_call":
      return { ...entry, name: redactHomePathUserSegments(entry.name), input: redactHomePathUserSegmentsInValue(entry.input) };
    case "tool_result":
      return { ...entry, content: redactHomePathUserSegments(entry.content) };
    case "init":
      return {
        ...entry,
        model: redactHomePathUserSegments(entry.model),
        sessionId: redactHomePathUserSegments(entry.sessionId),
      };
    case "result":
      return {
        ...entry,
        text: redactHomePathUserSegments(entry.text),
        subtype: redactHomePathUserSegments(entry.subtype),
        errors: entry.errors.map((error) => redactHomePathUserSegments(error)),
      };
    default:
      return entry;
  }
}
