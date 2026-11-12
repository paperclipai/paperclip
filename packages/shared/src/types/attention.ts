import type {
  IssueThreadInteractionCanonicalResolverPolicy,
  IssueThreadInteractionEffectiveResolverPolicySource,
  IssueThreadInteractionResolverPolicyProvenance,
} from "../constants.js";
import type { InboxDismissalKind } from "./inbox-dismissal.js";

export const ATTENTION_SOURCE_KINDS = [
  "approval",
  "decision",
  "issue_thread_interaction",
  "join_request",
  "recovery_action",
  // Legacy persisted decision sources remain readable; no feed items are generated.
  "productivity_review",
  "blocker_attention",
  "review",
  "failed_run",
  "budget_alert",
  "agent_error_alert",
] as const;

export type AttentionSourceKind = (typeof ATTENTION_SOURCE_KINDS)[number];

export type AttentionSubjectKind =
  | "approval"
  | "decision"
  | "issue"
  | "interaction"
  | "join_request"
  | "recovery_action"
  | "run"
  | "budget_incident"
  | "agent";

export type AttentionSeverity = "critical" | "high" | "medium" | "low";

export interface AttentionSubject {
  kind: AttentionSubjectKind;
  id: string;
  companyId: string;
  title: string | null;
  identifier: string | null;
  status: string | null;
  href: string | null;
  metadata?: Record<string, unknown>;
}

export interface AttentionDecisionVerb {
  id: string;
  label: string;
  description: string | null;
}

export interface AttentionProjectRef {
  id: string;
  name: string;
  urlKey: string;
  color: string | null;
  icon: string | null;
}

export interface AttentionWorkspaceRef {
  id: string;
  name: string;
}

export interface AttentionQueueRef {
  key: string;
  title: string;
}

export interface AttentionTriageAttribution {
  type: "agent" | "user";
  agentId: string | null;
  agentName: string | null;
  userId: string | null;
  runId: string | null;
  responsibleUserId: string | null;
  updatedAt: string;
}

export type AttentionSortMode = "activity" | "decide";

export interface AttentionFeedQuery {
  includeDismissed?: boolean;
  archived?: boolean;
  /**
   * Which audience slice to return (PAP-749 plan §1). Defaults to `all`, the
   * pre-PAP-749 superset, so omitting it keeps the current user-visible feed.
   */
  view?: AttentionFeedView;
  /** Return the complete filtered snapshot in one response. */
  all?: boolean;
  activitySince?: string;
  activityUntil?: string;
  queue?: string;
  sort?: AttentionSortMode;
  cursor?: string;
  limit?: number;
}

export interface AttentionDetailImage {
  assetId: string;
  alt?: string | null;
}

export interface AttentionItemDismissal {
  kind: InboxDismissalKind;
  dismissedAt: string;
  snoozedUntil: string | null;
  isActive: boolean;
}

export type AttentionItemDetail =
  | {
      kind: "approval";
      approvalType: string;
      summaryExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "plan_approval";
      issueTitle: string | null;
      planTitle: string | null;
      summaryExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "confirmation";
      promptExcerpt: string | null;
      isPlanTarget: false;
      images: AttentionDetailImage[];
    }
  | {
      kind: "questions";
      questionCount: number;
      firstQuestionText: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "suggested_tasks";
      taskCount: number;
      firstTaskTitle: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "checkbox_confirmation";
      optionCount: number;
      promptExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "item_verdicts";
      itemCount: number;
      promptExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "failed_run";
      agentName: string | null;
      failureReasonExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "blocker";
      blockingIssue: {
        id: string | null;
        identifier: string | null;
        title: string | null;
      } | null;
      blockedTaskCount?: number;
      images: AttentionDetailImage[];
    }
  | {
      kind: "budget";
      observedPercent: number;
      amountObserved: number;
      amountLimit: number;
      images: AttentionDetailImage[];
    }
  | {
      kind: "agent_error";
      agentName: string | null;
      failureReasonExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "generic";
      summaryExcerpt: string | null;
      images: AttentionDetailImage[];
    };

