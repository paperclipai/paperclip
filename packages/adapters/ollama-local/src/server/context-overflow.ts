/**
 * Pre-send context-overflow detection and truncation for the ollama_local
 * adapter. Ollama does not emit an overflow frame — if the prompt exceeds
 * num_ctx, the server silently drops earlier tokens. We detect this up front
 * so the heartbeat can still produce a useful summary and so CI assertions
 * have a stable telemetry surface.
 *
 * Spec: GEM-9 M3 — "Context-overflow telemetry: event emitted with pre/post
 * transcript token counts and truncation summary."
 */

export interface TranscriptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ContextOverflowResult {
  messages: TranscriptMessage[];
  /** Rough token estimate of the transcript BEFORE any truncation. */
  preTokens: number;
  /** Rough token estimate AFTER truncation (equal to preTokens when untouched). */
  postTokens: number;
  /** True when this call actually mutated the transcript. */
  triggered: boolean;
  /** Characters removed from the tail of the last user message. */
  droppedChars: number;
  /** Truncation strategy applied. v1 only supports `drop-tail`. */
  strategy: "drop-tail" | "none";
  /** Budget (in tokens) we aimed to stay under — contextWindow - outputHeadroom. */
  budgetTokens: number;
}

const TRUNCATION_MARKER = "\n\n[paperclip] ollama_local: transcript truncated to fit context window";

/**
 * Conservative 4-chars-per-token heuristic. This is intentionally a ceiling so
 * we truncate earlier rather than overshooting the real tokenizer count that
 * Ollama applies server-side.
 */
export function estimateTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

function totalChars(messages: TranscriptMessage[]): number {
  let sum = 0;
  for (const m of messages) sum += m.content.length;
  return sum;
}

/**
 * Enforce the configured Ollama num_ctx against a `[system, user]` transcript.
 * If the estimated token count exceeds the window (minus output headroom),
 * truncate the tail of the last user message so the request still lands.
 *
 * v1 keeps the system message intact. If there is NO user message OR the
 * system message alone already overflows, we return the transcript untouched
 * and flag it with `triggered: false` — the caller should still surface the
 * resulting post-send `truncated` flag.
 */
export function applyContextOverflow(
  messages: TranscriptMessage[],
  contextWindow: number,
  opts: { outputHeadroomTokens?: number; maxOutputTokens?: number } = {},
): ContextOverflowResult {
  const preTokens = estimateTokens(totalChars(messages));
  const headroom =
    opts.outputHeadroomTokens ??
    (opts.maxOutputTokens && opts.maxOutputTokens > 0
      ? Math.min(opts.maxOutputTokens, Math.floor(contextWindow / 4))
      : Math.max(256, Math.floor(contextWindow / 4)));
  const budgetTokens = Math.max(1, contextWindow - headroom);

  if (preTokens <= budgetTokens || messages.length === 0) {
    return {
      messages,
      preTokens,
      postTokens: preTokens,
      triggered: false,
      droppedChars: 0,
      strategy: "none",
      budgetTokens,
    };
  }

  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  if (!last || last.role !== "user") {
    // v1 only knows how to trim a trailing user message. Anything else is
    // left alone; caller still sees `triggered: true` so telemetry fires.
    return {
      messages,
      preTokens,
      postTokens: preTokens,
      triggered: true,
      droppedChars: 0,
      strategy: "none",
      budgetTokens,
    };
  }

  const otherTokens = estimateTokens(totalChars(messages.slice(0, lastIdx)));
  const markerTokens = estimateTokens(TRUNCATION_MARKER.length);
  const availableTokensForLast = Math.max(0, budgetTokens - otherTokens - markerTokens);
  const availableCharsForLast = availableTokensForLast * 4;

  if (availableCharsForLast <= 0) {
    // System + marker alone already exceed budget. Leave transcript intact;
    // Ollama's silent truncation will win. Telemetry still fires.
    return {
      messages,
      preTokens,
      postTokens: preTokens,
      triggered: true,
      droppedChars: 0,
      strategy: "none",
      budgetTokens,
    };
  }

  const trimmed = last.content.slice(0, availableCharsForLast) + TRUNCATION_MARKER;
  const droppedChars = last.content.length - (trimmed.length - TRUNCATION_MARKER.length);
  const newMessages = messages.slice(0, lastIdx).concat([{ role: last.role, content: trimmed }]);
  const postTokens = estimateTokens(totalChars(newMessages));

  return {
    messages: newMessages,
    preTokens,
    postTokens,
    triggered: true,
    droppedChars: Math.max(0, droppedChars),
    strategy: "drop-tail",
    budgetTokens,
  };
}
