import { describe, expect, it, vi } from "vitest";
import { formatKimiStreamEvent } from "./format-event.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("formatKimiStreamEvent", () => {
  it("prints assistant text, thinking, and tool calls", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      formatKimiStreamEvent(
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "I'll help you." }],
        }),
        false,
      );

      formatKimiStreamEvent(
        JSON.stringify({
          role: "assistant",
          content: [{ type: "think", think: "Analyzing..." }],
        }),
        false,
      );

      formatKimiStreamEvent(
        JSON.stringify({
          role: "assistant",
          content: [{ type: "tool_use", name: "bash", input: { command: "ls" } }],
        }),
        false,
      );

      const lines = spy.mock.calls.map((call) => stripAnsi(String(call[0])));

      expect(lines).toContain("I'll help you.");
      expect(lines).toContain("[thinking] Analyzing...");
      expect(lines.some((l) => l.includes("[tool: bash]"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("prints user text and tool results", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      formatKimiStreamEvent(
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: "Continue." }],
        }),
        false,
      );

      formatKimiStreamEvent(
        JSON.stringify({
          role: "user",
          content: [{ type: "tool_result", content: "result data", is_error: false }],
        }),
        false,
      );

      formatKimiStreamEvent(
        JSON.stringify({
          role: "user",
          content: [{ type: "tool_result", content: "error!", is_error: true }],
        }),
        false,
      );

      const lines = spy.mock.calls.map((call) => stripAnsi(String(call[0])));

      expect(lines.some((l) => l.includes("[user] Continue."))).toBe(true);
      expect(lines.some((l) => l.includes("[tool result] result data"))).toBe(true);
      expect(lines.some((l) => l.includes("[tool result] error!"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("prints result with usage and cost", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      formatKimiStreamEvent(
        JSON.stringify({
          type: "result",
          done: true,
          usage: { input_tokens: 100, output_tokens: 50 },
          total_cost_usd: 0.0025,
        }),
        false,
      );

      const lines = spy.mock.calls.map((call) => stripAnsi(String(call[0])));

      expect(lines.some((l) => l.includes("Tokens: 100 in / 50 out"))).toBe(true);
      expect(lines.some((l) => l.includes("Cost: $0.0025"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("prints debug info for unknown formats when debug is enabled", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      formatKimiStreamEvent("not json", true);

      const lines = spy.mock.calls.map((call) => stripAnsi(String(call[0])));

      expect(lines.some((l) => l.includes("[raw]") && l.includes("not json"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("silently ignores unknown formats when debug is disabled", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      formatKimiStreamEvent("not json", false);
      formatKimiStreamEvent(JSON.stringify({ unknown: "event" }), false);

      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
