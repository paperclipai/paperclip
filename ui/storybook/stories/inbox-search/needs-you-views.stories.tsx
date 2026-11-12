import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  AttentionAudience,
  AttentionItem,
  AttentionPersonalView,
  AttentionSourceKind,
  AttentionViewCounts,
} from "@paperclipai/shared";
import { AttentionSnoozedGroup, AttentionStaleGroup } from "@/components/AttentionCloseMenu";
import { AttentionQueueRow } from "@/components/AttentionQueueRow";
import { AttentionUnassignedBanner, AttentionViewSwitch } from "@/components/AttentionViews";
import { splitArchivedAttentionItems, splitStaleAttentionItems } from "@/lib/attention-close";
import { attentionObligationEvidence, foldAttentionObligations } from "@/lib/attention-obligations";

// PAP-749 tasks 1b, 2c, 2e and 2d, and PAP-768's Everyone tab: the view switch, the "Why me?" line, the
// "For @name" chip, Claim and the Unassigned banner, plus the Close… menu, the
// Stale chip and the collapsed Stale (N) group with "Withdraw all stale", the
// Archived view with Restore and its Snoozed group, and one card for each
// obligation, as the classic Decisions page and Coordinator Needs You render
// them. Scott is the viewer.
const companyId = "company-storybook";
const SCOTT = "user-scott";
const DOTTA = "user-dotta";
const RILEY = "user-riley";
const USER_LABELS: ReadonlyMap<string, string> = new Map([[SCOTT, "Scott"], [DOTTA, "Dotta"], [RILEY, "Riley"]]);
const NOW = Date.parse("2026-10-30T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WITHDRAWABLE = { closeModes: ["withdraw", "archive", "snooze"] } satisfies Partial<AttentionItem>;
const noop = () => {};

function card(
  id: string,
  sourceKind: AttentionSourceKind,
  title: string,
  detail: string,
  audience: AttentionAudience,
  overrides: Partial<AttentionItem> = {},
): AttentionItem {
  const at = new Date(NOW - HOUR).toISOString();
  return {
    id,
    companyId,
    sourceKind,
    subject: {
      kind: sourceKind === "issue_thread_interaction" ? "interaction" : "issue",
      id: `${id}-subject`,
      companyId,
      title,
      identifier: null,
      status: "pending",
      href: "/PAP/issues/PAP-1000",
      metadata: {},
    },
    whyNow: detail,
    decisionVerbs: [],
    inlineResolvable: false,
    entryRule: "",
    exitRule: "",
    dedupKey: `${id}-dedup`,
    dismissalKey: `attention:${id}-dedup`,
    dismissal: null,
    severity: "medium",
    rank: 0,
    activityAt: at,
    createdAt: at,
    updatedAt: at,
    relatedIssue: {
      kind: "issue",
      id: "issue-1000",
      companyId,
      title: "Ship the Needs You views",
      identifier: "PAP-1000",
      status: "in_progress",
      href: "/PAP/issues/PAP-1000",
      metadata: {},
    },
    audience,
    stale: null,
    required: false,
    changeFingerprint: "fixture.me", closeModes: ["archive", "snooze"], obligationKey: null, obligationLeadId: null,
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
    ...overrides,
  };
}

const forScott = (reason: AttentionAudience["reason"]): AttentionAudience => ({ kind: "user", userId: SCOTT, reason });
const POOL: AttentionAudience = { kind: "pool", userId: null, reason: "none" };
const COMPANY: AttentionAudience = { kind: "company", userId: null, reason: "none" };

const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();
const STALE: AttentionItem[] = [
  card("stale-31", "issue_thread_interaction", "Confirm the Q3 roadmap order", "No important change for 31 days.", forScott("addressee"),
    { ...WITHDRAWABLE, stale: { reason: "aged" }, activityAt: daysAgo(31), createdAt: daysAgo(31) }),
  card("stale-done", "issue_thread_interaction", "Which screenshot goes in the release note?", "Its task is done.", forScott("instigator"),
    { ...WITHDRAWABLE, stale: { reason: "issue_closed" }, activityAt: daysAgo(4) }),
  card("stale-decision", "decision", "Pick the archive window", "85% of its time limit is gone.", forScott("escalation_owner"),
    { ...WITHDRAWABLE, stale: { reason: "decision_expiring" }, activityAt: daysAgo(6) }),
  card("stale-review", "review", "Review the old onboarding copy", "Nobody touched it for 60 days.", forScott("reviewer"),
    { stale: { reason: "aged" }, activityAt: daysAgo(60), createdAt: daysAgo(60) }),
];

const FOR_YOU: AttentionItem[] = [
  card("q-scott", "issue_thread_interaction", "Which rollout order should we use?", "An agent asked you two questions.", forScott("addressee"), WITHDRAWABLE),
  card("review-scott", "review", "Review the pricing page copy", "Waiting on your review.", forScott("reviewer")),
  card("confirm-scott", "issue_thread_interaction", "Approve the migration plan", "A child task of your task needs a confirmation.", forScott("instigator"), WITHDRAWABLE),
  card("approval-scott", "approval", "Hire agent: Research Analyst", "You asked for this hire.", forScott("requester")),
  card("owner-scott", "decision", "Pick a vendor for transcripts", "No other owner; you are the company's default decision owner.", forScott("escalation_owner"), WITHDRAWABLE),
  ...STALE,
];

const UNASSIGNED: AttentionItem[] = [
  card("pool-routine", "issue_thread_interaction", "Confirm the weekly digest recipients", "A routine-created task asks for a confirmation.", POOL, WITHDRAWABLE),
  card("pool-agent", "issue_thread_interaction", "Answer a question for a paused agent", "The agent it was sent to cannot run.", POOL, WITHDRAWABLE),
  card("pool-decision", "decision", "Choose a retry budget", "An agent-created task needs a decision.", POOL, WITHDRAWABLE),
];

const COMPANY_CARDS: AttentionItem[] = [
  card("failed-run", "failed_run", "Nightly sync failed after all retries", "The last of three retries failed.", COMPANY, {
    severity: "high",
    inlineResolvable: true,
    decisionVerbs: [{ id: "retry", label: "Retry", description: null }, { id: "inspect", label: "Open run", description: null }],
  }),
  card("budget", "budget_alert", "Budget hard stop: Research team", "Spend reached 100% of the monthly limit.", COMPANY, {
    severity: "critical",
    inlineResolvable: true,
    subject: {
      kind: "budget_incident", id: "budget-incident", companyId, title: "Budget hard stop: Research team", identifier: null, status: "open", href: "/PAP/costs",
      metadata: { thresholdType: "hard", amountObserved: 50_000, amountLimit: 50_000 },
    },
  }),
  card("stale-pool", "issue_thread_interaction", "Confirm the release checklist", "No owner for 7+ days.", COMPANY,
    { ...WITHDRAWABLE, stale: { reason: "unowned" }, activityAt: daysAgo(9) }),
];

const FOR_OTHERS: AttentionItem[] = [
  card("q-dotta", "issue_thread_interaction", "Which launch date works for marketing?", "Sent to Dotta.", { kind: "user", userId: DOTTA, reason: "addressee" },
    { ...WITHDRAWABLE, inlineResolvable: true, subject: { kind: "interaction", id: "q-dotta-subject", companyId, title: "Which launch date works for marketing?", identifier: null, status: "pending", href: "/PAP/issues/PAP-1000", metadata: { issueId: "issue-1000" } } }),
  card("review-dotta", "review", "Review the onboarding email", "Dotta is the reviewer.", { kind: "user", userId: DOTTA, reason: "reviewer" }),
  card("stale-dotta", "issue_thread_interaction", "Confirm the old pricing test", "Dotta's request, 45 days without a change.", { kind: "user", userId: DOTTA, reason: "addressee" },
    { ...WITHDRAWABLE, stale: { reason: "aged" }, activityAt: daysAgo(45) }),
];

function hiddenBy(kind: "dismiss" | "snooze", dismissedAt: number, snoozedUntil: number | null = null): Partial<AttentionItem> {
  return {
    dismissal: {
      kind,
      dismissedAt: new Date(dismissedAt).toISOString(),
      snoozedUntil: snoozedUntil === null ? null : new Date(snoozedUntil).toISOString(),
      isActive: true,
    },
  };
}

// Scott's own hidden cards: two archived (one also stale) and one snoozed until tomorrow.
const ARCHIVED: AttentionItem[] = [
  card("archived-copy", "issue_thread_interaction", "Approve the launch blog copy", "Archived yesterday; still open for Dotta.", { kind: "user", userId: SCOTT, reason: "addressee" },
    { ...WITHDRAWABLE, ...hiddenBy("dismiss", NOW - DAY) }),
  card("archived-stale", "issue_thread_interaction", "Confirm the old pricing test", "45 days without a change.", { kind: "user", userId: SCOTT, reason: "instigator" },
    { ...WITHDRAWABLE, ...hiddenBy("dismiss", NOW - 3 * DAY), stale: { reason: "aged" }, activityAt: daysAgo(45) }),
  card("snoozed-review", "issue_thread_interaction", "Pick the onboarding email subject", "Snoozed until tomorrow morning.", { kind: "user", userId: SCOTT, reason: "addressee" },
    { ...WITHDRAWABLE, ...hiddenBy("snooze", NOW - 2 * HOUR, NOW + 21 * HOUR) }),
];

// One card for each obligation (Rule 11): an approval with the in-review task
// that waits on it, and a failed run with the task it blocks. The feed returns
// all four cards; the page shows two.
const OBLIGATIONS: AttentionItem[] = [
  card("ob-approval", "approval", "Approve the launch budget", "You asked for this approval.", forScott("requester"), {
    ...WITHDRAWABLE,
    obligationKey: "approval:launch", obligationLeadId: "ob-approval", relatedIssue: null,
    subject: { kind: "approval", id: "approval-launch", companyId, title: "Approve the launch budget", identifier: null, status: "pending", href: "/PAP/approvals/approval-launch", metadata: { issueId: "issue-1001" } },
  }),
  card("ob-review", "review", "Launch page", "Issue is in review with a linked pending approval.", forScott("requester"), {
    obligationKey: "approval:launch", obligationLeadId: "ob-approval", relatedIssue: null,
    subject: { kind: "issue", id: "issue-1001", companyId, title: "Launch page", identifier: "PAP-1001", status: "in_review", href: "/PAP/issues/PAP-1001", metadata: {} },
  }),
  card("ob-run", "failed_run", "Flaky Runner run failed", "Run failed after automatic retries were exhausted.", forScott("instigator"), {
    severity: "high",
    inlineResolvable: true,
    decisionVerbs: [{ id: "retry", label: "Retry", description: null }, { id: "inspect", label: "Open run", description: null }],
    obligationKey: "blocked:nightly", obligationLeadId: "ob-run",
    subject: { kind: "run", id: "run-1002", companyId, title: "Flaky Runner run failed", identifier: null, status: "failed", href: "/PAP/agents/flaky/runs/run-1002", metadata: { issueId: "issue-1002" } },
    relatedIssue: { kind: "issue", id: "issue-1002", companyId, title: "Nightly sync", identifier: "PAP-1002", status: "blocked", href: "/PAP/issues/PAP-1002", metadata: {} },
  }),
  card("ob-blocked", "blocker_attention", "Nightly sync", "Automatic retries exhausted. Retry or reassign the task.", forScott("instigator"), {
    severity: "high",
    obligationKey: "blocked:nightly", obligationLeadId: "ob-run", relatedIssue: null,
    subject: { kind: "issue", id: "issue-1002", companyId, title: "Nightly sync", identifier: "PAP-1002", status: "blocked", href: "/PAP/issues/PAP-1002", metadata: {} },
  }),
];

// Escalation owners (PAP-749 task 1d): the budget owner's hard stop, which
// Company still shows to everyone, and a card that reached Scott as the
// project's decision owner. The stop's override approval is folded into it
// (PAP-768): Raise limit approves it and Keep paused rejects it.
const BUDGET_OWNER = { kind: "user", userId: SCOTT, reason: "budget_owner", alsoInCompany: true } satisfies AttentionAudience;
const BUDGET_OWNER_STOP = card("budget-owned", "budget_alert", "Research team budget hard stop", "Budget hard stop was reached.",
  BUDGET_OWNER, {
    severity: "high",
    inlineResolvable: true,
    relatedIssue: null,
    obligationKey: "approval:budget-override", obligationLeadId: "budget-owned",
    decisionVerbs: [{ id: "raise_budget_and_resume", label: "Raise limit", description: null }, { id: "keep_paused", label: "Keep paused", description: null }],
    subject: {
      kind: "budget_incident", id: "budget-incident-owned", companyId, title: "Research team budget hard stop", identifier: null, status: "open", href: "/PAP/costs",
      metadata: { thresholdType: "hard", amountObserved: 50_000, amountLimit: 50_000 },
    },
  });
const BUDGET_OVERRIDE_APPROVAL = card("budget-override", "approval", "budget override required", "Approval is pending a board decision.", BUDGET_OWNER, {
  relatedIssue: null,
  obligationKey: "approval:budget-override", obligationLeadId: "budget-owned",
  subject: {
    kind: "approval", id: "budget-override", companyId, title: "budget override required", identifier: null, status: "pending", href: "/PAP/approvals/budget-override",
    metadata: { type: "budget_override_required" },
  },
});
const ESCALATION_OWNER_CARDS: AttentionItem[] = [
  BUDGET_OWNER_STOP,
  BUDGET_OVERRIDE_APPROVAL,
  card("project-owned", "issue_thread_interaction", "Confirm the Platform migration plan", "No person on the task; you own the Platform project's decisions.", forScott("project_owner"), WITHDRAWABLE),
];

// Everyone (PAP-768): every person's open cards, for a board member.
const EVERYONE: AttentionItem[] = [...FOR_YOU, ...FOR_OTHERS, ...UNASSIGNED, ...COMPANY_CARDS];
const COUNTS: AttentionViewCounts = {
  mine: FOR_YOU.length, unassigned: UNASSIGNED.length, company: COMPANY_CARDS.length, archived: ARCHIVED.length, all: EVERYONE.length,
};
const ITEMS: Record<AttentionPersonalView, AttentionItem[]> = { mine: FOR_YOU, unassigned: UNASSIGNED, company: COMPANY_CARDS, archived: ARCHIVED, all: EVERYONE };

function NeedsYouViews({
  initialView = "mine",
  items = ITEMS,
  counts = COUNTS,
  staleOpen: initialStaleOpen = false,
  expandedId: initialExpandedId = null,
  viewerId = SCOTT,
  everyone = true,
}: {
  initialView?: AttentionPersonalView;
  items?: Record<AttentionPersonalView, AttentionItem[]>;
  counts?: AttentionViewCounts;
  staleOpen?: boolean;
  expandedId?: string | null;
  viewerId?: string;
  /** The viewer is a board member, so the switch shows Everyone. */
  everyone?: boolean;
}) {
  const [view, setView] = useState<AttentionPersonalView>(initialView);
  // Claim, Close… verbs and Withdraw all stale only hide rows locally here.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [staleOpen, setStaleOpen] = useState(initialStaleOpen);
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId);
  const [snoozedOpen, setSnoozedOpen] = useState(true);
  const hide = (entry: AttentionItem) => setHidden((current) => new Set(current).add(entry.id));
  // Evidence folds into its lead before anything is hidden or split (Rule 11).
  const obligations = foldAttentionObligations(items[view]);
  const visible = obligations.cards.filter((item) => !hidden.has(item.id));
  // The Archived view keeps stale cards in place and puts snoozed cards in their own group.
  const archivedSplit = splitArchivedAttentionItems(visible);
  const { current, stale, snoozed } = view === "archived"
    ? { current: archivedSplit.archived, stale: [] as AttentionItem[], snoozed: archivedSplit.snoozed }
    : { ...splitStaleAttentionItems(visible), snoozed: [] as AttentionItem[] };
  const row = (item: AttentionItem) => (
    <AttentionQueueRow
      key={item.id}
      item={item}
      companyId={companyId}
      expanded={expandedId === item.id}
      onToggleExpand={(entry) => setExpandedId((open) => (open === entry.id ? null : entry.id))}
      onDismiss={hide}
      onSnooze={hide}
      onWithdraw={hide}
      onTransfer={hide}
      onRestore={view === "archived" ? hide : undefined}
      currentUserId={viewerId}
      userLabelMap={USER_LABELS}
      onClaim={hide}
      evidence={attentionObligationEvidence(obligations, item)}
    />
  );
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-xl font-bold">Decisions</h1>
      <AttentionViewSwitch value={view} counts={counts} onChange={setView} everyone={everyone} />
      {view === "mine" && <AttentionUnassignedBanner count={counts.unassigned} onOpen={() => setView("unassigned")} />}
      <div className="space-y-4">{current.map(row)}</div>
      <AttentionStaleGroup
        items={stale}
        open={staleOpen}
        onToggle={() => setStaleOpen((open) => !open)}
        onWithdrawAll={(entries) => setHidden((currentHidden) => new Set([...currentHidden, ...entries.map((entry) => entry.id)]))}
        currentUserId={viewerId}
        userLabelMap={USER_LABELS}
      >
        {stale.map(row)}
      </AttentionStaleGroup>
      <AttentionSnoozedGroup count={snoozed.length} open={snoozedOpen} onToggle={() => setSnoozedOpen((open) => !open)}>
        {snoozed.map(row)}
      </AttentionSnoozedGroup>
    </div>
  );
}

