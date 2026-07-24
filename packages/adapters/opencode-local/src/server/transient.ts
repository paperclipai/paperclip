// Transient-upstream classification for OpenCode runs (GOL-4038 Layer A).
//
// OpenCode exits with code 0 and produces no assistant output when the model
// call dies on a retryable upstream error (AI_APICallError with statusCode 429 /
// RESOURCE_EXHAUSTED / 5xx / quota). Core then scores the run as a clean empty
// success, `classifyRunLiveness` maps it to `empty_response`, and the immediate
// no-backoff continuation path retries in a tight loop against an exhausted
// provider. This module detects that failure shape so the adapter can report a
// backed-off failure through the existing `transient_upstream` + `retryNotBefore`
// recovery contract instead (the same path the Codex/Claude adapters use).
//
// Kept dependency-free so it can be unit-verified standalone.

export type OpenCodeTransientUpstreamMode = "off" | "shadow" | "enforce";

export const OPENCODE_TRANSIENT_UPSTREAM_MODE_ENV = "PAPERCLIP_OPENCODE_TRANSIENT_UPSTREAM_MODE";
export const OPENCODE_TRANSIENT_UPSTREAM_ERROR_CODE = "opencode_transient_upstream";

// Applied when a retryable signature matched but the provider gave no explicit
// retry hint. Core's bounded-retry scheduler takes max(its own backoff, this
// value), so the floor only ever delays the retry — it can never accelerate it.
export const OPENCODE_TRANSIENT_DEFAULT_BACKOFF_MS = 60_000;
// Provider hints are clamped into this window so a malformed or hostile hint
// cannot pin an agent (or retry instantly).
export const OPENCODE_TRANSIENT_MIN_BACKOFF_MS = 5_000;
export const OPENCODE_TRANSIENT_MAX_BACKOFF_MS = 24 * 60 * 60 * 1_000;

export function resolveOpenCodeTransientUpstreamMode(
  raw: string | null | undefined,
): OpenCodeTransientUpstreamMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "enforce" || value === "enforced" || value === "on" || value === "true" || value === "1") {
    return "enforce";
  }
  if (value === "off" || value === "false" || value === "0" || value === "disabled" || value === "none") {
    return "off";
  }
  // Default (unset or unrecognized) is shadow: detect and annotate, change nothing.
  return "shadow";
}