/**
 * Who may resolve an issue-thread interaction, as the server evaluated it
 * (PAP-17287). A collapsed attention row carries decision buttons before the
 * full interaction is ever fetched, so the audience has to travel with the feed
 * item — otherwise the queue asks for a decision without saying whose it is.
 *
 * These are *facts*, not copy: the canonical policy the resolution evaluator
 * will apply plus the identities it will compare against. Presentation layers
 * turn them into a sentence; nothing here grants or withholds capability, which
 * the server re-checks at use time.
 */
export interface AttentionResolverAudience {
  /** Canonical policy the creator asked for, before caps and clamps. */
  requestedResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
  /** Canonical policy the server will actually enforce. */
  effectiveResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
  /** Why the effective policy differs from the requested one, if it does. */
  effectiveResolverPolicySource: IssueThreadInteractionEffectiveResolverPolicySource;
  /** Whether the requested policy was explicit, inherited, or pre-migration. */
  resolverPolicyProvenance: IssueThreadInteractionResolverPolicyProvenance;
  /** Agent the card is addressed to, when it names one. */
  addresseeAgentId: string | null;
  /** User the card is addressed to, when it names one. */
  addresseeUserId?: string | null;
  /** Display name of the agent addressee, resolved server-side. */
  addresseeName: string | null;
  /** Agent that created the card, excluded when the policy is `not_creator`. */
  createdByAgentId: string | null;
  /** Display name of {@link createdByAgentId}, resolved server-side. */
  createdByAgentName: string | null;
}

/**
 * Where a card *shows* (PAP-749 plan §1, Rule 2) — distinct from
 * {@link AttentionResolverAudience}, which says who may *act*. The server
 * computes this once per item from participation facts (an explicit addressee,
 * the chat user, the review participant or human assignee, or the instigator
 * who created the originating human work) and never from `responsibleUserId`,
 * the routine creator, a connected account, the agent owner, or a manual
 * routine starter. `kind` drives the three-view switch: `user` belongs in that
 * user's "For you" list, `pool` belongs in the claimable "Unassigned" pool, and
 * `company` belongs in the operator "Company" view. Audience governs placement
 * only; the resolver policy still gates every action.
 */
export type AttentionAudienceKind = "user" | "pool" | "company";

export type AttentionAudienceReason =
  | "addressee"
  | "conversation"
  | "reviewer"
  | "assignee"
  | "instigator"
  | "requester"
  /** The company's default decision owner (task 1d-lite). */
  | "escalation_owner"
  /** The decision owner of the card's project (task 1d). */
  | "project_owner"
  /** The company's budget owner, on a budget hard stop (task 1d). */
  | "budget_owner"
  | "none";

export interface AttentionAudience {
  kind: AttentionAudienceKind;
  userId: string | null;
  reason: AttentionAudienceReason;
  /**
   * A company alert that also has a personal owner (PAP-749 plan §1, Rule 3):
   * the card shows in {@link userId}'s "For you" list and in the Company view.
   * Only a budget hard stop with a budget owner sets it today.
   */
  alsoInCompany?: boolean;
  /**
   * The person who transferred the card to {@link userId} ("Route to @x"),
   * when the addressee came from a transfer (PAP-749 plan §6, Rule 12). The
   * "Why me?" line reads "Transferred by @x".
   */
  transferredByUserId?: string | null;
}

/**
 * Which slice of the attention feed to return. `all` is the default and is a
 * superset that preserves the pre-PAP-749 behaviour (no user-visible change);
 * `mine`, `unassigned`, and `company` partition the feed by {@link
 * AttentionAudience.kind}. `archived` is the requesting person's own hidden
 * cards (PAP-749 plan §3): open cards they archived or snoozed, read from
 * their `inbox_dismissals`, whatever the card's audience.
 */
