import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AGENT_STATUSES, ISSUE_PRIORITIES, ISSUE_STATUSES } from "@paperclipai/shared";
import type {
  IssueBlockerAttention,
  IssueProductivityReview,
  IssueRelationIssueSummary,
} from "@paperclipai/shared";
import { Bot, CheckCircle2, Clock3, DollarSign, FolderKanban, Inbox, MessageSquare, Users } from "lucide-react";
import { CopyText } from "@/components/CopyText";
import { EmptyState } from "@/components/EmptyState";
import { Identity } from "@/components/Identity";
import { IssueBlockedNotice } from "@/components/IssueBlockedNotice";
import { IssueRow } from "@/components/IssueRow";
import { MetricCard } from "@/components/MetricCard";
import { PriorityIcon } from "@/components/PriorityIcon";
import { ProductivityReviewBadge } from "@/components/ProductivityReviewBadge";
import { QuotaBar } from "@/components/QuotaBar";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createIssue } from "../fixtures/paperclipData";

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="paperclip-story__label">{eyebrow}</div>
        <h2 className="mt-1 text-xl font-semibold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

type CoveredBlockedCell = {
  label: string;
  status: string;
  blockerAttention: IssueBlockerAttention | null;
  expectedVisual: string;
  expectedCopy: string;
};

function attention(
  partial: Partial<IssueBlockerAttention> & Pick<IssueBlockerAttention, "state" | "reason">,
): IssueBlockerAttention {
  return {
    state: partial.state,
    reason: partial.reason,
    unresolvedBlockerCount: partial.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: partial.coveredBlockerCount ?? 0,
    stalledBlockerCount: partial.stalledBlockerCount ?? 0,
    attentionBlockerCount: partial.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: partial.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier: partial.sampleStalledBlockerIdentifier ?? null,
  };
}

const coveredBlockedMatrix: CoveredBlockedCell[] = [
  {
    label: "Normal blocked",
    status: "blocked",
    blockerAttention: null,
    expectedVisual: "solid red ring",
    expectedCopy: "Blocked",
  },
  {
    label: "Covered by 1 active child",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2175",
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · waiting on active sub-issue PAP-2175",
  },
  {
    label: "Covered by N active children",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 3,
      coveredBlockerCount: 3,
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · waiting on 3 active sub-issues",
  },
  {
    label: "Covered by active dependency",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-1918",
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · covered by active dependency PAP-1918",
  },
  {
    label: "Covered by N active dependencies",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · covered by 2 active dependencies",
  },
  {
    label: "Stalled review (single leaf)",
    status: "blocked",
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      stalledBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2279",
      sampleStalledBlockerIdentifier: "PAP-2279",
    }),
    expectedVisual: "amber ring with dot",
    expectedCopy: "Blocked · review stalled on PAP-2279",
  },
  {
    label: "Stalled review (multiple leaves)",
    status: "blocked",
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 2,
      stalledBlockerCount: 2,
      sampleStalledBlockerIdentifier: "PAP-2279",
    }),
    expectedVisual: "amber ring with dot",
    expectedCopy: "Blocked · 2 reviews stalled with no clear next step",
  },
  {
    label: "Mixed: 1 covered, 1 needs attention",
    status: "blocked",
    blockerAttention: attention({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 1,
      attentionBlockerCount: 1,
    }),
    expectedVisual: "solid red ring",
    expectedCopy: "Blocked · 2 unresolved blockers need attention",
  },
  {
    label: "Needs attention (single blocker)",
    status: "blocked",
    blockerAttention: attention({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-1042",
    }),
    expectedVisual: "solid red ring",
    expectedCopy: "Blocked · 1 unresolved blocker needs attention",
  },
  {
    label: "Non-blocked with prop ignored",
    status: "in_progress",
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2175",
    }),
    expectedVisual: "yellow ring",
    expectedCopy: "In Progress",
  },
];

const coveredBlockedIssue = createIssue({
  id: "issue-covered-blocked-story",
  identifier: "PAP-2178",
  issueNumber: 2178,
  title: "Covered blocked visual state: final acceptance",
  status: "blocked",
  priority: "medium",
  blockerAttention: coveredBlockedMatrix[1]!.blockerAttention ?? undefined,
  lastActivityAt: new Date("2026-04-24T13:40:00.000Z"),
  updatedAt: new Date("2026-04-24T13:40:00.000Z"),
});

function summaryBlocker(
  partial: Partial<IssueRelationIssueSummary> & Pick<IssueRelationIssueSummary, "id" | "title" | "status">,
): IssueRelationIssueSummary {
  return {
    id: partial.id,
    identifier: partial.identifier ?? null,
    title: partial.title,
    status: partial.status,
    priority: partial.priority ?? "medium",
    assigneeAgentId: partial.assigneeAgentId ?? null,
    assigneeUserId: partial.assigneeUserId ?? null,
    terminalBlockers: partial.terminalBlockers,
  };
}

