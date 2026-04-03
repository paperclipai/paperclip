import { describe, expect, it } from "vitest";
import {
  classifyHeartbeatCostObservation,
  classifyHeartbeatSemanticOutcome,
  detectHeartbeatLowSignalReasons,
  summarizeHeartbeatRunResultJson,
} from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });

  it("preserves semantic outcome and cost observation metadata", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "completed",
      semanticOutcome: "noop_telemetry_only",
      costObservation: "unknown",
      costObserved: false,
      lowSignalReasons: ["fallback_workspace", "no_assigned_tasks"],
      workspaceWarnings: [
        'Project workspace path "/tmp/missing" is not available yet. Using fallback workspace "/tmp/fallback" for this run.',
      ],
    });

    expect(summary).toEqual({
      summary: "completed",
      semanticOutcome: "noop_telemetry_only",
      costObservation: "unknown",
      costObserved: false,
      lowSignalReasons: ["fallback_workspace", "no_assigned_tasks"],
      workspaceWarnings: [
        'Project workspace path "/tmp/missing" is not available yet. Using fallback workspace "/tmp/fallback" for this run.',
      ],
    });
  });
});

describe("detectHeartbeatLowSignalReasons", () => {
  it("detects low-signal patterns from excerpts and workspace warnings", () => {
    expect(
      detectHeartbeatLowSignalReasons({
        stdoutExcerpt: "Inbox empty. Nothing to do.",
        workspaceWarnings: ['Using fallback workspace "/tmp/fallback" for this run.'],
      }),
    ).toEqual(["fallback_workspace", "inbox_empty"]);
  });
});

describe("classifyHeartbeatSemanticOutcome", () => {
  it("treats empty-task runs as noop telemetry", () => {
    expect(
      classifyHeartbeatSemanticOutcome({
        status: "succeeded",
        stdoutExcerpt: "No assigned tasks. Inbox empty.",
      }),
    ).toEqual({
      semanticOutcome: "noop_telemetry_only",
      lowSignalReasons: ["no_assigned_tasks", "inbox_empty"],
    });
  });

  it("treats fallback workspace issue runs as blocked_with_unblock_task", () => {
    expect(
      classifyHeartbeatSemanticOutcome({
        status: "succeeded",
        issueId: "issue-1",
        workspaceWarnings: ['No project workspace directory is currently available for this issue. Using fallback workspace "/tmp/fallback" for this run.'],
      }),
    ).toEqual({
      semanticOutcome: "blocked_with_unblock_task",
      lowSignalReasons: ["fallback_workspace"],
    });
  });

  it("treats failed issue runs as blocked_with_unblock_task", () => {
    expect(
      classifyHeartbeatSemanticOutcome({
        status: "failed",
        issueId: "issue-1",
      }),
    ).toEqual({
      semanticOutcome: "blocked_with_unblock_task",
      lowSignalReasons: [],
    });
  });

  it("treats successful non-empty runs as done_with_evidence", () => {
    expect(
      classifyHeartbeatSemanticOutcome({
        status: "succeeded",
        resultJson: { summary: "Implemented fix and updated tests." },
      }),
    ).toEqual({
      semanticOutcome: "done_with_evidence",
      lowSignalReasons: [],
    });
  });
});

describe("classifyHeartbeatCostObservation", () => {
  it("marks metered runs with tokens and no cost as unknown", () => {
    expect(
      classifyHeartbeatCostObservation({
        billingType: "metered_api",
        costUsd: null,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 10,
        },
      }),
    ).toBe("unknown");
  });

  it("marks subscription usage as subscription_included", () => {
    expect(
      classifyHeartbeatCostObservation({
        billingType: "subscription_included",
        costUsd: null,
        usage: {
          inputTokens: 100,
          outputTokens: 10,
        },
      }),
    ).toBe("subscription_included");
  });

  it("marks explicit metered cost as reported", () => {
    expect(
      classifyHeartbeatCostObservation({
        billingType: "metered_api",
        costUsd: 0.42,
        usage: {
          inputTokens: 100,
          outputTokens: 10,
        },
      }),
    ).toBe("reported");
  });
});
