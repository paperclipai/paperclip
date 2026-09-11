import { describe, expect, it } from "vitest";
import {
  buildCompactContinuationPrompt,
  decideWatchdogTick,
  deriveStructuredRunMetrics,
  evaluateRunBudget,
  MAX_AUTO_RECOVERIES,
  MAX_COMPACT_CONTINUATION_CHARS,
  RUN_BUDGET_BY_PROFILE,
  shouldOpenNewMetaIssue,
  type RunTelemetryEvent,
} from "./rtb-execution-control.js";

describe("decideWatchdogTick ÔÇö RTB no-meta-issue + bounded lifecycle (KOMAA-166 A/B, acceptance #2/#3)", () => {
  it("idle / not_applicable => no model, no meta-issue, no action", () => {
    const decision = decideWatchdogTick({
      severity: "ok",
      priorRecoveryCount: 0,
      livenessProgress: false,
      openMetaIssueExists: false,
    });
    expect(decision.invokeModel).toBe(false);
    expect(decision.createMetaIssue).toBe(false);
    expect(decision.action).toBe("none");
  });

  it("suspicious tick => zero model invocations, zero new meta-issue (state-only)", () => {
    const decision = decideWatchdogTick({
      severity: "suspicious",
      priorRecoveryCount: 0,
      livenessProgress: false,
      openMetaIssueExists: false,
    });
    expect(decision.invokeModel).toBe(false);
    expect(decision.createMetaIssue).toBe(false);
    expect(decision.action).toBe("state_only");
  });

  it("3 consecutive suspicious ticks for the same source => 0 meta-issues, 0 model, no duplicates", () => {
    let openMetaIssueExists = false;
    for (let tick = 0; tick < 3; tick += 1) {
      const decision = decideWatchdogTick({
        severity: "suspicious",
        priorRecoveryCount: 0,
        livenessProgress: false,
        openMetaIssueExists,
      });
      expect(decision.invokeModel).toBe(false);
      expect(decision.createMetaIssue).toBe(false);
    }
    // Idempotency guard: while no meta-issue exists the guard *permits* opening
    // the first one, but the RTB default (allowMetaIssue=false) means
    // decideWatchdogTick never requests it. Once one exists, the guard refuses a
    // duplicate — so across the 3 ticks we never open a second meta-issue.
    expect(shouldOpenNewMetaIssue(false)).toBe(true);
    expect(shouldOpenNewMetaIssue(true)).toBe(false);
  });

  it("critical with confirmed liveness => single bounded recovery, no meta-issue by default", () => {
    const decision = decideWatchdogTick({
      severity: "critical",
      priorRecoveryCount: 0,
      livenessProgress: true,
      openMetaIssueExists: false,
    });
    expect(decision.action).toBe("recover");
    expect(decision.invokeModel).toBe(false);
    expect(decision.createMetaIssue).toBe(false);
  });

  it("critical without liveness => terminalize (bounded lifecycle)", () => {
    const decision = decideWatchdogTick({
      severity: "critical",
      priorRecoveryCount: 0,
      livenessProgress: false,
      openMetaIssueExists: false,
    });
    expect(decision.action).toBe("terminalize");
    expect(decision.createMetaIssue).toBe(false);
  });

  it("critical after MAX_AUTO_RECOVERIES => terminalize, never a second recovery", () => {
    const decision = decideWatchdogTick({
      severity: "critical",
      priorRecoveryCount: MAX_AUTO_RECOVERIES,
      livenessProgress: true,
      openMetaIssueExists: false,
    });
    expect(decision.action).toBe("terminalize");
    expect(decision.invokeModel).toBe(false);
  });

  it("recovery budget is exactly one (max 1 automatic recovery)", () => {
    expect(MAX_AUTO_RECOVERIES).toBe(1);
  });
});

describe("shouldOpenNewMetaIssue ÔÇö idempotent meta-issue guard (acceptance #3)", () => {
  it("returns false when a meta-issue is already open for the source", () => {
    expect(shouldOpenNewMetaIssue(true)).toBe(false);
  });
  it("returns true only when no meta-issue exists and legacy path is taken", () => {
    expect(shouldOpenNewMetaIssue(false)).toBe(true);
  });
});