export type AttentionFeedView = "mine" | "unassigned" | "company" | "archived" | "all";

/**
 * The views the Decisions pages switch between (PAP-749 plan §1, Rule 3; §3):
 * For you, Unassigned, Company, the person's own Archived view, and Everyone
 * (`all`, every person's cards), which only board members see (PAP-768).
 */
export const ATTENTION_PERSONAL_VIEWS = ["mine", "unassigned", "company", "archived", "all"] as const;
export type AttentionPersonalView = (typeof ATTENTION_PERSONAL_VIEWS)[number];

/**
 * Cards in each view for the requesting user (PAP-749 plan §1, Rule 5).
 * Counted before the view, date and queue filters and pagination, so every
 * surface reads the same numbers whatever it fetched. `mine`, `unassigned`,
 * `company` and `all` count current cards without the ones this person
 * archived or snoozed; `archived` counts exactly those hidden cards (archived
 * plus snoozed). Only `mine` is the badge; the other counts stay on their tabs.
 */
export type AttentionViewCounts = Record<AttentionPersonalView, number>;

/**
 * Source kinds whose card names a person through an addressee field, so Claim
 * and Transfer can store the new owner there (PAP-749 plan §1, Rule 3; §2,
 * Rule 6). Other kinds have no addressee to set yet.
 */
export const ATTENTION_CLAIMABLE_SOURCE_KINDS = ["issue_thread_interaction"] as const;
export type AttentionClaimableSourceKind = (typeof ATTENTION_CLAIMABLE_SOURCE_KINDS)[number];

/** Result of `POST /companies/:companyId/attention/:sourceKind/:sourceId/claim`. */
export interface AttentionClaimResult {
  sourceKind: AttentionClaimableSourceKind;
  sourceId: string;
  claimedByUserId: string;
  /** `true` when the caller already owned the card; nothing changed. */
  alreadyClaimed: boolean;
}

/**
 * The verbs of the Close… menu (PAP-749 plan §2, Rule 6). Each has one effect:
 * - `withdraw`: closes the request for everyone because it is out of date. It
 *   is never an approval or consent, and it tells the agent.
 * - `archive`: hides the card for you only, until it changes. The source stays
 *   open and teammates still see it.
 * - `snooze`: hides the card for you only, until a time you pick. It does not
 *   change a shared deadline.
 * Transfer is not a close mode; it has its own endpoint.
 */
export const ATTENTION_CLOSE_MODES = ["withdraw", "archive", "snooze"] as const;
export type AttentionCloseMode = (typeof ATTENTION_CLOSE_MODES)[number];

/** Body of `POST /companies/:companyId/attention/:sourceKind/:sourceId/close`. */
export interface AttentionCloseInput {
  mode: AttentionCloseMode;
  /** Why the request is out of date. Shown in history and sent to the agent. */
  reason?: string | null;
  /** Snooze end, ISO timestamp in the future. Required for `snooze` only. */
  until?: string | null;
  /**
   * The card's `changeFingerprint` as the viewer saw it, for `archive` and
   * `snooze`. The card returns when its content differs from this version.
   * Omitted: the server uses the current version.
   */
  fingerprint?: string | null;
}

/** Result of the close endpoint. */
export interface AttentionCloseResult {
  sourceKind: AttentionSourceKind;
  sourceId: string;
  mode: AttentionCloseMode;
  closedByUserId: string;
  /** The task the card belongs to, when it has one. */
  issueId: string | null;
  /** Snooze end for `snooze`; `null` otherwise. */
  until: string | null;
}

/** Body of `POST /companies/:companyId/attention/:sourceKind/:sourceId/transfer`. */
export interface AttentionTransferInput {
  /** The person who gets the card ("Route to @x"). */
  userId: string;
  reason?: string | null;
}

