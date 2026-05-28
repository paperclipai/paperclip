import type { TranscriptEntry, StdoutLineParser } from "@paperclipai/adapter-utils";

// ---------------------------------------------------------------------------
// Kimi stream-json line parser
// ---------------------------------------------------------------------------

interface KimiMessage {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    type?: string;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

function parseKimiJsonLine(line: string): KimiMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as KimiMessage;
  } catch {
    return null;
  }
}

function isKimiJsonLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("{") && trimmed.includes('"role"');
}

export const parseStdoutLine: StdoutLineParser = (line: string, ts: string) => {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // If it looks like a Kimi stream-json message, parse it
  if (isKimiJsonLine(trimmed)) {
    const msg = parseKimiJsonLine(trimmed);
    if (!msg || !msg.role) {
      return [{ kind: "stdout", ts, text: line }];
    }

    const entries: TranscriptEntry[] = [];

    if (msg.role === "assistant") {
      if (typeof msg.content === "string" && msg.content) {
        entries.push({ kind: "assistant", ts, text: msg.content, delta: true });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name ?? "unknown";
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function?.arguments ?? "{}");
          } catch {
            input = { raw: tc.function?.arguments };
          }
          entries.push({
            kind: "tool_call",
            ts,
            name,
            input,
            toolUseId: tc.id,
          });
        }
      }
      return entries;
    }

    if (msg.role === "tool") {
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId: msg.tool_call_id ?? "",
        content: typeof msg.content === "string" ? msg.content : "",
        isError: false,
      });
      return entries;
    }

    if (msg.role === "user") {
      entries.push({
        kind: "user",
        ts,
        text: typeof msg.content === "string" ? msg.content : "",
      });
      return entries;
    }

    // System or unknown role — fall through to stdout
    return [{ kind: "stdout", ts, text: line }];
  }

  // Non-JSON lines go to stdout
  return [{ kind: "stdout", ts, text: line }];
};

export function createStdoutParser(): {
  parseLine: StdoutLineParser;
  flush: (ts: string) => TranscriptEntry[];
} {
  return {
    parseLine: parseStdoutLine,
    flush: () => [],
  };
}
