import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AttentionItem } from "@paperclipai/shared";
import { AttentionQueueRow } from "@/components/AttentionQueueRow";

// Stalled review actions remain available where decisions are handled. The
// issue header no longer duplicates decision or review-path summaries.

function Frame({
  label,
  children,
  width = 680,
}: {
  label: string;
  children: React.ReactNode;
  /** Content width in px — narrow (390) exercises the action row's stacked layout. */
  width?: number;
}) {
  return (
    <div className="mx-auto space-y-2 p-6" style={{ maxWidth: width }}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

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
    {
      id: "choose_review_path",
      label: "Choose review path",
      description: "Add a reviewer or waiting path, return the issue to work, or accept it.",
    },
    {
      id: "request_changes",
      label: "Request changes",
      description: "Return the issue to the assignee with changes requested.",
    },
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

const meta = {
  title: "Product/Decisions/Stalled review actions",
  component: AttentionQueueRow,
  args: {
    item: stalledReviewRow,
    companyId: "company-1",
    expanded: true,
    onToggleExpand: () => {},
    onDismiss: () => {},
  },
  parameters: {
    docs: {
      description: {
        component:
          "Stalled reviews remain actionable in the Decisions queue after removing decision summaries from the issue header.",
      },
    },
  },
} satisfies Meta<typeof AttentionQueueRow>;

export default meta;

type Story = StoryObj<typeof meta>;

export const DecisionsCardInline: Story = {
  name: "Stalled review resolves in-row",
  render: () => {
    const [expanded, setExpanded] = useState(true);
    return (
      <Frame label="Decisions · a stalled review actuates the three verbs inline">
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
  name: "390px phone (verbs stack in-row)",
  render: () => {
    const [expanded, setExpanded] = useState(true);
    return (
      <Frame width={390} label="Decisions · phone width — the inline verbs stack, never overlap">
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
