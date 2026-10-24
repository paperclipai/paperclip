import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

interface MuseParserState {
  sessionId: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

function parseLineWithState(state: MuseParserState, line: string, ts: string): TranscriptEntry[] {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(line));
  } catch {
    parsed = null;
  }
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const stream = asRecord(parsed.stream);
  if (stream?.kind === "session" && typeof stream.id === "string" && stream.id) {
    state.sessionId = stream.id;
  }
  const payloadType = asText(parsed.payload_type);
  const payload = asRecord(parsed.payload) ?? {};

  if (payloadType === "run.model.configured") {
    state.model = asText(payload.model_id) || state.model;
    return [{ kind: "init", ts, model: state.model, sessionId: state.sessionId }];
  }

  if (payloadType === "turn.input.user") {
    const text = asText(payload.prompt);
    return text ? [{ kind: "user", ts, text }] : [];
  }

  if (payloadType === "run.output.delta") {
    const text = asText(payload.text);
    return text ? [{ kind: "assistant", ts, text, delta: true }] : [];
  }

  if (payloadType === "task.lifecycle.proposed") {
    const event = asRecord(payload.event) ?? {};
    const taskKind = asText(event.task_kind);
    if (!taskKind.startsWith("tool.")) return [];
    return [
      {
        kind: "tool_call",
        ts,
        name: taskKind.slice("tool.".length) || "tool",
        toolUseId: asText(event.task_id) || undefined,
        input: {},
      },
    ];
  }

  if (payloadType === "tool.result" || payload.kind === "tool_result") {
    const facts = asRecord(payload.correlation_facts) ?? {};
    const editFacts = asRecord(payload.edit_facts) ?? {};
    const outcome = asText(facts.outcome);
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: asText(payload.call_id) || "tool",
        toolName: asText(facts.tool_name) || asText(editFacts.tool_name) || undefined,
        content: asText(payload.text),
        isError: outcome.length > 0 && outcome !== "success",
      },
    ];
  }

  if (payloadType === "run.usage") {
    const models = Array.isArray(payload.models) ? payload.models : [];
    state.inputTokens = 0;
    state.cachedTokens = 0;
    state.outputTokens = 0;
    for (const entry of models) {
      const record = asRecord(entry);
      if (!record) continue;
      state.inputTokens += asCount(record.input_tokens);
      state.cachedTokens += asCount(record.cached_tokens);
      state.outputTokens += asCount(record.output_tokens) + asCount(record.reasoning_tokens);
      if (!state.model && typeof record.model === "string" && record.model) state.model = record.model;
    }
    return [];
  }

  if (payloadType.startsWith("run.terminal.") || payload.kind === "run_terminal") {
    const terminal = asText(payload.terminal) || payloadType.slice("run.terminal.".length);
    const isError = terminal !== "completed";
    const reason = asText(payload.reason);
    return [
      {
        kind: "result",
        ts,
        text: asText(payload.text) || reason,
        inputTokens: Math.max(0, state.inputTokens - state.cachedTokens),
        outputTokens: state.outputTokens,
        cachedTokens: state.cachedTokens,
        costUsd: 0,
        subtype: terminal || "completed",
        isError,
        errors: isError && reason ? [reason] : [],
      },
    ];
  }

  if (payloadType.startsWith("task.") || payloadType.startsWith("session.") || payloadType.startsWith("runtime.")) {
    return [];
  }

  return [{ kind: "stdout", ts, text: line }];
}

export function createMuseCodeStdoutParser() {
  const state: MuseParserState = { sessionId: "", model: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  return {
    parseLine: (line: string, ts: string) => parseLineWithState(state, line, ts),
    reset: () => {
      state.sessionId = "";
      state.model = "";
      state.inputTokens = 0;
      state.cachedTokens = 0;
      state.outputTokens = 0;
    },
  };
}

export function parseMuseCodeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const state: MuseParserState = { sessionId: "", model: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  return parseLineWithState(state, line, ts);
}
