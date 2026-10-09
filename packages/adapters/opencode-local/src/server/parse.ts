import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
  };
}

export interface OpenCodeToolCallRuntimeEvent {
  eventType: "opencode.tool_call";
  stream: "stdout";
  /** Tool name or invocation title, when the part carries one. */
  message: string | null;
  payload: {
    name: string | null;
    toolCallId: string | null;
    status: string | null;
  };
}

/**
 * Parse one OpenCode `run --format json` stdout line for tool-call activity.
 * A `tool_use` event is emitted for every tool-part update OpenCode streams
 * (pending → running → completed/error), so callers see both the start and the
 * outcome of each provider tool call — including the call that was still
 * running when the provider died. Non-tool lines, and tool lines whose status
 * or identity cannot be read, yield no events rather than guesses.
 */
export function extractOpenCodeToolCallEvents(
  line: string,
): OpenCodeToolCallRuntimeEvent[] {
  const event = parseJson(line);
  if (!event) return [];
  if (asString(event.type, "") !== "tool_use") return [];
  const part = parseObject(event.part);
  const state = parseObject(part.state);
  const toolCallId = asString(part.callID, "").trim() || asString(part.callId, "").trim() || asString(part.id, "").trim() || null;
  const name = asString(part.tool, "").trim() || asString(state.title, "").trim() || null;
  const status = asString(state.status, "").trim() || null;
  if (!toolCallId && !name) return [];
  return [
    {
      eventType: "opencode.tool_call",
      stream: "stdout",
      message: name,
      payload: { name, toolCallId, status },
    },
  ];
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}
