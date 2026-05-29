import { describe, expect, it } from "vitest";
import { parseAcpxStdoutLine } from "./parse-stdout.js";

const TS = "2026-04-30T00:00:00.000Z";

function emit(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe("parseAcpxStdoutLine", () => {
  it("renders an init entry from acpx.session", () => {
    const entries = parseAcpxStdoutLine(
      emit({
        type: "acpx.session",
        agent: "claude",
        acpSessionId: "acp-1",
        runtimeSessionName: "runtime-1",
        mode: "persistent",
        permissionMode: "approve-all",
      }),
      TS,
    );
    expect(entries).toEqual([
      {
        kind: "init",
        ts: TS,
        model: "claude (persistent / approve-all)",
        sessionId: "acp-1",
      },
    ]);
  });

  it("routes output text_delta to the assistant transcript", () => {
    const entries = parseAcpxStdoutLine(
      emit({ type: "acpx.text_delta", text: "hello", channel: "output", tag: "agent_message_chunk" }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "assistant", ts: TS, text: "hello", delta: true },
    ]);
  });

  it("routes thought text_delta to the thinking transcript", () => {
    const entries = parseAcpxStdoutLine(
      emit({ type: "acpx.text_delta", text: "thinking…", channel: "thought" }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "thinking", ts: TS, text: "thinking…", delta: true },
    ]);
  });

  it("falls back to stream when channel is missing", () => {
    const entries = parseAcpxStdoutLine(
      emit({ type: "acpx.text_delta", text: "thinking…", stream: "thought" }),
      TS,
    );
    expect(entries[0]).toMatchObject({ kind: "thinking" });
  });

  it("renders status events as system text with optional ctx usage", () => {
    expect(
      parseAcpxStdoutLine(
        emit({ type: "acpx.status", text: "thinking", tag: "agent_thought_chunk" }),
        TS,
      ),
    ).toEqual([{ kind: "system", ts: TS, text: "thinking" }]);

    expect(
      parseAcpxStdoutLine(
        emit({ type: "acpx.status", tag: "context_window", used: 12000, size: 200000 }),
        TS,
      ),
    ).toEqual([{ kind: "system", ts: TS, text: "context_window (12000/200000 ctx)" }]);
  });

  it("emits a tool_call entry that preserves toolCallId, status, and input", () => {
    const entries = parseAcpxStdoutLine(
      emit({
        type: "acpx.tool_call",
        name: "read",
        toolCallId: "tool-1",
        status: "running",
        text: "read README.md",
      }),
      TS,
    );
    expect(entries).toEqual([
      {
        kind: "tool_call",
        ts: TS,
        name: "read",
        toolUseId: "tool-1",
        input: { text: "read README.md", status: "running" },
      },
    ]);
  });

  it("emits a paired tool_result entry when a tool_call reports terminal status", () => {
    const completed = parseAcpxStdoutLine(
      emit({
        type: "acpx.tool_call",
        name: "read",
        toolCallId: "tool-1",
        status: "completed",
        text: "ok",
      }),
      TS,
    );
    expect(completed[1]).toEqual({
      kind: "tool_result",
      ts: TS,
      toolUseId: "tool-1",
      toolName: "read",
      content: "ok",
      isError: false,
    });

    const failed = parseAcpxStdoutLine(
      emit({
        type: "acpx.tool_call",
        name: "edit",
        toolCallId: "tool-2",
        status: "failed",
        text: "permission denied",
      }),
      TS,
    );
    expect(failed[1]).toMatchObject({ kind: "tool_result", isError: true, content: "permission denied" });
  });

  it("renders acpx.result with summary fallback to stopReason", () => {
    const entries = parseAcpxStdoutLine(
      emit({ type: "acpx.result", summary: "completed", stopReason: "end_turn" }),
      TS,
    );
    expect(entries[0]).toMatchObject({ kind: "result", text: "completed", subtype: "end_turn", isError: false });
  });

  it("treats acpx.error as a stderr entry", () => {
    const entries = parseAcpxStdoutLine(
      emit({ type: "acpx.error", message: "auth required", code: "ACP_AUTH" }),
      TS,
    );
    expect(entries).toEqual([{ kind: "stderr", ts: TS, text: "auth required" }]);
  });

  it("renders unknown acpx.* events as system entries", () => {
    const entries = parseAcpxStdoutLine(
      emit({ type: "acpx.misc", message: "unhandled" }),
      TS,
    );
    expect(entries).toEqual([{ kind: "system", ts: TS, text: "unhandled" }]);
  });

  it("falls back to a stdout entry for non-JSON lines", () => {
    const entries = parseAcpxStdoutLine("not json", TS);
    expect(entries).toEqual([{ kind: "stdout", ts: TS, text: "not json" }]);
  });
});
