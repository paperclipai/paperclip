import { describe, expect, it } from "vitest";
import type {
  InterruptedRunRecovery,
  IssueRecoveryAction,
  IssueScheduledRetry,
} from "@paperclipai/shared";
import {
  describeRecoverySlot,
  isUnhealthyLeafRecoveryState,
  leafRecoveryChip,
  leafRecoveryNeedsOwner,
  receiptChipTitle,
  recoveryAttemptLabel,
  recoverySlotHeadline,
  resolveRecoverySlot,
} from "./interrupted-run-recovery";

const model: InterruptedRunRecovery = {
  state: "retry_queued",
  interruptedRunId: "run-interrupted",
  interruptedAt: "2026-04-18T19:55:13.000Z",
  errorCode: "server_shutdown_interrupted",
  successorRunId: null,
  successorStatus: null,
  receiptId: "receipt-abcdef01-2345",
  receiptOutcome: "queued",
  suppressionReason: null,
  escalationReason: null,
  attempt: 1,
  maxAttempts: 3,
  recoveryActionId: null,
  owner: null,
  nextAction: null,
};

const retry: IssueScheduledRetry = {
  runId: "run-successor",
  status: "scheduled_retry",
  agentId: "agent-1",
  agentName: "CodexCoder",
  retryOfRunId: "run-interrupted",
  scheduledRetryAt: "2026-04-18T20:02:00.000Z",
  scheduledRetryAttempt: 1,
  scheduledRetryReason: "process_lost",
  retryExhaustedReason: null,
  error: null,
  errorCode: null,
};

function buildAction(overrides: Partial<IssueRecoveryAction> = {}): IssueRecoveryAction {
  return {
    id: "action-1",
    issueId: "issue-1",
    kind: "stranded_assigned_issue",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-2",
    ownerUserId: null,
    previousOwnerAgentId: "agent-1",
    returnOwnerAgentId: null,
    outcome: null,
    nextAction: "Reassign the task and restart the run.",
    evidence: {},
    attemptCount: 1,
    maxAttempts: 3,
    timeoutAt: null,
    resolvedAt: null,
    createdAt: "2026-04-18T19:56:00.000Z",
    updatedAt: "2026-04-18T19:56:00.000Z",
    ...overrides,
  } as unknown as IssueRecoveryAction;
}

