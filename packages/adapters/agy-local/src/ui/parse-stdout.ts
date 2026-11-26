import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Map one agy stream-json stdout line to transcript entries.
 * Shapes: init, step_update (agent_response / tool), result.
 */
export function parseAgyStdoutLine(line: string, ts: string): TranscriptEntry[] {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(line));
  } catch {
    parsed = null;
  }
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const type = asString(parsed.event);

  if (type === "init") {
    const init = asRecord(parsed.init) ?? {};
    return [{
      kind: "init",
      ts,
      model: asString(init.model, "agy"),
      sessionId: asString(parsed.conversation_id, asString(init.conversation_id)),
    }];
  }

  if (type === "step_update") {
    const step = asRecord(parsed.step_update) ?? {};
    const stepType = asString(step.step_type);
    const state = asString(step.state).toLowerCase();
    // Streamed agent_response deltas are rendered from the final result.
    if (stepType !== "tool") return [];
    const info = asRecord(step.tool_info) ?? {};
    const name = asString(info.name, asString(step.tool_name, "tool")) || "tool";
    const toolUseId = `${asString(step.conversation_id)}:${asNumber(step.step_index)}`;
    const done = state === "done" || state === "completed" || info.output !== undefined;
    if (!done) return [];
    return [
      { kind: "tool_call", ts, name, input: info.parameters ?? {}, toolUseId },
      { kind: "tool_result", ts, toolUseId, content: stringify(info.output), isError: false },
    ];
  }

  if (type === "result") {
    const result = asRecord(parsed.result) ?? {};
    const usage = asRecord(result.usage) ?? {};
    const status = asString(result.status, "SUCCESS");
    const isError = status !== "SUCCESS";
    const response = asString(result.response).trim();
    const entries: TranscriptEntry[] = [];
    if (response) entries.push({ kind: "assistant", ts, text: response });
    entries.push({
      kind: "result",
      ts,
      text: response,
      inputTokens: asNumber(usage.input_tokens),
      outputTokens: asNumber(usage.output_tokens) + asNumber(usage.thinking_tokens),
      cachedTokens: asNumber(usage.cache_read_tokens),
      costUsd: 0,
      subtype: status,
      isError,
      errors: isError ? [status] : [],
    });
    return entries;
  }

  return [{ kind: "stdout", ts, text: line }];
}
