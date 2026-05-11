import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printAcpxStreamEvent } from "./format-event.js";

function emit(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

interface CapturedOutput {
  log: string[];
  stdout: string[];
}

function captureOutput(): { capture: CapturedOutput; restore: () => void } {
  const log: string[] = [];
  const stdout: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    log.push(String(value ?? ""));
  });
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk ?? ""));
    return true;
  }) as typeof process.stdout.write);
  return {
    capture: { log, stdout },
    restore: () => {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
    },
  };
}

function strip(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("printAcpxStreamEvent", () => {
  let captured: CapturedOutput;
  let restore: () => void;

  beforeEach(() => {
    const result = captureOutput();
    captured = result.capture;
    restore = result.restore;
  });

  afterEach(() => {
    restore();
  });

  it("renders acpx.session as a labeled session header", () => {
    printAcpxStreamEvent(
      emit({
        type: "acpx.session",
        agent: "claude",
        acpSessionId: "acp-1",
        mode: "persistent",
        permissionMode: "approve-all",
      }),
      false,
    );
    expect(captured.log.map(strip)).toEqual(["claude session: acp-1 [persistent / approve-all]"]);
  });

  it("streams output text_delta to stdout for live progress", () => {
    printAcpxStreamEvent(
      emit({ type: "acpx.text_delta", text: "hello", channel: "output" }),
      false,
    );
    expect(captured.log).toEqual([]);
    expect(captured.stdout.map(strip)).toEqual(["hello"]);
  });

  it("renders thought text_delta on its own line", () => {
    printAcpxStreamEvent(
      emit({ type: "acpx.text_delta", text: "thinking…", channel: "thought" }),
      false,
    );
    expect(captured.log.map(strip)).toEqual(["thinking…"]);
  });

  it("renders tool_call with status and id", () => {
    printAcpxStreamEvent(
      emit({
        type: "acpx.tool_call",
        name: "read",
        toolCallId: "tool-1",
        status: "running",
        text: "read README.md",
      }),
      false,
    );
    expect(captured.log.map(strip)).toEqual([
      "tool_call: read [running] (tool-1)",
      "read README.md",
    ]);
  });

  it("renders status events with optional context window", () => {
    printAcpxStreamEvent(
      emit({ type: "acpx.status", tag: "context_window", used: 100, size: 200000 }),
      false,
    );
    expect(captured.log.map(strip)).toEqual(["status: context_window (100/200000 ctx)"]);
  });

  it("renders acpx.result and acpx.error", () => {
    printAcpxStreamEvent(emit({ type: "acpx.result", summary: "completed", stopReason: "end_turn" }), false);
    printAcpxStreamEvent(emit({ type: "acpx.error", message: "auth required" }), false);
    expect(captured.log.map(strip)).toEqual(["result: completed", "error: auth required"]);
  });

  it("falls back to plain output for non-JSON lines", () => {
    printAcpxStreamEvent("not json", false);
    expect(captured.log).toEqual(["not json"]);
  });

  it("still emits unknown / non-JSON lines when debug is enabled", () => {
    printAcpxStreamEvent("not json", true);
    expect(strip(captured.log[0])).toBe("not json");
  });
});
