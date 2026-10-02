import type { Meta, StoryObj } from "@storybook/react-vite";
import { DecisionCard, type DecisionIssueRef } from "@/components/DecisionCard";
import type { Decision, DecisionEffectExecution } from "@/api/decisions";

// --- fixtures ---------------------------------------------------------------

const ISSUES: Record<string, DecisionIssueRef> = {
  "issue-origin": { id: "issue-origin", identifier: "PAP-123", title: "Gardener sweep", href: "/PAP/issues/PAP-123", status: "in_progress" },
  "issue-target": { id: "issue-target", identifier: "PAP-456", title: "Stale integration epic", href: "/PAP/issues/PAP-456", status: "backlog" },
  "issue-child-1": { id: "issue-child-1", identifier: "PAP-457", title: "Wire the adapter", href: "/PAP/issues/PAP-457", status: "backlog" },
  "issue-child-2": { id: "issue-child-2", identifier: "PAP-458", title: "Backfill fixtures", href: "/PAP/issues/PAP-458", status: "todo" },
  "issue-new": { id: "issue-new", identifier: "PAP-999", title: "Follow-up: document rollout", href: "/PAP/issues/PAP-999", status: "todo" },
};

const resolveIssue = (id: string): DecisionIssueRef | null => ISSUES[id] ?? null;
const cancelTreePreview = () => [ISSUES["issue-target"]!, ISSUES["issue-child-1"]!, ISSUES["issue-child-2"]!];

const originIssue = ISSUES["issue-origin"]!;

function mkDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "decision-1",
    companyId: "company-storybook",
    bundleId: null,
    originAgentId: "agent-gardener",
    originIssueId: "issue-origin",
    originRunId: "run-1",
    ruleKey: "stale-epic-sweep",
    title: "Stale epic PAP-456 hasn’t moved in 21 days",
    body: "PAP-456 and its two sub-issues have had no activity for three weeks. Cancel the tree, or keep it and I’ll snooze for another week.",
    options: [
      {
        id: "keep",
        label: "Keep it open",
        description: "Leave the epic as-is; I’ll re-check in a week.",
        style: "default",
        effects: [{ type: "comment_on_issue", targetIssueId: "issue-target", staleness: "lenient", bodyMarkdown: "Kept open by the board." }],
      },
    ],
    inputs: null,
    status: "open",
    executionStatus: null,
    chosenOptionId: null,
    inputValues: null,
    decidedByUserId: null,
    decidedAt: null,
    expiresAt: "2026-07-29T12:00:00Z",
    idempotencyKey: null,
    targetSnapshots: {
      "issue-target": { status: "backlog", assigneeAgentId: null, assigneeUserId: null, updatedAt: "2026-07-01T09:00:00Z", childCount: 2 },
    },
    continuationPolicy: "none",
    metadata: {},
    createdAt: "2026-07-22T09:00:00Z",
    updatedAt: "2026-07-22T09:00:00Z",
    ...overrides,
  };
}

const cancelTreeOption = {
  id: "cancel",
  label: "Cancel the tree",
  description: "Cancel PAP-456 and everything beneath it.",
  style: "destructive" as const,
  effects: [
    { type: "cancel_issue_tree" as const, targetIssueId: "issue-target", staleness: "strict" as const, reasonComment: "Cancelled as stale by the board." },
  ],
};

function exec(overrides: Partial<DecisionEffectExecution>): DecisionEffectExecution {
  return {
    id: `exec-${Math.round(Math.random() * 1e6)}`,
    decisionId: "decision-1",
    effectIndex: 0,
    effectType: "comment_on_issue",
    targetIssueId: "issue-target",
    status: "executed",
    result: {},
    error: null,
    activityLogId: null,
    executedAt: "2026-07-22T10:00:00Z",
    ...overrides,
  };
}

const shared = {
  resolveIssue,
  cancelTreePreview,
  originAgentName: "Gardener",
  originIssue,
};

const meta: Meta<typeof DecisionCard> = {
  title: "Decisions/DecisionCard",
  component: DecisionCard,
  render: (args) => (
    <div className="max-w-2xl p-6">
      <DecisionCard {...args} />
    </div>
  ),
};
export default meta;

