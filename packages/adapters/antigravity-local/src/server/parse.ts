import { extractPaperclipDisposition, type ParsedDisposition } from "@paperclipai/adapter-utils";

export interface ParsedAntigravityOutput {
  sessionId: string | null;
  summary: string;
  errorMessage: string | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  disposition: {
    status: string;
    hasBlocker: boolean;
    blocker?: string;
    reviewer?: string;
  } | null;
  /** The agy CLI's own verdict on the turn: SUCCESS / CANCELED / ERROR. */
  resultStatus: string | null;
}

export interface AntigravityQuotaExhaustedMatch {
  exhausted: boolean;
  matchedLine: string | null;
  resetAt: Date | null;
}

/**
 * A bare non-zero `agy` exit has been observed to be an intermittent provider
 * flake: the identical model can succeed on another lane moments later.  Keep
 * this deliberately narrow so a diagnostic emitted on stderr remains a normal
 * (and breaker-eligible) adapter failure rather than being masked as transient.
 */
export function isAntigravityTransientSilentExit(input: {
  exitCode: number | null | undefined;
  stderr: string | null | undefined;
}) {
  return input.exitCode != null && input.exitCode !== 0 && !(input.stderr ?? "").trim();
}

const CONVERSATION_ID_RE =
  /(?:conversation|session)(?:\s+id)?\s*[:=]\s*([A-Za-z0-9._:-]+)/i;
const ANTIGRAVITY_QUOTA_EXHAUSTED_RE =
  /(?:resource[ _-]?exhausted|resource has been exhausted|quota (?:exceeded|exhausted|reached)|individual quota reached|exceeded your[^.\n]{0,40}quota|ineligible[ _-]?tier|upgrade your subscription to increase your limits)/i;
const ANTIGRAVITY_RESET_IN_RE =
  /resets?\s+in\s+(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i;
const PAPERCLIP_DISPOSITION_STATUSES = new Set(["done", "cancelled", "in_review", "blocked"]);

type TokenUsage = ParsedAntigravityOutput["usage"];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asFiniteTokenCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Math.max(0, Number(value));
  return 0;
}

function firstTokenCount(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const count = asFiniteTokenCount(record[key]);
    if (count > 0) return count;
  }
  return 0;
}

function readUsageRecord(value: unknown): TokenUsage {
  const root = asRecord(value);
  const candidates = [
    root,
    asRecord(root.usage),
    asRecord(root.usage_metadata),
    asRecord(root.usageMetadata),
    asRecord(root.token_usage),
    asRecord(root.tokenUsage),
    asRecord(asRecord(root.response).usage),
    asRecord(asRecord(root.response).usageMetadata),
    // 2026-08-23: the agy CLI wraps its terminal payload as
    // {"event":"result","result":{...,"usage":{...}}}. Without these two
    // candidates every antigravity run reported ZERO tokens (91/91 succeeded
    // runs in 24h), so the weighted token governor could never see the lane.
    asRecord(root.result),
    asRecord(asRecord(root.result).usage),
  ];
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const candidate of candidates) {
    inputTokens = Math.max(inputTokens, firstTokenCount(candidate, [
      "inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "promptTokenCount",
      "numInputTokens", "num_input_tokens",
    ]));
    cachedInputTokens = Math.max(cachedInputTokens, firstTokenCount(candidate, [
      "cachedInputTokens", "cached_input_tokens", "cachedTokens", "cached_tokens",
      // agy reports its cache hits as cache_read_tokens; without it the lane
      // reported zero cached input even once the envelope was readable.
      "cacheReadTokens", "cache_read_tokens",
      "cachedContentTokenCount", "cacheReadInputTokens",
    ]));
    outputTokens = Math.max(outputTokens, firstTokenCount(candidate, [
      "outputTokens", "output_tokens", "completionTokens", "completion_tokens",
      "candidatesTokenCount", "numOutputTokens", "num_output_tokens",
    ]));
  }
  return { inputTokens, cachedInputTokens, outputTokens };
}

function parseDispositionRecord(value: unknown): ParsedAntigravityOutput["disposition"] {
  const record = asRecord(value);
  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!PAPERCLIP_DISPOSITION_STATUSES.has(status)) return null;
  const blocker = [record.blocker, record.reason, record.statusReason]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
    ?.trim();
  const reviewer = typeof record.reviewer === "string" && record.reviewer.trim().length > 0
    ? record.reviewer.trim()
    : undefined;
  return {
    status,
    hasBlocker: record.hasBlocker === true || status === "blocked",
    ...(blocker ? { blocker } : {}),
    ...(reviewer ? { reviewer } : {}),
  };
}


