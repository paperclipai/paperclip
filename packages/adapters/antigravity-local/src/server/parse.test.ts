import { describe, expect, it } from "vitest";
import {
  detectAntigravityQuotaExhausted,
  inspectAntigravityStream,
  isAntigravityTransientSilentExit,
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

describe("Antigravity transient silent exits", () => {
  it("classifies only a non-zero exit with no stderr diagnostic as transient", () => {
    expect(isAntigravityTransientSilentExit({ exitCode: 1, stderr: " \n" })).toBe(true);
    expect(isAntigravityTransientSilentExit({ exitCode: 0, stderr: "" })).toBe(false);
    expect(isAntigravityTransientSilentExit({ exitCode: 1, stderr: "quota reached" })).toBe(false);
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

describe("agy CLI `event`-shaped stream (2026-08-23 regression)", () => {
  // Verbatim event shape from production run f54af589 (2026-08-22). The reader
  // keyed terminal-ness off `event.type` and read text from `event.response`,
  // but the agy CLI names the discriminator `event` and carries the text at
  // `result.response`. Every terminal event therefore looked non-terminal:
  // 91 of 91 succeeded antigravity runs in 24h stored an EMPTY summary, zero
  // tokens, and 0% disposition capture.
  const resultEvent = JSON.stringify({
    event: "result",
    result: {
      conversation_id: "65dd5b02-20b5-4a19-9a73-09c8dba850dc",
      status: "SUCCESS",
      response:
        "Closed the review issue as expected behavior.\n\n" +
        'PAPERCLIP_DISPOSITION: {"status":"done","hasBlocker":false}',
      duration_seconds: 45.3,
      num_turns: 1,
      usage: {
        input_tokens: 70817,
        output_tokens: 2919,
        cache_read_tokens: 73251,
        total_tokens: 73736,
      },
    },
  });
  const stdout = [
    JSON.stringify({ event: "init", conversation_id: "65dd5b02-20b5-4a19-9a73-09c8dba850dc", init: {} }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE" } }),
    resultEvent,
  ].join("\n");

  it("reads the final response text out of the result envelope", () => {
    const stream = inspectAntigravityStream(stdout);
    expect(stream.summary).toContain("Closed the review issue");
    expect(stream.sessionId).toBe("65dd5b02-20b5-4a19-9a73-09c8dba850dc");
  });

  it("reads usage out of the result envelope so the token governor can see the lane", () => {
    const stream = inspectAntigravityStream(stdout);
    expect(stream.usage.inputTokens).toBe(70817);
    expect(stream.usage.outputTokens).toBe(2919);
    expect(stream.usage.cachedInputTokens).toBe(73251);
  });

  it("captures the disposition and leaves a clean human summary", () => {
    const parsed = parseAntigravityOutput(stdout);
    expect(parsed.disposition?.status).toBe("done");
    expect(parsed.summary).toBe("Closed the review issue as expected behavior.");
  });

  it("captures the bare string-valued marker gemini also emits", () => {
    const bare = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "c1",
        response: 'Nothing left to do.\n\n```json\n{"PAPERCLIP_DISPOSITION": "done"}\n```',
      },
    });
    expect(parseAntigravityOutput(bare).disposition?.status).toBe("done");
  });
});