const meta: Meta<typeof NeedsYouViews> = {
  id: "pages-decisions-views",
  title: "Tasks and conversations/Inbox, decisions, and search/Pages/Decisions views",
  component: NeedsYouViews,
  parameters: {
    layout: "fullscreen",
    paperclip: {
      "capabilities": [
        "inbox-search/decisions"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Mounts the shipped view switch, Unassigned banner, AttentionQueueRow (audience line, Stale chip, Close… menu, For-other gate, inline Retry and budget verbs, obligation evidence) and the Stale (N) group with fixture cards; Scott is the viewer. Claim, the Close… verbs and Withdraw all stale only hide rows locally here; the real close/claim/transfer endpoints, live updates and per-user server views need the running app."
    },
  },
};
export default meta;

type Story = StoryObj<typeof NeedsYouViews>;

/** Default view with the "Why me?" line for each audience reason, the banner and a collapsed Stale (4) group. */
export const ForYou: Story = {};

/**
 * The Stale group open: each card carries its Stale chip and Close… menu.
 * "Withdraw all stale" confirms first and lists the three requests it will
 * withdraw and the review that stays.
 */
export const StaleGroupOpen: Story = { args: { staleOpen: true } };

/** Ownerless cards: why you can answer, and Claim. */
export const Unassigned: Story = { args: { initialView: "unassigned" } };

/** Operator alerts, plus an ownerless card that moved here after 7 days. */
export const Company: Story = { args: { initialView: "company" } };

/**
 * Cards for a different person show "For @name" instead of "Why me?". Expanded,
 * the answer controls wait behind "This is for @Dotta. Continue?"; the Close…
 * menu asks the same before Withdraw or Transfer.
 */
export const ForAnotherPerson: Story = {
  args: { initialView: "company", items: { ...ITEMS, company: FOR_OTHERS }, expandedId: "q-dotta", staleOpen: true },
};

/**
 * Everyone (PAP-768): a board member sees every person's open cards with
 * their own count, never in the badge. Each card for a different person shows
 * "For @name"; Withdraw, Transfer and the answer controls ask "This is for
 * @Dotta. Continue?" first.
 */
export const Everyone: Story = { args: { initialView: "all", expandedId: "q-dotta" } };

/** A viewer is not a board member, so the switch has no Everyone tab. */
export const NoEveryoneForViewer: Story = { args: { everyone: false } };

/** Company alerts expanded: the failed run retries inline, the budget stop raises or keeps paused. */
export const CompanyInlineVerbs: Story = {
  args: { initialView: "company", expandedId: "budget" },
};

/**
 * Your Archived view (PAP-749 plan §3): the cards you archived, each with its
 * archive date (and Stale chip when it is also stale), then the Snoozed group
 * with the time each card comes back. The Close… menu offers Restore (or
 * "Restore now" and "Change snooze time") instead of Archive. The tab count
 * is never in the For you badge.
 */
export const Archived: Story = { args: { initialView: "archived" } };

/**
 * One card for each obligation (PAP-749 plan §2, Rule 11): the approval card
 * names the task in review that waits on it, and the failed run names the task
 * it blocks and keeps the one action (Retry). Two obligations, two cards, and
 * the badge counts two.
 */
export const OneObligation: Story = {
  args: { items: { ...ITEMS, mine: OBLIGATIONS }, counts: { ...COUNTS, mine: 2 }, expandedId: "ob-run" },
};

/**
 * Escalation owners (PAP-749 task 1d): Scott owns budget escalation, so the
 * budget hard stop is in his For you ("You own budget escalation") with Raise
 * limit and Keep paused, and its override approval is one line under it
 * ("Approval this answers"), not a card in Unassigned (PAP-768); a card on the
 * Platform project reached him as the project's decision owner.
 */
export const EscalationOwners: Story = {
  args: { items: { ...ITEMS, mine: ESCALATION_OWNER_CARDS }, counts: { ...COUNTS, mine: 2 }, expandedId: "budget-owned" },
};

/**
 * The same hard stop in Dotta's Company view: Company still shows it to every
 * operator, as "For @Scott", and Raise limit / Keep paused wait behind "This is
 * for @Scott. Continue?".
 */
export const BudgetOwnerCardInCompany: Story = {
  args: {
    viewerId: DOTTA,
    initialView: "company",
    items: { ...ITEMS, company: [BUDGET_OWNER_STOP, BUDGET_OVERRIDE_APPROVAL, ...COMPANY_CARDS] },
    counts: { ...COUNTS, company: COMPANY_CARDS.length + 1 },
    expandedId: "budget-owned",
  },
};

/** Nothing waits in the pool, so For you shows no banner. */
export const ForYouNoBanner: Story = {
  args: { counts: { ...COUNTS, unassigned: 0 } },
};
