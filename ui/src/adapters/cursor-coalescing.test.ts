import { describe, expect, it } from "vitest";
import { parseCursorStdoutLine } from "@paperclipai/adapter-cursor-local/ui";
import { parseCursorCloudStdoutLine } from "@paperclipai/adapter-cursor-cloud/ui";
import { buildTranscript, type RunLogChunk } from "./transcript";

const ts = "2026-06-23T12:00:00.000Z";

function lines(...jsonLines: unknown[]): RunLogChunk[] {
  return [{ ts, stream: "stdout", chunk: jsonLines.map((l) => JSON.stringify(l)).join("\n") + "\n" }];
}

// The canonical "nice view" shape both adapters must produce for the run:
//   assistant text -> tool_call -> tool_result -> assistant text  (+ a separate result footer)
// i.e. exactly two prose blocks with the tool between them, and zero duplication
// of the streamed text into separate per-token bubbles or a re-rendered final.
function assertCanonicalShape(entries: ReturnType<typeof buildTranscript>) {
  const assistantTexts = entries.filter((e) => e.kind === "assistant").map((e) => (e as { text: string }).text);
  expect(assistantTexts).toEqual(["Hello world", "Done"]);

  expect(entries.filter((e) => e.kind === "tool_call")).toHaveLength(1);
  expect(entries.filter((e) => e.kind === "tool_result")).toHaveLength(1);

  const runShape = entries
    .filter((e) => e.kind === "assistant" || e.kind === "tool_call" || e.kind === "tool_result")
    .map((e) => e.kind);
  expect(runShape).toEqual(["assistant", "tool_call", "tool_result", "assistant"]);
}

describe("cursor transcript coalescing (render-time projection)", () => {
  it("cursor local: coalesces streamed text deltas into prose blocks, preserves tool boundary", () => {
    // Six streamed `text` events (token/word granularity) around one tool call.
    const chunks = lines(
      { type: "text", part: { text: "Hello" } },
      { type: "text", part: { text: " world" } },
      { type: "tool_call", subtype: "started", call_id: "c1", tool_call: { shellToolCall: { args: { command: "ls" } } } },
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "c1",
        tool_call: { shellToolCall: { result: { success: { exitCode: 0, stdout: "file.txt" } } } },
      },
      { type: "text", part: { text: "Done" } },
      { type: "result", subtype: "success", result: "Hello world\nDone", usage: { input_tokens: 1, output_tokens: 2 } },
    );

    const entries = buildTranscript(chunks, parseCursorStdoutLine);
    assertCanonicalShape(entries);

    // The consolidated final must not be re-rendered as a third prose block.
    expect(entries.some((e) => e.kind === "result")).toBe(true);
    expect(entries.filter((e) => e.kind === "assistant")).toHaveLength(2);
  });

  it("cursor local: preserves inter-token whitespace when coalescing deltas", () => {
    const chunks = lines(
      { type: "text", part: { text: "foo" } },
      { type: "text", part: { text: " bar" } },
      { type: "text", part: { text: " baz" } },
    );
    const entries = buildTranscript(chunks, parseCursorStdoutLine);
    const assistantTexts = entries.filter((e) => e.kind === "assistant").map((e) => (e as { text: string }).text);
    expect(assistantTexts).toEqual(["foo bar baz"]);
  });

  it("cursor cloud: SDK messages render as prose blocks with tool boundary, no duplication", () => {
    const chunks = lines(
      { type: "cursor_cloud.message", message: { type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] } } },
      { type: "cursor_cloud.message", message: { type: "tool_call", id: "c1", name: "bash", status: "running", args: { command: "ls" } } },
      { type: "cursor_cloud.message", message: { type: "tool_call", id: "c1", name: "bash", status: "completed", result: { stdout: "file.txt" } } },
      { type: "cursor_cloud.message", message: { type: "assistant", message: { content: [{ type: "text", text: "Done" }] } } },
      { type: "cursor_cloud.result", status: "finished", result: "Hello world\nDone" },
    );

    const entries = buildTranscript(chunks, parseCursorCloudStdoutLine);
    assertCanonicalShape(entries);
    expect(entries.some((e) => e.kind === "result")).toBe(true);
  });
});
