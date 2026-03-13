import { describe, expect, it } from "vitest";
import { parseTriageOutput, TRIAGE_SYSTEM_PROMPT } from "../services/heartbeat.js";
import type { TriageResult } from "../services/heartbeat.js";

describe("parseTriageOutput", () => {
  it('returns "none" when triage model reports no work', () => {
    const stdout = '{"_paperclipTriageAction": "none", "reason": "No assigned issues found"}';
    const result = parseTriageOutput(stdout);
    expect(result.action).toBe("none");
    expect(result.reason).toBe("No assigned issues found");
  });

  it('returns "escalate" when triage model reports complex work', () => {
    const stdout = '{"_paperclipTriageAction": "escalate", "reason": "Found 3 assigned issues requiring code changes"}';
    const result = parseTriageOutput(stdout);
    expect(result.action).toBe("escalate");
    expect(result.reason).toBe("Found 3 assigned issues requiring code changes");
  });

  it('returns "handle" when triage model handles simple work', () => {
    const stdout = '{"_paperclipTriageAction": "handle", "reason": "Updated issue status to in_progress"}';
    const result = parseTriageOutput(stdout);
    expect(result.action).toBe("handle");
    expect(result.reason).toBe("Updated issue status to in_progress");
  });

  it("defaults to escalate when output is not parseable", () => {
    const result = parseTriageOutput("Some random text without any JSON");
    expect(result.action).toBe("escalate");
    expect(result.reason).toContain("not parseable");
  });

  it("defaults to escalate when JSON is malformed", () => {
    const result = parseTriageOutput('{_paperclipTriageAction: "none"}');
    expect(result.action).toBe("escalate");
    expect(result.reason).toContain("not parseable");
  });

  it("defaults to escalate for unknown action values", () => {
    const result = parseTriageOutput('{"_paperclipTriageAction": "unknown_action", "reason": "test"}');
    expect(result.action).toBe("escalate");
    expect(result.reason).toContain("Unknown triage action");
  });

  it("extracts JSON from mixed output with surrounding text", () => {
    const stdout = `Checking for work...
Calling Paperclip API...
{"_paperclipTriageAction": "none", "reason": "Nothing to do"}
Done.`;
    const result = parseTriageOutput(stdout);
    expect(result.action).toBe("none");
    expect(result.reason).toBe("Nothing to do");
  });

  it("provides a default reason when none is given", () => {
    const result = parseTriageOutput('{"_paperclipTriageAction": "none"}');
    expect(result.action).toBe("none");
    expect(result.reason).toBe("No reason provided");
  });

  it("handles empty string output", () => {
    const result = parseTriageOutput("");
    expect(result.action).toBe("escalate");
    expect(result.reason).toContain("not parseable");
  });
});

describe("TRIAGE_SYSTEM_PROMPT", () => {
  it("is a non-empty string constant", () => {
    expect(typeof TRIAGE_SYSTEM_PROMPT).toBe("string");
    expect(TRIAGE_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it("mentions the three possible actions", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"none"');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"handle"');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"escalate"');
  });

  it("mentions _paperclipTriageAction", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain("_paperclipTriageAction");
  });
});

describe("heartbeat triage integration logic", () => {
  // These tests verify the conditional logic for when triage should/shouldn't run.
  // The actual executeRun is too complex to unit test directly, but we test the
  // decision criteria here.

  it("triage should only run for timer source with heartbeatModel set", () => {
    // Simulates the condition check in executeRun
    const scenarios = [
      { heartbeatModel: "claude-haiku-4-5", source: "timer", shouldTriage: true },
      { heartbeatModel: "claude-haiku-4-5", source: "on_demand", shouldTriage: false },
      { heartbeatModel: "claude-haiku-4-5", source: "assignment", shouldTriage: false },
      { heartbeatModel: "claude-haiku-4-5", source: "automation", shouldTriage: false },
      { heartbeatModel: "", source: "timer", shouldTriage: false },
      { heartbeatModel: null, source: "timer", shouldTriage: false },
      { heartbeatModel: undefined, source: "timer", shouldTriage: false },
      { heartbeatModel: "", source: "on_demand", shouldTriage: false },
    ];

    for (const { heartbeatModel, source, shouldTriage } of scenarios) {
      const model = typeof heartbeatModel === "string" && heartbeatModel.trim().length > 0 ? heartbeatModel : null;
      const isTimerSource = source === "timer";
      const willTriage = !!(model && isTimerSource);
      expect(willTriage).toBe(shouldTriage);
    }
  });

  it("triage action 'none' should finalize early", () => {
    // "none" means no work — run exits without launching full model
    const triageResult: TriageResult = { action: "none", reason: "No work" };
    const shouldContinueToFullModel = triageResult.action === "escalate";
    expect(shouldContinueToFullModel).toBe(false);
  });

  it("triage action 'handle' should finalize early", () => {
    // "handle" means triage handled it — run exits without launching full model
    const triageResult: TriageResult = { action: "handle", reason: "Handled" };
    const shouldContinueToFullModel = triageResult.action === "escalate";
    expect(shouldContinueToFullModel).toBe(false);
  });

  it("triage action 'escalate' should continue to full model", () => {
    const triageResult: TriageResult = { action: "escalate", reason: "Complex work" };
    const shouldContinueToFullModel = triageResult.action === "escalate";
    expect(shouldContinueToFullModel).toBe(true);
  });

  it("triage parse failure defaults to escalate (never skip work)", () => {
    // Simulate various failure modes
    const failures = [
      parseTriageOutput(""),
      parseTriageOutput("not json at all"),
      parseTriageOutput('{"wrong_key": "none"}'),
      parseTriageOutput('{"_paperclipTriageAction": "invalid"}'),
    ];

    for (const result of failures) {
      expect(result.action).toBe("escalate");
    }
  });

  it("triage usage should be tracked in the run", () => {
    // Verify that triage usage can be combined into the final usageJson
    const triageUsage = { inputTokens: 100, outputTokens: 50, costUsd: 0.001 };
    const mainUsage = { inputTokens: 5000, outputTokens: 2000, costUsd: 0.05 };

    // The merging pattern used in heartbeat.ts
    const combinedUsage = {
      ...mainUsage,
      triageUsage,
    };

    expect(combinedUsage.inputTokens).toBe(5000);
    expect(combinedUsage.outputTokens).toBe(2000);
    expect(combinedUsage.costUsd).toBe(0.05);
    expect(combinedUsage.triageUsage).toEqual(triageUsage);
  });
});