// Retryable upstream signatures. `AI_APICallError` alone is deliberately NOT
// sufficient — it also wraps deterministic failures (401 invalid key, 404
// unknown model) that must keep their existing non-retryable handling.
const OPENCODE_TRANSIENT_UPSTREAM_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "resource_exhausted", re: /RESOURCE_EXHAUSTED/i },
  {
    name: "http_429",
    re: /status(?:\s*_?\s*code)?["'`\s:=]+429\b|\b429\b[^\n]{0,80}(?:too\s+many\s+requests|rate|resource[\s_-]?exhausted|quota)|(?:too\s+many\s+requests|rate[\s_-]?limit)[^\n]{0,80}\b429\b/i,
  },
  { name: "rate_limit", re: /rate[\s_-]?limit(?:ed|s)?/i },
  { name: "too_many_requests", re: /too\s+many\s+requests/i },
  {
    name: "quota",
    re: /quota\s+(?:exceeded|exhausted|reached)|insufficient_quota|exceeded\s+your\s+current\s+quota|out\s+of\s+quota/i,
  },
  { name: "http_5xx", re: /status(?:\s*_?\s*code)?["'`\s:=]+5\d{2}\b/i },
  { name: "overloaded", re: /\boverloaded\b|overloaded_error/i },
  {
    name: "upstream_unavailable",
    re: /service\s+(?:temporarily\s+)?unavailable|bad\s+gateway|gateway\s+time-?out|internal\s+server\s+error|server\s+had\s+an\s+error/i,
  },
];

// Provider retry hints, declared in the precedence order they are checked:
// RetryInfo retryDelay, then Retry-After HTTP-date, then Retry-After seconds,
// then prose.
// Google RESOURCE_EXHAUSTED RetryInfo: `"retryDelay": "27s"` (also seen unquoted).
const RETRY_DELAY_RE = /retry[-_\s]?delay["'`\s:=]+["'`]?(\d+(?:\.\d+)?)\s*s\b/i;
const RETRY_AFTER_DATE_RE = /retry[-_\s]?after["'`\s:=]+["'`]?([A-Z][a-z]{2},\s?[^"'`\n]+?(?:GMT|UTC))/;
// `(?![\d.])` pins the capture to the full number so backtracking cannot shrink
// it to a prefix digit and slip past the GMT/UTC negative lookahead
// (e.g. "retry-after: 30 GMT" must not match "3").
const RETRY_AFTER_SECONDS_RE = /retry[-_\s]?after["'`\s:=]+["'`]?(\d+(?:\.\d+)?)(?![\d.])(?!\s*(?:gmt|utc)\b)/i;
// OpenAI-style prose: "Please try again in 1.2s." / "retry in 20 seconds".
const RETRY_IN_PHRASE_RE =
  /(?:try\s+again|retry)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)\b/i;

export interface OpenCodeTransientUpstreamScanInput {
  stdout?: string | null;
  stderr?: string | null;
  /** Structured error text extracted from the OpenCode JSONL stream. */
  errorMessage?: string | null;
  exitCode?: number | null;
  timedOut?: boolean;
  /** True when the run produced non-empty assistant output (parsed summary). */
  hasOutput?: boolean;
}

export interface OpenCodeTransientUpstreamDetection {
  detected: boolean;
  /** Name of the matched signature pattern (for observability). */
  signature: string | null;
  /** First line containing the match, trimmed and capped (for observability). */
  evidence: string | null;
  retryNotBefore: Date | null;
  retryHintSource: "retry_after_seconds" | "retry_after_date" | "retry_delay" | "retry_in_phrase" | "default" | null;
}

const NO_DETECTION: OpenCodeTransientUpstreamDetection = {
  detected: false,
  signature: null,
  evidence: null,
  retryNotBefore: null,
  retryHintSource: null,
};

function buildHaystack(input: OpenCodeTransientUpstreamScanInput): string {
  return [input.errorMessage ?? "", input.stderr ?? "", input.stdout ?? ""]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function firstMatchingLine(haystack: string, re: RegExp): string | null {
  for (const rawLine of haystack.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line && re.test(line)) return line.length > 300 ? `${line.slice(0, 297)}...` : line;
  }
  // Some patterns span lines (e.g. pretty-printed JSON); fall back to a capped slice.
  const match = haystack.match(re);
  if (!match || match.index == null) return null;
  const start = Math.max(0, match.index - 80);
  return haystack.slice(start, match.index + 220).replace(/\s+/g, " ").trim().slice(0, 300);
}

function clampBackoffMs(ms: number): number {
  if (!Number.isFinite(ms)) return OPENCODE_TRANSIENT_DEFAULT_BACKOFF_MS;
  return Math.min(OPENCODE_TRANSIENT_MAX_BACKOFF_MS, Math.max(OPENCODE_TRANSIENT_MIN_BACKOFF_MS, ms));
}

function phraseUnitToMs(value: number, unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("ms") || normalized.startsWith("millisecond")) return value;
  if (normalized.startsWith("h")) return value * 3_600_000;
  if (normalized.startsWith("m") && !normalized.startsWith("ms")) return value * 60_000;
  return value * 1_000;
}

export function extractOpenCodeRetryHint(
  input: OpenCodeTransientUpstreamScanInput,
  now: Date = new Date(),
): { retryNotBefore: Date; source: NonNullable<OpenCodeTransientUpstreamDetection["retryHintSource"]> } | null {
  const haystack = buildHaystack(input);
  if (!haystack) return null;

  const retryDelay = haystack.match(RETRY_DELAY_RE);
  if (retryDelay?.[1]) {
    const ms = clampBackoffMs(Number.parseFloat(retryDelay[1]) * 1_000);
    return { retryNotBefore: new Date(now.getTime() + ms), source: "retry_delay" };
  }

  const retryAfterDate = haystack.match(RETRY_AFTER_DATE_RE);
  if (retryAfterDate?.[1]) {
    const parsed = new Date(retryAfterDate[1]);
    if (!Number.isNaN(parsed.getTime())) {
      const ms = clampBackoffMs(parsed.getTime() - now.getTime());
      return { retryNotBefore: new Date(now.getTime() + ms), source: "retry_after_date" };
    }
  }

  const retryAfterSeconds = haystack.match(RETRY_AFTER_SECONDS_RE);
  if (retryAfterSeconds?.[1]) {
    const ms = clampBackoffMs(Number.parseFloat(retryAfterSeconds[1]) * 1_000);
    return { retryNotBefore: new Date(now.getTime() + ms), source: "retry_after_seconds" };
  }

  const phrase = haystack.match(RETRY_IN_PHRASE_RE);
  if (phrase?.[1] && phrase[2]) {
    const ms = clampBackoffMs(phraseUnitToMs(Number.parseFloat(phrase[1]), phrase[2]));
    return { retryNotBefore: new Date(now.getTime() + ms), source: "retry_in_phrase" };
  }

  return null;
}

export function detectOpenCodeTransientUpstream(
  input: OpenCodeTransientUpstreamScanInput,
  now: Date = new Date(),
): OpenCodeTransientUpstreamDetection {
  // Timeouts have their own classifier; leave them alone.
  if (input.timedOut) return NO_DETECTION;
  // A run that exited cleanly, reported no structured error, and produced real
  // assistant output is a success — even if the transcript happens to mention
  // rate limits or the provider logged a recovered blip on stderr.
  if ((input.exitCode ?? 0) === 0 && !(input.errorMessage ?? "").trim() && input.hasOutput) {
    return NO_DETECTION;
  }

  const haystack = buildHaystack(input);
  if (!haystack) return NO_DETECTION;

  for (const pattern of OPENCODE_TRANSIENT_UPSTREAM_PATTERNS) {
    if (!pattern.re.test(haystack)) continue;
    const hint = extractOpenCodeRetryHint(input, now);
    return {
      detected: true,
      signature: pattern.name,
      evidence: firstMatchingLine(haystack, pattern.re),
      retryNotBefore: hint?.retryNotBefore ?? new Date(now.getTime() + OPENCODE_TRANSIENT_DEFAULT_BACKOFF_MS),
      retryHintSource: hint?.source ?? "default",
    };
  }

  return NO_DETECTION;
}

export interface OpenCodeTransientUpstreamOutcome {
  /** True when the result must be rewritten into a backed-off failure. */
  enforce: boolean;
  exitCode: number | null;
  errorCode: typeof OPENCODE_TRANSIENT_UPSTREAM_ERROR_CODE | null;
  errorFamily: "transient_upstream" | null;
  retryNotBefore: string | null;
  /** Shadow-mode observability record for resultJson (null outside shadow mode). */
  shadowRecord: Record<string, unknown> | null;
}

export function resolveOpenCodeTransientUpstreamOutcome(input: {
  mode: OpenCodeTransientUpstreamMode;
  detection: OpenCodeTransientUpstreamDetection;
  exitCode: number | null;
}): OpenCodeTransientUpstreamOutcome {
  const passthrough: OpenCodeTransientUpstreamOutcome = {
    enforce: false,
    exitCode: input.exitCode,
    errorCode: null,
    errorFamily: null,
    retryNotBefore: null,
    shadowRecord: null,
  };
  if (!input.detection.detected || input.mode === "off") return passthrough;

  const retryNotBefore = input.detection.retryNotBefore?.toISOString() ?? null;
  if (input.mode === "shadow") {
    return {
      ...passthrough,
      shadowRecord: {
        detected: true,
        mode: "shadow",
        signature: input.detection.signature,
        evidence: input.detection.evidence,
        retryHintSource: input.detection.retryHintSource,
        wouldErrorCode: OPENCODE_TRANSIENT_UPSTREAM_ERROR_CODE,
        wouldRetryNotBefore: retryNotBefore,
      },
    };
  }

  return {
    enforce: true,
    exitCode: (input.exitCode ?? 0) === 0 ? 1 : input.exitCode,
    errorCode: OPENCODE_TRANSIENT_UPSTREAM_ERROR_CODE,
    errorFamily: "transient_upstream",
    retryNotBefore,
    shadowRecord: null,
  };
}
