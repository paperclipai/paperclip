import { describe, expect, it } from "vitest";
import {
  ISSUE_EXECUTION_HEALTH_REASON_CODES,
  ISSUE_EXECUTION_HEALTH_STATES,
  type IssueExecutionHealthReasonCode,
  type IssueExecutionHealthState,
} from "@paperclipai/shared";
import {
  classifyIssueExecutionHealth,
  ISSUE_EXECUTION_HEALTH_CRITICAL_THRESHOLD_MS,
  ISSUE_EXECUTION_HEALTH_SUSPICION_THRESHOLD_MS,
  type IssueExecutionHealthClassifyInput,
  type IssueExecutionHealthIssueInput,
  type IssueExecutionHealthRunInput,
} from "../services/issue-execution-health.ts";

const NOW = new Date("2026-04-27T15:00:00.000Z");

function issue(overrides: Partial<IssueExecutionHealthIssueInput> = {}): IssueExecutionHealthIssueInput {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-1",
    title: "Sample issue",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    executionRunId: null,
    executionPolicy: null,
    executionState: null,
    ...overrides,
  };
}

function run(overrides: Partial<IssueExecutionHealthRunInput> = {}): IssueExecutionHealthRunInput {
  return {
    id: "run-1",
    status: "running",
    livenessState: null,
    livenessReason: null,
    lastOutputAt: new Date(NOW.getTime() - 5_000),
    processStartedAt: new Date(NOW.getTime() - 10_000),
    startedAt: new Date(NOW.getTime() - 10_000),
    createdAt: new Date(NOW.getTime() - 10_000),
    silenceSnoozedUntil: null,
    ...overrides,
  };
}

function classifyInput(overrides: Partial<IssueExecutionHealthClassifyInput> = {}): IssueExecutionHealthClassifyInput {
  return {
    issue: overrides.issue ?? issue(),
    activeRun: overrides.activeRun ?? null,
    queuedWakes: overrides.queuedWakes ?? [],
    pendingInteractions: overrides.pendingInteractions ?? [],
    pendingApprovals: overrides.pendingApprovals ?? [],
    openRecoveryIssues: overrides.openRecoveryIssues ?? [],
    blockers: overrides.blockers ?? [],
    assigneeAgentStatus: overrides.assigneeAgentStatus ?? "active",
    now: overrides.now ?? NOW,
  };
}