type Story = StoryObj<typeof DecisionCard>;

export const Pending: Story = {
  args: {
    ...shared,
    decision: mkDecision({
      options: [
        {
          id: "cancel-soft",
          label: "Comment and snooze",
          description: "Post a nudge and re-check in a week.",
          effects: [{ type: "comment_on_issue", targetIssueId: "issue-target", staleness: "lenient", bodyMarkdown: "Nudging — still stale." }],
        },
        {
          id: "create",
          label: "Split off a follow-up",
          effects: [
            { type: "create_issue", targetIssueId: "issue-target", staleness: "lenient", draft: { title: "Follow-up: document rollout", parentId: "issue-target" } },
            { type: "update_issue_status", targetIssueId: "issue-target", staleness: "lenient", status: "done" },
          ],
        },
      ],
    }),
  },
};

export const PendingWithInput: Story = {
  args: {
    ...shared,
    decision: mkDecision({
      body: "Reassign PAP-456 to whoever should own it. Add a note for the record.",
      inputs: [{ id: "note", label: "Reassignment note", placeholder: "Why this owner?", required: true, maxLength: 500 }],
      options: [
        {
          id: "assign",
          label: "Reassign the epic",
          effects: [{ type: "assign_issue", targetIssueId: "issue-target", staleness: "lenient", comment: "Reassigned: {{input.note}}" }],
        },
      ],
    }),
  },
};

export const StaleTarget: Story = {
  args: {
    ...shared,
    targetChanged: { "issue-target": true },
    decision: mkDecision({
      options: [
        {
          id: "cancel-strict",
          label: "Cancel it (needs unchanged target)",
          effects: [{ type: "update_issue_status", targetIssueId: "issue-target", staleness: "strict", status: "cancelled" }],
        },
        {
          id: "comment-lenient",
          label: "Just comment",
          effects: [{ type: "comment_on_issue", targetIssueId: "issue-target", staleness: "lenient", bodyMarkdown: "Still worth a look." }],
        },
      ],
    }),
  },
};

export const DestructiveCancelTree: Story = {
  args: {
    ...shared,
    decision: mkDecision({ options: [cancelTreeOption] }),
  },
};

export const Decided: Story = {
  args: {
    ...shared,
    decision: mkDecision({ status: "decided", executionStatus: "succeeded", chosenOptionId: "create", decidedAt: "2026-07-22T10:00:00Z" }),
    executions: [
      exec({ effectIndex: 0, effectType: "create_issue", status: "executed", result: { issueId: "issue-new" } }),
      exec({ effectIndex: 1, effectType: "update_issue_status", status: "executed", result: { issueId: "issue-target", status: "done" } }),
    ],
  },
};

export const Partial: Story = {
  args: {
    ...shared,
    decision: mkDecision({ status: "decided", executionStatus: "partial", chosenOptionId: "create", decidedAt: "2026-07-22T10:00:00Z" }),
    executions: [
      exec({ effectIndex: 0, effectType: "comment_on_issue", status: "executed" }),
      exec({ effectIndex: 1, effectType: "update_issue_status", status: "failed", error: "deny_decision_intersection" }),
    ],
  },
};

export const Failed: Story = {
  args: {
    ...shared,
    decision: mkDecision({ status: "decided", executionStatus: "failed", chosenOptionId: "cancel", decidedAt: "2026-07-22T10:00:00Z" }),
    executions: [
      exec({ effectIndex: 0, effectType: "cancel_issue_tree", status: "skipped", error: "target_changed" }),
    ],
  },
};

export const Expired: Story = {
  args: {
    ...shared,
    decision: mkDecision({ status: "expired", metadata: { expiredReason: "ttl" }, continuationPolicy: "wake_origin_agent" }),
  },
};

export const Dismissed: Story = {
  args: {
    ...shared,
    decision: mkDecision({ status: "decided", executionStatus: "succeeded", chosenOptionId: "dismissed", decidedAt: "2026-07-22T10:00:00Z", metadata: { dismissed: true } }),
    executions: [],
  },
};
