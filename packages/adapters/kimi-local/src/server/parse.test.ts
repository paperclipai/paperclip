import { describe, expect, it } from "vitest";
import { isKimiUnknownSessionError, parseKimiJsonl } from "./parse.js";

describe("parseKimiJsonl", () => {
  it("collects streamed assistant content and session hint", () => {
    const parsed = parseKimiJsonl([
      JSON.stringify({ role: "assistant", content: "hel" }),
      JSON.stringify({ role: "assistant", content: "lo" }),
      "To resume this session: kimi -r sess-1",
    ].join("\n"));

    expect(parsed).toEqual({
      sessionId: "sess-1",
      summary: "hello",
      errorMessage: null,
      stopReason: null,
    });
  });

  it("collects assistant content from array format", () => {
    const parsed = parseKimiJsonl([
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Hello" }] }),
      "To resume this session: kimi -r sess-2",
    ].join("\n"));

    expect(parsed.summary).toBe("Hello");
    expect(parsed.sessionId).toBe("sess-2");
  });

  it("ignores think blocks in server parse (only text goes to summary)", () => {
    const parsed = parseKimiJsonl([
      JSON.stringify({ role: "assistant", content: [{ type: "think", think: "planning" }, { type: "text", text: "Done." }] }),
    ].join("\n"));

    expect(parsed.summary).toBe("Done.");
  });

  it("collects tool results", () => {
    const parsed = parseKimiJsonl([
      JSON.stringify({ role: "assistant", content: "Let me check." }),
      JSON.stringify({ role: "tool", tool_call_id: "tc_1", content: "file1.py\nfile2.py" }),
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Done." }] }),
    ].join("\n"));

    expect(parsed.summary).toBe("Let me check.[tool result] file1.py\nfile2.pyDone.");
  });

  it("collects tool results from array format", () => {
    const parsed = parseKimiJsonl([
      JSON.stringify({ role: "tool", tool_call_id: "tc_1", content: [{ type: "text", text: "output1" }, { type: "text", text: "output2" }] }),
    ].join("\n"));

    expect(parsed.summary).toBe("[tool result] output1output2");
  });

  it("reads structured error payloads", () => {
    const parsed = parseKimiJsonl([
      JSON.stringify({ role: "error", message: "Authentication required" }),
    ].join("\n"));

    expect(parsed.errorMessage).toBe("Authentication required");
  });

  it("handles plain text lines gracefully", () => {
    const parsed = parseKimiJsonl([
      "Some plain text output",
      JSON.stringify({ role: "assistant", content: "hello" }),
    ].join("\n"));

    expect(parsed.summary).toBe("Some plain text outputhello");
  });
});

describe("isKimiUnknownSessionError", () => {
  it("detects stale resume failures", () => {
    expect(isKimiUnknownSessionError("", "session not found")).toBe(true);
    expect(isKimiUnknownSessionError("", "everything fine")).toBe(false);
  });
});
