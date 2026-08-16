import { describe, expect, it } from "vitest";
import {
  deriveActiveRecoveryDisplayState,
  deriveRecoveryDisplayState,
  deriveRecoveryPresentation,
  isRecessedRecoveryState,
  recoveryChipLabel,
  recoveryLivenessFromIssue,
  RECOVERY_CHIP_DEFAULT_TONE,
} from "./recovery-display";

const CTO_ID = "cto-agent-id";
const CODER_ID = "coder-agent-id";

const base = {
  status: "active" as const,
  kind: "missing_disposition" as const,
  outcome: null,
  ownerAgentId: CTO_ID,
  recoveryIssueId: null,
};

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

  it("names the live recovery owner on the in-progress line", () => {
    expect(recoveryChipLabel("in_progress", "missing_disposition", { ownerName: "CTO" })).toBe(
      "Recovery in progress · CTO",
    );
  });

  it("ignores an owner name for states that are not in progress", () => {
    expect(recoveryChipLabel("needed", "missing_disposition", { ownerName: "CTO" })).toBe(
      "Recovery needed",
    );
    expect(recoveryChipLabel("escalated", "missing_disposition", { ownerName: "CTO" })).toBe(
      "Recovery escalated",
    );
  });

  it("ignores a blank owner name", () => {
    expect(recoveryChipLabel("in_progress", "missing_disposition", { ownerName: "  " })).toBe(
      "Recovery in progress",
    );
  });
});

describe("recovery tones", () => {
  it("keeps prominent amber/red only for needed and escalated", () => {
    expect(RECOVERY_CHIP_DEFAULT_TONE.needed.recessed).toBe(false);
    expect(RECOVERY_CHIP_DEFAULT_TONE.escalated.recessed).toBe(false);
    expect(RECOVERY_CHIP_DEFAULT_TONE.in_progress.recessed).toBe(true);
    expect(RECOVERY_CHIP_DEFAULT_TONE.observe_only.recessed).toBe(true);
  });

  it("gives the in-progress chip no amber or red treatment", () => {
    expect(RECOVERY_CHIP_DEFAULT_TONE.in_progress.className).not.toMatch(/amber|red/);
    expect(RECOVERY_CHIP_DEFAULT_TONE.observe_only.className).not.toMatch(/amber|red/);
  });

  it("classifies recessed states", () => {
    expect(isRecessedRecoveryState("in_progress")).toBe(true);
    expect(isRecessedRecoveryState("observe_only")).toBe(true);
    expect(isRecessedRecoveryState("resolved")).toBe(true);
    expect(isRecessedRecoveryState("needed")).toBe(false);
    expect(isRecessedRecoveryState("escalated")).toBe(false);
  });
});

describe("deriveRecoveryDisplayState", () => {
  it("classifies workspace_validation active as needed", () => {
    expect(deriveRecoveryDisplayState({ ...base, kind: "workspace_validation" })).toBe(
      "needed",
    );
    expect(
      deriveActiveRecoveryDisplayState({ ...base, kind: "workspace_validation" }),
    ).toBe("needed");
  });

  it("keeps needed when nothing is live or queued", () => {
    expect(deriveRecoveryDisplayState(base, {})).toBe("needed");
  });

  // PAP-17057 added this kind: a run stopped to wait on nothing, so the original
  // owner gets bounded disposition-repair attempts. While one of those attempts
  // is live or queued the state is recessed, not a prominent call to action.
  it("reads a bounded repair attempt on deliberate_wait_without_target as in progress", () => {
    const action = { ...base, kind: "deliberate_wait_without_target" as const };
    expect(
      deriveRecoveryDisplayState(action, {
        ownerRun: { agentId: CTO_ID, status: "running" },
      }),
    ).toBe("in_progress");
    expect(deriveRecoveryDisplayState(action, { hasQueuedWake: true })).toBe("in_progress");
  });

  it("keeps deliberate_wait_without_target needed once repair attempts stop", () => {
    expect(
      deriveRecoveryDisplayState({ ...base, kind: "deliberate_wait_without_target" }, {}),
    ).toBe("needed");
  });

  it("prefers the server-projected display state when present", () => {
    expect(
      deriveRecoveryDisplayState({ ...base, displayState: "observe_only" } as never, {
        sourceHasLiveRun: false,
      }),
    ).toBe("observe_only");
  });

  it("ignores an unrecognized server-projected display state", () => {
    expect(deriveRecoveryDisplayState({ ...base, displayState: "bogus" } as never)).toBe("needed");
  });

  it("reads a running recovery-owner run as in progress", () => {
    expect(
      deriveRecoveryDisplayState(base, {
        ownerRun: { agentId: CTO_ID, status: "running" },
      }),
    ).toBe("in_progress");
  });

  it("reads a queued recovery-owner run as in progress", () => {
    expect(
      deriveRecoveryDisplayState(base, {
        ownerRun: { agentId: CTO_ID, status: "queued" },
      }),
    ).toBe("in_progress");
  });

  it("does not treat a finished owner run as liveness", () => {
    expect(
      deriveRecoveryDisplayState(base, {
        ownerRun: { agentId: CTO_ID, status: "completed" },
      }),
    ).toBe("needed");
  });

  it("does not credit another agent's live run to the recovery owner", () => {
    expect(
      deriveRecoveryDisplayState(base, {
        ownerRun: { agentId: CODER_ID, status: "running" },
      }),
    ).toBe("needed");
  });

  // PAP-16986: recovery escalated to the CTO while the CTO was already running.
  it("shows an escalated action with a live owner run as in progress, not escalated", () => {
    expect(
      deriveRecoveryDisplayState(
        { ...base, status: "escalated" },
        { ownerRun: { agentId: CTO_ID, status: "running" } },
      ),
    ).toBe("in_progress");
  });

  it("keeps escalated prominent when no owner is live", () => {
    expect(deriveRecoveryDisplayState({ ...base, status: "escalated" }, {})).toBe("escalated");
  });

  it("reads a live source run owned by the recovery owner as in progress", () => {
    expect(
      deriveRecoveryDisplayState(base, {
        sourceHasLiveRun: true,
        sourceLiveRunAgentId: CTO_ID,
      }),
    ).toBe("in_progress");
  });

  it("folds the action to observation when a different owner took the task over", () => {
    expect(
      deriveRecoveryDisplayState(base, {
        sourceHasLiveRun: true,
        sourceLiveRunAgentId: CODER_ID,
      }),
    ).toBe("observe_only");
  });

  it("reads a queued wake as in progress", () => {
    expect(deriveRecoveryDisplayState(base, { hasQueuedWake: true })).toBe("in_progress");
  });

  it("reads a delegated outcome or a recovery issue as in progress", () => {
    expect(deriveRecoveryDisplayState({ ...base, outcome: "delegated" })).toBe("in_progress");
    expect(deriveRecoveryDisplayState({ ...base, recoveryIssueId: "issue-1" })).toBe(
      "in_progress",
    );
  });

  it("observes rather than warns when the successful-run handoff has a live continuation", () => {
    expect(deriveRecoveryDisplayState(base, { hasLiveContinuation: true })).toBe("observe_only");
  });

  it("keeps the watchdog observational", () => {
    expect(deriveRecoveryDisplayState({ ...base, kind: "active_run_watchdog" })).toBe(
      "observe_only",
    );
  });

  it("still escalates a watchdog that escalated", () => {
    expect(
      deriveRecoveryDisplayState({ ...base, kind: "active_run_watchdog", status: "escalated" }),
    ).toBe("escalated");
  });

  it("treats resolved and cancelled as resolved regardless of liveness", () => {
    expect(
      deriveRecoveryDisplayState(
        { ...base, status: "resolved" },
        { ownerRun: { agentId: CTO_ID, status: "running" } },
      ),
    ).toBe("resolved");
    expect(deriveRecoveryDisplayState({ ...base, status: "cancelled" })).toBe("resolved");
    expect(deriveActiveRecoveryDisplayState({ ...base, status: "resolved" })).toBeNull();
  });
});

