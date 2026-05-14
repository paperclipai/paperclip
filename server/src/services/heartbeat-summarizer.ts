/**
 * Standalone summarizer service for heartbeat session compaction.
 *
 * Plan reference: THE-429 (rev 2). C2 deliverable: THE-433.
 *
 * Contract:
 *   `(priorSummary, newTrailTail) → newSummary` via Haiku.
 *
 * Failure modes (timeout, malformed output, API error, oversize input) MUST
 * return a fallback signal — never throw into the heartbeat path. Callers
 * (C3 prompt-builder) are expected to replay the full transcript verbatim
 * when they receive `{ ok: false }` — reliability over cost on the failure
 * path, per plan §4.
 *
 * The function is pure / harness-agnostic: caller supplies API key, model,
 * timeouts, and (in tests) a `fetchImpl`. No platform globals are read here.
 */
import { z } from "zod";

export const SUMMARY_MARKER = "SUMMARY-V1";

/** Default model: Haiku 4.5 dated alias. v1 has no Sonnet escape hatch. */
export const DEFAULT_SUMMARIZER_MODEL = "claude-haiku-4-5-20251001";

/** Token cap on output (per plan §1). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;

/** Wall-clock cap on a single summarizer call. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Hard cap on combined input size (priorSummary + newTrailTail). Anything
 * larger fails fast with `oversize_input` rather than burning a doomed API
 * call. ~400K chars ≈ 100K tokens, comfortably under Haiku's context window
 * but signals an upstream invariant break (checkpoint threshold should keep
 * inputs far smaller than this).
 */
export const DEFAULT_MAX_INPUT_CHARS = 400_000;

/** Defensive char cap on returned summary, in case the model exceeds max_tokens. */
const SUMMARY_OUTPUT_CHAR_CAP = 8_800;

export interface SummarizerInput {
  /** Prior summary body (without marker), or null if this is the first checkpoint. */
  priorSummary: string | null;
  /** New trail tail (everything since the prior summary's checkpoint). */
  newTrailTail: string;
}

export type SummarizerFailureReason =
  | "timeout"
  | "malformed"
  | "api_error"
  | "oversize_input"
  | "missing_api_key";

export interface SummarizerSuccess {
  ok: true;
  /** Summary body with the SUMMARY-V1 marker stripped. */
  summary: string;
  /** True if the model output was defensively truncated to fit the char cap. */
  truncated: boolean;
  /** Token usage reported by the API, when available. */
  usage: {
    inputTokens: number;
    outputTokens: number;
  } | null;
  model: string;
}

export interface SummarizerFailure {
  ok: false;
  reason: SummarizerFailureReason;
  /** Human-readable detail for logs. Never includes raw API key bytes. */
  detail: string;
}

export type SummarizerResult = SummarizerSuccess | SummarizerFailure;

export interface SummarizerOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  maxInputChars?: number;
  fetchImpl?: typeof fetch;
  /** Optional caller-supplied abort signal (composed with the timeout). */
  signal?: AbortSignal;
  /** Override the API URL (used by tests; default is api.anthropic.com). */
  apiUrl?: string;
}

const SUMMARIZER_SYSTEM_PROMPT = [
  "You are a context-compaction service for an AI agent. You receive (1) a prior",
  "summary of the agent's work on a single issue and (2) the most recent trail tail",
  "(new actions, comments, tool I/O) since that summary was written. Produce a NEW",
  "summary that supersedes the prior one.",
  "",
  "PRESERVE VERBATIM (these MUST appear in the new summary, copied as-is from the source):",
  "- Decisions made (and who made them).",
  "- Commitments (what is owed to whom, with deadlines).",
  "- Unresolved questions (open items awaiting an answer).",
  "- Open blockers (with the unblock owner if known).",
  "",
  "COMPRESS:",
  "- Tool output details, search results, intermediate reasoning, prior status transitions.",
  "",
  "RULES:",
  "- Output a markdown document only. No prose framing, no apologies, no chain-of-thought.",
  `- Begin every output with the literal line: ${SUMMARY_MARKER}`,
  "- Use stable section headings: ## Decisions, ## Commitments, ## Unresolved questions, ## Open blockers, ## Context.",
  "- If a section has no content, write the literal line: (none)",
  "- Hard cap: keep the entire summary under 2000 tokens. If you must drop content to fit,",
  "  drop compressible material first; never drop a decision, commitment, question, or blocker.",
  "- Never invent facts. If something is unclear in the source, list it under Unresolved questions.",
].join("\n");