/** Result of the transfer endpoint. */
export interface AttentionTransferResult {
  sourceKind: AttentionClaimableSourceKind;
  sourceId: string;
  transferredToUserId: string;
  /** The person the card was for before the transfer, if any. */
  previousAddresseeUserId: string | null;
  /** `true` when the card already went to that person; nothing changed. */
  alreadyTransferred: boolean;
}

/**
 * Details of the 409 that the close, claim and transfer endpoints return when
 * a different person already answered or closed the source first (PAP-749
 * plan §2, "Two persons answer at the same time"). The UI shows "Already
 * answered by @x".
 */
export interface AttentionAlreadyClosedDetails {
  code: "attention_already_closed";
  sourceKind: AttentionSourceKind;
  sourceId: string;
  status: string;
  resolvedByUserId: string | null;
  resolvedByAgentId: string | null;
  resolvedAt: string | null;
}

/**
 * Why a card is stale (PAP-749 plan §2, Rule 10). A stale card stays open and
 * answerable; the label only moves it to the Stale group. The server never
 * withdraws a stale card and never treats one as approved.
 * - `issue_closed`: its task is done or cancelled and the card is still pending.
 * - `aged`: no important change for 30 days ("Waiting 30+ days").
 * - `decision_expiring`: a decision with 80% or more of its time limit gone.
 * - `unowned`: an Unassigned card with no owner for 7 days ("No owner for 7+
 *   days"); it moves to the Company view.
 */
export type AttentionStaleReason = "issue_closed" | "aged" | "decision_expiring" | "unowned";

export interface AttentionStale {
  reason: AttentionStaleReason;
}

/**
 * What a different person did with a card that was for you (PAP-749 plan §6,
 * Rule 12). Archive and snooze are personal, so they never make a receipt;
 * Claim takes only ownerless cards, so it has no audience person to tell.
 * Decision history names the same action with the same value, so a receipt
 * and its history row read the same verb (PAP-767).
 */
export const ATTENTION_RECEIPT_OUTCOMES = [
  "answered",
  "approved",
  "rejected",
  "changes_requested",
  "revision_requested",
  "decided",
  "withdrawn",
  "skipped",
  "transferred",
  "kept_paused",
  "limit_raised",
] as const;
export type AttentionReceiptOutcome = (typeof ATTENTION_RECEIPT_OUTCOMES)[number];

/** A receipt stays at the top of For you this long, or until its person dismisses it. */
export const ATTENTION_RECEIPT_DAYS = 7;

/**
 * Stored on the activity entry of the action as `details.receipt`, next to
 * `details.handledForUserId` (the card's audience person at the time of the
 * action). Present only when that person is not the actor. Receipts and the
 * "Handled for me" history filter read these; there is no receipts table.
 */
export interface AttentionHandledDetails {
  outcome: AttentionReceiptOutcome;
  sourceKind: AttentionSourceKind;
  sourceId: string;
  issueId: string | null;
  /** The card title when the person acted. */
  title: string | null;
  /** The person who acted. Decisions log as the executor, so it is kept here. */
  actorUserId: string;
  reason?: string | null;
  /** For `transferred`: who got the card. */
  transferredToUserId?: string | null;
}

/**
 * One receipt at the top of For you: "Answered by @scott", "Withdrawn by
 * @scott" with the reason, "Transferred to @riley by @scott". A receipt is not
 * a card and is never in the badge count.
 */
export interface AttentionReceipt {
  /** The activity entry the receipt comes from. */
  id: string;
  /** Inbox dismissal key; dismissing it hides the receipt for you. */
  dismissalKey: string;
  outcome: AttentionReceiptOutcome;
  sourceKind: AttentionSourceKind;
  sourceId: string;
  title: string | null;
  reason: string | null;
  actorUserId: string;
  transferredToUserId: string | null;
  issue: { id: string; identifier: string | null; title: string; href: string } | null;
  /** Where the source shows now: its task thread, or the approval page. */
  href: string | null;
  createdAt: string;
  /** When the receipt leaves For you on its own. */
  expiresAt: string;
}

export interface AttentionRequester {
  kind: "agent" | "user";
  id: string;
  name: string | null;
}

