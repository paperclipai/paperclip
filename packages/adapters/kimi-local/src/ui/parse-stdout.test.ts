import { describe, expect, it } from "vitest";
import { parseKimiStdoutLine } from "./parse-stdout.js";

const ts = "2026-07-19T00:00:00.000Z";

describe("parseKimiStdoutLine ACP delegation", () => {
  it("delegates acpx.* events to the shared acpx transcript parser", () => {
    const line = JSON.stringify({ type: "acpx.tool_call", name: "Terminal", status: "pending", text: "Terminal (pending)" });
    const entries = parseKimiStdoutLine(line, ts);
    // The shared parser produces a structured entry, not the raw stdout fallback.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.kind !== "stdout")).toBe(true);
  });

  it("still parses native kimi role events (no acpx type)", () => {
    const line = JSON.stringify({ role: "assistant", content: "hi" });
    expect(parseKimiStdoutLine(line, ts)).toEqual([{ kind: "assistant", ts, text: "hi" }]);
  });
});

describe("parseKimiStdoutLine", () => {
  it("renders assistant content as an assistant transcript entry", () => {
    const line = JSON.stringify({
      role: "assistant",
      content: "PAPERCLIP_ADAPTER_TEST_OK",
    });
    expect(parseKimiStdoutLine(line, ts)).toEqual([
      { kind: "assistant", ts, text: "PAPERCLIP_ADAPTER_TEST_OK" },
    ]);
  });

  it("renders assistant tool_calls with parsed arguments", () => {
    const line = JSON.stringify({
      role: "assistant",
      tool_calls: [{
        type: "function",
        id: "tool_8c1OWyRBe68OMTbWY6NqnkMm",
        function: { name: "Read", arguments: "{\"path\":\"probe.txt\"}" },
      }],
    });
    expect(parseKimiStdoutLine(line, ts)).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "Read",
        input: { path: "probe.txt" },
        toolUseId: "tool_8c1OWyRBe68OMTbWY6NqnkMm",
      },
    ]);
  });

  it("renders tool results as tool_result entries", () => {
    const line = JSON.stringify({
      role: "tool",
      tool_call_id: "tool_8c1OWyRBe68OMTbWY6NqnkMm",
      content: "1\thello paperclip",
    });
    expect(parseKimiStdoutLine(line, ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tool_8c1OWyRBe68OMTbWY6NqnkMm",
        content: "1\thello paperclip",
        isError: false,
      },
    ]);
  });

  it("surfaces the meta session resume hint as session info", () => {
    const line = JSON.stringify({
      role: "meta",
      type: "session.resume_hint",
      session_id: "session_769ddab9-0a25-4edd-99f4-cdfebdc90879",
      command: "kimi -r session_769ddab9-0a25-4edd-99f4-cdfebdc90879",
      content: "To resume this session: kimi -r session_769ddab9-0a25-4edd-99f4-cdfebdc90879",
    });
    expect(parseKimiStdoutLine(line, ts)).toEqual([
      { kind: "system", ts, text: "session: session_769ddab9-0a25-4edd-99f4-cdfebdc90879" },
    ]);
  });

  it("ignores unrecognized meta lines", () => {
    const line = JSON.stringify({ role: "meta", type: "progress", content: "working" });
    expect(parseKimiStdoutLine(line, ts)).toEqual([]);
  });

  it("passes non-JSON lines through as stdout", () => {
    expect(parseKimiStdoutLine("plain output line", ts)).toEqual([
      { kind: "stdout", ts, text: "plain output line" },
    ]);
  });
});
