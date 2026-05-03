import type { UIAdapterModule, StatefulStdoutParser } from "../types";
import { BobShellConfigFields } from "./config-fields";
import type { CreateConfigValues, TranscriptEntry } from "@paperclipai/adapter-utils";

function createBobShellStdoutParser(): StatefulStdoutParser {
  let buffer = "";
  // State for multi-line XML blocks
  let inThinking = false;
  let inToolCall = false;
  let inToolResult = false;
  let toolName = "";
  let blockText = "";
  let lastAssistantText = "";

  const flush = (ts: string): TranscriptEntry[] => {
    const text = blockText.trim();
    blockText = "";
    return text ? [{ kind: "assistant" as const, ts, text }] : [];
  };

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    buffer = line;

    // [paperclip] and [system] internal lines — skip
    if (line.startsWith("[paperclip]") || line.startsWith("[system]")) return [];

    // Tool status line: "Tool <name> status: Success/Error"
    const toolStatusMatch = line.match(/^Tool <(\w+)> status: (Success|Error)/);
    if (toolStatusMatch) {
      inToolResult = true;
      toolName = toolStatusMatch[1];
      return [];
    }

    // [using tool name: ...] progress lines — skip
    if (line.match(/^\[using tool /)) return [];

    // Thinking block open
    if (line.includes("<thinking>") && !line.includes("</thinking>")) {
      const entries = flush(ts);
      inThinking = true;
      const after = line.slice(line.indexOf("<thinking>") + "<thinking>".length);
      if (after.trim()) blockText = after;
      return entries;
    }

    // Thinking block close
    if (inThinking) {
      if (line.includes("</thinking>")) {
        const before = line.slice(0, line.indexOf("</thinking>"));
        if (before.trim()) blockText += "\n" + before;
        const text = blockText.trim();
        blockText = "";
        inThinking = false;
        return text ? [{ kind: "thinking" as const, ts, text }] : [];
      }
      blockText += "\n" + line;
      return [];
    }

    // attempt_completion result
    const legacyMatch = line.match(/^\[using tool attempt_completion:/);
    if (legacyMatch) {
      inToolCall = true;
      toolName = "attempt_completion";
      blockText = "";
      return [];
    }

    // ---output--- block (legacy attempt_completion result)
    if (line.trim() === "---output---") {
      if (inToolCall && toolName === "attempt_completion") {
        // Start capturing result
        blockText = "";
      }
      return [];
    }

    // XML tool call open: <tool_name>
    const xmlOpenMatch = !inThinking && !inToolCall && line.match(/^<([a-z_][a-z0-9_]*)>$/i);
    if (xmlOpenMatch && !["thinking", "attempt_completion", "result", "response"].includes(xmlOpenMatch[1])) {
      const entries = flush(ts);
      inToolCall = true;
      toolName = xmlOpenMatch[1];
      blockText = "";
      return entries;
    }

    // XML tool call close: </tool_name>
    if (inToolCall) {
      const xmlCloseMatch = line.match(/^<\/([a-z_][a-z0-9_]*)>$/i);
      if (xmlCloseMatch && xmlCloseMatch[1] === toolName) {
        const input = blockText.trim();
        inToolCall = false;
        blockText = "";
        if (toolName === "attempt_completion") {
          const resultMatch = input.match(/<result>([\s\S]*?)<\/result>/);
          const resultText = resultMatch ? resultMatch[1].trim() : input;
          if (!resultText) return [];
          return [{
            kind: "result" as const,
            ts,
            text: resultText,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            costUsd: 0,
            subtype: "success",
            isError: false,
            errors: [],
          }];
        }
        return [{
          kind: "tool_call" as const,
          ts,
          name: toolName,
          input,
        }];
      }
      blockText += (blockText ? "\n" : "") + line;
      return [];
    }

    // Tool result content (after "Tool <name> status:" line)
    if (inToolResult) {
      if (line.trim() === "<response>" || line.trim() === "</response>" ||
          line.trim() === "<error_message>" || line.trim() === "</error_message>") {
        if (line.includes("</response>") || line.includes("</error_message>")) {
          const content = blockText.trim();
          inToolResult = false;
          blockText = "";
          return content ? [{ kind: "tool_result" as const, ts, content, isError: false, toolUseId: toolName }] : [];
        }
        return [];
      }
      blockText += (blockText ? "\n" : "") + line;
      return [];
    }

    // Skip JSON lines (tool responses)
    if (line.startsWith("{") || line.startsWith("[")) return [];

    // Skip obvious command fragments
    if (line.startsWith("-H ") || line.startsWith("-d ") || line.startsWith("--")) return [];
    if (line.match(/\(\d+s\)\]?$/)) return [];

    // Regular assistant text
    const text = line.trim();
    if (!text) return [];

    // Accumulate into current message block
    if (text !== lastAssistantText) {
      lastAssistantText = text;
      return [{ kind: "assistant" as const, ts, text, delta: true }];
    }
    return [];
  }

  function reset() {
    buffer = "";
    inThinking = false;
    inToolCall = false;
    inToolResult = false;
    toolName = "";
    blockText = "";
    lastAssistantText = "";
  }

  return { parseLine, reset };
}

export const bobShellUIAdapter: UIAdapterModule = {
  type: "bob_shell",
  label: "Bob Shell (local)",
  parseStdoutLine: (line: string, ts: string) => {
    return [{ kind: "stdout", ts, text: line }];
  },
  createStdoutParser: createBobShellStdoutParser,
  ConfigFields: BobShellConfigFields,
  buildAdapterConfig: (values: CreateConfigValues) => {
    return values as unknown as Record<string, unknown>;
  },
};