describe("recoveryLivenessFromIssue", () => {
  it("reads the execution lock, queued retry, and handoff projection", () => {
    expect(
      recoveryLivenessFromIssue({
        executionRunId: "run-1",
        assigneeAgentId: CTO_ID,
        scheduledRetry: { status: "scheduled_retry" },
        successfulRunHandoff: { hasLiveContinuation: true },
      }),
    ).toEqual({
      sourceHasLiveRun: true,
      sourceLiveRunAgentId: CTO_ID,
      hasQueuedWake: true,
      hasLiveContinuation: true,
    });
  });

  it("does not attribute an assignee when no run is live", () => {
    expect(
      recoveryLivenessFromIssue({ executionRunId: null, assigneeAgentId: CTO_ID }),
    ).toMatchObject({ sourceHasLiveRun: false, sourceLiveRunAgentId: null });
  });

  it("ignores a cancelled scheduled retry", () => {
    expect(
      recoveryLivenessFromIssue({ scheduledRetry: { status: "cancelled" } }),
    ).toMatchObject({ hasQueuedWake: false });
  });

  it("lets explicit signals override the issue-derived ones", () => {
    expect(
      recoveryLivenessFromIssue(
        { executionRunId: null },
        { sourceHasLiveRun: true, sourceLiveRunAgentId: CODER_ID },
      ),
    ).toMatchObject({ sourceHasLiveRun: true, sourceLiveRunAgentId: CODER_ID });
  });

  it("tolerates a missing issue", () => {
    expect(recoveryLivenessFromIssue(null)).toMatchObject({ sourceHasLiveRun: false });
  });
});

describe("deriveRecoveryPresentation", () => {
  it("returns null without an action", () => {
    expect(deriveRecoveryPresentation({ action: null })).toBeNull();
  });

  it("names the live recovery owner from the run list", () => {
    expect(
      deriveRecoveryPresentation({
        action: base,
        liveRuns: [{ agentId: CTO_ID, agentName: "CTO", status: "running" }],
      }),
    ).toEqual({ state: "in_progress", ownerName: "CTO", recessed: true });
  });

  it("falls back to the agent map for the owner name", () => {
    expect(
      deriveRecoveryPresentation({
        action: base,
        scheduledRetry: { status: "queued" },
        resolveAgentName: (agentId) => (agentId === CTO_ID ? "CTO" : null),
      }),
    ).toEqual({ state: "in_progress", ownerName: "CTO", recessed: true });
  });

  it("counts a live-issue id as source liveness", () => {
    expect(
      deriveRecoveryPresentation({
        action: base,
        issueId: "issue-1",
        liveIssueIds: new Set(["issue-1"]),
        issueAssigneeAgentId: CODER_ID,
      }),
    ).toMatchObject({ state: "observe_only", recessed: true });
  });

  it("keeps an ownerless action prominent", () => {
    expect(
      deriveRecoveryPresentation({ action: { ...base, ownerAgentId: null } }),
    ).toEqual({ state: "needed", ownerName: null, recessed: false });
  });

  it("ignores terminal runs in the live list", () => {
    expect(
      deriveRecoveryPresentation({
        action: base,
        liveRuns: [{ agentId: CTO_ID, agentName: "CTO", status: "completed" }],
      }),
    ).toMatchObject({ state: "needed", recessed: false });
  });
});
