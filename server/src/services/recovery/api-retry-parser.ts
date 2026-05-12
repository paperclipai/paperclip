// Parses Claude CLI run-log chunks to detect `api_retry` system events.
//
// The Claude CLI emits no stdout while it is internally retrying transient
// Anthropic API failures and writes a `{"type":"system","subtype":"api_retry",
// "attempt":N,"error_status":"...","error":"..."}` event on its run-log stream
// for each attempt. The watchdog uses this signal to keep `lastLivenessAt`
// fresh (so an actively-retrying run is not flagged as silent) and to feed
// the retry-stall detector (so a genuinely wedged retry loop is auto-killed
// before the 4h critical-silent threshold).

export type ApiRetryEvent = {
  attempt: number;
  errorStatus: string | null;
  errorMessage: string | null;
};

export type ParsedRunLogChunk = {
  // true when at least one parseable api_retry event was observed in the chunk.
  hasApiRetry: boolean;
  // true when the chunk contained ANY non-api_retry, non-whitespace content.
  // When false the chunk is treated as retry-only liveness (does not bump
  // lastOutputAt) — when true the chunk is real progress and bumps both
  // clocks and resets the retry-stall tracker.
  hasNonRetryContent: boolean;
  // The latest api_retry event seen in the chunk (for state updates).
  latestRetry: ApiRetryEvent | null;
};

function tryParseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
}

function isApiRetryEvent(obj: Record<string, unknown>): boolean {
  return obj.type === "system" && obj.subtype === "api_retry";
}

export function parseRunLogChunkForLiveness(chunk: string): ParsedRunLogChunk {
  const result: ParsedRunLogChunk = {
    hasApiRetry: false,
    hasNonRetryContent: false,
    latestRetry: null,
  };
  if (!chunk) return result;
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = tryParseJsonLine(line);
    if (parsed && isApiRetryEvent(parsed)) {
      result.hasApiRetry = true;
      const attempt = asNumber(parsed.attempt);
      result.latestRetry = {
        attempt: attempt ?? result.latestRetry?.attempt ?? 1,
        errorStatus: asString(parsed.error_status) ?? result.latestRetry?.errorStatus ?? null,
        errorMessage: asString(parsed.error) ?? result.latestRetry?.errorMessage ?? null,
      };
      continue;
    }
    result.hasNonRetryContent = true;
  }
  return result;
}
