// UI parser for the openai adapter.
//
// CRITICAL CONSTRAINTS (per docs/adapters/adapter-ui-parser.md):
//   - Zero runtime imports. This file must compile to a self-contained ESM
//     module that the Paperclip UI can fetch and eval in a browser sandbox.
//   - No side effects at module scope.
//   - Only the contracted exports below.
//
// Output shape: this adapter streams plain content deltas as stdout. There
// are no tool calls or structured events to parse, so we emit each non-empty
// line as an `assistant` transcript entry and silently drop empty lines.
// Anything coming through stderr is rendered by the host's default stderr
// handler — we never see it here.

// Local copy of the TranscriptEntry union from @paperclipai/adapter-utils.
// Inlined intentionally so this file has zero imports at runtime.
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
      content: string;
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

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line) return [];
  return [{ kind: "assistant", ts, text: line, delta: true }];
}
