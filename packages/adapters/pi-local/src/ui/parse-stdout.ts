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

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
}

export function parsePiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  // RPC protocol messages - filter these out (internal implementation detail)
  if (type === "response" || type === "extension_ui_request" || type === "extension_ui_response" || type === "extension_error") {
    return [];
  }

  // Agent lifecycle
  if (type === "agent_start") {
    return [{ kind: "system", ts, text: "Pi agent started" }];
  }

  if (type === "agent_end") {
    return [{ kind: "system", ts, text: "Pi agent finished" }];
  }

  // Turn lifecycle
  if (type === "turn_start") {
    return [{ kind: "system", ts, text: "Turn started" }];
  }

  if (type === "turn_end") {
    const message = asRecord(parsed.message);
    const toolResults = parsed.toolResults as Array<Record<string, unknown>> | undefined;
    
    const entries: TranscriptEntry[] = [];
    
    if (message) {
      const content = message.content as string | Array<{ type: string; text?: string }>;
      const text = extractTextContent(content);
      if (text) {
        entries.push({ kind: "assistant", ts, text });
      }
    }
    
    // Process tool results
    if (toolResults) {
      for (const tr of toolResults) {
        const content = tr.content;
        const isError = tr.isError === true;
        const contentStr = typeof content === "string" ? content : JSON.stringify(content);
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: asString(tr.toolCallId, "unknown"),
          content: contentStr,
          isError,
        });
      }
    }
    
    return entries.length > 0 ? entries : [{ kind: "system", ts, text: "Turn ended" }];
  }

  // Message streaming
  if (type === "message_start") {
    return [];
  }

  if (type === "message_update") {
    const assistantEvent = asRecord(parsed.assistantMessageEvent);
    if (assistantEvent) {
      const msgType = asString(assistantEvent.type);
      if (msgType === "text_delta") {
        const delta = asString(assistantEvent.delta);
        if (delta) {
          return [{ kind: "assistant", ts, text: delta, delta: true }];
        }
      }
    }
    return [];
  }

  if (type === "message_end") {
    return [];
  }

  // Tool execution
  if (type === "tool_execution_start") {
    const toolName = asString(parsed.toolName);
    const args = parsed.args;
    if (toolName) {
      return [{
        kind: "tool_call",
        ts,
        name: toolName,
        input: args,
      }];
    }
    return [{ kind: "system", ts, text: `Tool started` }];
  }

  if (type === "tool_execution_update") {
    return [];
  }

  if (type === "tool_execution_end") {
    const toolCallId = asString(parsed.toolCallId);
    const result = parsed.result;
    const isError = parsed.isError === true;
    const contentStr = typeof result === "string" ? result : JSON.stringify(result);
    
    return [{
      kind: "tool_result",
      ts,
      toolUseId: toolCallId || "unknown",
      content: contentStr,
      isError,
    }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
