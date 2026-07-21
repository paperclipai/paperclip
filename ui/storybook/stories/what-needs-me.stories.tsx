import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowUpDown, CheckCircle2, Inbox, Layers, ListFilter } from "lucide-react";
import type { AttentionItem, AttentionSourceKind, AttentionSeverity, InboxDismissalKind } from "@paperclipai/shared";
import { AttentionQueueRow } from "@/components/AttentionQueueRow";
import { IssueGroupHeader } from "@/components/IssueGroupHeader";
import { ToastProvider, useToastActions } from "@/context/ToastContext";
import { ToastViewport } from "@/components/ToastViewport";
import { Button } from "@/components/ui/button";
import {
  groupAttentionItems,
  sortAttentionItems,
  type AttentionGroupBy,
  type AttentionSortOrder,
} from "@/lib/attention";

const companyId = "company-storybook";

// Base "now" resolved once at module load so date buckets are stable per render.
const NOW = Date.parse("2026-07-10T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function dismissal(kind: InboxDismissalKind, snoozedUntil: string | null): AttentionItem["dismissal"] {
  return { kind, dismissedAt: new Date(NOW - HOUR).toISOString(), snoozedUntil, isActive: true };
}

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
    project: null,
    workspace: null,
    detail: null,
    dismissal: null,
    ...overrides,
    trainingExampleId: overrides.trainingExampleId ?? null,
  };
}

