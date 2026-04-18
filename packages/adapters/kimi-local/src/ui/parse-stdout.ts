import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, defaultValue = ""): string {
  return typeof value === "string" ? value : defaultValue;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse a single line of Kimi's stream-json output.
 */
export function parseKimiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const event = asRecord(safeJsonParse(trimmed));
  if (!event) {
    // Not valid JSON, treat as plain text output
    return [
      {
        kind: "assistant",
        ts,
        text: trimmed,
      },
    ];
  }

  const entries: TranscriptEntry[] = [];
  const role = asString(event.role, "");

  // Handle assistant messages
  if (role === "assistant") {
    const content = Array.isArray(event.content) ? event.content : [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block) continue;
      
      const blockType = asString(block.type, "");
      if (blockType === "think") {
        const text = asString(block.think, "");
        if (text) {
          entries.push({
            kind: "thinking",
            ts,
            text,
          });
        }
      } else if (blockType === "text") {
        const text = asString(block.text, "");
        if (text) {
          entries.push({
            kind: "assistant",
            ts,
            text,
          });
        }
      }
    }
    return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: line }];
  }

  // Handle tool calls (if Kimi supports them in this format)
  const toolCalls = event.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      const tc = asRecord(toolCall);
      if (!tc) continue;
      
      const toolName = asString(tc.name, "");
      const toolInput = tc.arguments || tc.input || {};
      if (toolName) {
        entries.push({
          kind: "tool_call",
          ts,
          name: toolName,
          input: typeof toolInput === "object" ? toolInput : {},
        });
      }
    }
  }

  // If no specific handling, return empty
  return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: line }];
}