/**
 * The two kinds of Needs You card (PAP-775, IA7): a `decision` asks a person
 * to choose, answer or approve; a `problem` reports something that broke (a
 * failed run, an agent error, a budget stop, a stuck task). Each card is
 * exactly one kind.
 */
export type AttentionCardKind = "decision" | "problem";

const ATTENTION_PROBLEM_SOURCE_KINDS: ReadonlySet<AttentionSourceKind> = new Set([
  "failed_run",
  "agent_error_alert",
  "budget_alert",
  "blocker_attention",
  "recovery_action",
]);

export function attentionCardKind(item: Pick<AttentionItem, "sourceKind" | "subject">): AttentionCardKind {
  if (ATTENTION_PROBLEM_SOURCE_KINDS.has(item.sourceKind)) return "problem";
  // A review with no reviewer and no way forward is a stuck task.
  if (item.sourceKind === "review" && item.subject.metadata?.reviewAttentionState === "stalled") return "problem";
  return "decision";
}

/**
 * Which of the Needs You card designs a card uses (PAP-775, Paper "A · Compact
 * cards"): one design per type of request, each with its own context panel and
 * actions. Receipts are the `update` type and never reach this from the feed.
 */
export type AttentionCardType =
  | "answer_questions"
  | "make_choice"
  | "review_plan"
  | "confirm"
  | "suggested_tasks"
  | "review_deliverable"
  | "review_items"
  | "board_approval"
  | "join_request"
  | "tool_access"
  | "connect_service"
  | "review_task"
  | "failed_run"
  | "budget_stop"
  | "blocked_task"
  | "recovery";

/**
 * What an interaction confirmation is about, read from its payload so the feed
 * can pick the card design before the interaction itself loads.
 */
export type AttentionRequestKind = "tool_action" | "secret" | "connection" | "access" | "deliverable";

export function attentionCardType(item: Pick<AttentionItem, "sourceKind" | "subject">): AttentionCardType {
  const metadata = item.subject.metadata ?? {};
  switch (item.sourceKind) {
    case "issue_thread_interaction": {
      const requestKind = metadata.requestKind as AttentionRequestKind | null | undefined;
      if (requestKind === "tool_action" || requestKind === "secret" || requestKind === "access") return "tool_access";
      if (requestKind === "connection") return "connect_service";
      if (metadata.kind === "connection_intent") return "connect_service";
      if (metadata.kind === "ask_user_questions") return "answer_questions";
      if (metadata.kind === "suggest_tasks") return "suggested_tasks";
      if (metadata.kind === "request_item_verdicts") return "review_items";
      if (metadata.isPlanTarget === true) return "review_plan";
      if (requestKind === "deliverable") return "review_deliverable";
      return "confirm";
    }
    case "decision": return "make_choice";
    case "approval": return "board_approval";
    case "join_request": return "join_request";
    case "review": return metadata.reviewAttentionState === "stalled" ? "blocked_task" : "review_task";
    case "blocker_attention": return "blocked_task";
    case "failed_run":
    case "agent_error_alert": return "failed_run";
    case "budget_alert": return "budget_stop";
    case "recovery_action": return "recovery";
    default: return "confirm";
  }
}