/** A visible colored tile as a data URI so thumbnails render in static screenshots. */
function thumb(hex: string, label: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='88' height='88'><rect width='88' height='88' fill='${hex}'/><text x='44' y='50' font-family='sans-serif' font-size='13' fill='white' text-anchor='middle'>${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const IMAGES = [
  { assetId: thumb("#0ea5e9", "1"), alt: "screenshot 1" },
  { assetId: thumb("#8b5cf6", "2"), alt: "screenshot 2" },
  { assetId: thumb("#f43f5e", "3"), alt: "screenshot 3" },
  { assetId: thumb("#f59e0b", "4"), alt: "screenshot 4" },
];

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

// Spread activity across recent buckets + attach a couple of projects so the
// date/project group-by modes have something to show.
const ACTIVITY_OFFSETS: Record<string, number> = {
  "recov-1": NOW - 30 * 60 * 1000,
  "appr-1": NOW - 2 * HOUR,
  "intx-1": NOW - 26 * HOUR,
  "review-1": NOW - 27 * HOUR,
  "join-1": NOW - 3 * DAY,
  "fail-1": NOW - 5 * DAY,
  "budget-1": NOW - 40 * DAY,
};
const PROJECTS: Record<string, AttentionItem["project"]> = {
  "appr-1": { id: "proj-alpha", name: "Alpha", urlKey: "alpha", color: "#0f766e", icon: "rocket" },
  "intx-1": { id: "proj-alpha", name: "Alpha", urlKey: "alpha", color: "#0f766e", icon: "rocket" },
  "review-1": { id: "proj-beta", name: "Beta", urlKey: "beta", color: "#7c3aed", icon: "layers" },
};
const DETAILS: Record<string, AttentionItem["detail"]> = {
  "recov-1": { kind: "generic", summaryExcerpt: "Agent has not produced output in 40 minutes.", images: [] },
  "appr-1": { kind: "approval", approvalType: "hire_agent", summaryExcerpt: "Adds a Research Analyst to the Growth pod.", images: [] },
  "intx-1": {
    kind: "questions",
    questionCount: 2,
    firstQuestionText: "Which auth provider should we standardize on?",
    images: [IMAGES[0], IMAGES[1]],
  },
  "review-1": { kind: "generic", summaryExcerpt: "3 files changed · +212 / −41", images: [IMAGES[0], IMAGES[1], IMAGES[2], IMAGES[3]] },
  "fail-1": { kind: "failed_run", agentName: "Deployer", failureReasonExcerpt: "exit code 1 running migrate", images: [] },
  "budget-1": { kind: "budget", observedPercent: 85, amountObserved: 425, amountLimit: 500, images: [] },
};

const POPULATED_DATED: AttentionItem[] = POPULATED.map((it) => ({
  ...it,
  activityAt: new Date(ACTIVITY_OFFSETS[it.id] ?? NOW).toISOString(),
  project: PROJECTS[it.id] ?? null,
  detail: DETAILS[it.id] ?? it.detail,
}));

// A dedicated set exercising the §4 color map (a plan approval = violet next to a
// sky confirmation), §7 detail lines, §8 project chips and §10 thumbnail stacks.
const SHOWCASE: AttentionItem[] = [
  {
    ...item("plan-1", "issue_thread_interaction", "high", "Approve plan: Attention queue redesign", "A plan is awaiting your approval.", {
      inlineResolvable: true,
      subject: { kind: "interaction", id: "intx-plan", companyId, title: "Approve plan: Attention queue redesign", identifier: null, status: "pending", href: "/PAP/issues/PAP-1000#plan", metadata: { kind: "request_confirmation", issueId: "issue-1000" } },
      decisionVerbs: [
        { id: "approve", label: "Approve plan", description: null },
        { id: "request_changes", label: "Request changes", description: null },
      ],
      project: { id: "proj-alpha", name: "Alpha", urlKey: "alpha", color: "#0f766e", icon: "rocket" },
    }),
    activityAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
    detail: { kind: "plan_approval", issueTitle: "Attention home", planTitle: "Row/card redesign — 8 sections", summaryExcerpt: null, images: [IMAGES[1]] },
  },
  {
    ...item("conf-1", "approval", "medium", "Confirm: publish release notes", "A confirmation is pending.", {
      inlineResolvable: true,
      subject: { kind: "approval", id: "appr-conf", companyId, title: "Confirm: publish release notes", identifier: null, status: "pending", href: "/PAP/approvals/appr-conf", metadata: {} },
      relatedIssue: null,
      decisionVerbs: [
        { id: "approve", label: "Approve", description: null },
        { id: "reject", label: "Reject", description: null },
      ],
      project: { id: "proj-beta", name: "Beta", urlKey: "beta", color: "#7c3aed", icon: "layers" },
    }),
    activityAt: new Date(NOW - 40 * 60 * 1000).toISOString(),
    detail: { kind: "confirmation", promptExcerpt: "Ship v2026.707.0 changelog to the public page?", isPlanTarget: false, images: [] },
  },
  {
    ...item("qs-1", "issue_thread_interaction", "medium", "Answer 2 questions on rollout", "Questions need answers.", {
      inlineResolvable: true,
      subject: { kind: "interaction", id: "intx-qs", companyId, title: "Answer 2 questions on rollout", identifier: null, status: "pending", href: "/PAP/issues/PAP-1000#qs", metadata: { kind: "ask_user_questions", issueId: "issue-1000" } },
      decisionVerbs: [{ id: "respond", label: "Answer", description: null }],
      project: PROJECTS["intx-1"],
    }),
    activityAt: new Date(NOW - 90 * 60 * 1000).toISOString(),
    detail: { kind: "questions", questionCount: 2, firstQuestionText: "Which auth provider should we standardize on?", images: [IMAGES[0], IMAGES[2]] },
  },
  {
    ...item("fail-2", "failed_run", "critical", "Deploy pipeline failed after 3 retries", "Retries exhausted.", {
      inlineResolvable: false,
      relatedIssue: null,
    }),
    activityAt: new Date(NOW - 3 * HOUR).toISOString(),
    detail: { kind: "failed_run", agentName: "Deployer", failureReasonExcerpt: "exit code 1 running migrate", images: [IMAGES[3]] },
  },
  {
    ...item("budg-2", "budget_alert", "low", "Company budget crossed 85%", "Budget threshold crossed.", {
      inlineResolvable: false,
      relatedIssue: null,
    }),
    activityAt: new Date(NOW - 5 * HOUR).toISOString(),
    detail: { kind: "budget", observedPercent: 85, amountObserved: 425, amountLimit: 500, images: [] },
  },
  {
    ...item("join-2", "join_request", "medium", "alex@acme.dev wants to join", "Join request pending.", {
      inlineResolvable: true,
      subject: { kind: "join_request", id: "join-2", companyId, title: "alex@acme.dev wants to join", identifier: null, status: "pending_approval", href: "/PAP/settings/access", metadata: {} },
      relatedIssue: null,
    }),
    activityAt: new Date(NOW - 6 * HOUR).toISOString(),
  },
];

// Image variations (PAP-13544): a row with images can be expanded by clicking
// its thumbnails; when expanded it shows the first three larger plus an
// "n more" link to the issue. These rows exercise every image count boundary.
const IMAGE_ROWS: AttentionItem[] = [
  {
    ...item("img-review", "review", "medium", "PR ready for review: attention feed endpoint", "In-review issue is waiting on a human reviewer.", {
      inlineResolvable: false,
      project: { id: "proj-beta", name: "Beta", urlKey: "beta", color: "#7c3aed", icon: "layers" },
    }),
    activityAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
    detail: { kind: "generic", summaryExcerpt: "5 files changed · +212 / −41", images: [IMAGES[0], IMAGES[1], IMAGES[2], IMAGES[3], IMAGES[0]] },
  },
  {
    ...item("img-questions", "issue_thread_interaction", "medium", "Answer 2 questions on rollout", "Questions need answers.", {
      inlineResolvable: true,
      subject: { kind: "interaction", id: "intx-img", companyId, title: "Answer 2 questions on rollout", identifier: null, status: "pending", href: "/PAP/issues/PAP-1000#qs", metadata: { kind: "ask_user_questions", issueId: "issue-1000" } },
      decisionVerbs: [{ id: "respond", label: "Answer", description: null }],
      project: { id: "proj-alpha", name: "Alpha", urlKey: "alpha", color: "#0f766e", icon: "rocket" },
    }),
    activityAt: new Date(NOW - 90 * 60 * 1000).toISOString(),
    detail: { kind: "questions", questionCount: 2, firstQuestionText: "Which auth provider should we standardize on?", images: [IMAGES[0], IMAGES[2], IMAGES[3]] },
  },
  {
    ...item("img-failed", "failed_run", "high", "Deploy pipeline failed after 3 retries", "Retries exhausted.", {
      inlineResolvable: false,
      relatedIssue: null,
    }),
    activityAt: new Date(NOW - 3 * HOUR).toISOString(),
    detail: { kind: "failed_run", agentName: "Deployer", failureReasonExcerpt: "exit code 1 running migrate", images: [IMAGES[3]] },
  },
];

const SNOOZED: AttentionItem[] = [
  {
    ...item("snz-1", "review", "medium", "Design review: settings redesign", "Snoozed until this afternoon."),
    activityAt: new Date(NOW - 6 * HOUR).toISOString(),
    dismissal: dismissal("snooze", new Date(NOW + 3 * HOUR).toISOString()),
  },
  {
    ...item("snz-2", "budget_alert", "low", "Budget crossed 70%", "Snoozed until next week.", { inlineResolvable: false }),
    activityAt: new Date(NOW - 2 * DAY).toISOString(),
    dismissal: dismissal("snooze", new Date(NOW + 5 * DAY).toISOString()),
  },
];
const DISMISSED: AttentionItem[] = [
  {
    ...item("dsm-1", "agent_error_alert", "medium", "Agent error: research analyst", "Dismissed earlier today.", { inlineResolvable: false }),
    activityAt: new Date(NOW - 8 * HOUR).toISOString(),
    dismissal: dismissal("dismiss", null),
  },
];

function ToolbarButton({ icon: Icon, active }: { icon: typeof Layers; active?: boolean }) {
  return (
    <Button type="button" variant="outline" size="icon" className={active ? "h-8 w-8 shrink-0 bg-accent" : "h-8 w-8 shrink-0"}>
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}

function Queue({
  items,
  groupBy = "none",
  sortOrder = "newest",
  snoozed = [],
  dismissed = [],
  openCurtains = false,
  initialExpandedId,
}: {
  items: AttentionItem[];
  groupBy?: AttentionGroupBy;
  sortOrder?: AttentionSortOrder;
  snoozed?: AttentionItem[];
  dismissed?: AttentionItem[];
  openCurtains?: boolean;
  /** Pre-expand a specific row (e.g. to show the larger image gallery). */
  initialExpandedId?: string;
}) {
  const firstInline = items.find((i) => i.inlineResolvable && (i.sourceKind === "approval" || i.sourceKind === "join_request"));
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId ?? firstInline?.id ?? null);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const visible = items.filter((i) => !cleared.has(i.id));

  const groups = useMemo(
    () => groupAttentionItems(sortAttentionItems(visible, sortOrder), groupBy, { now: NOW }),
    [visible, groupBy, sortOrder],
  );
  const count = visible.length;

  return (
    <div className="max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Decisions</h1>
        <div className="flex items-center gap-2">
          {count > 0 && (
            <span className="text-sm text-muted-foreground">
              {count} {count === 1 ? "decision" : "decisions"}
            </span>
          )}
          <ToolbarButton icon={ListFilter} />
          <ToolbarButton icon={Layers} active={groupBy !== "none"} />
          <ToolbarButton icon={ArrowUpDown} />
        </div>
      </div>
      {count === 0 && snoozed.length === 0 && dismissed.length === 0 ? (
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
        <div className="space-y-4">
          {groups.map((group) => {
            const groupLabel = group.label;
            return (
              <section key={group.key} className="space-y-2">
                {groupLabel !== null && (
                  <IssueGroupHeader
                    label={groupLabel}
                    collapsible
                    collapsed={false}
                    trailing={<span className="text-xs tabular-nums text-muted-foreground">{group.items.length}</span>}
                  />
                )}
                <div className="space-y-2">
                  {group.items.map((it) => (
                    <AttentionQueueRow
                      key={it.id}
                      item={it}
                      companyId={companyId}
                      expanded={expandedId === it.id}
                      onToggleExpand={() => setExpandedId((p) => (p === it.id ? null : it.id))}
                      onDismiss={(d) => setCleared((prev) => new Set(prev).add(d.id))}
                      onSnooze={(d) => setCleared((prev) => new Set(prev).add(d.id))}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          {snoozed.length > 0 && (
            <section className="space-y-2">
              <IssueGroupHeader label={`Snoozed (${snoozed.length})`} collapsible collapsed={!openCurtains} className="text-muted-foreground" />
              {openCurtains && (
                <div className="space-y-2">
                  {snoozed.map((it) => (
                    <AttentionQueueRow
                      key={it.id}
                      item={it}
                      companyId={companyId}
                      variant="hidden"
                      expanded={false}
                      onToggleExpand={() => {}}
                      onDismiss={() => {}}
                      onRestore={() => {}}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {dismissed.length > 0 && (
            <section className="space-y-2">
              <IssueGroupHeader label={`Dismissed (${dismissed.length})`} collapsible collapsed={!openCurtains} className="text-muted-foreground" />
              {openCurtains && (
                <div className="space-y-2">
                  {dismissed.map((it) => (
                    <AttentionQueueRow
                      key={it.id}
                      item={it}
                      companyId={companyId}
                      variant="hidden"
                      expanded={false}
                      onToggleExpand={() => {}}
                      onDismiss={() => {}}
                      onRestore={() => {}}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

const meta: Meta<typeof Queue> = {
  title: "Pages/Decisions",
  component: Queue,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof Queue>;

export const DateGrouping: Story = {
  args: { items: POPULATED_DATED, groupBy: "date" },
};

export const GroupedByType: Story = {
  args: { items: POPULATED_DATED, groupBy: "type" },
};

export const GroupedByProject: Story = {
  args: { items: POPULATED_DATED, groupBy: "project" },
};

export const GroupedBySeverity: Story = {
  args: { items: POPULATED_DATED, groupBy: "severity" },
};

export const WithCurtains: Story = {
  args: { items: POPULATED_DATED.slice(0, 3), groupBy: "date", snoozed: SNOOZED, dismissed: DISMISSED, openCurtains: true },
};

export const TypeColorsAndDetail: Story = {
  args: { items: SHOWCASE, groupBy: "type" },
};

/**
 * Collapsed image rows (PAP-13544). Each row shows up to three small
 * thumbnails plus a "+n" chip; clicking the thumbnails expands the row. Covers
 * a 5-image review row, a 3-image (no "+n") questions row, and a single-image
 * failed-run row.
 */
export const ImageThumbnails: Story = {
  args: { items: IMAGE_ROWS },
};

/**
 * An expanded image row (PAP-13544). The 5-image review row is pre-expanded so
 * the first three screenshots render larger with a "2 more" tile that links to
 * the issue.
 */
export const ImageGalleryExpanded: Story = {
  args: { items: IMAGE_ROWS, initialExpandedId: "img-review" },
};

/** The ~8s undo toast shown after dismissing a row (plan §6). */
function DismissUndoDemo() {
  const { pushToast } = useToastActions();
  useEffect(() => {
    pushToast({
      id: "attention-dismiss-demo",
      title: "Dismissed",
      body: "Hire agent: Research Analyst",
      tone: "info",
      ttlMs: 15000,
      action: { label: "Undo", onClick: () => {} },
    });
  }, [pushToast]);
  return (
    <div className="max-w-3xl space-y-4 p-6">
      <Queue items={SHOWCASE.slice(0, 3)} groupBy="type" />
    </div>
  );
}

export const DismissUndoToast: StoryObj = {
  render: () => (
    <ToastProvider>
      <DismissUndoDemo />
      <ToastViewport />
    </ToastProvider>
  ),
};

export const ZeroState: Story = {
  args: { items: [] },
};

/**
 * A 390×844 phone frame. Rows use container queries, so the stacked mobile
 * layout renders here at any Storybook viewport — the row reflows off its own
 * column width, not the browser width.
 */
function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center bg-background p-4">
      <div className="w-[390px] overflow-hidden rounded-xl border border-border bg-background shadow-sm">
        {children}
      </div>
    </div>
  );
}

/** Mobile: the populated queue at phone width — full-width headlines + actions. */
export const MobilePopulated: StoryObj = {
  name: "Mobile · Populated",
  render: () => (
    <PhoneFrame>
      <Queue items={POPULATED_DATED} groupBy="date" />
    </PhoneFrame>
  ),
};

/** Mobile: the type-color + detail + thumbnail showcase at phone width. */
export const MobileShowcase: StoryObj = {
  name: "Mobile · Type colors & detail",
  render: () => (
    <PhoneFrame>
      <Queue items={SHOWCASE} groupBy="type" />
    </PhoneFrame>
  ),
};

/** Mobile: snoozed / dismissed curtains and the restore affordance at phone width. */
export const MobileCurtains: StoryObj = {
  name: "Mobile · Curtains",
  render: () => (
    <PhoneFrame>
      <Queue
        items={POPULATED_DATED.slice(0, 2)}
        groupBy="date"
        snoozed={SNOOZED}
        dismissed={DISMISSED}
        openCurtains
      />
    </PhoneFrame>
  ),
};
