import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  AttentionAudience,
  AttentionItem,
  AttentionPersonalView,
  AttentionSourceKind,
  AttentionViewCounts,
} from "@paperclipai/shared";
import { AttentionQueueRow } from "@/components/AttentionQueueRow";
import { AttentionUnassignedBanner, AttentionViewSwitch } from "@/components/AttentionViews";

// PAP-749 task 1b: the three-view switch, the "Why me?" line, the "For @name"
// chip, Claim and the Unassigned banner, as the classic Decisions page and
// Coordinator Needs You render them. Scott is the viewer.
const companyId = "company-storybook";
const SCOTT = "user-scott";
const DOTTA = "user-dotta";
const USER_LABELS: ReadonlyMap<string, string> = new Map([[SCOTT, "Scott"], [DOTTA, "Dotta"]]);
const NOW = Date.parse("2026-10-30T12:00:00Z");
const HOUR = 60 * 60 * 1000;
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
    changeFingerprint: "fixture.me", closeModes: ["archive", "snooze"],
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

const FOR_YOU: AttentionItem[] = [
  card("q-scott", "issue_thread_interaction", "Which rollout order should we use?", "An agent asked you two questions.", forScott("addressee")),
  card("review-scott", "review", "Review the pricing page copy", "Waiting on your review.", forScott("reviewer")),
  card("confirm-scott", "issue_thread_interaction", "Approve the migration plan", "A child task of your task needs a confirmation.", forScott("instigator")),
  card("approval-scott", "approval", "Hire agent: Research Analyst", "You asked for this hire.", forScott("requester")),
  card("owner-scott", "decision", "Pick a vendor for transcripts", "No other owner; you are the company's default decision owner.", forScott("escalation_owner")),
];

const UNASSIGNED: AttentionItem[] = [
  card("pool-routine", "issue_thread_interaction", "Confirm the weekly digest recipients", "A routine-created task asks for a confirmation.", POOL),
  card("pool-agent", "issue_thread_interaction", "Answer a question for a paused agent", "The agent it was sent to cannot run.", POOL),
  card("pool-decision", "decision", "Choose a retry budget", "An agent-created task needs a decision.", POOL),
];

const COMPANY_CARDS: AttentionItem[] = [
  card("failed-run", "failed_run", "Nightly sync failed after all retries", "The last of three retries failed.", COMPANY, { severity: "high" }),
  card("budget", "budget_alert", "Budget hard stop: Research team", "Spend reached 100% of the monthly limit.", COMPANY, { severity: "critical" }),
  card("stale-pool", "issue_thread_interaction", "Confirm the release checklist", "No owner for 7+ days.", COMPANY),
];

const FOR_OTHERS: AttentionItem[] = [
  card("q-dotta", "issue_thread_interaction", "Which launch date works for marketing?", "Sent to Dotta.", { kind: "user", userId: DOTTA, reason: "addressee" }),
  card("review-dotta", "review", "Review the onboarding email", "Dotta is the reviewer.", { kind: "user", userId: DOTTA, reason: "reviewer" }),
];

const COUNTS: AttentionViewCounts = { mine: FOR_YOU.length, unassigned: UNASSIGNED.length, company: COMPANY_CARDS.length };
const ITEMS: Record<AttentionPersonalView, AttentionItem[]> = { mine: FOR_YOU, unassigned: UNASSIGNED, company: COMPANY_CARDS };

function NeedsYouViews({
  initialView = "mine",
  items = ITEMS,
  counts = COUNTS,
}: {
  initialView?: AttentionPersonalView;
  items?: Record<AttentionPersonalView, AttentionItem[]>;
  counts?: AttentionViewCounts;
}) {
  const [view, setView] = useState<AttentionPersonalView>(initialView);
  const [claimed, setClaimed] = useState<Set<string>>(() => new Set());
  const rows = items[view].filter((item) => !claimed.has(item.id));
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-xl font-bold">Decisions</h1>
      <AttentionViewSwitch value={view} counts={counts} onChange={setView} />
      {view === "mine" && <AttentionUnassignedBanner count={counts.unassigned} onOpen={() => setView("unassigned")} />}
      <div className="space-y-4">
        {rows.map((item) => (
          <AttentionQueueRow
            key={item.id}
            item={item}
            companyId={companyId}
            expanded={false}
            onToggleExpand={noop}
            onDismiss={noop}
            currentUserId={SCOTT}
            userLabelMap={USER_LABELS}
            onClaim={(entry) => setClaimed((current) => new Set(current).add(entry.id))}
          />
        ))}
      </div>
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
      "notes": "Mounts the shipped view switch, Unassigned banner and AttentionQueueRow audience line with fixture cards; Scott is the viewer. Claim only hides the row locally here; the real claim endpoint, live updates and per-user server views need the running app."
    },
  },
};
export default meta;

type Story = StoryObj<typeof NeedsYouViews>;

/** Default view with the "Why me?" line for each audience reason and the banner. */
export const ForYou: Story = {};

/** Ownerless cards: why you can answer, and Claim. */
export const Unassigned: Story = { args: { initialView: "unassigned" } };

/** Operator alerts, plus an ownerless card that moved here after 7 days. */
export const Company: Story = { args: { initialView: "company" } };

/** Cards for a different person show "For @name" instead of "Why me?". */
export const ForAnotherPerson: Story = {
  args: { initialView: "company", items: { ...ITEMS, company: FOR_OTHERS } },
};

/** Nothing waits in the pool, so For you shows no banner. */
export const ForYouNoBanner: Story = {
  args: { counts: { ...COUNTS, unassigned: 0 } },
};
