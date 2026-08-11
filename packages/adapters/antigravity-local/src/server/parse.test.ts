import { describe, expect, it } from "vitest";
import {
  detectAntigravityQuotaExhausted,
  inspectAntigravityStream,
  parseAntigravityOutput,
} from "./parse.js";

describe("detectAntigravityQuotaExhausted", () => {
  it("requires a strong quota signature and parses the reset countdown", () => {
    const now = new Date("2026-07-11T10:00:00.000Z");
    const result = detectAntigravityQuotaExhausted({
      stderr: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1d 2h 3m 4s.",
      now,
    });

    expect(result.exhausted).toBe(true);
    expect(result.matchedLine).toContain("Individual quota reached");
    expect(result.resetAt?.toISOString()).toBe("2026-07-12T12:03:04.000Z");
  });

  it("does not treat a bare 429 as quota exhaustion", () => {
    const result = detectAntigravityQuotaExhausted({
      stderr: "HTTP 429 Too Many Requests",
    });

    expect(result).toEqual({
      exhausted: false,
      matchedLine: null,
      resetAt: null,
    });
  });
});

describe("Antigravity stream-json parsing", () => {
  it("extracts usage, conversation identity, summary, and a structured disposition", () => {
    const stdout = [
      JSON.stringify({ type: "session", conversation_id: "conv-42" }),
      JSON.stringify({ type: "usage", usageMetadata: { promptTokenCount: 70_000, cachedContentTokenCount: 20_000, candidatesTokenCount: 5_000 } }),
      JSON.stringify({ type: "final_result", result: "Work verified.\nPAPERCLIP_DISPOSITION: {\"status\":\"done\",\"hasBlocker\":false}" }),
    ].join("\n");

    expect(inspectAntigravityStream(stdout)).toMatchObject({
      sessionId: "conv-42",
      usage: { inputTokens: 70_000, cachedInputTokens: 20_000, outputTokens: 5_000 },
      sawJsonEvent: true,
    });
    expect(parseAntigravityOutput(stdout)).toMatchObject({
      sessionId: "conv-42",
      summary: "Work verified.",
      usage: { inputTokens: 70_000, cachedInputTokens: 20_000, outputTokens: 5_000 },
      disposition: { status: "done", hasBlocker: false },
    });
  });

  it("rejects malformed or unsupported disposition prose", () => {
    const output = parseAntigravityOutput(JSON.stringify({
      type: "final",
      text: "PAPERCLIP_DISPOSITION: {\"status\":\"in_progress\"}",
    }));
    expect(output.disposition).toBeNull();
  });
});
