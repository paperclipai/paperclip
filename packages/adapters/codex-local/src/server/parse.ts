import {
  asString,
  asNumber,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

const CODEX_TRANSIENT_UPSTREAM_RE =
  /(?:we(?:'|’)re\s+currently\s+experiencing\s+high\s+demand|temporary\s+errors|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|server\s+overloaded|service\s+unavailable|try\s+again\s+later|usage\s+limit|quota\s+(?:exceeded|limit)|insufficient_quota)/i;
const CODEX_REMOTE_COMPACTION_RE = /remote\s+compact\s+task/i;
const CODEX_RATE_LIMIT_RE =
  /(?:rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|usage\s+limit|quota\s+(?:exceeded|limit)|insufficient_quota)/i;
const CODEX_USAGE_LIMIT_RE =
  /you(?:'|’| ha)ve\s+(?:hit|reached)\s+(?:your\s+)?usage limit[\s\S]*?try again at\s+([^.!\n]+)(?:[.!]|\n|$)/i;

export function parseCodexJsonl(stdout: string) {
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let errorMessage: string | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "thread.started") {
      sessionId = asString(event.thread_id, sessionId ?? "") || sessionId;
      continue;
    }

    if (type === "error") {
      const msg = asString(event.message, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "item.completed") {
      const item = parseObject(event.item);
      if (asString(item.type, "") === "agent_message") {
        const text = asString(item.text, "");
        if (text) finalMessage = text;
      }
      continue;
    }

    if (type === "turn.completed") {
      const usageObj = parseObject(event.usage);
      usage.inputTokens = asNumber(usageObj.input_tokens, usage.inputTokens);
      usage.cachedInputTokens = asNumber(usageObj.cached_input_tokens, usage.cachedInputTokens);
      usage.outputTokens = asNumber(usageObj.output_tokens, usage.outputTokens);
      continue;
    }

    if (type === "turn.failed") {
      const err = parseObject(event.error);
      const msg = asString(err.message, "").trim();
      if (msg) errorMessage = msg;
    }
  }

  return {
    sessionId,
    summary: finalMessage?.trim() ?? "",
    usage,
    errorMessage,
  };
}

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|no rollout found for thread id/i.test(
    haystack,
  );
}

const CODEX_URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

export function extractCodexLoginUrl(text: string): string | null {
  const match = text.match(CODEX_URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("openai.com") || cleaned.includes("chatgpt.com") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

// Strip ANSI escape sequences (CSI, OSC, SGR, cursor moves, etc.) from terminal output.
// The Codex CLI emits color codes in stdout that confuse downstream regex parsing.
const ANSI_ESCAPE_RE = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

// `codex login --device-auth` (v0.128+) output looks like:
//   1. Open this link in your browser and sign in to your account
//      https://auth.openai.com/codex/device
//   2. Enter this one-time code (expires in 15 minutes)
//      FYL1-MAV09
// (typically with ANSI styling). Codes are alphanumeric blocks separated by
// a dash. Lengths vary across codex versions — older builds emitted 4-4
// (XXXX-XXXX), 0.128 emits 4-5 (XXXX-XXXXX = 9 chars), and newer builds have
// been observed emitting longer blocks. Allow 3-12 in each block so we stay
// forward-compatible without false-positive matches like "[v0.128.0]".
const CODEX_DEVICE_AUTH_URL_RE = /https?:\/\/auth\.openai\.com\/[^\s]*device[^\s]*/i;
const CODEX_USER_CODE_RE = /\b([A-Z0-9]{3,12})-([A-Z0-9]{3,12})\b/;

export function extractCodexDeviceAuth(text: string): { verificationUrl: string | null; userCode: string | null } {
  const cleaned = stripAnsi(text);
  const urlMatch = cleaned.match(CODEX_DEVICE_AUTH_URL_RE);
  const codeMatch = cleaned.match(CODEX_USER_CODE_RE);
  return {
    verificationUrl: urlMatch ? urlMatch[0].replace(/[\])}.!,?;:'\"]+$/g, "") : null,
    userCode: codeMatch ? `${codeMatch[1]}-${codeMatch[2]}` : null,
  };
}

function buildCodexErrorHaystack(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  return [
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

function parseLocalClockTime(clockText: string, now: Date): Date | null {
  const normalized = clockText.trim();
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?$/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  const timeZoneHint = match[4] ?? match[5];
  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

export function extractCodexRetryNotBefore(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}, now = new Date()): Date | null {
  const haystack = buildCodexErrorHaystack(input);
  const usageLimitMatch = haystack.match(CODEX_USAGE_LIMIT_RE);
  if (!usageLimitMatch) return null;
  return parseLocalClockTime(usageLimitMatch[1] ?? "", now);
}

export function isCodexTransientUpstreamError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildCodexErrorHaystack(input);

  if (extractCodexRetryNotBefore(input) != null) return true;
  if (!CODEX_TRANSIENT_UPSTREAM_RE.test(haystack)) return false;
  // Keep automatic retries scoped to the observed remote-compaction/high-demand
  // failure shape, plus explicit rate/usage-limit windows that can be relieved
  // by rotating to another selected OpenAI credential.
  return (
    CODEX_REMOTE_COMPACTION_RE.test(haystack) ||
    CODEX_RATE_LIMIT_RE.test(haystack) ||
    /high\s+demand|temporary\s+errors/i.test(haystack)
  );
}
