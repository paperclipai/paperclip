import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

export interface CopilotLocalResult {
  sessionId: string | null;
  summary: string;
  errorMessage: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  premiumRequests: number;
  model: string | null;
}

/**
 * Parse a single JSONL line into an envelope with `type` and `data`.
 *
 * Copilot CLI v1.0.24 envelope format:
 * ```
 * {"type":"assistant.message_delta","data":{"deltaContent":"hi"},"id":"...","timestamp":"...","ephemeral":true}
 * ```
 * Top-level keys: type, data, id, timestamp, parentId, ephemeral.
 * The `result` event is an exception — it puts sessionId, exitCode, usage at top level.
 */
function parseEvent(line: string): { type: string; data: Record<string, unknown>; raw: Record<string, unknown> } | null {
  const parsed = parseJson(line);
  if (!parsed) return null;
  const obj = parseObject(parsed);
  const type = asString(obj.type, "");
  if (!type) return null;

  // `data` envelope — most events nest payload here
  const dataRaw = obj.data;
  const data = (typeof dataRaw === "object" && dataRaw !== null && !Array.isArray(dataRaw))
    ? (dataRaw as Record<string, unknown>)
    : {};

  return { type, data, raw: obj };
}

/**
 * Parse JSONL output from the Copilot CLI (`copilot -p --output-format json`).
 *
 * Each line is a JSON object. Chunks from `runChildProcess` may contain multiple
 * newline-separated JSON objects (buffering), so we split on `\n` first.
 */
export function parseCopilotLocalJsonl(stdout: string): CopilotLocalResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
  let premiumRequests = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseEvent(line);
    if (!event) continue;

    const { type, data, raw } = event;

    // --- assistant.message_delta: streaming text chunk ---
    if (type === "assistant.message_delta") {
      const content = asString(data.deltaContent, "");
      if (content) messages.push(content);
      continue;
    }

    // --- assistant.message: complete message (may include tool requests) ---
    if (type === "assistant.message") {
      const content = asString(data.content, "");
      if (content) messages.push(content);
      // Accumulate per-message outputTokens
      const msgTokens = asNumber(data.outputTokens, 0);
      if (msgTokens > 0) usage.outputTokens += msgTokens;
      continue;
    }

    // --- assistant.reasoning / assistant.reasoning_delta: skip (encrypted/opaque) ---
    if (type === "assistant.reasoning" || type === "assistant.reasoning_delta") {
      continue;
    }

    // --- tool events: extract model info, otherwise skip (Copilot handles internally) ---
    if (type === "tool.execution_start" || type === "tool.execution_complete" || type === "tool.execution_partial_result") {
      // tool.execution_complete carries the model name
      if (type === "tool.execution_complete") {
        const m = asString(data.model, "");
        if (m && !model) model = m;
      }
      continue;
    }

    // --- result: final result summary ---
    if (type === "result") {
      // sessionId and exitCode are top-level on result events
      sessionId = asString(raw.sessionId, "") || sessionId;

      // usage is top-level on result
      const usageObj = parseObject(raw.usage);
      premiumRequests += asNumber(usageObj.premiumRequests, 0);
      // Copilot CLI doesn't report inputTokens/outputTokens in result.usage
      // but may have totalApiDurationMs, sessionDurationMs, codeChanges
      continue;
    }

    // --- assistant.usage: token tracking (if emitted) ---
    if (type === "assistant.usage") {
      const usageData = (Object.keys(data).length > 0) ? data : parseObject(raw.usage);
      usage.inputTokens += asNumber(usageData.inputTokens, 0);
      usage.outputTokens += asNumber(usageData.outputTokens, 0);
      continue;
    }

    // --- session.* events: skip (ephemeral setup events) ---
    if (type.startsWith("session.")) {
      // Extract model from session.tools_updated if available
      if (type === "session.tools_updated") {
        const m = asString(data.model, "");
        if (m) model = m;
      }
      continue;
    }

    // --- user.message / assistant.turn_start / assistant.turn_end / assistant.intent: skip ---
    if (type === "user.message" || type === "assistant.turn_start" || type === "assistant.turn_end" || type === "assistant.intent") {
      continue;
    }

    // --- error: accumulate into errors ---
    if (type === "error") {
      const msg = asString(data.message, "").trim() || asString(raw.message, "").trim();
      if (msg) {
        errors.push(msg);
      } else {
        const errObj = parseObject(data.error ?? raw.error);
        const nestedMsg = asString(errObj.message, "").trim();
        if (nestedMsg) errors.push(nestedMsg);
      }
      continue;
    }

    // Unknown event types: log at debug level for diagnostics, then skip
    console.debug(`[copilot-local] Skipping unrecognised JSONL event type=${JSON.stringify(type)}`);
  }

  return {
    sessionId,
    summary: messages.join("").trim(),
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    usage,
    premiumRequests,
    model,
  };
}

/**
 * Detect if Copilot CLI output indicates a stale/expired/invalid session.
 */
export function isCopilotLocalStaleSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /invalid\s+session|session\s+not\s+found|session\s.*expired|unknown\s+session/i.test(
    haystack,
  );
}