describe("resolveRecoverySlot — arbitration table (spec §1)", () => {
  it("pri 1: renders nothing for a terminal task", () => {
    expect(
      resolveRecoverySlot({ issueStatus: "done", interruptedRunRecovery: model }),
    ).toBeNull();
    expect(
      resolveRecoverySlot({ issueStatus: "cancelled", interruptedRunRecovery: model }),
    ).toBeNull();
  });

  it("pri 2: an active recovery action takes the slot away from the retry card", () => {
    const slot = resolveRecoverySlot({
      issueStatus: "in_progress",
      interruptedRunRecovery: model,
      scheduledRetry: retry,
      activeRecoveryAction: buildAction(),
    });
    expect(slot?.variant).toBe("recovery_owner_required");
    expect(slot?.card).toBe("recovery_action");
  });

  it("pri 2 beats pri 3: an escalated action wins over a live successor", () => {
    const slot = resolveRecoverySlot({
      interruptedRunRecovery: { ...model, state: "recovered", successorStatus: "running" },
      activeRecoveryAction: buildAction({ status: "escalated" }),
    });
    expect(slot?.card).toBe("recovery_action");
  });

  it("pri 2 ignores actions that are no longer open", () => {
    const slot = resolveRecoverySlot({
      interruptedRunRecovery: model,
      activeRecoveryAction: buildAction({ status: "resolved" }),
    });
    expect(slot?.variant).toBe("retry_queued");
  });

  it("pri 3: a promoted successor reads as recovered, not as a pending promise", () => {
    const slot = resolveRecoverySlot({
      interruptedRunRecovery: {
        ...model,
        state: "recovered",
        successorRunId: "run-successor",
        successorStatus: "running",
      },
    });
    expect(slot?.variant).toBe("recovered");
    expect(slot?.card).toBe("retry");
  });

  it("pri 4: a scheduled retry is variant A", () => {
    const slot = resolveRecoverySlot({ scheduledRetry: retry });
    expect(slot?.variant).toBe("retry_queued");
    expect(slot?.promotableRetry).toBe(true);
  });

  it("pri 5: exhausted, suppressed and pathless each map to their own variant", () => {
    expect(
      resolveRecoverySlot({ interruptedRunRecovery: { ...model, state: "retry_exhausted" } })?.variant,
    ).toBe("retry_exhausted");
    expect(
      resolveRecoverySlot({
        interruptedRunRecovery: { ...model, state: "suppressed", suppressionReason: "budget exhausted" },
      })?.variant,
    ).toBe("suppressed");
    expect(
      resolveRecoverySlot({ interruptedRunRecovery: { ...model, state: "pathless" } })?.variant,
    ).toBe("pathless");
  });

  it("pri 6: a pre-5A payload whose receipt is still waiting renders nothing", () => {
    expect(
      resolveRecoverySlot({
        scheduledRetry: { ...retry, status: "cancelled", retryOfRunId: null },
      }),
    ).toBeNull();
  });

  it("the server's state wins over the receipt outcome that produced it", () => {
    // A `queued` receipt that later exhausted must not be re-derived as A.
    const slot = resolveRecoverySlot({
      interruptedRunRecovery: { ...model, state: "retry_exhausted", receiptOutcome: "queued" },
    });
    expect(slot?.variant).toBe("retry_exhausted");
  });

  it("never claims an interruption from an ordinary failure retry (pre-5A payload)", () => {
    const slot = resolveRecoverySlot({
      scheduledRetry: { ...retry, scheduledRetryReason: "transient_failure" },
    });
    expect(slot).toBeNull();
  });

  it("derives variant A from a pre-5A payload carrying an interruption reason", () => {
    const slot = resolveRecoverySlot({ scheduledRetry: retry });
    expect(slot?.variant).toBe("retry_queued");
    expect(slot?.fromReadModel).toBe(false);
    expect(slot?.interruptedRunId).toBe("run-interrupted");
    expect(slot?.agentId).toBe("agent-1");
  });

  it("derives variant B from a promoted pre-5A retry", () => {
    const slot = resolveRecoverySlot({
      scheduledRetry: { ...retry, status: "running" },
    });
    expect(slot?.variant).toBe("recovered");
    expect(slot?.successorRunId).toBe("run-successor");
    expect(slot?.promotableRetry).toBe(false);
  });

  it("derives variant C from a pre-5A exhausted retry", () => {
    const slot = resolveRecoverySlot({
      scheduledRetry: {
        ...retry,
        status: "cancelled",
        retryExhaustedReason: "Automatic retries exhausted after 3 attempts.",
      },
    });
    expect(slot?.variant).toBe("retry_exhausted");
    expect(slot?.escalationReason).toBe("Automatic retries exhausted after 3 attempts.");
  });

  it("renders nothing when there is no recovery data at all", () => {
    expect(resolveRecoverySlot({})).toBeNull();
    expect(resolveRecoverySlot({ scheduledRetry: null, activeRecoveryAction: null })).toBeNull();
  });
});