type BlockedNoticeStateLabel =
  | "Default covered"
  | "Stalled (single leaf)"
  | "Stalled (multiple leaves)";

type BlockedNoticeFixture = {
  label: BlockedNoticeStateLabel;
  caption: string;
  blockers: IssueRelationIssueSummary[];
  blockerAttention: IssueBlockerAttention;
};

const stalledLeafSingle = summaryBlocker({
  id: "issue-stalled-leaf-single",
  identifier: "PAP-2279",
  title: "Stage gate review for export pipeline",
  status: "in_review",
});

const stalledLeafMultiPrimary = summaryBlocker({
  id: "issue-stalled-leaf-multi-1",
  identifier: "PAP-2284",
  title: "Approve schema migration",
  status: "in_review",
});

const stalledLeafMultiSecondary = summaryBlocker({
  id: "issue-stalled-leaf-multi-2",
  identifier: "PAP-2291",
  title: "Sign off on rollout copy",
  status: "in_review",
});

const blockedNoticeFixtures: BlockedNoticeFixture[] = [
  {
    label: "Default covered",
    caption: "Active sub-issue covers the chain — informational only.",
    blockers: [
      summaryBlocker({
        id: "issue-active-child",
        identifier: "PAP-2175",
        title: "Wire export pipeline preview",
        status: "in_progress",
      }),
    ],
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2175",
    }),
  },
  {
    label: "Stalled (single leaf)",
    caption: "Chain stalled on one leaf review — copy names the leaf and shows the chip strip.",
    blockers: [
      summaryBlocker({
        id: "issue-stalled-parent-single",
        identifier: "PAP-2278",
        title: "Ship rollout dashboard",
        status: "blocked",
        terminalBlockers: [stalledLeafSingle],
      }),
    ],
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      stalledBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2279",
      sampleStalledBlockerIdentifier: "PAP-2279",
    }),
  },
  {
    label: "Stalled (multiple leaves)",
    caption: "Multiple stalled reviews — body uses plural agreement (\"reviews\"/\"them\") to match the chip strip.",
    blockers: [
      summaryBlocker({
        id: "issue-stalled-parent-multi-a",
        identifier: "PAP-2283",
        title: "Coordinate billing change rollout",
        status: "blocked",
        terminalBlockers: [stalledLeafMultiPrimary],
      }),
      summaryBlocker({
        id: "issue-stalled-parent-multi-b",
        identifier: "PAP-2290",
        title: "Coordinate marketing handoff",
        status: "blocked",
        terminalBlockers: [stalledLeafMultiSecondary],
      }),
    ],
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 2,
      stalledBlockerCount: 2,
      sampleStalledBlockerIdentifier: "PAP-2284",
    }),
  },
];

function BlockedNoticeSurface({
  mode,
  size,
  fixture,
}: {
  mode: "light" | "dark";
  size: "desktop" | "mobile";
  fixture: BlockedNoticeFixture;
}) {
  const isDark = mode === "dark";
  const isMobile = size === "mobile";
  return (
    <div className={isDark ? "dark" : undefined}>
      <div className="rounded-lg border border-border bg-background text-foreground">
        <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          <span>{fixture.label}</span>
          <span className="font-mono">
            {size} · {mode}
          </span>
        </div>
        <div className={isMobile ? "max-w-[358px] px-3 py-3" : "min-w-[620px] px-4 py-3"}>
          <IssueBlockedNotice
            issueStatus="blocked"
            blockers={fixture.blockers}
            blockerAttention={fixture.blockerAttention}
          />
          <p className="text-[11px] text-muted-foreground">{fixture.caption}</p>
        </div>
      </div>
    </div>
  );
}

function CoveredBlockedSurface({ mode, size }: { mode: "light" | "dark"; size: "desktop" | "mobile" }) {
  const isDark = mode === "dark";
  const isMobile = size === "mobile";

  return (
    <div className={isDark ? "dark" : undefined}>
      <div className="rounded-lg border border-border bg-background text-foreground">
        <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          {size} · {mode}
        </div>
        <div className={isMobile ? "max-w-[340px]" : "min-w-[620px]"}>
          <IssueRow
            issue={coveredBlockedIssue}
            mobileMeta={<StatusBadge status={coveredBlockedIssue.status} />}
            trailingMeta="waiting on PAP-2175"
          />
        </div>
      </div>
    </div>
  );
}

type ProductivityReviewFixture = {
  label: string;
  description: string;
  review: IssueProductivityReview;
};

