import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  IssueBlockedInboxAttention,
  IssueBlockerDiagnosticsResponse,
  IssueRecoveryAction,
  IssueScheduledRetry,
} from "@paperclipai/shared";
import { IssueNextActionCard } from "@/components/IssueNextActionCard";

/**
 * The consolidated "what moves this forward next" surface.
 * Each story exercises one branch of the next-action derivation so the board
 * always sees a single readable answer instead of recovery churn.
 */
const meta: Meta<typeof IssueNextActionCard> = {
  title: "Product/Next Action",
  component: IssueNextActionCard,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof IssueNextActionCard>;

function inboxAttention(
  overrides: Partial<IssueBlockedInboxAttention> = {},
): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: "blocked_chain_stalled",
    severity: "high",
    stoppedSinceAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    owner: { type: "agent", agentId: "qa-1", userId: null, label: "QA" },
    action: {
      label: "finish the QA verification",
      detail: "Resolve PAP-12921 or remove it as a blocker.",
    },
    sourceIssue: {
      id: "src-1",
      identifier: "PAP-12915",
      title: "Release verify parallel plan",
      status: "blocked",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: null,
    },
    leafIssue: {
      id: "leaf-1",
      identifier: "PAP-12921",
      title: "QA release verification",
      status: "blocked",
      priority: "high",
      assigneeAgentId: "qa-1",
      assigneeUserId: null,
    },
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

function terminalGateDiagnostics(
  flag: IssueBlockerDiagnosticsResponse["blockers"][number]["flags"][number],
): IssueBlockerDiagnosticsResponse {
  return {
    issue: {
      id: "src-1",
      identifier: "PAP-12915",
      title: "Release verify parallel plan",
      status: "blocked",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: null,
    },
    diagnosis: "A done child still gates this task through its workspace finalize step.",
    readiness: {
      allBlockersDone: true,
      isDependencyReady: false,
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerCount: 1,
    },
    blockers: [
      {
        id: "b1",
        identifier: "PAP-12920",
        title: "Release verify child",
        status: "done",
        priority: "high",
        assigneeAgentId: null,
        assigneeUserId: null,
        isUnresolved: false,
        isDependencyReady: false,
        isPendingFinalize: flag === "workspace_finalize_pending",
        flags: [flag],
      },
    ],
    omittedUnauthorizedBlockerCount: 0,
    truncated: false,
    caps: { maxBlockers: 50 },
  };
}

const recoveryAction: IssueRecoveryAction = {
  id: "rec-1",
  companyId: "c1",
  sourceIssueId: "src-1",
  recoveryIssueId: "rec-issue-1",
  kind: "workspace_validation",
  status: "active",
  ownerType: "agent",
  ownerAgentId: "coder-1",
  ownerUserId: null,
  previousOwnerAgentId: null,
  returnOwnerAgentId: null,
  cause: "workspace_divergence",
  fingerprint: "fp-1",
  evidence: {},
  nextAction: "Reissue this task in a clean isolated workspace, then re-run the release check.",
  wakePolicy: null,
  monitorPolicy: null,
  attemptCount: 1,
  maxAttempts: 3,
  timeoutAt: null,
  lastAttemptAt: null,
  outcome: null,
  resolutionNote: null,
  resolvedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const scheduledRetry: IssueScheduledRetry = {
  runId: "run-1",
  status: "scheduled_retry",
  agentId: "coder-1",
  agentName: "ClaudeCoder",
  retryOfRunId: "run-0",
  scheduledRetryAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  scheduledRetryAttempt: 2,
  scheduledRetryReason: "Cheap recovery handed back to a normal worker lane.",
  retryExhaustedReason: null,
  error: null,
  errorCode: null,
};

/** A blocked tree whose real leaf is a stalled QA review. */
export const BlockedTree: Story = {
  args: {
    status: "blocked",
    blockedInboxAttention: inboxAttention(),
  },
};

/** Terminal gate: a done child still blocks via its workspace finalize step. */
export const BlockedTreeTerminalGate: Story = {
  args: {
    status: "blocked",
    blockedInboxAttention: inboxAttention({
      reason: "blocked_chain_stalled",
      action: {
        label: "Recover the workspace finalize gate",
        detail: "PAP-12920 is done but its finalize step still blocks this task.",
      },
    }),
    blockerDiagnostics: terminalGateDiagnostics("workspace_finalize_pending"),
  },
};

/** Recovery lane: an active recovery action owns the next step. */
export const RecoveryLane: Story = {
  args: {
    status: "in_progress",
    activeRecoveryAction: recoveryAction,
  },
};

/** Recovery lane handed a corrective run back to a normal worker lane. */
export const RecoveryLaneScheduledRun: Story = {
  args: {
    status: "in_progress",
    scheduledRetry,
  },
};

/** A finished run left the task open with no disposition. */
export const NeedsDisposition: Story = {
  args: {
    status: "in_progress",
    successfulRunHandoff: {
      state: "required",
      required: true,
      hasLiveContinuation: false,
      sourceRunId: "run-x",
      correctiveRunId: null,
      assigneeAgentId: "coder-1",
      detectedProgressSummary: "Committed the fix but never marked the task done.",
      createdAt: null,
    },
  },
};

/** Waiting on a board decision. */
export const AwaitingDecision: Story = {
  args: {
    status: "in_review",
    blockedInboxAttention: inboxAttention({
      reason: "pending_board_decision",
      state: "awaiting_decision",
      severity: "medium",
      owner: { type: "board", agentId: null, userId: null, label: "Board" },
      action: { label: "Accept or reject the plan", detail: null },
      leafIssue: null,
      sourceIssue: null,
    }),
  },
};

/** Blocker diagnostics failed to load — the failure is surfaced, not hidden. */
export const DiagnosticsError: Story = {
  args: {
    status: "blocked",
    blockedInboxAttention: inboxAttention(),
    diagnosticsError: "Request failed (500)",
  },
};
