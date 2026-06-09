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

function extractTextContent(content: string | Array<{ type: string; text?: string; thinking?: string }>): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  
  let text = "";
  let thinking = "";
  
  for (const c of content) {
    if (c.type === "text" && c.text) {
      text += c.text;
    }
    if (c.type === "thinking" && c.thinking) {
      thinking += c.thinking;
    }
  }
  
  return { text, thinking };
}

// Track pending tool calls for proper toolUseId matching
let pendingToolCalls = new Map<string, { toolName: string; args: unknown }>();

export function resetParserState(): void {
  pendingToolCalls.clear();
}

export function parsePiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    // Non-JSON line, treat as raw stdout
    const trimmed = line.trim();
    if (!trimmed) return [];
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const type = asString(parsed.type);

  // RPC protocol messages - filter these out (internal implementation detail)
  if (type === "response" || type === "extension_ui_request" || type === "extension_ui_response" || type === "extension_error") {
    return [];
  }

  // Agent lifecycle
  if (type === "agent_start") {
    return [{ kind: "system", ts, text: "🚀 Pi agent started" }];
  }

  if (type === "agent_end") {
    const entries: TranscriptEntry[] = [];
    
    // Extract final message from messages array if available
    const messages = parsed.messages as Array<Record<string, unknown>> | undefined;
    if (messages && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === "assistant") {
        const content = lastMessage.content as string | Array<{ type: string; text?: string; thinking?: string }>;
        const { text, thinking } = extractTextContent(content);
        
        if (thinking) {
          entries.push({ kind: "thinking", ts, text: thinking });
        }
        if (text) {
          entries.push({ kind: "assistant", ts, text });
        }
        
        // Extract usage
        const usage = asRecord(lastMessage.usage);
        if (usage) {
          const inputTokens = (usage.inputTokens ?? usage.input ?? 0) as number;
          const outputTokens = (usage.outputTokens ?? usage.output ?? 0) as number;
          const cachedTokens = (usage.cacheRead ?? usage.cachedInputTokens ?? 0) as number;
          const costRecord = asRecord(usage.cost);
          const costUsd = (costRecord?.total ?? usage.costUsd ?? 0) as number;
          
          if (inputTokens > 0 || outputTokens > 0) {
            entries.push({
              kind: "result",
              ts,
              text: "Run completed",
              inputTokens,
              outputTokens,
              cachedTokens,
              costUsd,
              subtype: "end",
              isError: false,
              errors: [],
            });
          }
        }
      }
    }
    
    if (entries.length === 0) {
      entries.push({ kind: "system", ts, text: "✅ Pi agent finished" });
    }
    
    return entries;
  }

  // Turn lifecycle
  if (type === "turn_start") {
    return []; // Skip noisy lifecycle events
  }

  if (type === "turn_end") {
    const message = asRecord(parsed.message);
    const toolResults = parsed.toolResults as Array<Record<string, unknown>> | undefined;
    
    const entries: TranscriptEntry[] = [];
    
    if (message) {
      const content = message.content as string | Array<{ type: string; text?: string; thinking?: string }>;
      const { text, thinking } = extractTextContent(content);
      
      if (thinking) {
        entries.push({ kind: "thinking", ts, text: thinking });
      }
      if (text) {
        entries.push({ kind: "assistant", ts, text });
      }
    }
    
    // Process tool results - match with pending tool calls
    if (toolResults) {
      for (const tr of toolResults) {
        const toolCallId = asString(tr.toolCallId, `tool-${Date.now()}`);
        const content = tr.content;
        const isError = tr.isError === true;
        
        // Extract text from Pi's content array format
        let contentStr: string;
        if (typeof content === "string") {
          contentStr = content;
        } else if (Array.isArray(content)) {
          const extracted = extractTextContent(content as Array<{ type: string; text?: string }>);
          contentStr = extracted.text || JSON.stringify(content);
        } else {
          contentStr = JSON.stringify(content);
        }
        
        // Get tool name from pending calls if available
        const pendingCall = pendingToolCalls.get(toolCallId);
        const toolName = asString(tr.toolName, pendingCall?.toolName || "tool");
        
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: toolCallId,
          toolName,
          content: contentStr,
          isError,
        });
        
        // Clean up pending call
        pendingToolCalls.delete(toolCallId);
      }
    }
    
    return entries;
  }

  // Message streaming
  if (type === "message_start") {
    return [];
  }

  if (type === "message_update") {
    const assistantEvent = asRecord(parsed.assistantMessageEvent);
    if (assistantEvent) {
      const msgType = asString(assistantEvent.type);
      
      // Handle thinking deltas
      if (msgType === "thinking_delta") {
        const delta = asString(assistantEvent.delta);
        if (delta) {
          return [{ kind: "thinking", ts, text: delta, delta: true }];
        }
      }
      
      // Handle text deltas
      if (msgType === "text_delta") {
        const delta = asString(assistantEvent.delta);
        if (delta) {
          return [{ kind: "assistant", ts, text: delta, delta: true }];
        }
      }
      
      // Handle thinking end - emit full thinking block
      if (msgType === "thinking_end") {
        const content = asString(assistantEvent.content);
        if (content) {
          return [{ kind: "thinking", ts, text: content }];
        }
      }
      
      // Handle text end - emit full text block
      if (msgType === "text_end") {
        const content = asString(assistantEvent.content);
        if (content) {
          return [{ kind: "assistant", ts, text: content }];
        }
      }
    }
    return [];
  }

  if (type === "message_end") {
    const message = asRecord(parsed.message);
    if (message) {
      const content = message.content as string | Array<{ type: string; text?: string; thinking?: string }>;
      const { text, thinking } = extractTextContent(content);
      
      const entries: TranscriptEntry[] = [];
      
      // Emit final thinking block if present
      if (thinking) {
        entries.push({ kind: "thinking", ts, text: thinking });
      }
      
      // Emit final text block if present
      if (text) {
        entries.push({ kind: "assistant", ts, text });
      }
      
      return entries;
    }
    return [];
  }

  // Tool execution
  if (type === "tool_execution_start") {
    const toolCallId = asString(parsed.toolCallId, `tool-${Date.now()}`);
    const toolName = asString(parsed.toolName, "tool");
    const args = parsed.args;
    
    // Track this tool call for later matching
    pendingToolCalls.set(toolCallId, { toolName, args });
    
    return [{
      kind: "tool_call",
      ts,
      name: toolName,
      input: args,
      toolUseId: toolCallId,
    }];
  }

  if (type === "tool_execution_update") {
    return [];
  }

  if (type === "tool_execution_end") {
    const toolCallId = asString(parsed.toolCallId, `tool-${Date.now()}`);
    const toolName = asString(parsed.toolName, "tool");
    const result = parsed.result;
    const isError = parsed.isError === true;
    
    // Extract text from Pi's content array format
    let contentStr: string;
    if (typeof result === "string") {
      contentStr = result;
    } else if (Array.isArray(result)) {
      const extracted = extractTextContent(result as Array<{ type: string; text?: string }>);
      contentStr = extracted.text || JSON.stringify(result);
    } else if (result && typeof result === "object") {
      const resultObj = result as Record<string, unknown>;
      if (Array.isArray(resultObj.content)) {
        const extracted = extractTextContent(resultObj.content as Array<{ type: string; text?: string }>);
        contentStr = extracted.text || JSON.stringify(result);
      } else {
        contentStr = JSON.stringify(result);
      }
    } else {
      contentStr = String(result);
    }
    
    // Clean up pending call
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

  // Fallback for unknown event types
  return [{ kind: "stdout", ts, text: line }];
}
