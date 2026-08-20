import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseCodeBuddyStdoutLine(line: string, ts: string): TranscriptEntry[] {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = record(JSON.parse(line));
  } catch {
    return [{ kind: "stdout", ts, text: line }];
  }
  if (!parsed) return [{ kind: "stdout", ts, text: line }];
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "system" && parsed.subtype === "init") {
    return [{
      kind: "init",
      ts,
      model: typeof parsed.model === "string" ? parsed.model : "unknown",
      sessionId: typeof parsed.session_id === "string" ? parsed.session_id : "",
    }];
  }
  if (type === "assistant" || type === "user") {
    const message = record(parsed.message) ?? {};
    const entries: TranscriptEntry[] = [];
    for (const raw of Array.isArray(message.content) ? message.content : []) {
      const block = record(raw);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        entries.push({ kind: type === "assistant" ? "assistant" : "user", ts, text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        entries.push({ kind: "thinking", ts, text: block.thinking });
      } else if (block.type === "tool_use") {
        entries.push({
          kind: "tool_call",
          ts,
          name: typeof block.name === "string" ? block.name : "unknown",
          toolUseId: typeof block.id === "string" ? block.id : undefined,
          input: block.input ?? {},
        });
      } else if (block.type === "tool_result") {
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
          content: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
          isError: block.is_error === true,
        });
      }
    }
    if (entries.length > 0) return entries;
  }
  if (type === "result") {
    const usage = record(parsed.usage) ?? {};
    return [{
      kind: "result",
      ts,
      text: typeof parsed.result === "string" ? parsed.result : "",
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      cachedTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
      costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
      subtype: typeof parsed.subtype === "string" ? parsed.subtype : "",
      isError: parsed.is_error === true,
      errors: [],
    }];
  }
  return [{ kind: "stdout", ts, text: line }];
}
