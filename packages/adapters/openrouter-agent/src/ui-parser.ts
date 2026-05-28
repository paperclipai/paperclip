// UI parser for the openrouter_agent adapter.
//
// CRITICAL CONSTRAINTS (per docs/adapters/adapter-ui-parser.md):
//   - Zero runtime imports. This file must compile to a self-contained ESM
//     module that the Paperclip UI can fetch and eval in a browser sandbox.
//   - No side effects at module scope.
//   - Only the contracted exports below.
//
// The execute loop emits one JSON object per stdout line, each conforming
// to the TranscriptEntry union from @paperclipai/adapter-utils. We just
// parse and pass through, with a fallback to plain stdout for any line
// that isn't valid JSON (e.g. a trace from a downstream library).

type TranscriptEntry =
  | { kind: "assistant"; ts: string; text: string; delta?: boolean }
  | { kind: "thinking"; ts: string; text: string; delta?: boolean }
  | { kind: "user"; ts: string; text: string }
  | {
      kind: "tool_call";
      ts: string;
      name: string;
      input: unknown;
      toolUseId?: string;
    }
  | {
      kind: "tool_result";
      ts: string;
      toolUseId: string;
      toolName?: string;
      content: unknown;
      isError: boolean;
    }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | {
      kind: "result";
      ts: string;
      text: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      costUsd: number;
      subtype: string;
      isError: boolean;
      errors: string[];
    }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string }
  | {
      kind: "diff";
      ts: string;
      changeType:
        | "add"
        | "remove"
        | "context"
        | "hunk"
        | "file_header"
        | "truncation";
      text: string;
    };

const KNOWN_KINDS = new Set([
  "assistant",
  "thinking",
  "user",
  "tool_call",
  "tool_result",
  "init",
  "result",
  "stderr",
  "system",
  "stdout",
  "diff",
]);

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line) return [];
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed[0] === "{") {
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { kind?: unknown }).kind === "string" &&
        KNOWN_KINDS.has((parsed as { kind: string }).kind)
      ) {
        if (typeof (parsed as { ts?: unknown }).ts !== "string") {
          (parsed as { ts: string }).ts = ts;
        }
        return [parsed as TranscriptEntry];
      }
    } catch {
      // fall through to plain stdout
    }
  }
  return [{ kind: "stdout", ts, text: line }];
}