function buildUserPrompt(input: SummarizerInput): string {
  const priorBlock = input.priorSummary?.trim()
    ? `<prior-summary>\n${input.priorSummary.trim()}\n</prior-summary>`
    : "<prior-summary>(none — this is the first checkpoint)</prior-summary>";
  return [
    priorBlock,
    "",
    "<new-trail-tail>",
    input.newTrailTail,
    "</new-trail-tail>",
    "",
    `Produce the new summary now. Begin with the literal line ${SUMMARY_MARKER}.`,
  ].join("\n");
}

const messagesResponseSchema = z.object({
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
  stop_reason: z.string().optional(),
});

function joinAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const handlers: Array<() => void> = [];
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    const onAbort = () => controller.abort(s.reason);
    s.addEventListener("abort", onAbort, { once: true });
    handlers.push(() => s.removeEventListener("abort", onAbort));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const h of handlers) h();
    },
  };
}

function failure(reason: SummarizerFailureReason, detail: string): SummarizerFailure {
  return { ok: false, reason, detail };
}

function validateAndStripMarker(raw: string): { body: string; truncated: boolean } | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith(SUMMARY_MARKER)) return null;
  let body = trimmed.slice(SUMMARY_MARKER.length).replace(/^\r?\n/, "");
  let truncated = false;
  if (body.length > SUMMARY_OUTPUT_CHAR_CAP) {
    body = body.slice(0, SUMMARY_OUTPUT_CHAR_CAP);
    truncated = true;
  }
  return { body, truncated };
}

export async function summarizeHeartbeatTrail(
  input: SummarizerInput,
  options: SummarizerOptions,
): Promise<SummarizerResult> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    return failure("missing_api_key", "ANTHROPIC_API_KEY not configured for summarizer");
  }

  const model = options.model ?? DEFAULT_SUMMARIZER_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const apiUrl = options.apiUrl ?? "https://api.anthropic.com/v1/messages";
  const fetchImpl = options.fetchImpl ?? fetch;

  const inputCharCount = (input.priorSummary?.length ?? 0) + input.newTrailTail.length;
  if (inputCharCount > maxInputChars) {
    return failure(
      "oversize_input",
      `input chars ${inputCharCount} exceed cap ${maxInputChars}; checkpoint threshold should prevent this`,
    );
  }

  const userPrompt = buildUserPrompt(input);

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error("summarizer-timeout")), timeoutMs);
  const joined = joinAbortSignals([timeoutController.signal, options.signal]);

  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        system: SUMMARIZER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: joined.signal,
    });
  } catch (err) {
    const aborted =
      timeoutController.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message)));
    if (aborted && timeoutController.signal.aborted) {
      return failure("timeout", `summarizer exceeded ${timeoutMs}ms`);
    }
    if (aborted) {
      return failure("api_error", "summarizer call aborted by caller");
    }
    return failure("api_error", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    joined.cleanup();
  }

  if (!response.ok) {
    let detail = `status ${response.status}`;
    try {
      const text = await response.text();
      if (text) detail += `: ${text.slice(0, 500)}`;
    } catch {
      // ignore — response body is best-effort for diagnostics
    }
    return failure("api_error", detail);
  }

  let parsedBody: unknown;
  try {
    parsedBody = await response.json();
  } catch (err) {
    return failure("api_error", `non-json response body: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = messagesResponseSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return failure("malformed", `messages response did not match schema: ${parsed.error.message}`);
  }

  const textBlock = parsed.data.content.find((c) => c.type === "text" && typeof c.text === "string");
  if (!textBlock?.text) {
    return failure("malformed", "no text content block in messages response");
  }

  const validated = validateAndStripMarker(textBlock.text);
  if (!validated) {
    return failure(
      "malformed",
      `summary did not begin with ${SUMMARY_MARKER} marker; got: ${textBlock.text.slice(0, 80)}`,
    );
  }

  return {
    ok: true,
    summary: validated.body,
    truncated: validated.truncated,
    usage: parsed.data.usage
      ? {
          inputTokens: parsed.data.usage.input_tokens ?? 0,
          outputTokens: parsed.data.usage.output_tokens ?? 0,
        }
      : null,
    model,
  };
}