const productivityReviewFixtures: ProductivityReviewFixture[] = [
  {
    label: "No-comment streak",
    description: "Source issue has had 12 completed runs without a run-created comment.",
    review: {
      reviewIssueId: "review-issue-1",
      reviewIdentifier: "PAP-2702",
      status: "todo",
      priority: "high",
      trigger: "no_comment_streak",
      noCommentStreak: 12,
      createdAt: new Date("2026-04-28T13:30:00.000Z"),
      updatedAt: new Date("2026-04-28T13:55:00.000Z"),
    },
  },
  {
    label: "Long active duration",
    description: "Source issue has been actively running for over 6 hours.",
    review: {
      reviewIssueId: "review-issue-2",
      reviewIdentifier: "PAP-2703",
      status: "in_progress",
      priority: "medium",
      trigger: "long_active_duration",
      noCommentStreak: null,
      createdAt: new Date("2026-04-28T08:30:00.000Z"),
      updatedAt: new Date("2026-04-28T13:00:00.000Z"),
    },
  },
  {
    label: "High churn",
    description: "Source issue is producing >10 runs/comments per hour.",
    review: {
      reviewIssueId: "review-issue-3",
      reviewIdentifier: "PAP-2704",
      status: "todo",
      priority: "high",
      trigger: "high_churn",
      noCommentStreak: 4,
      createdAt: new Date("2026-04-28T13:45:00.000Z"),
      updatedAt: new Date("2026-04-28T13:55:00.000Z"),
    },
  },
];

const productivityReviewIssueRowFixtures = productivityReviewFixtures.map((fixture, index) =>
  createIssue({
    id: `issue-productivity-source-${index + 1}`,
    identifier: `PAP-${2710 + index}`,
    issueNumber: 2710 + index,
    title: `Source issue under review · ${fixture.label}`,
    status: index === 1 ? "in_progress" : "in_progress",
    priority: fixture.review.priority,
    productivityReview: fixture.review,
    lastActivityAt: fixture.review.updatedAt,
    updatedAt: fixture.review.updatedAt,
  }),
);