export interface AttentionItem {
  id: string;
  companyId: string;
  sourceKind: AttentionSourceKind;
  subject: AttentionSubject;
  whyNow: string;
  decisionVerbs: AttentionDecisionVerb[];
  inlineResolvable: boolean;
  entryRule: string;
  exitRule: string;
  dedupKey: string;
  dismissalKey: string;
  dismissal: AttentionItemDismissal | null;
  severity: AttentionSeverity;
  rank: number;
  activityAt: string;
  createdAt: string;
  updatedAt: string;
  relatedIssue: AttentionSubject | null;
  /** Where this card shows (PAP-749 plan §1, Rule 2). Placement only; never authority. */
  audience: AttentionAudience;
  /** Set when the card is stale (PAP-749 plan §2, Rule 10); `null` for a current card. */
  stale: AttentionStale | null;
  /**
   * The card is a required gate: an approval or a governed request that keeps
   * its gate until someone answers it (PAP-749 plan §2, Rule 10). A stale
   * required card goes to a person; "Withdraw all stale" never closes it. A
   * person can still withdraw one from its own Close… menu.
   */
  required: boolean;
  /**
   * Opaque fingerprint of the card's important content for this viewer
   * (PAP-749 plan §2, Rule 9). Send it with a dismiss or snooze; the hidden
   * card returns only when the fingerprint changes, not on log entries,
   * retries, unrelated comments or assignee changes.
   */
  changeFingerprint: string;
  /**
   * The Close… menu verbs the server supports for this card (PAP-749 plan §2,
   * Rule 6). `withdraw` is present only when the source has a real withdraw
   * or cancel; budget, review, blocker and operator alerts use their own
   * actions instead.
   */
  closeModes: AttentionCloseMode[];
  /**
   * One card for each obligation (PAP-749 plan §2, Rule 11). Cards with the
   * same key are one obligation: a pending approval with the in-review state of
   * its task (`approval:<approvalId>`), a budget hard stop with its override
   * approval (`approval:<approvalId>`, the stop leads; PAP-768), or a blocked
   * task with the failed run that caused it (`blocked:<issueId>`). The UI shows the lead card and folds
   * the others into it as evidence; the feed still returns every card, keeps
   * the evidence right after its lead, and shows or hides it with the lead.
   * `null` when the card is its own obligation. A configured human review
   * stage is an independent quality gate, so it keeps its own card.
   */
  obligationKey: string | null;
  /** The `id` of the card that leads the obligation; set with `obligationKey`. */
  obligationLeadId: string | null;
  project: AttentionProjectRef | null;
  workspace: AttentionWorkspaceRef | null;
  expiresAt: string | null;
  ruleKey: string | null;
  originAgentName: string | null;
  /**
   * Who is asking (PAP-775, UI2): the agent or person that created the
   * request, so a card can show their avatar and name. `name` is set for an
   * agent; a person's name comes from the company directory. `null` for a
   * system alert nobody asked for.
   */
  requester?: AttentionRequester | null;
  queues: AttentionQueueRef[];
  shelf: boolean;
  retentionDays: number;
  keep: boolean;
  archivedAt: string | null;
  retentionVersion: number;
  decideBy: string | null;
  decideByAttribution: AttentionTriageAttribution | null;
  snoozedUntil: string | null;
  detail: AttentionItemDetail | null;
  trainingExampleId: string | null;
  /**
   * Set for `issue_thread_interaction` rows only. Absent on every other source
   * kind, whose decisions are not governed by a resolver policy.
   */
  resolverAudience?: AttentionResolverAudience | null;
}

export interface AttentionFeed {
  companyId: string;
  generatedAt: string;
  totalCount: number;
  /**
   * The one badge on the sidebar, mobile navigation and Decisions page
   * (PAP-749 plan §1, Rule 5): current "For you" cards, the same number as
   * `viewCounts.mine`. It does not reset at midnight; an open card stays in the
   * count until a person answers it. Unassigned and Company are never in it.
   */
  deskBadgeCount: number;
  /**
   * Per-view counts for the three-view switch and the Unassigned banner. Each
   * obligation counts once, so a lead and its evidence are one (Rule 11).
   */
  viewCounts: AttentionViewCounts;
  nextCursor: string | null;
  countsBySourceKind: Record<AttentionSourceKind, number>;
  items: AttentionItem[];
  /**
   * Receipts for the requesting person, newest first (PAP-749 plan §6). Set
   * for the For you view (`view=mine`) only; not counted in any badge.
   */
  receipts?: AttentionReceipt[];
}

