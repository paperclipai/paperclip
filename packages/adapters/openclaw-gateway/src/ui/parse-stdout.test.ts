import { describe, expect, it } from "vitest";
import { parseOpenClawGatewayStdoutLine } from "./parse-stdout.js";

const ts = "2026-10-21T18:44:08.160Z";

function event(stream: string, data: Record<string, unknown>) {
  return `[openclaw-gateway:event] run=run-1 stream=${stream} data=${JSON.stringify(data)}`;
}

describe("parseOpenClawGatewayStdoutLine", () => {
  it("keeps assistant deltas", () => {
    expect(parseOpenClawGatewayStdoutLine(event("assistant", { text: "Hel", delta: "lo" }), ts)).toEqual([
      { kind: "assistant", ts, text: "lo", delta: true },
    ]);
  });

  it("maps thinking deltas to thinking entries", () => {
    expect(parseOpenClawGatewayStdoutLine(event("thinking", { text: "Check the", delta: " versions" }), ts)).toEqual([
      { kind: "thinking", ts, text: " versions", delta: true },
    ]);
  });

  it("maps a full thinking text when there is no delta", () => {
    expect(parseOpenClawGatewayStdoutLine(event("thinking", { text: "Plan first." }), ts)).toEqual([
      { kind: "thinking", ts, text: "Plan first." },
    ]);
  });

  it("maps a tool item start to a tool call", () => {
    const line = event("item", {
      itemId: "tool:call-1",
      toolCallId: "call-1",
      name: "read",
      kind: "tool",
      phase: "start",
      title: "Read from skills/cve-patching/SKILL.md",
      status: "running",
    });
    expect(parseOpenClawGatewayStdoutLine(line, ts)).toEqual([
      { kind: "tool_call", ts, name: "read", toolUseId: "call-1", input: { title: "Read from skills/cve-patching/SKILL.md" } },
    ]);
  });

  it("maps a tool item end to a tool result, failed ones as errors", () => {
    const ok = event("item", { toolCallId: "call-1", name: "read", kind: "tool", phase: "end", title: "Read SKILL.md", status: "completed" });
    const failed = event("item", {
      toolCallId: "call-2",
      name: "tool_search",
      kind: "tool",
      phase: "end",
      title: "Tool Search",
      status: "failed",
      error: "set limit on each batch query",
    });
    expect(parseOpenClawGatewayStdoutLine(ok, ts)).toEqual([
      { kind: "tool_result", ts, toolUseId: "call-1", toolName: "read", content: "Read SKILL.md", isError: false },
    ]);
    expect(parseOpenClawGatewayStdoutLine(failed, ts)).toEqual([
      { kind: "tool_result", ts, toolUseId: "call-2", toolName: "tool_search", content: "set limit on each batch query", isError: true },
    ]);
  });

  it("still ignores other item kinds and streams", () => {
    expect(parseOpenClawGatewayStdoutLine(event("item", { kind: "message", phase: "start" }), ts)).toEqual([]);
    expect(parseOpenClawGatewayStdoutLine(event("usage", { input: 10 }), ts)).toEqual([]);
  });
});
