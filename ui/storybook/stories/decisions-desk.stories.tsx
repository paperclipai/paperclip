import { useMemo, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  AttentionFeed,
  AttentionItem,
  AttentionSeverity,
  AttentionSourceKind,
} from "@paperclipai/shared";
import { Routes, Route } from "@/lib/router";
import { WhatNeedsMe } from "@/pages/WhatNeedsMe";
import { DecisionQueuePage } from "@/pages/DecisionQueuePage";
import { AttentionQueueRow } from "@/components/AttentionQueueRow";
import type { DecisionQueueDto } from "@/api/decisionQueues";
import { queryKeys } from "@/lib/queryKeys";

// The company id the Storybook providers select (see .storybook/preview.tsx).
const companyId = "company-storybook";

// A fixed clock so the decide-by split ("today" vs "this week") and the aging
// "idle N days" labels are deterministic across renders/screenshots.
const NOW = Date.parse("2026-08-02T15:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

// --- fixture builders -------------------------------------------------------

/** The board operator, so `route to agent` mentions have someone to hand to. */
const AGENTS: Agent[] = [
  { id: "agent-prioritizer", name: "Prioritizer", status: "idle" },
  { id: "agent-coder", name: "ClaudeCoder", status: "working" },
  { id: "agent-qa", name: "QA", status: "idle" },
] as unknown as Agent[];

function attribution(agentName: string) {
  return {
    type: "agent" as const,
    agentId: "agent-prioritizer",
    agentName,
    userId: null,
    runId: "run-prio-1",
    responsibleUserId: null,
    updatedAt: iso(NOW - 2 * HOUR),
  };
}

function item(
  id: string,
  sourceKind: AttentionSourceKind,
  severity: AttentionSeverity,
  title: string,
  whyNow: string,
  overrides: Partial<AttentionItem> = {},
): AttentionItem {
  const base: AttentionItem = {
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
    dismissal: null,
    severity,
    rank: 0,
    activityAt: iso(NOW - HOUR),
    createdAt: iso(NOW - 3 * DAY),
    updatedAt: iso(NOW - HOUR),
    relatedIssue: {
      kind: "issue",
      id: "issue-1000",
      companyId,
      title: "Ship the decisions desk",
      identifier: "PAP-1000",
      status: "in_progress",
      href: "/PAP/issues/PAP-1000",
      metadata: {},
    },
    project: null,
    workspace: null,
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
    detail: null,
    trainingExampleId: null,
  };
  return { ...base, ...overrides };
}

/** Approval-shaped item (symmetric accept/reject → bulk-eligible on a queue). */
function approval(id: string, title: string, whyNow: string, overrides: Partial<AttentionItem> = {}) {
  return item(id, "approval", "high", title, whyNow, {
    inlineResolvable: true,
    subject: {
      kind: "approval",
      id: `${id}-approval`,
      companyId,
      title,
      identifier: null,
      status: "pending",
      href: `/PAP/approvals/${id}`,
      metadata: { type: "merge_pr" },
    },
    decisionVerbs: [
      { id: "approve", label: "Approve", description: null },
      { id: "reject", label: "Reject", description: null },
    ],
    ...overrides,
  });
}

function feed(items: AttentionItem[]): AttentionFeed {
  // New-today (surfaced today) or overdue decide-by — the sidebar badge load.
  const startOfToday = Date.UTC(
    new Date(NOW).getUTCFullYear(),
    new Date(NOW).getUTCMonth(),
    new Date(NOW).getUTCDate(),
  );
  const deskBadgeCount = items.filter(
    (it) =>
      !it.shelf &&
      (it.decideBy === "today" || new Date(it.createdAt).getTime() >= startOfToday),
  ).length;
  return {
    companyId,
    generatedAt: iso(NOW),
    totalCount: items.length,
    deskBadgeCount,
    nextCursor: null,
    countsBySourceKind: {} as AttentionFeed["countsBySourceKind"],
    items,
  };
}

const PRS_QUEUE: DecisionQueueDto = {
  id: "queue-prs",
  companyId,
  key: "prs",
  title: "PRs to review",
  description: "Pull requests waiting on a merge decision.",
  createdByType: "agent",
  createdByAgentId: "agent-prioritizer",
  createdByUserId: null,
  createdByRunId: "run-1",
  retentionDays: 30,
  seedRules: [
    {
      key: "pr-work-product",
      description: "Issues that reach in-review with a pull-request work product",
      signal: "issue_has_pull_request_work_product",
    },
  ],
  seedRulesEnabled: true,
  itemCount: 4,
  createdAt: iso(NOW - 9 * DAY),
  updatedAt: iso(NOW - 20 * 60 * 1000),
};

const QUEUES: DecisionQueueDto[] = [
  PRS_QUEUE,
  {
    ...PRS_QUEUE,
    id: "queue-plans",
    key: "plan-approvals",
    title: "Plan approvals",
    description: "Plan documents awaiting board sign-off.",
    seedRules: [
      {
        key: "plan-confirmation",
        description: "Plan-document confirmations opened on an issue",
        signal: "plan_document_confirmation",
      },
    ],
    itemCount: 2,
    updatedAt: iso(NOW - 3 * HOUR),
  },
  {
    ...PRS_QUEUE,
    id: "queue-questions",
    key: "questions",
    title: "Questions",
    description: "Open questions from agents that need an answer.",
    seedRules: [
      {
        key: "ask-user-questions",
        description: "Agents asking the board a structured question",
        signal: "ask_user_questions",
      },
    ],
    seedRulesEnabled: false,
    itemCount: 1,
    updatedAt: iso(NOW - 30 * HOUR),
  },
];

const PRS_QUEUE_REF = { key: "prs", title: "PRs to review" };

// --- desk items -------------------------------------------------------------

const DESK_ITEMS: AttentionItem[] = [
  approval("pr-1", "Merge PR #10664: decisions desk data layer", "PR passed CI and is waiting on a merge decision.", {
    decideBy: "today",
    decideByAttribution: attribution("Prioritizer"),
    queues: [PRS_QUEUE_REF],
    expiresAt: iso(NOW + 5 * HOUR),
    activityAt: iso(NOW - 40 * 60 * 1000),
    project: { id: "proj-desk", name: "Decisions", urlKey: "decisions", color: "#7c3aed", icon: "layers" },
  }),
  item(
    "conf-1",
    "issue_thread_interaction",
    "high",
    "Approve plan: heartbeat.ts split",
    "A plan is awaiting your approval before children are created.",
    {
      inlineResolvable: true,
      decideBy: "today",
      decideByAttribution: attribution("Prioritizer"),
      queues: [{ key: "plan-approvals", title: "Plan approvals" }],
      subject: {
        kind: "interaction",
        id: "intx-plan",
        companyId,
        title: "Approve plan: heartbeat.ts split",
        identifier: null,
        status: "pending",
        href: "/PAP/issues/PAP-1000#plan",
        metadata: { kind: "request_confirmation", issueId: "issue-1000" },
      },
      decisionVerbs: [
        { id: "approve", label: "Approve plan", description: null },
        { id: "request_changes", label: "Request changes", description: null },
      ],
      activityAt: iso(NOW - 90 * 60 * 1000),
      detail: { kind: "plan_approval", issueTitle: "heartbeat split", planTitle: "Coverage-first, 5 phases", summaryExcerpt: null, images: [] },
    },
  ),
  approval("pr-2", "Merge PR #10651: prioritized attention feed", "Second review approved; ready to merge.", {
    decideBy: "this_week",
    decideByAttribution: attribution("Prioritizer"),
    queues: [PRS_QUEUE_REF],
    createdAt: iso(NOW - 3 * HOUR),
    activityAt: iso(NOW - 5 * HOUR),
  }),
  item(
    "review-1",
    "review",
    "medium",
    "Design review: settings redesign",
    "In-review issue is waiting on a human reviewer.",
    {
      decideBy: "whenever",
      createdAt: iso(NOW - 2 * HOUR),
      activityAt: iso(NOW - 26 * HOUR),
      project: { id: "proj-beta", name: "Beta", urlKey: "beta", color: "#0f766e", icon: "rocket" },
    },
  ),
  item(
    "budget-1",
    "budget_alert",
    "low",
    "Company budget crossed 85%",
    "Budget crossed the 85% threshold.",
    { relatedIssue: null, inlineResolvable: false, createdAt: iso(NOW - 2 * DAY), activityAt: iso(NOW - 2 * DAY) },
  ),
];

// The desk when nothing has a due decide-by — every item is deferred
// ("whenever"), so there is no "Decide now" shelf and no "can wait" claim; the
// desk is purely the arrival groups "New today" / "Earlier".
const CLEAR_TODAY_ITEMS: AttentionItem[] = DESK_ITEMS.filter((it) => it.decideBy !== "today").map((it) => ({
  ...it,
  decideBy: "whenever",
  decideByAttribution: null,
}));

// Aging shelf: items idle past the 30-day retention leave the desk. The server
// sets `shelf: true`; here we mirror that plus a couple of live desk items so
// the shelf renders alongside a populated desk.
const AGING_ITEMS: AttentionItem[] = [
  ...DESK_ITEMS.slice(0, 2),
  item("aging-1", "review", "low", "Old PR review: legacy exporter", "No activity in over a month.", {
    shelf: true,
    decideBy: null,
    activityAt: iso(NOW - 47 * DAY),
    relatedIssue: {
      kind: "issue",
      id: "issue-legacy",
      companyId,
      title: "Legacy exporter cleanup",
      identifier: "PAP-812",
      status: "backlog",
      href: "/PAP/issues/PAP-812",
      metadata: {},
    },
  }),
  item("aging-2", "budget_alert", "low", "Budget alert from last quarter", "Idle 63 days.", {
    shelf: true,
    decideBy: null,
    relatedIssue: null,
    inlineResolvable: false,
    activityAt: iso(NOW - 63 * DAY),
  }),
];

// A single fully-triaged card, to show the per-card triage strip (wireframe
// screen 3) with every control populated: decide-by set + attribution, queue
// membership chip, an expiry countdown and the route-to-agent picker.
const TRIAGE_ITEM = approval(
  "triage-1",
  "Merge PR #10664: decisions desk data layer",
  "PR passed CI and is waiting on a merge decision.",
  {
    decideBy: "today",
    decideByAttribution: attribution("Prioritizer"),
    queues: [PRS_QUEUE_REF, { key: "plan-approvals", title: "Plan approvals" }],
    expiresAt: iso(NOW + 4 * HOUR),
    project: { id: "proj-desk", name: "Decisions", urlKey: "decisions", color: "#7c3aed", icon: "layers" },
  },
);

// --- seeding wrapper --------------------------------------------------------

/**
 * Seed the react-query cache the desk/queue pages read from. The Storybook
 * QueryClient uses `staleTime: Infinity` + `retry: false`, so seeded queries
 * render immediately and never hit the network — the pages run their real code
 * paths against fixture data.
 */
function PrimeDeskFixtures({
  items,
  queueItems,
  children,
}: {
  items?: AttentionItem[];
  queueItems?: AttentionItem[];
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  useMemo(() => {
    queryClient.setQueryData(queryKeys.decisionQueues.list(companyId), QUEUES);
    queryClient.setQueryData(queryKeys.agents.list(companyId), AGENTS);
    if (items) {
      queryClient.setQueryData(
        [...queryKeys.attention(companyId), "with-dismissed", null, null],
        feed(items),
      );
    }
    if (queueItems) {
      // The queue feed key carries the resolved activity bounds (null/null for
      // the default "all" range), matching the page's real query key.
      queryClient.setQueryData(
        [...queryKeys.attention(companyId), "queue", "prs", null, null],
        feed(queueItems),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient]);
  return <>{children}</>;
}

const meta: Meta = {
  title: "Pages/Decisions Desk",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

/**
 * Screen 1 — today's desk. Queue rail + date chips on top, then a "Decide now"
 * shelf (only because some items have an explicit due decide-by) followed by the
 * arrival groups "New today" / "Earlier", with decide-by + provenance ("set by
 * Prioritizer") on the cards.
 */
export const TodaysDesk: Story = {
  render: () => (
    <PrimeDeskFixtures items={DESK_ITEMS}>
      <div className="p-6">
        <WhatNeedsMe />
      </div>
    </PrimeDeskFixtures>
  ),
};

/**
 * Screen 1 variant — no item has an explicit decide-by deadline, so there is no
 * "Decide now" shelf and no "can wait" claim; the desk is purely the arrival
 * groups "New today" / "Earlier".
 */
export const DeskClearToday: Story = {
  render: () => (
    <PrimeDeskFixtures items={CLEAR_TODAY_ITEMS}>
      <div className="p-6">
        <WhatNeedsMe />
      </div>
    </PrimeDeskFixtures>
  ),
};

/** Screen 1 variant — the aging shelf; the "Aging" curtain holds idle items. */
export const AgingShelf: Story = {
  render: () => (
    <PrimeDeskFixtures items={AGING_ITEMS}>
      <div className="p-6">
        <WhatNeedsMe />
      </div>
    </PrimeDeskFixtures>
  ),
};

/**
 * Screen 2 — a queue page. The queue carries the same toolbar as
 * the desk (filter / group / sort / training), the date-range chips, the arrival
 * timeline groupings ("Decide now" / "New today" / "Earlier") and the aging
 * shelf, above the seed-rules card (with its rewritten copy) and the per-item
 * Exclude-with-reason affordance. Each source-native decision still resolves per
 * item (approve/reject on the card).
 */
export const QueuePage: Story = {
  render: () => (
    <PrimeDeskFixtures
      queueItems={[
        approval("q-pr-1", "Merge PR #10664: decisions desk data layer", "CI green; ready to merge.", {
          queues: [PRS_QUEUE_REF],
          decideBy: "today",
          decideByAttribution: attribution("Prioritizer"),
          expiresAt: iso(NOW + 5 * HOUR),
        }),
        approval("q-pr-2", "Merge PR #10651: prioritized attention feed", "Second review approved.", {
          queues: [PRS_QUEUE_REF],
          createdAt: iso(NOW - 2 * HOUR),
        }),
        approval("q-pr-3", "Merge PR #10636: quieter workspace-ready", "Reviewed and passing.", {
          queues: [PRS_QUEUE_REF],
          createdAt: iso(NOW - 4 * DAY),
        }),
        approval("q-pr-4", "Merge PR #10623: inbox sort pinning", "Awaiting a merge decision.", {
          queues: [PRS_QUEUE_REF],
          createdAt: iso(NOW - 5 * DAY),
        }),
        approval("q-pr-5", "Merge PR #9744: legacy exporter cleanup", "No activity in over a month.", {
          queues: [PRS_QUEUE_REF],
          shelf: true,
          activityAt: iso(NOW - 44 * DAY),
        }),
      ]}
    >
      <div className="p-6">
        <Routes location="/decisions/queues/prs">
          <Route path="/decisions/queues/:key" element={<DecisionQueuePage />} />
        </Routes>
      </div>
    </PrimeDeskFixtures>
  ),
};

/**
 * Screen 3 — the per-card triage strip. A single card, expanded, showing the
 * decide-by control (with "set by Prioritizer"), queue chips + picker, snooze
 * and route-to-agent, plus the read-only expiry countdown.
 */
export const CardTriageStrip: Story = {
  render: () => (
    <PrimeDeskFixtures>
      <div className="max-w-3xl space-y-2 p-6">
        <AttentionQueueRow
          item={TRIAGE_ITEM}
          companyId={companyId}
          agents={AGENTS}
          showTriage
          expanded
          onToggleExpand={() => {}}
          onDismiss={() => {}}
          onSnooze={() => {}}
        />
      </div>
    </PrimeDeskFixtures>
  ),
};