/** Canonical attention counts without downloading the decision cards. */
export type AttentionSummary = Omit<AttentionFeed, "items" | "nextCursor">;
/** Complete accessible task membership for Tasks → Needs attention. */
export interface AttentionTaskIndex extends AttentionSummary {
  taskIds: string[];
}
/** Read-only projection of canonical task decisions; never a second write store. */
/**
 * Read-only projection of canonical task decisions and approvals (PAP-749 plan
 * §3); never a second write store.
 */
export interface DecisionHistoryItem {
  id: string;
  sourceKind: "issue_thread_interaction" | "decision" | "approval";
  sourceId: string;
  /** The task the decision belongs to. `null` for an approval with no linked task. */
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  agentId: string | null;
  agentName: string | null;
  projectId: string | null;
  projectName: string | null;
  title: string;
  /** The stored status: `accepted`, `answered`, `cancelled`, `expired`, `approved`, … */
  outcome: string;
  /**
   * The more specific recorded close, when the status alone hides it:
   * `withdrawn` (a person or the agent withdrew the request), `skipped` or
   * `issue_closed` ("Closed with task"). `null` for an ordinary answer.
   */
  resultOutcome?: DecisionHistoryResultOutcome | null;
  label: string;
  /**
   * What the person did, in the receipt's words: the UI renders "Approved by
   * @scott" from this and `resolvedByUserId`, like the receipt for the same
   * action (PAP-767). `detail` is what the verb leaves out: the chosen option
   * of a decision, or the verdict counts of an item review. `null` when no
   * person acted (expired, closed with its task, superseded).
   */
  action?: DecisionHistoryAction | null;
  /** Why the request was withdrawn or skipped, when the person gave a reason. */
  reason?: string | null;
  resolvedAt: string;
  resolvedByUserId: string | null;
  resolvedByAgentId: string | null;
  /**
   * The person the card was for, when a different person answered, withdrew
   * or transferred it ("Answered by @x for @y"; PAP-749 plan §6).
   */
  handledForUserId?: string | null;
  href: string;
  target: { kind: "issue_document"; issueId?: string; key: string; revisionId: string } | { kind: "issue_attachment"; attachmentId: string } | null;
}

export type DecisionHistoryResultOutcome = "withdrawn" | "skipped" | "issue_closed";

export interface DecisionHistoryAction {
  outcome: AttentionReceiptOutcome;
  detail: string | null;
}

/**
 * Outcome filters of the Decision history panel (PAP-749 plan §3). Each value
 * matches every source that can have it: `withdrawn` covers withdrawn
 * interactions and the decisions and approvals a person withdrew; `expired`
 * is a time-out or supersede, never a card that closed with its task;
 * `issue_closed` is "Closed with task".
 */
export const DECISION_HISTORY_OUTCOME_FILTERS = [
  "accepted",
  "answered",
  "rejected",
  "decided",
  "withdrawn",
  "expired",
  "issue_closed",
  "cancelled",
] as const;
export type DecisionHistoryOutcomeFilter = (typeof DECISION_HISTORY_OUTCOME_FILTERS)[number];

export interface DecisionHistoryQuery {
  cursor?: string;
  limit?: number;
  search?: string;
  outcome?: string;
  agentId?: string;
  projectId?: string;
  sort?: "newest" | "oldest";
  since?: string;
  /** "Handled for me": only cards for you that a different person handled (PAP-749 plan §6). */
  handledForMe?: boolean;
  /**
   * Whose history (PAP-768). `mine` is "Handled by me or for me": what you
   * answered, withdrew or transferred, what a different person handled for
   * you, and the cards whose audience is you. `all` (the default) is every
   * person's history. The outcome filters apply within either scope.
   */
  scope?: DecisionHistoryScope;
}

export const DECISION_HISTORY_SCOPES = ["mine", "all"] as const;
export type DecisionHistoryScope = (typeof DECISION_HISTORY_SCOPES)[number];

export interface DecisionHistoryPage {
  items: DecisionHistoryItem[];
  nextCursor: string | null;
}
