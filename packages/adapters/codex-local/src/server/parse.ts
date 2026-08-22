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
// 2026-08-22 tolerant rewrite (operator: end the disposition disease at source).
// The old line-anchored single-line regex silently rejected 233 real markers in
// one week — audited failure shapes from production final messages:
//   {"PAPERCLIP_DISPOSITION":{...}}          marker wrapped as a JSON key
//   prose**{"PAPERCLIP_DISPOSITION":{...}}   glued mid-line to preceding text
//   PAPERCLIP_DISPOSITION {"blocker":{...}}  nested objects / multi-line JSON
//   ..."blocker":{"owner":...}               blocker as an OBJECT, not a string
// Every rejected marker became a "missing disposition" corrective run. The
// extractor now finds the LAST marker anywhere in the text, scans a balanced
// JSON object (string/escape aware, capped), unwraps the wrapped form, and
// tolerates object blockers plus summary/reason fallbacks for blocked runs.
const PAPERCLIP_DISPOSITION_MARKER = "PAPERCLIP_DISPOSITION";
const MAX_DISPOSITION_JSON_CHARS = 4000;

type ParsedDisposition = {
  status: string;
  hasBlocker: boolean;
  blocker?: string;
  reviewer?: string;
};

function scanBalancedJsonObject(text: string, openIndex: number): string | null {
  if (text[openIndex] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const limit = Math.min(text.length, openIndex + MAX_DISPOSITION_JSON_CHARS);
  for (let i = openIndex; i < limit; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return null;
}

function coerceBlockerText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const parts = ["summary", "reason", "description", "owner", "action"]
      .map((key) => (typeof record[key] === "string" ? (record[key] as string).trim() : ""))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" — ");
    try {
      const serialized = JSON.stringify(value);
      return serialized && serialized !== "{}" ? serialized.slice(0, 500) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function extractPaperclipDisposition(text: string): {
  disposition: ParsedDisposition | null;
  cleanedText: string;
} {
  let lastValid:
    | {
        disposition: ParsedDisposition;
        spanStart: number;
        spanEnd: number;
      }
    | null = null;

  let searchFrom = 0;
  while (true) {
    const markerIndex = text.indexOf(PAPERCLIP_DISPOSITION_MARKER, searchFrom);
    if (markerIndex === -1) break;
    searchFrom = markerIndex + PAPERCLIP_DISPOSITION_MARKER.length;

    // Find the JSON object that belongs to this marker: the next "{" within a
    // short window (tolerates `: `, ` `, `":` from the wrapped form, backticks).
    let braceIndex = -1;
    const windowEnd = Math.min(text.length, searchFrom + 12);
    for (let i = searchFrom; i < windowEnd; i += 1) {
      if (text[i] === "{") {
        braceIndex = i;
        break;
      }
    }
    if (braceIndex === -1) continue;

    const jsonText = scanBalancedJsonObject(text, braceIndex);
    if (!jsonText) continue;

    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = JSON.parse(jsonText) as unknown;
      parsed = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    } catch {
      continue;
    }
    if (!parsed) continue;

    // Wrapped form: the whole object may itself be {"PAPERCLIP_DISPOSITION": {...}}
    // — in that case the marker we matched was the KEY inside this object, and the
    // span starts at the outer opening brace (one char before the quoted key).
    let spanStart = markerIndex;
    const wrapped = parsed[PAPERCLIP_DISPOSITION_MARKER];
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      parsed = wrapped as Record<string, unknown>;
    } else {
      const before = text.slice(Math.max(0, markerIndex - 2), markerIndex);
      if (before.endsWith('{"')) {
        // marker is the key of a wrapper object whose body failed to parse on its
        // own; re-scan from the wrapper's opening brace.
        const outer = scanBalancedJsonObject(text, markerIndex - 2);
        if (outer) {
          try {
            const outerParsed = JSON.parse(outer) as Record<string, unknown>;
            const inner = outerParsed[PAPERCLIP_DISPOSITION_MARKER];
            if (inner && typeof inner === "object" && !Array.isArray(inner)) {
              parsed = inner as Record<string, unknown>;
              spanStart = markerIndex - 2;
            }
          } catch {
            // keep the directly-parsed object
          }
        }
      }
    }

    const status = typeof parsed.status === "string" ? parsed.status.trim() : "";
    if (!status) continue;

    const blockerText = coerceBlockerText(parsed.blocker)
      ?? (status === "blocked"
        ? coerceBlockerText(parsed.summary) ?? coerceBlockerText(parsed.reason)
        : null);

    lastValid = {
      disposition: {
        status,
        // Named blocker text IS the affirmative identification (mirrors the
        // 2026-08-22 heartbeat-side fix); an explicit false still records false.
        hasBlocker: parsed.hasBlocker === true || Boolean(blockerText),
        ...(blockerText ? { blocker: blockerText } : {}),
        ...(typeof parsed.reviewer === "string" && parsed.reviewer.trim().length > 0
          ? { reviewer: parsed.reviewer.trim() }
          : {}),
      },
      spanStart,
      spanEnd: braceIndex + (scanBalancedJsonObject(text, braceIndex)?.length ?? 0),
    };
  }

  if (!lastValid) {
    return { disposition: null, cleanedText: text.trim() };
  }

  const cleanedText = `${text.slice(0, lastValid.spanStart)}${text.slice(lastValid.spanEnd)}`
    .replace(/`+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    disposition: lastValid.disposition,
    cleanedText,
  };
}
const CODEX_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve hit your usage limit|usage limit|model (?:is )?at capacity|at capacity for this model|capacity limit)/i;
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

  const { disposition, cleanedText } = extractPaperclipDisposition(finalMessage?.trim() ?? "");

  return {
    sessionId,
    summary: cleanedText,
    usage,
    usageBasis: "per_run" as const,
    errorMessage,
    sawProtocolEvent,
    sawProtocolTerminalEvent,
    disposition,
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

/**
 * Codex ACP can emit a completed `end_turn` wrapper after its remote context
 * compaction has failed. The actual failure is delivered as final output text,
 * not as the terminal turn status, so it must be detected separately from the
 * ordinary transient-upstream classification. Retrying that same poisoned
 * session only repeats the compaction failure.
 */
export function isCodexContextCompactionFailure(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildCodexErrorHaystack(input);
  return CODEX_REMOTE_COMPACTION_RE.test(haystack)
    && /(?:ran\s+out\s+of\s+room|context\s+window|context\s+limit)/i.test(haystack);
}

export function isCodexProviderQuotaError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildCodexErrorHaystack(input);
  return CODEX_PROVIDER_QUOTA_RE.test(haystack) || extractCodexRetryNotBefore(input) != null;
}
