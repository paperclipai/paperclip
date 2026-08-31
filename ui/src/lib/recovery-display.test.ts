import { describe, expect, it } from "vitest";
import {
  deriveActiveRecoveryDisplayState,
  deriveRecoveryDisplayState,
  recoveryChipLabel,
} from "./recovery-display";
import { readRecoveryRetryLineage } from "./recovery-lineage";

describe("recoveryChipLabel", () => {
  it("returns the workspace-specific label when kind is workspace_validation and state is needed", () => {
    expect(recoveryChipLabel("needed", "workspace_validation")).toBe(
      "Workspace recovery needed",
    );
  });

  it("falls back to the generic label for other needed kinds", () => {
    expect(recoveryChipLabel("needed", "missing_disposition")).toBe("Recovery needed");
    expect(recoveryChipLabel("needed", "stranded_assigned_issue")).toBe("Recovery needed");
    expect(recoveryChipLabel("needed", "issue_graph_liveness")).toBe("Recovery needed");
  });

  it("adds the attempt budget to an in-progress chip when a lineage is supplied", () => {
    const lineage = readRecoveryRetryLineage({
      wakePolicy: {
        type: "bounded_owner_disposition_repair",
        attempt: 2,
        maxAttempts: 5,
        retryAt: "2099-01-01T00:00:00.000Z",
      },
    });
    expect(recoveryChipLabel("in_progress", "deliberate_wait_without_target", lineage)).toBe(
      "Recovery in progress · 2/5",
    );
  });

  it("keeps the plain label when no attempt has been spent yet", () => {
    const lineage = readRecoveryRetryLineage({
      wakePolicy: { type: "bounded_owner_disposition_repair", attempt: 0, maxAttempts: 5 },
    });
    expect(recoveryChipLabel("in_progress", "deliberate_wait_without_target", lineage)).toBe(
      "Recovery in progress",
    );
  });

  it("does not override the chip label for non-needed states", () => {
    expect(recoveryChipLabel("in_progress", "workspace_validation")).toBe(
      "Recovery in progress",
    );
    expect(recoveryChipLabel("escalated", "workspace_validation")).toBe(
      "Recovery escalated",
    );
    expect(recoveryChipLabel("observe_only", "workspace_validation")).toBe(
      "Observing active run",
    );
  });
});

describe("deriveRecoveryDisplayState", () => {
  const base = {
    status: "active" as const,
    kind: "missing_disposition" as const,
    outcome: null,
  };

  it("classifies workspace_validation active as needed", () => {
    expect(deriveRecoveryDisplayState({ ...base, kind: "workspace_validation" })).toBe(
      "needed",
    );
    expect(
      deriveActiveRecoveryDisplayState({ ...base, kind: "workspace_validation" }),
    ).toBe("needed");
  });

  const waitBase = { ...base, kind: "deliberate_wait_without_target" as const };

  it("stays quiet while a bounded owner retry is stored", () => {
    expect(
      deriveRecoveryDisplayState({
        ...waitBase,
        wakePolicy: {
          type: "bounded_owner_disposition_repair",
          attempt: 2,
          maxAttempts: 5,
          retryAt: "2099-01-01T00:00:00.000Z",
        },
      }),
    ).toBe("in_progress");
  });

  it("stays quiet while a bounded manager retry is stored", () => {
    expect(
      deriveRecoveryDisplayState({
        ...waitBase,
        wakePolicy: {
          type: "bounded_recovery_owner",
          attempt: 1,
          maxAttempts: 3,
          retryAt: "2099-01-01T00:00:00.000Z",
          preservesSourceAssignee: true,
        },
      }),
    ).toBe("in_progress");
  });

  it("warns when the lane is exhausted", () => {
    expect(
      deriveRecoveryDisplayState({
        ...waitBase,
        wakePolicy: {
          type: "bounded_owner_disposition_repair",
          attempt: 5,
          maxAttempts: 5,
          retryAt: "2099-01-01T00:00:00.000Z",
        },
      }),
    ).toBe("needed");
  });

  it("warns when the stored retry time has already passed", () => {
    // The PAP-17561 false healthy state: attempts remain, so the lane is not exhausted, but
    // the attempt it promised came due and never ran. Nothing is moving this task.
    expect(
      deriveRecoveryDisplayState({
        ...waitBase,
        wakePolicy: {
          type: "bounded_owner_disposition_repair",
          attempt: 1,
          maxAttempts: 5,
          retryAt: "2020-01-01T00:00:00.000Z",
          scheduledRunId: "run-2",
        },
      }),
    ).toBe("needed");
  });

  it("stays quiet when a verified live run is executing the overdue attempt", () => {
    expect(
      deriveRecoveryDisplayState(
        {
          ...waitBase,
          wakePolicy: {
            type: "bounded_owner_disposition_repair",
            attempt: 1,
            maxAttempts: 5,
            retryAt: "2020-01-01T00:00:00.000Z",
            scheduledRunId: "run-2",
          },
        },
        { scheduledRetry: { runId: "run-2", status: "running" } },
      ),
    ).toBe("in_progress");
  });

  it("still warns when the live run belongs to a different lane", () => {
    expect(
      deriveRecoveryDisplayState(
        {
          ...waitBase,
          wakePolicy: {
            type: "bounded_owner_disposition_repair",
            attempt: 1,
            maxAttempts: 5,
            retryAt: "2020-01-01T00:00:00.000Z",
            scheduledRunId: "run-2",
          },
        },
        { scheduledRetry: { runId: "run-other", status: "running" } },
      ),
    ).toBe("needed");
  });

  it("warns when no next attempt is stored at all", () => {
    expect(
      deriveRecoveryDisplayState({
        ...waitBase,
        wakePolicy: { type: "bounded_owner_disposition_repair", attempt: 1, maxAttempts: 5 },
      }),
    ).toBe("needed");
  });

  it("keeps an escalated board action red even with a lineage", () => {
    expect(
      deriveRecoveryDisplayState({
        ...waitBase,
        status: "escalated",
        wakePolicy: {
          type: "board_escalation",
          reason: "recovery_owner_retry_exhausted",
          preservesSourceAssignee: true,
        },
      }),
    ).toBe("escalated");
  });

  it("does not change kinds that carry no bounded lineage", () => {
    expect(
      deriveRecoveryDisplayState({ ...base, wakePolicy: { type: "wake_owner" } }),
    ).toBe("needed");
    expect(
      deriveRecoveryDisplayState({ ...base, outcome: "delegated", wakePolicy: null }),
    ).toBe("in_progress");
  });
});
