import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CheckCircle2, Inbox } from "lucide-react";
import type { AttentionItem, AttentionSourceKind, AttentionSeverity } from "@paperclipai/shared";
import { AttentionQueueRow } from "@/components/AttentionQueueRow";

const companyId = "company-storybook";

function item(
  id: string,
  sourceKind: AttentionSourceKind,
  severity: AttentionSeverity,
  title: string,
  whyNow: string,
  overrides: Partial<AttentionItem> = {},
): AttentionItem {
  const now = new Date("2026-07-09T12:00:00Z");
  return {
    id,
    companyId,
    sourceKind,
    subject: {
      kind: "issue",
      id: `${id}-subject`,
      companyId,
      title,
      identifier: null,
      status: "pending",
      href: "/PAP/issues/PAP-1000",
      metadata: {},
    },
    whyNow,
    decisionVerbs: [
      { id: "approve", label: "Approve", description: null },
      { id: "reject", label: "Reject", description: null },
    ],
    inlineResolvable: false,
    entryRule: "",
    exitRule: "",
    dedupKey: `${id}-dedup`,
    dismissalKey: `attention:${id}-dedup`,
    severity,
    rank: 0,
    activityAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    relatedIssue: {
      kind: "issue",
      id: "issue-1000",
      companyId,
      title: "Ship the attention queue",
      identifier: "PAP-1000",
      status: "in_progress",
      href: "/PAP/issues/PAP-1000",
      metadata: {},
    },
    ...overrides,
  };
}

const POPULATED: AttentionItem[] = [
  item(
    "recov-1",
    "recovery_action",
    "critical",
    "Run watchdog escalated — agent stalled 40m",
    "Recovery action escalated and needs a human decision.",
    { subject: { kind: "recovery_action", id: "r1", companyId, title: "Run watchdog escalated — agent stalled 40m", identifier: null, status: "escalated", href: "/PAP/issues/PAP-1000", metadata: {} } },
  ),
  item(
    "appr-1",
    "approval",
    "high",
    "Hire agent: Research Analyst",
    "Approval is pending a board decision.",
    {
      inlineResolvable: true,
      subject: { kind: "approval", id: "approval-1", companyId, title: "Hire agent: Research Analyst", identifier: null, status: "pending", href: "/PAP/approvals/approval-1", metadata: { type: "hire_agent" } },
      relatedIssue: null,
      decisionVerbs: [
        { id: "approve", label: "Approve", description: null },
        { id: "reject", label: "Reject", description: null },
        { id: "request_revision", label: "Request revision", description: null },
      ],
    },
  ),
  item(
    "intx-1",
    "issue_thread_interaction",
    "medium",
    "Which rollout order should we use?",
    "Questions need answers on an issue thread.",
    {
      inlineResolvable: true,
      subject: { kind: "interaction", id: "interaction-1", companyId, title: "Which rollout order should we use?", identifier: null, status: "pending", href: "/PAP/issues/PAP-1000#interaction-1", metadata: { kind: "ask_user_questions", issueId: "issue-1000" } },
      decisionVerbs: [{ id: "respond", label: "Respond", description: null }],
    },
  ),
  item(
    "review-1",
    "review",
    "medium",
    "PR ready for review: attention feed endpoint",
    "In-review issue is waiting on a human reviewer.",
    {
      inlineResolvable: false,
      decisionVerbs: [
        { id: "approve", label: "Approve", description: null },
        { id: "request_changes", label: "Request changes", description: null },
      ],
    },
  ),
  item(
    "join-1",
    "join_request",
    "medium",
    "alex@acme.dev wants to join",
    "Join request is pending approval.",
    {
      inlineResolvable: true,
      subject: { kind: "join_request", id: "join-1", companyId, title: "alex@acme.dev wants to join", identifier: null, status: "pending_approval", href: "/PAP/settings/access", metadata: {} },
      relatedIssue: null,
    },
  ),
  item(
    "fail-1",
    "failed_run",
    "high",
    "Deploy pipeline failed after 3 retries",
    "Retries are exhausted; a human action is needed.",
    { relatedIssue: null, inlineResolvable: false },
  ),
  item(
    "budget-1",
    "budget_alert",
    "low",
    "Company budget crossed 85%",
    "Budget crossed the 85% threshold.",
    { relatedIssue: null, inlineResolvable: false },
  ),
];

function Queue({ items }: { items: AttentionItem[] }) {
  const firstInline = items.find((i) => i.inlineResolvable && (i.sourceKind === "approval" || i.sourceKind === "join_request"));
  const [expandedId, setExpandedId] = useState<string | null>(firstInline?.id ?? null);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const visible = items.filter((i) => !cleared.has(i.id));

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">What needs me</h1>
        {visible.length > 0 && (
          <span className="text-sm text-muted-foreground">
            {visible.length} {visible.length === 1 ? "decision" : "decisions"}
          </span>
        )}
      </div>
      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20 text-center">
          <div className="mb-4 rounded-full bg-green-500/10 p-4">
            <CheckCircle2 className="h-10 w-10 text-green-500" />
          </div>
          <p className="text-lg font-semibold text-foreground">You're all caught up</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Inbox className="h-4 w-4" />
            Nothing needs a decision from you right now.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((it) => (
            <AttentionQueueRow
              key={it.id}
              item={it}
              companyId={companyId}
              expanded={expandedId === it.id}
              onToggleExpand={() => setExpandedId((p) => (p === it.id ? null : it.id))}
              onDismiss={(dismissed) => setCleared((prev) => new Set(prev).add(dismissed.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const meta: Meta<typeof Queue> = {
  title: "Pages/What needs me",
  component: Queue,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof Queue>;

export const Populated: Story = {
  args: { items: POPULATED },
};

export const ZeroState: Story = {
  args: { items: [] },
};
