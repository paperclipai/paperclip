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

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

let pendingToolCalls = new Map<string, { toolName: string; args: unknown }>();

export function resetParserState(): void {
  pendingToolCalls.clear();
}

/**
 * Parse a single line from jcode's --ndjson stdout stream into transcript entries.
 */
export function parseJcodeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    const trimmed = line.trim();
    if (!trimmed) return [];
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const type = asString(parsed.type);

  switch (type) {
    case "start":
    case "connection_phase":
    case "connection_type":
      return [];

    case "text_delta": {
      const delta = asString(parsed.delta, "");
      if (!delta) return [];
      return [{ kind: "assistant", ts, text: delta, delta: true }];
    }

    case "text_replace": {
      const text = asString(parsed.text, "");
      if (!text) return [];
      return [{ kind: "assistant", ts, text }];
    }

    case "tool_start": {
      const toolCallId = asString(parsed.tool_call_id, `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const toolName = asString(parsed.tool_name, "unknown");
      const args = parsed.args ?? {};
      pendingToolCalls.set(toolCallId, { toolName, args });
      return [{
        kind: "tool_call",
        ts,
        name: toolName,
        input: args,
        toolUseId: toolCallId,
      }];
    }

    case "tool_input": {
      const toolCallId = asString(parsed.tool_call_id, "");
      const toolInput = parsed.input;
      const pending = toolCallId ? pendingToolCalls.get(toolCallId) : null;
      if (pending && toolInput !== undefined) {
        pending.args = toolInput;
      }
      return [];
    }

    case "tool_exec": {
      const toolCallId = asString(parsed.tool_call_id, "");
      const result = parsed.result;
      const isError = parsed.is_error === true;
      const toolName = pendingToolCalls.get(toolCallId)?.toolName ?? "tool";
      const contentStr = typeof result === "string" ? result : JSON.stringify(result);
      pendingToolCalls.delete(toolCallId);
      return [{
        kind: "tool_result",
        ts,
        toolUseId: toolCallId,
        toolName,
        content: contentStr,
        isError,
      }];
    }

    case "tool_done": {
      const toolCallId = asString(parsed.tool_call_id, "");
      const isError = parsed.is_error === true;
      const result = parsed.result;
      pendingToolCalls.delete(toolCallId);
      if (result !== undefined) {
        const toolName = pendingToolCalls.get(toolCallId)?.toolName ?? "tool";
        const contentStr = typeof result === "string" ? result : JSON.stringify(result);
        return [{
          kind: "tool_result",
          ts,
          toolUseId: toolCallId,
          toolName,
          content: contentStr,
          isError,
        }];
      }
      return [];
    }

    case "tokens":
      return [];

    case "done": {
      const sessionId = asString(parsed.session_id, "");
      const model = asString(parsed.model, "");
      const provider = asString(parsed.provider, "");
      const text = asString(parsed.text, "");
      const usage = asRecord(parsed.usage);
      const inputTokens = asNumber(usage?.input_tokens, 0);
      const outputTokens = asNumber(usage?.output_tokens, 0);
      const cachedTokens = asNumber(usage?.cache_read_input_tokens, 0);

      const entries: TranscriptEntry[] = [];
      if (text) {
        entries.push({ kind: "assistant", ts, text });
      }
      if (inputTokens > 0 || outputTokens > 0) {
        entries.push({
          kind: "result",
          ts,
          text: `Run completed (${model || provider || "jcode"})`,
          inputTokens,
          outputTokens,
          cachedTokens,
          costUsd: 0,
          subtype: "end",
          isError: false,
          errors: [],
        });
      }
      return entries;
    }

    case "error": {
      const message = asString(parsed.message, "");
      if (!message) return [];
      return [{ kind: "stderr", ts, text: message }];
    }

    default:
      return [{ kind: "stdout", ts, text: line }];
  }
}