function ProductivityReviewMatrix() {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3">
        {productivityReviewFixtures.map((fixture) => (
          <div
            key={fixture.label}
            className="flex flex-col gap-3 rounded-lg border border-border bg-background/70 p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{fixture.label}</div>
                <div className="mt-1 text-xs text-muted-foreground">{fixture.description}</div>
              </div>
              <ProductivityReviewBadge review={fixture.review} />
            </div>
            <div className="rounded-md bg-muted/45 px-2.5 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
              Trigger {fixture.review.trigger ?? "unknown"} · review {fixture.review.reviewIdentifier}
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border">
        <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          IssueRow with productivity-review indicator
        </div>
        <div>
          {productivityReviewIssueRowFixtures.map((issue) => (
            <IssueRow key={issue.id} issue={issue} mobileMeta={<StatusBadge status={issue.status} />} />
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        On the source issue header the amber pill reads <strong>Under review</strong> and links to the open
        productivity-review child — describing the state the task is in. The productivity-review issue itself
        carries a static <strong>Productivity review</strong> pill identifying what kind of issue it is.
        List rows get a smaller eye glyph next to the status icon so operators can spot yellow tasks without
        the clickable label.
      </p>
    </div>
  );
}

function StatusLanguage() {
  const [priority, setPriority] = useState("high");

  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="paperclip-story__label">Language</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Status, priority, identity, and metrics</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            These components carry the operational vocabulary of the board: who is acting, what state work is in,
            how urgent it is, and whether capacity or spend needs attention.
          </p>
        </section>

        <Section eyebrow="Lifecycle" title="Issue and agent statuses">
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Issue statuses</CardTitle>
                <CardDescription>Every task transition state in the V1 issue lifecycle.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {ISSUE_STATUSES.map((status) => (
                  <StatusBadge key={status} status={status} />
                ))}
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Agent statuses</CardTitle>
                <CardDescription>Runtime and governance states shown in org, sidebar, and detail surfaces.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {AGENT_STATUSES.map((status) => (
                  <StatusBadge key={status} status={status} />
                ))}
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Covered blocked" title="Blocked attention state matrix">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {coveredBlockedMatrix.map((item) => (
              <div
                key={item.label}
                className="flex min-h-[136px] flex-col justify-between rounded-lg border border-border bg-background/70 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{item.label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{item.expectedVisual}</div>
                  </div>
                  <StatusIcon status={item.status} blockerAttention={item.blockerAttention} />
                </div>
                <div className="mt-4 rounded-md bg-muted/45 px-2.5 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
                  {item.expectedCopy}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Tooltip and aria-label copy begin with "Blocked · " for every cell after the first. Covered cells show a cyan
            ring with a small dot, stalled-review cells show an amber ring with a centered dot, and the needs-attention
            cells retain the solid red ring.
          </p>
        </Section>

        <Section eyebrow="Covered blocked" title="IssueRow desktop and mobile surfaces">
          <div className="grid gap-4 xl:grid-cols-2">
            <CoveredBlockedSurface mode="light" size="desktop" />
            <CoveredBlockedSurface mode="dark" size="desktop" />
            <CoveredBlockedSurface mode="light" size="mobile" />
            <CoveredBlockedSurface mode="dark" size="mobile" />
          </div>
        </Section>

        <Section eyebrow="Covered blocked" title="IssueBlockedNotice in chat thread">
          <div className="space-y-5">
            {blockedNoticeFixtures.map((fixture) => (
              <div key={fixture.label} className="grid gap-4 xl:grid-cols-2">
                <BlockedNoticeSurface mode="light" size="desktop" fixture={fixture} />
                <BlockedNoticeSurface mode="dark" size="desktop" fixture={fixture} />
                <BlockedNoticeSurface mode="light" size="mobile" fixture={fixture} />
                <BlockedNoticeSurface mode="dark" size="mobile" fixture={fixture} />
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Stalled-state copy switches to "stalled in review without a clear next step" and adds a "Stalled in review"
            chip strip beneath the regular blocker chips. The trailing imperative pluralizes when multiple stalled
            leaves are surfaced ("reviews"/"them") to match the chip strip.
          </p>
        </Section>

        <Section eyebrow="Productivity review" title="Yellow accountability state on source issues">
          <ProductivityReviewMatrix />
        </Section>

        <Section eyebrow="Priority" title="Static labels and editable popover trigger">
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="grid gap-3 sm:grid-cols-2">
              {ISSUE_PRIORITIES.map((item) => (
                <div key={item} className="flex items-center justify-between rounded-lg border border-border bg-background/70 p-4">
                  <PriorityIcon priority={item} showLabel />
                  <span className="font-mono text-xs text-muted-foreground">{item}</span>
                </div>
              ))}
            </div>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Editable priority</CardTitle>
                <CardDescription>Click the control to inspect the same popover used in issue rows.</CardDescription>
              </CardHeader>
              <CardContent>
                <PriorityIcon priority={priority} onChange={setPriority} showLabel />
                <div className="mt-3 text-xs text-muted-foreground">Current value: {priority}</div>
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Identity" title="Agent and user chips">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>XS</CardTitle>
              </CardHeader>
              <CardContent>
                <Identity name="CodexCoder" size="xs" />
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Small</CardTitle>
              </CardHeader>
              <CardContent>
                <Identity name="Board User" size="sm" initials="BU" />
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Default</CardTitle>
              </CardHeader>
              <CardContent>
                <Identity name="DesignSystemCoder" />
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Long label</CardTitle>
              </CardHeader>
              <CardContent className="max-w-[220px]">
                <Identity name="Senior Product Engineering Reviewer" size="lg" />
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Dashboard" title="Metrics, quota bars, empty states, and copy affordances">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard icon={Users} value={8} label="Active agents" description="3 running right now" to="/agents/active" />
              <MetricCard icon={FolderKanban} value={27} label="Open issues" description="5 in review" to="/issues" />
              <MetricCard icon={DollarSign} value="$675" label="MTD spend" description="27% of budget" to="/costs" />
              <MetricCard icon={Clock3} value="14m" label="P95 run age" description="last 24 hours" />
            </div>

            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Copyable identifiers</CardTitle>
                <CardDescription>Click values to exercise the status tooltip.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Issue</span>
                  <CopyText text="PAP-1641" className="font-mono">PAP-1641</CopyText>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Run</span>
                  <CopyText text="49442f05-f1c1-45c5-88d3-1e5b871dbb8b" className="font-mono">
                    49442f05
                  </CopyText>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Quota thresholds</CardTitle>
                <CardDescription>Green, warning, and hard-stop-adjacent progress treatments.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <QuotaBar label="Company budget" percentUsed={27} leftLabel="$675 used" rightLabel="$2,500 cap" />
                <QuotaBar label="Project budget" percentUsed={86} leftLabel="$1,031 used" rightLabel="$1,200 cap" />
                <QuotaBar label="Agent budget" percentUsed={108} leftLabel="$432 used" rightLabel="$400 cap" showDeficitNotch />
              </CardContent>
            </Card>

            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Empty state</CardTitle>
                <CardDescription>Used when a list has no meaningful rows yet.</CardDescription>
              </CardHeader>
              <CardContent>
                <EmptyState icon={Inbox} message="No assigned work is waiting in this queue." action="Create issue" onAction={() => undefined} />
              </CardContent>
            </Card>
          </div>
        </Section>
      </main>
    </div>
  );
}

const meta = {
  title: "Foundations/Status Language",
  component: StatusLanguage,
  parameters: {
    docs: {
      description: {
        component:
          "Status-language stories show the reusable operational labels, identity chips, metrics, and capacity indicators used throughout the board.",
      },
    },
  },
} satisfies Meta<typeof StatusLanguage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FullMatrix: Story = {};
