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

describe("the shape production actually emits (TSMC-21352)", () => {
  // Verbatim from run a3dfa0b6-7d17-40ca-abb1-aa3e1830985f, 2026-08-23 13:15Z.
  // The quota rejection arrives on STDOUT inside the result envelope; stderr
  // carries only Paperclip's own generic notice, which matches no quota
  // pattern. The pre-existing unit test fed the quota string on stderr and so
  // stayed green while 164 of 176 classifiable failures in 24h went undetected
  // and were retried immediately against an exhausted quota.
  const STDOUT = [
    '{"event":"init","conversation_id":"5860f8ec-10c0-4e6d-bccd-498b125fd54e","init":{"model":"Gemini 3.1 Pro (High)"}}',
    '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
    '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"error_message"}}',
    '{"event":"result","result":{"conversation_id":"5860f8ec-10c0-4e6d-bccd-498b125fd54e","status":"ERROR",'
      + '"response":"","error":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 14m32s.",'
      + '"duration_seconds":0,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}',
  ].join("\n");
  const STDERR = "[paperclip] Antigravity reported turn status ERROR with an EMPTY response.\n";

  it("lifts the CLI's own error text off stdout", () => {
    const parsed = parseAntigravityOutput(STDOUT, STDERR);
    expect(parsed.resultStatus).toBe("ERROR");
    expect(parsed.errorMessage).toContain("Individual quota reached");
    expect(parsed.sessionId).toBe("5860f8ec-10c0-4e6d-bccd-498b125fd54e");
  });

  it("detects quota exhaustion and dates the retry from the stdout message", () => {
    const now = new Date("2026-08-23T13:15:18.000Z");
    const parsed = parseAntigravityOutput(STDOUT, STDERR);
    const result = detectAntigravityQuotaExhausted({ stderr: STDERR, cliError: parsed.errorMessage, now });
    expect(result.exhausted).toBe(true);
    // 14m32s after the observation, so the retry lands after the quota resets
    expect(result.resetAt?.toISOString()).toBe("2026-08-23T13:29:50.000Z");
  });

  it("stays blind when only stderr is offered, which is the defect being fixed", () => {
    expect(detectAntigravityQuotaExhausted({ stderr: STDERR }).exhausted).toBe(false);
  });

  it("does not misread a quota rejection as a nameless silent exit", () => {
    // stderr is non-empty, so the silent-exit heuristic already declines; the
    // run must be classified by its named cause, not by an absence.
    expect(isAntigravityTransientSilentExit({ exitCode: 1, stderr: STDERR })).toBe(false);
  });
});

describe("per-step usage must be visible to the budget guard (TSMC-21362)", () => {
  // agy emits usage on every step_update and only the final total in the
  // result envelope. The mid-stream observer reads inspectAntigravityStream on
  // the partial stdout, so it can only stop a run early if step usage parses.
  const STEPS = [
    '{"event":"init","conversation_id":"c1","init":{"model":"Gemini 3.1 Pro (High)"}}',
    '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":22021,"output_tokens":700,"cache_read_tokens":50000}}}',
    '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":6,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":258396,"output_tokens":9641,"cache_read_tokens":684996}}}',
  ].join("\n");

  it("sees step usage before any result event arrives", () => {
    const mid = inspectAntigravityStream(STEPS);
    expect(mid.usage.inputTokens).toBe(258396);
    expect(mid.usage.outputTokens).toBe(9641);
    expect(mid.usage.cachedInputTokens).toBe(684996);
  });

  it("sees the FIRST step's usage from a partial stream, so the guard can act early", () => {
    const partial = STEPS.split("\n").slice(0, 2).join("\n");
    expect(inspectAntigravityStream(partial).usage.inputTokens).toBe(22021);
  });
});

describe("search fanout is counted so the cause is visible (TSMC-21368)", () => {
  const line = (i: number, tool: string, state = "DONE") =>
    `{"event":"step_update","step_update":{"conversation_id":"c1","step_index":${i},"state":"${state}","step_type":"tool","tool_name":"${tool}"}}`;

  it("counts each distinct search call once, not once per state transition", () => {
    const stream = [
      line(1, "grep_search", "ACTIVE"),
      line(1, "grep_search", "DONE"),
      line(2, "find_by_name"),
      line(3, "list_dir"),
    ].join("\n");
    expect(inspectAntigravityStream(stream).searchToolCalls).toBe(3);
  });

  it("does not count reads or writes as searches", () => {
    const stream = [line(1, "view_file"), line(2, "write_to_file"), line(3, "run_command")].join("\n");
    expect(inspectAntigravityStream(stream).searchToolCalls).toBe(0);
  });

  it("separates a healthy run from a hunting one", () => {
    const healthy = [line(1, "view_file"), line(2, "grep_search")].join("\n");
    const hunting = Array.from({ length: 14 }, (_, i) => line(i, "find_by_name")).join("\n");
    expect(inspectAntigravityStream(healthy).searchToolCalls).toBe(1);
    expect(inspectAntigravityStream(hunting).searchToolCalls).toBe(14);
  });
});

describe("total tool-call counting feeds the ceiling (TSMC-21369)", () => {
  const line = (i: number, tool: string, state = "DONE") =>
    `{"event":"step_update","step_update":{"conversation_id":"c1","step_index":${i},"state":"${state}","step_type":"tool","tool_name":"${tool}"}}`;

  it("counts every tool, not just searches, and counts each call once", () => {
    const stream = [
      line(1, "grep_search", "ACTIVE"), line(1, "grep_search", "DONE"),
      line(2, "view_file"), line(3, "run_command"), line(4, "write_to_file"),
    ].join("\n");
    const parsed = inspectAntigravityStream(stream);
    expect(parsed.toolCalls).toBe(4);
    expect(parsed.searchToolCalls).toBe(1);
  });

  it("rises monotonically as the partial stream grows, so the guard can trip mid-run", () => {
    const lines = Array.from({ length: 70 }, (_, i) => line(i, "view_file"));
    expect(inspectAntigravityStream(lines.slice(0, 10).join("\n")).toolCalls).toBe(10);
    expect(inspectAntigravityStream(lines.slice(0, 61).join("\n")).toolCalls).toBe(61);
  });

  it("ignores non-tool steps", () => {
    const stream = [
      '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
      '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response"}}',
    ].join("\n");
    expect(inspectAntigravityStream(stream).toolCalls).toBe(0);
  });
});