describe("evaluateRunBudget ÔÇö mechanical model-call budget + compaction (KOMAA-166 C, acceptance #4)", () => {
  it("within budget => no compaction", () => {
    const result = evaluateRunBudget({ modelCalls: RUN_BUDGET_BY_PROFILE.normal });
    expect(result.exceeded).toBe(false);
    expect(result.strategy).toBe("within");
  });

  it("over budget with small cached replay => compact continuation", () => {
    const result = evaluateRunBudget({ modelCalls: RUN_BUDGET_BY_PROFILE.normal + 1, cachedInputTokens: 10_000 });
    expect(result.exceeded).toBe(true);
    expect(result.strategy).toBe("compact");
  });

  it("over budget with huge cached replay => fork instead of full replay", () => {
    const result = evaluateRunBudget({
      modelCalls: RUN_BUDGET_BY_PROFILE.normal + 1,
      cachedInputTokens: 3_000_000,
    });
    expect(result.exceeded).toBe(true);
    expect(result.strategy).toBe("fork");
  });

  it("debug/complex profiles use their own limits", () => {
    expect(evaluateRunBudget({ modelCalls: 5 }, "debug").exceeded).toBe(false);
    expect(evaluateRunBudget({ modelCalls: 7 }, "complex").exceeded).toBe(false);
    expect(evaluateRunBudget({ modelCalls: 9 }, "complex").exceeded).toBe(true);
  });
});

describe("buildCompactContinuationPrompt ÔÇö bounded continuation context (acceptance #4)", () => {
  const ctx = {
    objective: "Ship RTB execution control",
    decisions: ["A1", "A2"],
    changedFiles: ["server/src/services/rtb-execution-control.ts"],
    tests: ["rtb-execution-control.test.ts"],
    blockers: ["none"],
    nextAction: "Wire decideWatchdogTick into recovery service",
    runtimeIds: { runId: "run_123", workspaceId: "ws_456" },
  };

  it("preserves objective/decisions/files/tests/blockers/next action and runtime ids", () => {
    const prompt = buildCompactContinuationPrompt(ctx);
    expect(prompt).toContain("OBJECTIVE:");
    expect(prompt).toContain("DECISIONS:");
    expect(prompt).toContain("CHANGED FILES:");
    expect(prompt).toContain("TESTS:");
    expect(prompt).toContain("BLOCKERS:");
    expect(prompt).toContain("NEXT ACTION:");
    expect(prompt).toContain("RUNTIME IDS:");
    expect(prompt).toContain("run_123");
  });

  it("is always bounded to MAX_COMPACT_CONTINUATION_CHARS", () => {
    const huge = { ...ctx, objective: "x".repeat(10_000), decisions: ["y".repeat(10_000)] };
    const prompt = buildCompactContinuationPrompt(huge);
    expect(prompt.length).toBeLessThanOrEqual(MAX_COMPACT_CONTINUATION_CHARS);
    expect(prompt).toContain("[truncated to bounded size]");
  });
});

describe("deriveStructuredRunMetrics ÔÇö persisted structured telemetry (KOMAA-166 D, acceptance #5)", () => {
  const start = 1_000_000;
  const events: RunTelemetryEvent[] = [
    { eventType: "tool_call", timestamp: start + 100, ok: true },
    { eventType: "tool_call", timestamp: start + 200, ok: false },
    { eventType: "tool_call", timestamp: start + 300, ok: true },
    { eventType: "tool_error", timestamp: start + 350 },
    { eventType: "retry", timestamp: start + 400 },
    { eventType: "retry", timestamp: start + 450 },
    { eventType: "search", timestamp: start + 500 },
    { eventType: "file_read", timestamp: start + 600 },
    { eventType: "file_read", timestamp: start + 650 },
    { eventType: "file_write", timestamp: start + 1000 },
    { eventType: "test", timestamp: start + 2000 },
    { eventType: "model_call", timestamp: start + 50 },
  ];

  it("derives all required counters/timestamps non-null and consistent with events", () => {
    const metrics = deriveStructuredRunMetrics({
      events,
      runStartedAt: start,
      usage: { inputTokens: 10 },
      durationMs: 5000,
      provider: "opencode_local",
      model: "mimo-v2.5",
    });

    expect(metrics.toolCalls).toBe(3);
    expect(metrics.failedToolCalls).toBe(2); // one tool_call ok:false + one tool_error
    expect(metrics.retryCount).toBe(2);
    expect(metrics.searchCalls).toBe(1);
    expect(metrics.fileReads).toBe(2);
    expect(metrics.fileWrites).toBe(1);
    expect(metrics.testCalls).toBe(1);
    expect(metrics.timeToFirstWriteMs).toBe(1000);
    expect(metrics.timeToFirstTestMs).toBe(2000);
    expect(metrics.derived).toBe(true);
    expect(metrics.unsupported).toEqual([]);
    expect(metrics.provider).toBe("opencode_local");
    expect(metrics.model).toBe("mimo-v2.5");
    expect(metrics.usage).toEqual({ inputTokens: 10 });
    expect(metrics.durationMs).toBe(5000);
  });

  it("reports null timestamps when no write/test events occurred (never estimated)", () => {
    const metrics = deriveStructuredRunMetrics({
      events: [{ eventType: "tool_call", timestamp: start + 10, ok: true }],
      runStartedAt: start,
    });
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.timeToFirstWriteMs).toBeNull();
    expect(metrics.timeToFirstTestMs).toBeNull();
    expect(metrics.derived).toBe(true);
    expect(metrics.unsupported).toEqual([]);
  });
});
