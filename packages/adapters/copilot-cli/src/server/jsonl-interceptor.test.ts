import { describe, expect, it, vi } from "vitest";
import { createJsonlLogInterceptor } from "./jsonl-interceptor.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type LogCall = [stream: "stdout" | "stderr", text: string];

function makeInterceptor() {
  const calls: LogCall[] = [];
  const onLog = vi.fn(async (stream: "stdout" | "stderr", text: string) => {
    calls.push([stream, text]);
  });
  const interceptor = createJsonlLogInterceptor(onLog);
  return { interceptor, calls, onLog };
}

const jsonlLine = (obj: unknown) => JSON.stringify(obj);

const assistantMsg = (content: string) =>
  jsonlLine({ type: "assistant.message", data: { content } });

const toolStart = (toolName: string) =>
  jsonlLine({ type: "tool.execution_start", data: { toolName, toolCallId: "tc1" } });

const resultEvent = () =>
  jsonlLine({ type: "result", sessionId: "s1", exitCode: 0, usage: {} });

// ─── stderr / non-stdout passthrough ─────────────────────────────────────────

describe("createJsonlLogInterceptor – stream passthrough", () => {
  it("passes stderr chunks through directly without buffering", async () => {
    const { interceptor, calls } = makeInterceptor();
    await interceptor.onChunk("stderr", "Error: something went wrong\n");
    expect(calls).toEqual([["stderr", "Error: something went wrong\n"]]);
  });

  it("passes stderr even when interleaved with stdout", async () => {
    const { interceptor, calls } = makeInterceptor();
    await interceptor.onChunk("stdout", assistantMsg("hi") + "\n");
    await interceptor.onChunk("stderr", "stderr chunk\n");
    await interceptor.flush();
    expect(calls.some(([s, t]) => s === "stderr" && t === "stderr chunk\n")).toBe(true);
    // stdout is now the raw JSONL line
    expect(calls.some(([s]) => s === "stdout")).toBe(true);
  });
});

// ─── Raw JSONL passthrough ────────────────────────────────────────────────────

describe("createJsonlLogInterceptor – raw JSONL passthrough", () => {
  it("passes assistant.message line through as-is with trailing newline", async () => {
    const { interceptor, calls } = makeInterceptor();
    const line = assistantMsg("Hello world");
    await interceptor.onChunk("stdout", line + "\n");
    await interceptor.flush();
    expect(calls).toEqual([["stdout", line + "\n"]]);
  });

  it("passes tool.execution_start line through as-is", async () => {
    const { interceptor, calls } = makeInterceptor();
    const line = toolStart("bash");
    await interceptor.onChunk("stdout", line + "\n");
    await interceptor.flush();
    expect(calls).toEqual([["stdout", line + "\n"]]);
  });

  it("passes result event line through as-is", async () => {
    const { interceptor, calls } = makeInterceptor();
    const line = resultEvent();
    await interceptor.onChunk("stdout", line + "\n");
    await interceptor.flush();
    expect(calls).toEqual([["stdout", line + "\n"]]);
  });

  it("passes session.tools_updated line through as-is", async () => {
    const { interceptor, calls } = makeInterceptor();
    const line = jsonlLine({ type: "session.tools_updated", data: { model: "gpt-5" } });
    await interceptor.onChunk("stdout", line + "\n");
    await interceptor.flush();
    expect(calls).toEqual([["stdout", line + "\n"]]);
  });

  it("passes non-JSON lines through as-is", async () => {
    const { interceptor, calls } = makeInterceptor();
    await interceptor.onChunk("stdout", "plain text line\n");
    await interceptor.flush();
    expect(calls).toEqual([["stdout", "plain text line\n"]]);
  });

  it("suppresses empty lines within a chunk", async () => {
    const { interceptor, calls } = makeInterceptor();
    await interceptor.onChunk("stdout", "\n\n\n");
    await interceptor.flush();
    expect(calls).toEqual([]);
  });
});

// ─── Multiple lines per chunk ─────────────────────────────────────────────────

describe("createJsonlLogInterceptor – multiple lines in one chunk", () => {
  it("forwards all complete lines in a single multi-line chunk", async () => {
    const { interceptor, calls } = makeInterceptor();
    const line1 = assistantMsg("First");
    const line2 = toolStart("edit_file");
    const line3 = assistantMsg("Second");
    const chunk = line1 + "\n" + line2 + "\n" + line3 + "\n";
    await interceptor.onChunk("stdout", chunk);
    await interceptor.flush();
    expect(calls).toEqual([
      ["stdout", line1 + "\n"],
      ["stdout", line2 + "\n"],
      ["stdout", line3 + "\n"],
    ]);
  });

  it("forwards all event types including suppressed ones", async () => {
    const { interceptor, calls } = makeInterceptor();
    const line1 = assistantMsg("Before tool");
    const line2 = jsonlLine({ type: "session.tools_updated", data: { model: "gpt-5" } });
    const line3 = toolStart("bash");
    const line4 = jsonlLine({ type: "tool.execution_complete", data: { success: true } });
    const line5 = assistantMsg("After tool");
    const chunk = [line1, line2, line3, line4, line5].join("\n") + "\n";
    await interceptor.onChunk("stdout", chunk);
    await interceptor.flush();
    expect(calls).toEqual([
      ["stdout", line1 + "\n"],
      ["stdout", line2 + "\n"],
      ["stdout", line3 + "\n"],
      ["stdout", line4 + "\n"],
      ["stdout", line5 + "\n"],
    ]);
  });
});

