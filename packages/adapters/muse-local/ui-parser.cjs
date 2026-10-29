"use strict";

function createMuseStdoutParser() {
  const state = {
    initialized: false,
    taskToToolId: new Map(),
    taskToName: new Map(),
    completedTools: new Set(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    }
  };

  function parseLine(line, ts) {
    const raw = (line || "").trim();
    if (!raw) return [];

    if (!raw.startsWith("{")) {
      return [{ kind: "stdout", ts, text: line }];
    }

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return [{ kind: "stdout", ts, text: line }];
    }

    if (!obj || typeof obj !== "object") {
      return [{ kind: "stdout", ts, text: line }];
    }

    const payloadType = typeof obj.payload_type === "string" ? obj.payload_type : "";
    const payload = (obj.payload && typeof obj.payload === "object") ? obj.payload : {};
    const event = (payload.event && typeof payload.event === "object") ? payload.event : {};

    // 1. Session & Model Initialization
    if (payloadType === "run.model.configured" || payloadType === "runtime.command.accepted") {
      if (!state.initialized) {
        state.initialized = true;
        const model = payload.model || (payload.configuration && payload.configuration.model) || "muse-wonder-1.0";
        const sessionId = obj.stream?.id || "";
        return [{ kind: "init", ts, model, sessionId }];
      }
      return [];
    }

    // 2. User Input
    if (payloadType === "turn.input.user") {
      const prompt = payload.prompt || "";
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
      const text = payload.text || "";
      return text ? [{ kind: "assistant", ts, text: String(text), delta: true }] : [];
    }

    // 5. Tool Proposed
    if (payloadType === "task.lifecycle.proposed") {
      const taskId = event.task_id || payload.task_id;
      const taskKind = event.task_kind || "";
      if (taskKind.startsWith("tool.")) {
        const name = taskKind.replace(/^tool\./, "");
        if (taskId) state.taskToName.set(taskId, name);
      }
      return [];
    }

    // 6. Tool Side Effect Intent / Start
    if (payloadType === "task.lifecycle.side_effect_intent") {
      const operation = event.operation || "";
      if (operation.startsWith("tool:")) {
        const name = operation.replace(/^tool:/, "");
        const rawId = event.idempotency_key || event.task_id || payload.task_id || "";
        const toolUseId = rawId.replace(/^tool:/, "");
        const taskId = event.task_id || payload.task_id;
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
      const taskId = event.task_id || payload.task_id;
      const toolUseId = state.taskToToolId.get(taskId) || taskId;
      const chunk = event.chunk || "";
      let chunkObj = null;
      try {
        chunkObj = JSON.parse(chunk);
      } catch {}

      const entries = [];
      if (chunkObj && typeof chunkObj === "object") {
        const inputUpdate = {};
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
        entries.push({ kind: "tool_result", ts, toolUseId, content: String(chunk), isError: false });
      }
      return entries;
    }

    // 8. Tool Result
    if (payloadType === "tool.result") {
      const rawId = payload.call_id || "";
      const toolUseId = rawId.replace(/^tool:/, "");
      if (toolUseId && state.completedTools.has(toolUseId)) {
        return [];
      }
      if (toolUseId) state.completedTools.add(toolUseId);
      const outcome = payload.correlation_facts?.outcome;
      const isError = outcome === "error" || outcome === "failure";
      let content = payload.text || "";
      try {
        const cObj = JSON.parse(content);
        if (cObj && cObj.output !== undefined) {
          content = String(cObj.output);
        }
      } catch {}
      return [{ kind: "tool_result", ts, toolUseId, content, isError }];
    }

    // 9. Token Usage
    if (payloadType === "run.usage" && Array.isArray(payload.models)) {
      for (const m of payload.models) {
        state.usage.inputTokens += Number(m.input_tokens) || 0;
        state.usage.outputTokens += Number(m.output_tokens) || 0;
        state.usage.cachedTokens += Number(m.cached_tokens) || 0;
      }
      return [];
    }

    // 10. Run Terminal / Completed
    if (payloadType === "run.terminal.completed") {
      const isError = payload.terminal === "failed";
      const text = payload.text || (isError ? "Muse run failed" : "Completed");
      return [{
        kind: "result",
        ts,
        text,
        inputTokens: state.usage.inputTokens,
        outputTokens: state.usage.outputTokens,
        cachedTokens: state.usage.cachedTokens,
        costUsd: 0,
        subtype: payload.terminal || "completed",
        isError,
        errors: isError ? [text] : []
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
function parseMuseStdoutLine(line, ts) {
  return defaultParser.parseLine(line, ts);
}

module.exports = {
  parseStdoutLine: parseMuseStdoutLine,
  createStdoutParser: createMuseStdoutParser,
  parseMuseStdoutLine: parseMuseStdoutLine,
  createMuseStdoutParser: createMuseStdoutParser,
};
if (typeof exports !== "undefined") {
  exports.parseStdoutLine = parseMuseStdoutLine;
  exports.createStdoutParser = createMuseStdoutParser;
  exports.parseMuseStdoutLine = parseMuseStdoutLine;
  exports.createMuseStdoutParser = createMuseStdoutParser;
}
