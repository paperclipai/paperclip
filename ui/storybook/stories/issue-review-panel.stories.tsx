import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AttentionItem, IssueReviewAttention, IssueReviewAttentionPath } from "@paperclipai/shared";
import { IssueReviewPanel, type ReviewPanelIssue } from "@/components/IssueReviewPanel";
import { AttentionQueueRow } from "@/components/AttentionQueueRow";

// PAP-16080 §4.4 — the review panel that pins above an `in_review` thread and
// the same three verbs inline on the /decisions card. These stories are the
// design/QA reference for the covered, stalled, and post-action states in both
// light and dark themes.

function path(overrides: Partial<IssueReviewAttentionPath> & Pick<IssueReviewAttentionPath, "kind" | "label">): IssueReviewAttentionPath {
  return {
    responder: null,
    since: "2026-08-02T00:30:00.000Z",
    ref: null,
    ...overrides,
  };
}

function issue(reviewAttention: IssueReviewAttention): ReviewPanelIssue {
  return { id: "issue-1", companyId: "company-1", status: "in_review", reviewAttention };
}

function Frame({
  label,
  children,
  width = 680,
}: {
  label: string;
  children: React.ReactNode;
  /** Content width in px — narrow (390) exercises the stalled action row's base stacked layout. */
  width?: number;
}) {
  return (
    <div className="mx-auto space-y-2 p-6" style={{ maxWidth: width }}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

const meta = {
  title: "Product/Issue/Review panel",
  component: IssueReviewPanel,
  args: { issue: issue({ state: "none", paths: [], reason: null }) },
  parameters: {
    docs: {
      description: {
        component:
          "Pinned above the thread whenever an issue is `in_review`. Covered names each maintained review path (what/who/since) and what each outcome does; stalled shows the amber \"nobody is reviewing this\" notice with approve / request-changes / send-back. The same three verbs actuate inline on the /decisions card when a review goes stalled.",
      },
    },
  },
} satisfies Meta<typeof IssueReviewPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CoveredSinglePath: Story = {
  name: "Covered · one maintained path",
  render: () => (
    <Frame label="In review · a pending confirmation is waiting on the board">
      <IssueReviewPanel
        issue={issue({
          state: "covered",
          reason: "Review has a maintained action path.",
          paths: [
            path({
              kind: "interaction",
              label: "Pending request confirmation",
              responder: "Board",
              ref: "interaction-1",
            }),
          ],
        })}
      />
    </Frame>
  ),
};

export const CoveredMultiplePaths: Story = {
  name: "Covered · reviewer + monitor",
  render: () => (
    <Frame label="In review · a named human reviewer plus a scheduled monitor">
      <IssueReviewPanel
        issue={issue({
          state: "covered",
          reason: "Review has 2 maintained action paths.",
          paths: [
            path({ kind: "human_reviewer", label: "Human reviewer", responder: "Dotta" }),
            path({
              kind: "monitor",
              label: "Scheduled review monitor",
              responder: null,
              since: "2026-08-02T00:10:00.000Z",
            }),
          ],
        })}
      />
    </Frame>
  ),
};

export const Stalled: Story = {
  name: "Stalled · nobody is reviewing this",
  render: () => (
    <Frame label="In review · no reviewer, interaction, approval, or monitor exists">
      <IssueReviewPanel
        issue={issue({
          state: "stalled",
          paths: [],
          reason:
            "Issue is in review without a maintained reviewer, interaction, approval, monitor, run, wake, or recovery path.",
        })}
      />
    </Frame>
  ),
};

export const StalledNarrow: Story = {
  name: "Stalled · 390px phone (action row stacks)",
  render: () => (
    <Frame width={390} label="In review · phone width — the three verbs stack, never overlap">
      <IssueReviewPanel
        issue={issue({
          state: "stalled",
          paths: [],
          reason:
            "Issue is in review without a maintained reviewer, interaction, approval, monitor, run, wake, or recovery path.",
        })}
      />
    </Frame>
  ),
};

const stalledReviewRow: AttentionItem = {
  id: "review:issue-1",
  companyId: "company-1",
  sourceKind: "review",
  subject: {
    kind: "issue",
    id: "issue-1",
    companyId: "company-1",
    title: "Ship the onboarding redesign",
    identifier: "PAP-4242",
    status: "in_review",
    href: "/PAP/issues/PAP-4242",
    metadata: { reviewAttentionState: "stalled" },
  },
  whyNow:
    "Issue is in review without a maintained reviewer, interaction, approval, monitor, run, wake, or recovery path.",
  decisionVerbs: [
    { id: "choose_review_path", label: "Choose review path", description: "Add a reviewer or waiting path, return the issue to work, or accept it." },
    { id: "request_changes", label: "Request changes", description: "Return the issue to the assignee with changes requested." },
  ],
  inlineResolvable: true,
  entryRule: "",
  exitRule: "",
  dedupKey: "review:issue-1",
  dismissalKey: "attention:review:issue-1",
  severity: "high",
  rank: 0,
  activityAt: "2026-08-02T00:30:00.000Z",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:30:00.000Z",
  relatedIssue: null,
  project: null,
  workspace: null,
  detail: null,
  dismissal: null,
  expiresAt: null,
  ruleKey: null,
  originAgentName: null,
  queues: [],
  shelf: false,
  retentionDays: 30,
  keep: false,
  archivedAt: null,
  retentionVersion: 1,
  decideBy: null,
  decideByAttribution: null,
  snoozedUntil: null,
  trainingExampleId: null,
};

export const DecisionsCardInline: Story = {
  name: "Decisions card · stalled review resolves in-row",
  render: () => {
    const [expanded, setExpanded] = useState(true);
    return (
      <Frame label="/decisions · a stalled review actuates the three verbs inline">
        <AttentionQueueRow
          item={stalledReviewRow}
          companyId="company-1"
          expanded={expanded}
          onToggleExpand={() => setExpanded((prev) => !prev)}
          onDismiss={() => {}}
        />
      </Frame>
    );
  },
};

export const DecisionsCardInlineNarrow: Story = {
  name: "Decisions card · 390px phone (verbs stack in-row)",
  render: () => {
    const [expanded, setExpanded] = useState(true);
    return (
      <Frame width={390} label="/decisions · phone width — the inline verbs stack, never overlap">
        <AttentionQueueRow
          item={stalledReviewRow}
          companyId="company-1"
          expanded={expanded}
          onToggleExpand={() => setExpanded((prev) => !prev)}
          onDismiss={() => {}}
        />
      </Frame>
    );
  },
};