// ─── Chunk boundary / buffering ──────────────────────────────────────────────

describe("createJsonlLogInterceptor – chunk splitting", () => {
  it("buffers a chunk with no newline and emits nothing until flush", async () => {
    const { interceptor, calls } = makeInterceptor();
    await interceptor.onChunk("stdout", assistantMsg("Streaming..."));
    expect(calls).toEqual([]);
    await interceptor.flush();
    expect(calls).toEqual([["stdout", assistantMsg("Streaming...") + "\n"]]);
  });

  it("completes a split JSON when second chunk supplies the newline", async () => {
    const { interceptor, calls } = makeInterceptor();
    const full = assistantMsg("Split across chunks");
    const mid = Math.floor(full.length / 2);
    await interceptor.onChunk("stdout", full.slice(0, mid));
    expect(calls).toEqual([]);
    await interceptor.onChunk("stdout", full.slice(mid) + "\n");
    expect(calls).toEqual([["stdout", full + "\n"]]);
  });

  it("handles chunk ending exactly on \\n (buffer cleared)", async () => {
    const { interceptor, calls } = makeInterceptor();
    const line = assistantMsg("Exact");
    await interceptor.onChunk("stdout", line + "\n");
    await interceptor.flush();
    expect(calls).toEqual([["stdout", line + "\n"]]);
  });

  it("handles CRLF line endings", async () => {
    const { interceptor, calls } = makeInterceptor();
    const line = assistantMsg("CRLF test");
    await interceptor.onChunk("stdout", line + "\r\n");
    await interceptor.flush();
    expect(calls).toEqual([["stdout", line + "\n"]]);
  });

  it("handles a chunk that completes one line and starts another (no trailing newline)", async () => {
    const { interceptor, calls } = makeInterceptor();
    const complete = assistantMsg("Complete");
    const partial = assistantMsg("Partial");
    const mid = Math.floor(partial.length / 2);
    await interceptor.onChunk("stdout", complete + "\n" + partial.slice(0, mid));
    expect(calls).toEqual([["stdout", complete + "\n"]]);
    await interceptor.onChunk("stdout", partial.slice(mid) + "\n");
    expect(calls).toEqual([["stdout", complete + "\n"], ["stdout", partial + "\n"]]);
  });

  it("handles three chunks: split across all three", async () => {
    const { interceptor, calls } = makeInterceptor();
    const full = assistantMsg("Three parts");
    const a = full.slice(0, 5);
    const b = full.slice(5, 15);
    const c = full.slice(15) + "\n";
    await interceptor.onChunk("stdout", a);
    await interceptor.onChunk("stdout", b);
    await interceptor.onChunk("stdout", c);
    expect(calls).toEqual([["stdout", full + "\n"]]);
  });

  it("processes multiple buffered lines that arrive in a single catch-up chunk", async () => {
    const { interceptor, calls } = makeInterceptor();
    const first = assistantMsg("First");
    const second = assistantMsg("Second");
    await interceptor.onChunk("stdout", first);
    await interceptor.onChunk("stdout", "\n" + second + "\n");
    expect(calls).toEqual([["stdout", first + "\n"], ["stdout", second + "\n"]]);
  });
});

// ─── flush edge cases ─────────────────────────────────────────────────────────

describe("createJsonlLogInterceptor – flush", () => {
  it("flush with empty buffer is a no-op", async () => {
    const { interceptor, calls } = makeInterceptor();
    await interceptor.flush();
    expect(calls).toEqual([]);
  });

  it("flush of whitespace-only buffer is a no-op", async () => {
    const { interceptor, calls } = makeInterceptor();
    await interceptor.onChunk("stdout", "  ");
    await interceptor.flush();
    expect(calls).toEqual([]);
  });

  it("flush clears the buffer (second flush is a no-op)", async () => {
    const { interceptor, calls } = makeInterceptor();
    const line = assistantMsg("Once");
    await interceptor.onChunk("stdout", line);
    await interceptor.flush();
    await interceptor.flush();
    expect(calls).toEqual([["stdout", line + "\n"]]);
  });

  it("flush after newline-terminated chunk does not re-emit", async () => {
    const { interceptor, calls } = makeInterceptor();
    const line = assistantMsg("Already done");
    await interceptor.onChunk("stdout", line + "\n");
    await interceptor.flush();
    expect(calls).toEqual([["stdout", line + "\n"]]);
  });
});
