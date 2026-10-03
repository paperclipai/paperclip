// Dependency-free normalization shared by the server, browser and terminal.
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function normalizeAgyEvents(line: string): Record<string, unknown>[] | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = record(raw);
  if (event.event === "init") {
    return [{ ...record(event.init), type: "system", subtype: "init", conversation_id: event.conversation_id }];
  }
  if (event.event === "result") {
    const result = record(event.result);
    const status = typeof result.status === "string" ? result.status : "";
    const isError = status !== "" && status !== "SUCCESS";
    return [{ ...result, type: "result", text: result.response, isError,
      error: isError ? result.error ?? `AGY finished with status ${status}` : undefined }];
  }
  if (event.event === "step_update") {
    const step = record(event.step_update);
    const base = { ...step, stepIndex: step.step_index, stepUsage: step.usage };
    const convId = typeof step.conversation_id === "string" && step.conversation_id
      ? step.conversation_id
      : (typeof event.conversation_id === "string" && event.conversation_id ? event.conversation_id : "agy");
    if (step.step_type === "agent_response") {
      const itemId = `${convId}:${step.step_index ?? "response"}`;
      const text = typeof step.text_delta === "string" ? step.text_delta : (typeof step.text === "string" ? step.text : "");
      return [{ ...base, type: "assistant", text, delta: true, itemId }];
    }
    if (step.step_type === "thinking" || step.step_type === "thought") {
      const itemId = `${convId}:${step.step_index ?? "thinking"}`;
      const text = typeof step.text_delta === "string" ? step.text_delta : (typeof step.text === "string" ? step.text : "");
      return [{ ...base, type: "thinking", text, delta: true, itemId }];
    }
    if (step.step_type === "tool") {
      const tool = record(step.tool_info);
      const toolName = typeof tool.name === "string" && tool.name ? tool.name : (typeof step.tool_name === "string" && step.tool_name ? step.tool_name : "tool");
      const explicitId =
        (typeof tool.toolUseId === "string" && tool.toolUseId) ||
        (typeof tool.tool_use_id === "string" && tool.tool_use_id) ||
        (typeof tool.call_id === "string" && tool.call_id) ||
        (typeof tool.id === "string" && tool.id) ||
        (typeof step.toolUseId === "string" && step.toolUseId) ||
        (typeof step.tool_use_id === "string" && step.tool_use_id) ||
        null;
      const toolUseId = explicitId ?? `${convId}:${step.step_index ?? "tool"}`;
      const call = { ...base, type: "tool_call", name: toolName, input: tool.parameters ?? {}, toolUseId };
      if (step.state !== "DONE") return [call];
      const toolError = tool.error;
      const errorMsg = typeof toolError === "string" ? toolError : record(toolError).message ?? (toolError ? String(toolError) : undefined);
      const rawOutput = tool.output != null ? (typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output)) : "";
      const content = rawOutput !== "" ? rawOutput : (errorMsg ?? "");
      return [call, { type: "tool_result", toolUseId, toolName, content, isError: tool.error != null }];
    }
    return [{ ...base, type: "system", text: `${step.step_type ?? "step"}: ${step.state ?? ""}` }];
  }
  return [event]; // Retain the older type-based format and unknown events.
}

export function hasAgyUsage(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const isCount = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return (
    isCount(raw.inputTokens) ||
    isCount(raw.input_tokens) ||
    isCount(raw.outputTokens) ||
    isCount(raw.output_tokens) ||
    isCount(raw.cachedInputTokens) ||
    isCount(raw.cached_input_tokens) ||
    isCount(raw.cache_read_tokens)
  );
}

export function agyUsage(value: unknown) {
  const usage = record(value);
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    inputTokens: count(usage.inputTokens ?? usage.input_tokens),
    outputTokens: count(usage.outputTokens ?? usage.output_tokens),
    cachedInputTokens: count(usage.cachedInputTokens ?? usage.cached_input_tokens ?? usage.cache_read_tokens),
  };
}
