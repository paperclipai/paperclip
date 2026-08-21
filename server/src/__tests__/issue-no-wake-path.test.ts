import { describe, expect, it } from "vitest";
import { deriveFlatMonitorStatus } from "../services/issue-execution-policy.js";
import { classifyNoWakePath, isNoWakePath, type NoWakePathIssueInput } from "../services/issue-no-wake-path.js";

/**
 * AGE-924: `GET /companies/:companyId/issues` used to omit `executionState`
 * (JSON `null`) with no cheap flat monitor-liveness signal, so any consumer
 * doing `.executionState?.monitor?.status ?? "none"` silently treated "field
 * omitted" the same as "no monitor" — a stranding sweep run reported 47 dead
 * issues when the real number was 9. These are the pure unit tests for the
 * two building blocks that fix that: the flat `monitorStatus` projection, and
 * the 4-condition "no wake path" classifier layered on top of it.
 */

describe("deriveFlatMonitorStatus", () => {
  it("is 'scheduled' whenever monitorNextCheckAt is set, regardless of trigger history", () => {
    expect(deriveFlatMonitorStatus({ monitorNextCheckAt: new Date(Date.now() + 60_000) })).toBe("scheduled");
    expect(
      deriveFlatMonitorStatus({
        monitorNextCheckAt: new Date(Date.now() + 60_000),
        monitorLastTriggeredAt: new Date(),
        monitorAttemptCount: 3,
      }),
    ).toBe("scheduled");
  });

  it("is 'triggered' once fired with nothing currently scheduled", () => {
    expect(
      deriveFlatMonitorStatus({ monitorNextCheckAt: null, monitorLastTriggeredAt: new Date(), monitorAttemptCount: 1 }),
    ).toBe("triggered");
    expect(
      deriveFlatMonitorStatus({ monitorNextCheckAt: null, monitorLastTriggeredAt: null, monitorAttemptCount: 2 }),
    ).toBe("triggered");
  });

  it("is 'none' when nothing was ever scheduled or triggered (covers both never-scheduled and cleared-without-triggering)", () => {
    expect(deriveFlatMonitorStatus({ monitorNextCheckAt: null, monitorLastTriggeredAt: null, monitorAttemptCount: 0 })).toBe("none");
    expect(deriveFlatMonitorStatus({})).toBe("none");
  });

  it("never returns undefined/absent — the whole point of AGE-924 is the field is always present", () => {
    const result = deriveFlatMonitorStatus({});
    expect(result).not.toBeUndefined();
    expect(["scheduled", "triggered", "none"]).toContain(result);
  });
});

function issue(overrides: Partial<NoWakePathIssueInput>): NoWakePathIssueInput {
  return {
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    blockedByIssueIds: [],
    monitorStatus: "none",
    hasActiveRun: false,
    assigneeAgentStatus: null,
    ...overrides,
  };
}

describe("classifyNoWakePath", () => {
  it("condition 1: blocked with no unresolved blockers and no live monitor has no wake path", () => {
    expect(classifyNoWakePath(issue({ status: "blocked", blockedByIssueIds: [] }))).toBe(
      "blocked_no_blockers_no_monitor",
    );
  });

  it("condition 1 does not fire when blocked issue has an unresolved blocker", () => {
    expect(classifyNoWakePath(issue({ status: "blocked", blockedByIssueIds: ["blocker-1"] }))).toBeNull();
  });

  it("condition 1 does not fire when blocked issue has a live scheduled monitor", () => {
    expect(
      classifyNoWakePath(issue({ status: "blocked", blockedByIssueIds: [], monitorStatus: "scheduled" })),
    ).toBeNull();
  });

  it("condition 2: in_review with a spent monitor (none) and no unresolved blocker has no wake path", () => {
    expect(
      classifyNoWakePath(issue({ status: "in_review", monitorStatus: "none", blockedByIssueIds: [] })),
    ).toBe("in_review_spent_monitor_no_blocker");
  });

  it("condition 2: 'triggered' is treated the same as 'none' — it is a spent state, not a live wait", () => {
    expect(
      classifyNoWakePath(issue({ status: "in_review", monitorStatus: "triggered", blockedByIssueIds: [] })),
    ).toBe("in_review_spent_monitor_no_blocker");
  });

  it("condition 2 does not fire when the monitor is live scheduled", () => {
    expect(
      classifyNoWakePath(issue({ status: "in_review", monitorStatus: "scheduled", blockedByIssueIds: [] })),
    ).toBeNull();
  });

  it("condition 2 does not fire when there is an unresolved blocker even with a spent monitor", () => {
    expect(
      classifyNoWakePath(issue({ status: "in_review", monitorStatus: "none", blockedByIssueIds: ["blocker-1"] })),
    ).toBeNull();
  });

  it("condition 3: todo with no assignee at all has no wake path", () => {
    expect(classifyNoWakePath(issue({ status: "todo", assigneeAgentId: null, assigneeUserId: null }))).toBe(
      "todo_unassigned",
    );
  });

  it("condition 3 does not fire once an agent or user is assigned", () => {
    expect(classifyNoWakePath(issue({ status: "todo", assigneeAgentId: "agent-1" }))).toBeNull();
    expect(classifyNoWakePath(issue({ status: "todo", assigneeUserId: "user-1" }))).toBeNull();
  });

  it("condition 4: an agent assignee whose own status is 'running' but with no active run bound to this issue is saturated elsewhere", () => {
    expect(
      classifyNoWakePath(
        issue({ status: "in_progress", assigneeAgentId: "agent-1", assigneeAgentStatus: "running", hasActiveRun: false }),
      ),
    ).toBe("assignee_saturated");
  });

  it("condition 4 does not fire when the active run is bound to this same issue", () => {
    expect(
      classifyNoWakePath(
        issue({ status: "in_progress", assigneeAgentId: "agent-1", assigneeAgentStatus: "running", hasActiveRun: true }),
      ),
    ).toBeNull();
  });

  it("condition 4 does not fire when the assignee agent is idle (not running anything)", () => {
    expect(
      classifyNoWakePath(
        issue({ status: "in_progress", assigneeAgentId: "agent-1", assigneeAgentStatus: "idle", hasActiveRun: false }),
      ),
    ).toBeNull();
  });

  it("a healthy in_review issue with a live monitor is not a no-wake-path issue", () => {
    expect(
      isNoWakePath(
        issue({
          status: "in_review",
          monitorStatus: "scheduled",
          assigneeAgentId: "agent-1",
          assigneeAgentStatus: "running",
          hasActiveRun: true,
        }),
      ),
    ).toBe(false);
  });

  it("done/cancelled issues are never classified as no-wake-path (the question is moot)", () => {
    expect(classifyNoWakePath(issue({ status: "done" }))).toBeNull();
    expect(classifyNoWakePath(issue({ status: "cancelled" }))).toBeNull();
  });
});