describe("classifyIssueExecutionHealth", () => {
  type TableCase = {
    name: string;
    input: IssueExecutionHealthClassifyInput;
    state: IssueExecutionHealthState;
    reasonCode: IssueExecutionHealthReasonCode;
    nextActionOwner?: string;
  };

  const cases: TableCase[] = [
    {
      name: "active run reports live_run / active_execution_run",
      input: classifyInput({ activeRun: run() }),
      state: "live_run",
      reasonCode: "active_execution_run",
      nextActionOwner: "assignee_agent",
    },
    {
      name: "active run silent past critical threshold reports watchdog_review",
      input: classifyInput({
        activeRun: run({
          lastOutputAt: new Date(NOW.getTime() - ISSUE_EXECUTION_HEALTH_CRITICAL_THRESHOLD_MS - 60_000),
          processStartedAt: new Date(NOW.getTime() - ISSUE_EXECUTION_HEALTH_CRITICAL_THRESHOLD_MS - 60_000),
        }),
      }),
      state: "watchdog_review",
      reasonCode: "silent_active_run_under_watchdog",
      nextActionOwner: "system",
    },
    {
      name: "active run silent past suspicion threshold but not critical stays live_run with suspicious silence level",
      input: classifyInput({
        activeRun: run({
          lastOutputAt: new Date(NOW.getTime() - ISSUE_EXECUTION_HEALTH_SUSPICION_THRESHOLD_MS - 60_000),
          processStartedAt: new Date(NOW.getTime() - ISSUE_EXECUTION_HEALTH_SUSPICION_THRESHOLD_MS - 60_000),
        }),
      }),
      state: "live_run",
      reasonCode: "active_execution_run",
    },
    {
      name: "active run with active snooze ignores silence level",
      input: classifyInput({
        activeRun: run({
          lastOutputAt: new Date(NOW.getTime() - ISSUE_EXECUTION_HEALTH_CRITICAL_THRESHOLD_MS - 60_000),
          processStartedAt: new Date(NOW.getTime() - ISSUE_EXECUTION_HEALTH_CRITICAL_THRESHOLD_MS - 60_000),
          silenceSnoozedUntil: new Date(NOW.getTime() + 60_000),
        }),
      }),
      state: "live_run",
      reasonCode: "active_execution_run",
    },
    {
      name: "open recovery issue reports recovering",
      input: classifyInput({
        openRecoveryIssues: [{ id: "recovery-1", identifier: "PAP-99", originKind: "harness_liveness_escalation", status: "todo" }],
      }),
      state: "recovering",
      reasonCode: "open_recovery_issue",
      nextActionOwner: "recovery_owner",
    },
    {
      name: "pending request_confirmation interaction reports awaiting_interaction",
      input: classifyInput({
        pendingInteractions: [{ id: "interaction-1", kind: "request_confirmation", status: "pending" }],
      }),
      state: "awaiting_interaction",
      reasonCode: "pending_issue_thread_interaction",
      nextActionOwner: "assignee_user",
    },
    {
      name: "pending linked approval reports awaiting_approval",
      input: classifyInput({
        pendingApprovals: [{ id: "approval-1", status: "pending" }],
      }),
      state: "awaiting_approval",
      reasonCode: "pending_linked_approval",
      nextActionOwner: "system",
    },
    {
      name: "in_review with execution-policy agent participant reports awaiting_review_participant",
      input: classifyInput({
        issue: issue({
          status: "in_review",
          executionState: { currentParticipant: { type: "agent", agentId: "agent-2" } },
        }),
      }),
      state: "awaiting_review_participant",
      reasonCode: "execution_policy_participant_owns_next_action",
      nextActionOwner: "review_participant",
    },
    {
      name: "in_review with human assignee reports awaiting_user",
      input: classifyInput({
        issue: issue({ status: "in_review", assigneeAgentId: null, assigneeUserId: "user-1" }),
      }),
      state: "awaiting_user",
      reasonCode: "human_assignee_owns_next_action",
      nextActionOwner: "assignee_user",
    },
    {
      name: "in_review with agent assignee but no participant or user reports invalid_state",
      input: classifyInput({
        issue: issue({ status: "in_review" }),
      }),
      state: "invalid_state",
      reasonCode: "in_review_without_action_path",
      nextActionOwner: "none",
    },
    {
      name: "human assignee owns next action when not in review",
      input: classifyInput({
        issue: issue({ assigneeAgentId: null, assigneeUserId: "user-1" }),
      }),
      state: "awaiting_user",
      reasonCode: "human_assignee_owns_next_action",
      nextActionOwner: "assignee_user",
    },
    {
      name: "blocked issue with active blocker leaf reports blocked_waiting",
      input: classifyInput({
        issue: issue({ status: "blocked" }),
        blockers: [
          {
            id: "blocker-1",
            identifier: "PAP-2",
            status: "in_progress",
            assigneeAgentId: "agent-2",
            assigneeAgentStatus: "active",
            assigneeUserId: null,
          },
        ],
      }),
      state: "blocked_waiting",
      reasonCode: "unresolved_blocker_chain_covered",
      nextActionOwner: "blocker_owner",
    },
    {
      name: "blocked issue with cancelled blocker reports invalid_state / blocked_by_cancelled_issue",
      input: classifyInput({
        issue: issue({ status: "blocked" }),
        blockers: [
          {
            id: "blocker-2",
            identifier: "PAP-3",
            status: "cancelled",
            assigneeAgentId: null,
            assigneeAgentStatus: null,
            assigneeUserId: null,
          },
        ],
      }),
      state: "invalid_state",
      reasonCode: "blocked_by_cancelled_issue",
    },
    {
      name: "blocked issue with unassigned blocker reports invalid_state / blocked_by_unassigned_issue",
      input: classifyInput({
        issue: issue({ status: "blocked" }),
        blockers: [
          {
            id: "blocker-3",
            identifier: "PAP-4",
            status: "todo",
            assigneeAgentId: null,
            assigneeAgentStatus: null,
            assigneeUserId: null,
          },
        ],
      }),
      state: "invalid_state",
      reasonCode: "blocked_by_unassigned_issue",
    },
    {
      name: "blocked issue with uninvokable blocker assignee reports invalid_state / agent_uninvokable",
      input: classifyInput({
        issue: issue({ status: "blocked" }),
        blockers: [
          {
            id: "blocker-4",
            identifier: "PAP-5",
            status: "todo",
            assigneeAgentId: "agent-paused",
            assigneeAgentStatus: "paused",
            assigneeUserId: null,
          },
        ],
      }),
      state: "invalid_state",
      reasonCode: "agent_uninvokable",
    },
    {
      name: "blocked issue with no unresolved blockers reports invalid_state",
      input: classifyInput({
        issue: issue({ status: "blocked" }),
        blockers: [
          {
            id: "blocker-5",
            identifier: "PAP-6",
            status: "done",
            assigneeAgentId: "agent-2",
            assigneeAgentStatus: "active",
            assigneeUserId: null,
          },
        ],
      }),
      state: "invalid_state",
      reasonCode: "blocked_by_unassigned_issue",
    },
    {
      name: "queued wake reports queued_wake",
      input: classifyInput({
        queuedWakes: [{ id: "wake-1", reason: "issue_assigned", status: "queued" }],
      }),
      state: "queued_wake",
      reasonCode: "queued_assignment_or_continuation",
      nextActionOwner: "assignee_agent",
    },
    {
      name: "agent-assigned todo with no live run / wake / recovery reports no_action_path / assigned_todo_without_dispatch_path",
      input: classifyInput({
        issue: issue({ status: "todo" }),
      }),
      state: "no_action_path",
      reasonCode: "assigned_todo_without_dispatch_path",
    },
    {
      name: "agent-assigned in_progress with no live run / wake / recovery reports no_action_path / assigned_in_progress_without_execution_path",
      input: classifyInput({}),
      state: "no_action_path",
      reasonCode: "assigned_in_progress_without_execution_path",
    },
    {
      name: "agent-assigned in_progress with paused agent reports invalid_state / agent_uninvokable",
      input: classifyInput({ assigneeAgentStatus: "paused" }),
      state: "invalid_state",
      reasonCode: "agent_uninvokable",
    },
    {
      name: "completed issue reports no_action_path / issue_terminal",
      input: classifyInput({ issue: issue({ status: "done" }) }),
      state: "no_action_path",
      reasonCode: "issue_terminal",
      nextActionOwner: "none",
    },
    {
      name: "cancelled issue reports no_action_path / issue_terminal",
      input: classifyInput({ issue: issue({ status: "cancelled" }) }),
      state: "no_action_path",
      reasonCode: "issue_terminal",
      nextActionOwner: "none",
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const result = classifyIssueExecutionHealth(tc.input);
      expect(result.state).toBe(tc.state);
      expect(result.reasonCode).toBe(tc.reasonCode);
      if (tc.nextActionOwner !== undefined) {
        expect(result.nextActionOwner).toBe(tc.nextActionOwner);
      }
      expect(result.evaluatedAt).toBe((tc.input.now ?? NOW).toISOString());
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    });
  }

  it("active run takes precedence over queued wakes, interactions, and approvals", () => {
    const result = classifyIssueExecutionHealth(
      classifyInput({
        activeRun: run(),
        queuedWakes: [{ id: "wake-1", reason: null, status: "queued" }],
        pendingInteractions: [{ id: "interaction-1", kind: "ask_user_questions", status: "pending" }],
        pendingApprovals: [{ id: "approval-1", status: "pending" }],
      }),
    );
    expect(result.state).toBe("live_run");
    expect(result.evidence.activeRun?.runId).toBe("run-1");
  });

  it("recovery issue takes precedence over interactions and approvals", () => {
    const result = classifyIssueExecutionHealth(
      classifyInput({
        openRecoveryIssues: [
          { id: "recovery-1", identifier: "PAP-90", originKind: "harness_liveness_escalation", status: "todo" },
        ],
        pendingInteractions: [{ id: "interaction-1", kind: "ask_user_questions", status: "pending" }],
        pendingApprovals: [{ id: "approval-1", status: "pending" }],
      }),
    );
    expect(result.state).toBe("recovering");
    expect(result.evidence.recoveryIssue?.recoveryIssueId).toBe("recovery-1");
  });

  it("interaction takes precedence over approval", () => {
    const result = classifyIssueExecutionHealth(
      classifyInput({
        pendingInteractions: [{ id: "interaction-1", kind: "request_confirmation", status: "pending" }],
        pendingApprovals: [{ id: "approval-1", status: "pending" }],
      }),
    );
    expect(result.state).toBe("awaiting_interaction");
    expect(result.evidence.pendingInteraction?.interactionId).toBe("interaction-1");
  });

  it("emits a stable summary with evaluatedAt set from now", () => {
    const result = classifyIssueExecutionHealth(classifyInput());
    expect(ISSUE_EXECUTION_HEALTH_STATES).toContain(result.state);
    expect(ISSUE_EXECUTION_HEALTH_REASON_CODES).toContain(result.reasonCode);
    expect(result.evaluatedAt).toBe(NOW.toISOString());
    expect(result.evidence).toBeDefined();
  });
});