describe("recovery slot copy (spec §6)", () => {
  it("variant A names the restart and says nothing is needed", () => {
    const slot = resolveRecoverySlot({ interruptedRunRecovery: model })!;
    const presentation = describeRecoverySlot(slot)!;
    expect(presentation.badgeLabel).toBe("Retry queued");
    expect(presentation.body).toBe(
      "The last run was interrupted by a server restart. Work resumes automatically — nothing is needed from you.",
    );
    expect(recoverySlotHeadline(slot, { relativeDue: "in ~2m" })).toBe("Automatic retry in ~2m");
    expect(recoverySlotHeadline(slot, { relativeDue: "now" })).toBe("Automatic retry due now");
    expect(recoverySlotHeadline(slot, {})).toBe("Automatic retry pending schedule");
  });

  it("variant A names a non-restart interruption reason", () => {
    const slot = resolveRecoverySlot({
      interruptedRunRecovery: { ...model, errorCode: "process_lost" },
    })!;
    expect(describeRecoverySlot(slot)!.body).toBe(
      "The last run was interrupted (Process lost). Work resumes automatically — nothing is needed from you.",
    );
  });

  it("variant B is quiet: neutral tone, no action, no second line", () => {
    const slot = resolveRecoverySlot({
      interruptedRunRecovery: {
        ...model,
        state: "recovered",
        successorRunId: "run-successor-12345",
        successorStatus: "running",
      },
    })!;
    const presentation = describeRecoverySlot(slot)!;
    expect(presentation.badgeLabel).toBe("Recovered");
    expect(presentation.tone.container).toBe("border-border/60");
    expect(presentation.showRetryNow).toBe(false);
    expect(presentation.body).toBeNull();
    expect(recoverySlotHeadline(slot)).toBe(
      "Recovered after restart — run run-succ is continuing the work.",
    );
  });

  it("variant C renders the bounded reason verbatim", () => {
    const exhausted = resolveRecoverySlot({
      interruptedRunRecovery: {
        ...model,
        state: "retry_exhausted",
        escalationReason: "Automatic retries exhausted after 3 attempts.",
      },
    })!;
    expect(describeRecoverySlot(exhausted)!.body).toBe(
      "Automatic retries exhausted after 3 attempts.",
    );
    expect(recoverySlotHeadline(exhausted)).toBe(
      "Automatic retries are used up. A recovery owner is needed to continue.",
    );

    const suppressed = resolveRecoverySlot({
      interruptedRunRecovery: {
        ...model,
        state: "suppressed",
        suppressionReason: "company budget exhausted",
      },
    })!;
    expect(describeRecoverySlot(suppressed)!.body).toBe(
      "Automatic retry withheld: company budget exhausted.",
    );
    // Withheld is not the same as spent — the badge and headline must not
    // contradict the body.
    expect(describeRecoverySlot(suppressed)!.badgeLabel).toBe("Retry withheld");
    expect(recoverySlotHeadline(suppressed)).toBe(
      "Automatic retry is withheld. A recovery owner is needed to continue.",
    );
  });

  it("variant C pathless tells the operator what to do when the card persists", () => {
    const slot = resolveRecoverySlot({
      interruptedRunRecovery: { ...model, state: "pathless" },
    })!;
    const presentation = describeRecoverySlot(slot)!;
    expect(presentation.badgeLabel).toBe("No recovery scheduled");
    expect(recoverySlotHeadline(slot)).toBe(
      "The last run was interrupted and no retry or recovery is scheduled.",
    );
    expect(presentation.body).toBe(
      "Paperclip should repair this automatically. If this card persists, open a typed recovery action or escalate to a recovery owner.",
    );
  });

  it("variant D has no retry-card presentation", () => {
    const slot = resolveRecoverySlot({
      interruptedRunRecovery: model,
      activeRecoveryAction: buildAction(),
    })!;
    expect(describeRecoverySlot(slot)).toBeNull();
  });

  it("formats the attempt bound and the receipt tooltip", () => {
    expect(recoveryAttemptLabel({ attempt: 2, maxAttempts: 3 })).toBe("Attempt 2 of 3");
    expect(recoveryAttemptLabel({ attempt: 2, maxAttempts: null })).toBe("Attempt 2");
    expect(recoveryAttemptLabel({ attempt: null, maxAttempts: 3 })).toBeNull();
    expect(receiptChipTitle({ receiptId: "receipt-1", receiptOutcome: "queued" })).toBe(
      "receipt-1 · queued",
    );
    expect(receiptChipTitle({ receiptId: null, receiptOutcome: "queued" })).toBeNull();
  });
});

describe("blocked-parent leaf states (spec §4)", () => {
  it("treats every interruption state except `recovered` as unhealthy", () => {
    expect(isUnhealthyLeafRecoveryState("retry_queued")).toBe(true);
    expect(isUnhealthyLeafRecoveryState("retry_exhausted")).toBe(true);
    expect(isUnhealthyLeafRecoveryState("recovery_owner_required")).toBe(true);
    expect(isUnhealthyLeafRecoveryState("recovered")).toBe(false);
    expect(isUnhealthyLeafRecoveryState(null)).toBe(false);
    expect(isUnhealthyLeafRecoveryState(undefined)).toBe(false);
  });

  it("gives A/C leaves a chip and leaves D leaves to the recovery chips", () => {
    expect(leafRecoveryChip("retry_queued")?.label).toBe("Retry queued");
    expect(leafRecoveryChip("retry_exhausted")?.label).toBe("Retry exhausted");
    expect(leafRecoveryChip("suppressed")?.label).toBe("Retry withheld");
    expect(leafRecoveryChip("recovery_owner_required")).toBeNull();
    expect(leafRecoveryChip("recovered")).toBeNull();
  });

  it("splits leaves into resumes-on-its-own vs needs-an-owner", () => {
    expect(leafRecoveryNeedsOwner("retry_queued")).toBe(false);
    expect(leafRecoveryNeedsOwner("recovered")).toBe(false);
    expect(leafRecoveryNeedsOwner("retry_exhausted")).toBe(true);
    expect(leafRecoveryNeedsOwner("suppressed")).toBe(true);
    expect(leafRecoveryNeedsOwner("pathless")).toBe(true);
    expect(leafRecoveryNeedsOwner("recovery_owner_required")).toBe(true);
  });
});
