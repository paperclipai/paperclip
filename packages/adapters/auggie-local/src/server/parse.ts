import {
  asNumber,
  asString,
  parseJson,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

function readSessionId(event: Record<string, unknown>): string | null {
  return (
    asString(event.session_id, "").trim() ||
    asString(event.sessionId, "").trim() ||
    asString(event.sessionID, "").trim() ||
    null
  );
}

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "") ||
    asString(rec.error, "") ||
    asString(rec.code, "") ||
    asString(rec.detail, "");
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

/**
 * Auggie's `--print --output-format json` mode emits a single JSON object on
 * stdout, optionally preceded by plain-text preamble lines such as
 * "Applying --max-turns override: 2 over agentMaxIterations=500".
 *
 * Shape (observed against auggie 0.24.0):
 *   {
 *     "type": "result",
 *     "result": "<final assistant text>",
 *     "is_error": false,
 *     "subtype": "success",
 *     "session_id": "<uuid>",
 *     "num_turns": 0,
 *     "request_id": "<uuid>"
 *   }
 *
 * Intermediate assistant / tool-call events are not emitted in JSON mode today.
 */
export function parseAuggieJsonResult(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let resultEvent: Record<string, unknown> | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue; // skip plain-text preamble lines

    const foundSessionId = readSessionId(event);
    if (foundSessionId) sessionId = foundSessionId;

    const type = asString(event.type, "").trim();

    if (type === "result") {
      resultEvent = event;
      const resultText =
        asString(event.result, "").trim() ||
        asString(event.text, "").trim() ||
        asString(event.response, "").trim();
      if (resultText) messages.push(resultText);
      const isError =
        event.is_error === true ||
        asString(event.subtype, "").toLowerCase() === "error";
      if (isError) {
        const text = asErrorText(
          event.error ?? event.message ?? event.result,
        ).trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "error") {
      const text = asErrorText(
        event.error ?? event.message ?? event.detail,
      ).trim();
      if (text) errorMessage = text;
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    // Usage tokens are not reported in the current JSON print-mode schema.
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    costUsd: null as number | null,
    errorMessage,
    resultEvent,
    // Auggie JSON mode does not surface structured choice prompts, so question
    // is always null here. Exposed for shape parity with other adapters.
    question: null as null | {
      prompt: string;
      choices: Array<{ key: string; label: string; description?: string }>;
    },
    numTurns: resultEvent
      ? asNumber((resultEvent as Record<string, unknown>).num_turns, 0)
      : 0,
  };
}

export function isAuggieUnknownSessionError(
  stdout: string,
  stderr: string,
): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown\s+session|session\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|cannot\s+resume|failed\s+to\s+resume|no\s+such\s+session/i.test(
    haystack,
  );
}

const AUGGIE_AUTH_REQUIRED_RE =
  /(?:not\s+authenticated|please\s+authenticate|authentication\s+required|unauthorized|invalid\s+credentials|not\s+logged\s+in|login\s+required|run\s+`?auggie\s+login`?|augment_session_auth)/i;

export function detectAuggieAuthRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const parsedError =
    asString((input.parsed ?? {}).error, "") ||
    asString((input.parsed ?? {}).message, "") ||
    "";
  const messages = [parsedError, input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const requiresAuth = messages.some((line) =>
    AUGGIE_AUTH_REQUIRED_RE.test(line),
  );
  return { requiresAuth };
}

export function describeAuggieFailure(
  parsed: Record<string, unknown>,
): string | null {
  const subtype = asString(parsed.subtype, "");
  const isError = parsed.is_error === true;
  const looksLikeFailure = isError || (!!subtype && subtype !== "success");
  if (!looksLikeFailure) return null;
  const result = asString(parsed.result, "");
  const error = asString(parsed.error, "") || asString(parsed.message, "");
  const detail = error || result;
  const parts = ["Auggie run failed"];
  if (subtype && subtype !== "success") parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.join(": ");
}

export function isAuggieTurnLimitResult(
  parsed: Record<string, unknown> | null | undefined,
): boolean {
  if (!parsed) return false;
  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "turn_limit" || subtype === "max_turns") return true;
  const error = asString(parsed.error, "").trim();
  return /turn\s*limit|max(?:imum)?\s+turns?/i.test(error);
}