function readEventText(event: Record<string, unknown>): string | null {
  // The agy CLI names its discriminator `event`, not `type`
  // ({"event":"result","result":{"response":"..."}}), and carries the model
  // text at result.response. Keying only on `type` made every terminal event
  // non-terminal-like: 91/91 succeeded antigravity runs in 24h recorded an
  // EMPTY summary and 0% disposition capture — the marker was emitted and then
  // thrown away before the shared extractor ever saw it. Accept both
  // discriminators and both text locations.
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  const eventName = typeof event.event === "string" ? event.event.toLowerCase() : "";
  const role = typeof event.role === "string" ? event.role.toLowerCase() : "";
  const terminalLike =
    /result|final|assistant|message|text/.test(type) ||
    /result|final|assistant|message|text/.test(eventName) ||
    role === "assistant";
  if (!terminalLike) return null;
  const resultRecord = asRecord(event.result);
  for (const value of [
    event.result,
    event.text,
    event.message,
    event.content,
    asRecord(event.response).text,
    resultRecord.response,
    resultRecord.text,
    resultRecord.message,
    resultRecord.content,
  ]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Parse Antigravity's line-delimited stream-json protocol. Usage field names
 * have changed between agy builds, so the reader deliberately accepts the
 * documented Gemini names and the common snake/camel-case CLI variants.
 */
export function inspectAntigravityStream(stdout: string) {
  let sessionId: string | null = null;
  let summary: string | null = null;
  // The agy CLI reports its OWN verdict on the turn in the result envelope
  // (SUCCESS / CANCELED / ERROR). Paperclip judged these runs only by exit code,
  // so a CANCELED turn with an empty response was stored as a successful run:
  // 68 of 91 "succeeded" antigravity runs in 24h were CANCELED and 9 were ERROR.
  let resultStatus: string | null = null;
  const usage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let sawJsonEvent = false;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = asRecord(JSON.parse(line));
      if (Object.keys(event).length === 0) continue;
      sawJsonEvent = true;
    } catch {
      continue;
    }
    sessionId = [event.conversation_id, event.conversationId, event.session_id, event.sessionId]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
      ?.trim() ?? sessionId;
    const eventUsage = readUsageRecord(event);
    usage.inputTokens = Math.max(usage.inputTokens, eventUsage.inputTokens);
    usage.cachedInputTokens = Math.max(usage.cachedInputTokens, eventUsage.cachedInputTokens);
    usage.outputTokens = Math.max(usage.outputTokens, eventUsage.outputTokens);
    summary = readEventText(event) ?? summary;
    const statusCandidate = asRecord(event.result).status ?? event.status;
    if (typeof statusCandidate === "string" && statusCandidate.trim()) {
      resultStatus = statusCandidate.trim().toUpperCase();
    }
  }
  return { sessionId, summary, usage, sawJsonEvent, resultStatus };
}

export function parseAntigravityOutput(stdout: string, stderr = ""): ParsedAntigravityOutput {
  const stream = inspectAntigravityStream(stdout);
  const sessionId =
    stream.sessionId ??
    CONVERSATION_ID_RE.exec(stdout)?.[1]?.trim() ??
    CONVERSATION_ID_RE.exec(stderr)?.[1]?.trim() ??
    null;
  const rawSummary = stream.summary ?? (stream.sawJsonEvent ? "" : stdout.trim());
  const { disposition, cleanedText } = extractPaperclipDisposition(rawSummary);
  return {
    sessionId,
    summary: cleanedText,
    errorMessage: null,
    usage: stream.usage,
    disposition,
    resultStatus: stream.resultStatus,
  };
}

export function isAntigravityUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`;
  return /unknown\s+(?:conversation|session)|(?:conversation|session)(?:\s+.*)?\s+not\s+found|invalid\s+(?:conversation|session)/i.test(haystack);
}

function parseResetAtFromQuotaLine(line: string, now: Date): Date | null {
  const match = ANTIGRAVITY_RESET_IN_RE.exec(line);
  if (!match) return null;

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const totalMs =
    (days * 24 * 60 * 60 * 1000) +
    (hours * 60 * 60 * 1000) +
    (minutes * 60 * 1000) +
    (seconds * 1000);
  if (totalMs <= 0) return null;
  return new Date(now.getTime() + totalMs);
}

export function detectAntigravityQuotaExhausted(input: {
  stderr: string;
  now?: Date;
}): AntigravityQuotaExhaustedMatch {
  const messages = input.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const matchedLine = messages.find((line) => ANTIGRAVITY_QUOTA_EXHAUSTED_RE.test(line)) ?? null;
  const now = input.now ?? new Date();
  return {
    exhausted: Boolean(matchedLine),
    matchedLine,
    resetAt: matchedLine ? parseResetAtFromQuotaLine(matchedLine, now) : null,
  };
}
