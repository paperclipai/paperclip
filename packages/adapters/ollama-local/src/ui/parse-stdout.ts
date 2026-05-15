import type { TranscriptEntry } from "@paperclipai/adapter-utils";

const ASSISTANT_PREFIX = "[assistant] ";
const TOOL_CALL_PREFIX = "[tool] ";
const TOOL_RESULT_PREFIX = /^\[tool:([^\]]+)\] (.*)$/s;
const PAPERCLIP_PREFIX = "[paperclip] ";

let toolUseCounter = 0;
const pendingToolCalls = new Map<string, string>(); // name -> last toolUseId

function nextToolUseId(name: string): string {
  toolUseCounter += 1;
  const id = `tool_${name}_${toolUseCounter}`;
  pendingToolCalls.set(name, id);
  return id;
}

function lastToolUseId(name: string): string {
  return pendingToolCalls.get(name) ?? `tool_${name}_unknown`;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseOllamaStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line) return [];

  if (line.startsWith(PAPERCLIP_PREFIX)) {
    return [{ kind: "system", ts, text: line.slice(PAPERCLIP_PREFIX.length).trim() }];
  }

  if (line.startsWith(ASSISTANT_PREFIX)) {
    return [{ kind: "assistant", ts, text: line.slice(ASSISTANT_PREFIX.length) }];
  }

  if (line.startsWith(TOOL_CALL_PREFIX)) {
    const rest = line.slice(TOOL_CALL_PREFIX.length).trim();
    const sep = rest.indexOf(" ");
    const name = sep > 0 ? rest.slice(0, sep) : rest;
    const argsRaw = sep > 0 ? rest.slice(sep + 1) : "";
    return [
      {
        kind: "tool_call",
        ts,
        name,
        input: argsRaw ? tryParseJson(argsRaw) : {},
        toolUseId: nextToolUseId(name),
      },
    ];
  }

  const toolResultMatch = TOOL_RESULT_PREFIX.exec(line);
  if (toolResultMatch) {
    const [, name, content] = toolResultMatch;
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: lastToolUseId(name),
        toolName: name,
        content,
        isError: content.startsWith("Error"),
      },
    ];
  }

  return [{ kind: "stdout", ts, text: line }];
}
