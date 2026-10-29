import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export interface MuseStdoutParser {
  parseLine: (line: string, ts: string) => TranscriptEntry[];
  reset: () => void;
}

export function createMuseStdoutParser(): MuseStdoutParser {
  const state = {
    initialized: false,
    taskToToolId: new Map<string, string>(),
    taskToName: new Map<string, string>(),
    completedTools: new Set<string>(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    },
  };

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const raw = (line || "").trim();
    if (!raw) return [];

    if (!raw.startsWith("{")) {
      return [{ kind: "stdout", ts, text: line }];
    }

    const obj = asRecord(safeJsonParse(raw));
    if (!obj) {
      return [{ kind: "stdout", ts, text: line }];
    }

    const payloadType = typeof obj.payload_type === "string" ? obj.payload_type : "";
    const payload = asRecord(obj.payload) || {};
    const event = asRecord(payload.event) || {};

    // 1. Session & Model Initialization
    if (payloadType === "run.model.configured" || payloadType === "runtime.command.accepted") {
      if (!state.initialized) {
        state.initialized = true;
        const conf = asRecord(payload.configuration);
        const model = (typeof payload.model === "string" && payload.model) || (conf && typeof conf.model === "string" && conf.model) || "muse-wonder-1.0";
        const stream = asRecord(obj.stream);
        const sessionId = (stream && typeof stream.id === "string" && stream.id) || "";
        return [{ kind: "init", ts, model, sessionId }];
      }
      return [];
    }

    // 2. User Turn
    if (payloadType === "turn.input.user") {
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      return prompt ? [{ kind: "user", ts, text: prompt }] : [];
    }

    // 3. Thinking / Chain of Thought
    if (
      payloadType === "thought" ||
      payloadType === "run.thought.delta" ||
      payloadType === "reasoning.delta" ||
      payload.thought !== undefined ||
      payload.reasoning !== undefined
    ) {
      const text = payload.thought || payload.reasoning || payload.text || payload.data || "";
      return text ? [{ kind: "thinking", ts, text: String(text), delta: true }] : [];
    }

    // 4. Streaming Assistant Output
    if (payloadType === "run.output.delta") {
      const text = typeof payload.text === "string" ? payload.text : "";
      return text ? [{ kind: "assistant", ts, text, delta: true }] : [];
    }

    // 5. Tool Proposed
    if (payloadType === "task.lifecycle.proposed") {
      const taskId = String(event.task_id || payload.task_id || "");
      const taskKind = String(event.task_kind || "");
      if (taskKind.startsWith("tool.")) {
        const name = taskKind.replace(/^tool\./, "");
        if (taskId) state.taskToName.set(taskId, name);
      }
      return [];
    }

    // 6. Tool Side Effect Intent / Start
    if (payloadType === "task.lifecycle.side_effect_intent") {
      const operation = String(event.operation || "");
      if (operation.startsWith("tool:")) {
        const name = operation.replace(/^tool:/, "");
        const rawId = String(event.idempotency_key || event.task_id || payload.task_id || "");
        const toolUseId = rawId.replace(/^tool:/, "");
        const taskId = String(event.task_id || payload.task_id || "");
        if (taskId) {
          state.taskToToolId.set(taskId, toolUseId);
          state.taskToName.set(taskId, name);
        }
        return [{ kind: "tool_call", ts, name, toolUseId, input: {} }];
      }
      return [];
    }

    // 7. Tool Lifecycle Output / Execution Chunk
    if (payloadType === "task.lifecycle.output") {
      const taskId = String(event.task_id || payload.task_id || "");
      const toolUseId = state.taskToToolId.get(taskId) || taskId;
      const chunk = String(event.chunk || "");
      const chunkObj = asRecord(safeJsonParse(chunk));

      const entries: TranscriptEntry[] = [];
      if (chunkObj) {
        const inputUpdate: Record<string, unknown> = {};
        if (chunkObj.command) inputUpdate.command = chunkObj.command;
        if (chunkObj.description) inputUpdate.description = chunkObj.description;
        if (Object.keys(inputUpdate).length > 0) {
          const name = state.taskToName.get(taskId) || "tool";
          entries.push({ kind: "tool_call", ts, name, toolUseId, input: inputUpdate });
        }
        if (chunkObj.output !== undefined || chunkObj.terminal_status === "completed") {
          const content = chunkObj.output !== undefined ? String(chunkObj.output) : chunk;
          const isError = chunkObj.exit_code !== 0 && chunkObj.exit_code != null;
          state.completedTools.add(toolUseId);
          entries.push({ kind: "tool_result", ts, toolUseId, content, isError });
        }
      } else if (chunk) {
        state.completedTools.add(toolUseId);
        entries.push({ kind: "tool_result", ts, toolUseId, content: chunk, isError: false });
      }
      return entries;
    }

    // 8. Tool Result
    if (payloadType === "tool.result") {
      const rawId = String(payload.call_id || "");
      const toolUseId = rawId.replace(/^tool:/, "");
      if (toolUseId && state.completedTools.has(toolUseId)) {
        return [];
      }
      if (toolUseId) state.completedTools.add(toolUseId);
      const correlation = asRecord(payload.correlation_facts);
      const outcome = correlation ? String(correlation.outcome || "") : "";
      const isError = outcome === "error" || outcome === "failure";
      let content = String(payload.text || "");
      const cObj = asRecord(safeJsonParse(content));
      if (cObj && cObj.output !== undefined) {
        content = String(cObj.output);
      }
      return [{ kind: "tool_result", ts, toolUseId, content, isError }];
    }

    // 9. Token Usage
    if (payloadType === "run.usage" && Array.isArray(payload.models)) {
      for (const m of payload.models) {
        const mod = asRecord(m);
        if (mod) {
          state.usage.inputTokens += Number(mod.input_tokens) || 0;
          state.usage.outputTokens += Number(mod.output_tokens) || 0;
          state.usage.cachedTokens += Number(mod.cached_tokens) || 0;
        }
      }
      return [];
    }

    // 10. Run Terminal / Completed
    if (payloadType === "run.terminal.completed") {
      const isError = payload.terminal === "failed";
      const text = typeof payload.text === "string" && payload.text ? payload.text : (isError ? "Muse run failed" : "Completed");
      return [{
        kind: "result",
        ts,
        text,
        inputTokens: state.usage.inputTokens,
        outputTokens: state.usage.outputTokens,
        cachedTokens: state.usage.cachedTokens,
        costUsd: 0,
        subtype: typeof payload.terminal === "string" ? payload.terminal : "completed",
        isError,
        errors: isError ? [text] : [],
      }];
    }

    return [];
  }

  function reset() {
    state.initialized = false;
    state.taskToToolId.clear();
    state.taskToName.clear();
    state.completedTools.clear();
    state.usage.inputTokens = 0;
    state.usage.outputTokens = 0;
    state.usage.cachedTokens = 0;
  }

  return { parseLine, reset };
}

const defaultParser = createMuseStdoutParser();
export function parseMuseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return defaultParser.parseLine(line, ts);
}
