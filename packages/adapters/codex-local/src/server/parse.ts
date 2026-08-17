import {
  asString,
  asNumber,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

const CODEX_TRANSIENT_UPSTREAM_RE =
  /(?:we(?:'|’)re\s+currently\s+experiencing\s+high\s+demand|temporary\s+errors|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|server\s+overloaded|service\s+unavailable|try\s+again\s+later)/i;
const CODEX_REMOTE_COMPACTION_RE = /remote\s+compact\s+task/i;
const CODEX_USAGE_LIMIT_RE =
  /you(?:'|’)ve hit your usage limit for .+\.\s+switch to another model now,\s+or try again at\s+([^.!\n]+)(?:[.!]|\n|$)/i;
const CODEX_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve hit your usage limit|usage limit|model (?:is )?at capacity|at capacity for this model|capacity limit)/i;
// A rejected model id is a *permanent* configuration failure: the same
// adapterConfig.model will be rejected identically on every retry, so the run
// must fail once and route to a human instead of re-incarnating. Anchored on
// the model being the rejected subject ("model ... is not supported", "unknown
// model", model_not_found) so it never matches capacity/quota text, which is
// transient and is checked first by the caller.
const CODEX_UNSUPPORTED_MODEL_RE =
  /(?:model_not_found|\bmodel\b[^\n]{0,120}?\bis not supported\b|\bis not supported\b[^\n]{0,120}?\bmodel\b|(?:requested |the )?model\s+[^\n]{0,120}?(?:does not exist|not found|is invalid|is unknown)|unknown model|invalid model|unsupported model|model\s+[^\n]{0,80}?\bis not available\b)/i;
// Pull the offending id out of the provider message so the blocked-issue notice
// can name the exact adapterConfig.model value an operator has to change.
// Ordered most-specific-first. A gateway (9router) wraps the provider message in
// its own JSON envelope, so the *first* quoted token in the sentence is the JSON
// key ("detail", "message"), not the model. Anchor on the id's position relative
// to the word "model", and only fall back to a bare quoted token that is not a
// JSON key (i.e. not followed by a colon).
const CODEX_UNSUPPORTED_MODEL_ID_PATTERNS: readonly RegExp[] = [
  // "The 'gpt-5.3-codex-spark' model is not supported" — id precedes "model"
  /['"`]([A-Za-z0-9._:\/-]{2,120})['"`]\s+model\b/i,
  // "model 'x' does not exist" / "model \"x\" not found"
  /\bmodel\s+['"`]([A-Za-z0-9._:\/-]{2,120})['"`]/i,
  // "[codex/gpt-5.3-codex-spark] [400]: ..." — gateway route prefix
  /\[([A-Za-z0-9._-]+\/[A-Za-z0-9._:-]{2,120})\]/,
  // "model gpt-5.3-codex-spark is unknown" — unquoted id after "model"
  /\bmodel\s+([A-Za-z0-9._:\/-]{2,120})\b/i,
  // Last resort: a quoted token that is not a JSON key.
  /['"`]([A-Za-z0-9._:\/-]{2,120})['"`](?!\s*:)/i,
];
const CODEX_REFRESH_TOKEN_REUSED_RE =
  /(?:refresh[_\s-]?token[_\s-]?reused|refresh token (?:has )?already been used|token reuse detected)/i;
const CODEX_REFRESH_TOKEN_EXPIRED_RE =
  /(?:refresh[_\s-]?token[_\s-]?expired|refresh token (?:has )?expired|expired refresh token)/i;
const CODEX_REFRESH_TOKEN_INVALIDATED_RE =
  /(?:refresh[_\s-]?token[_\s-]?(?:invalidated|revoked|invalid)|refresh token (?:has been )?(?:invalidated|revoked|invalid)|invalid refresh token|missing bearer)/i;
const CODEX_OAUTH_INVALID_GRANT_RE = /\binvalid_grant\b/i;
const CODEX_CONTEXTUAL_REFRESH_AUTH_INVALIDATED_RE =
  /(?:(?:oauth|refresh|access[_\s-]?token|bearer|credential).{0,80}(?:\b401\b|unauthori[sz]ed|\binvalid[\s-]grant\b)|(?:\b401\b|unauthori[sz]ed|\binvalid[\s-]grant\b).{0,80}(?:oauth|refresh|access[_\s-]?token|bearer|credential))/i;

export type CodexAuthRefreshFailureClass =
  | "refresh_token_reused"
  | "refresh_token_expired"
  | "refresh_token_invalidated";

export function parseCodexJsonl(stdout: string) {
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let errorMessage: string | null = null;
  let sawProtocolEvent = false;
  let sawProtocolTerminalEvent = false;
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
    if (type) sawProtocolEvent = true;
    if (type === "error" || type === "turn.completed" || type === "turn.failed") {
      sawProtocolTerminalEvent = true;
    }
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
    usageBasis: "per_run" as const,
    errorMessage,
    sawProtocolEvent,
    sawProtocolTerminalEvent,
  };
}

/**
 * Structural crash detection: the codex CLI can only report an agent-level
 * failure through the JSONL protocol (an `error` event, `turn.failed`, or a
 * finished `turn.completed` followed by a nonzero exit). A nonzero exit after
 * the protocol stream started but before any terminal event means the process
 * died out from under the agent (MCP transport crash, worker panic, killed
 * tool server) — retriable infrastructure, not agent behavior. This
 * deliberately does not match error text: transport failure strings vary, and
 * stdout/stderr can quote agent output that merely discusses network errors.
 */
export function isCodexHarnessCrash(input: {
  exitCode: number | null;
  sawProtocolEvent: boolean;
  sawProtocolTerminalEvent: boolean;
}): boolean {
  if ((input.exitCode ?? 0) === 0) return false;
  return input.sawProtocolEvent && !input.sawProtocolTerminalEvent;
}

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|state db returned stale rollout path|no rollout found for thread id/i.test(
    haystack,
  );
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

export function classifyCodexAuthRefreshFailure(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): CodexAuthRefreshFailureClass | null {
  const haystack = buildCodexErrorHaystack(input);

  if (CODEX_REFRESH_TOKEN_REUSED_RE.test(haystack)) return "refresh_token_reused";
  if (CODEX_REFRESH_TOKEN_EXPIRED_RE.test(haystack)) return "refresh_token_expired";
  if (CODEX_REFRESH_TOKEN_INVALIDATED_RE.test(haystack)) return "refresh_token_invalidated";
  if (CODEX_OAUTH_INVALID_GRANT_RE.test(haystack)) return "refresh_token_invalidated";
  if (CODEX_CONTEXTUAL_REFRESH_AUTH_INVALIDATED_RE.test(haystack)) return "refresh_token_invalidated";
  return null;
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

  if (isCodexProviderQuotaError(input)) return false;
  if (!CODEX_TRANSIENT_UPSTREAM_RE.test(haystack)) return false;
  // Keep automatic retries scoped to the observed remote-compaction/high-demand
  // failure shape.
  return CODEX_REMOTE_COMPACTION_RE.test(haystack) || /high\s+demand|temporary\s+errors/i.test(haystack);
}

export function isCodexProviderQuotaError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildCodexErrorHaystack(input);
  return CODEX_PROVIDER_QUOTA_RE.test(haystack) || extractCodexRetryNotBefore(input) != null;
}

/**
 * A model the provider refuses to serve (HTTP 400 unsupported/unknown model) is
 * a permanent configuration failure, not a transient upstream one. Retrying
 * re-sends the same rejected `adapterConfig.model` and burns a full run's
 * tokens per attempt for no possible progress, so the classification exists to
 * stop the retry loop at the first failure.
 *
 * Quota/capacity text wins over this check in the caller: "model is at
 * capacity" also names a model but clears on its own, so it must stay
 * transient.
 */
export function classifyCodexUnsupportedModelError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): { modelId: string | null } | null {
  if (isCodexProviderQuotaError(input)) return null;
  const haystack = buildCodexErrorHaystack(input);
  const match = haystack.match(CODEX_UNSUPPORTED_MODEL_RE);
  if (!match) return null;

  // Scope id extraction to the matched sentence so an unrelated quoted string
  // elsewhere in stdout is not reported as the offending model.
  const sentenceStart = haystack.lastIndexOf("\n", match.index ?? 0) + 1;
  const sentenceEnd = haystack.indexOf("\n", (match.index ?? 0) + match[0].length);
  const sentence = haystack.slice(sentenceStart, sentenceEnd === -1 ? undefined : sentenceEnd);
  for (const pattern of CODEX_UNSUPPORTED_MODEL_ID_PATTERNS) {
    const idMatch = sentence.match(pattern);
    const candidate = idMatch?.[1];
    if (candidate) return { modelId: candidate };
  }
  return { modelId: null };
}
