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
  | "escalation_owner"
  | "none";

export interface AttentionAudience {
  kind: AttentionAudienceKind;
  userId: string | null;
  reason: AttentionAudienceReason;
}

/**
 * Which slice of the attention feed to return. `all` is the default and is a
 * superset that preserves the pre-PAP-749 behaviour (no user-visible change);
 * `mine`, `unassigned`, and `company` partition the feed by {@link
 * AttentionAudience.kind}.
 */
export type AttentionFeedView = "mine" | "unassigned" | "company" | "all";

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
   * Opaque fingerprint of the card's important content for this viewer
   * (PAP-749 plan §2, Rule 9). Send it with a dismiss or snooze; the hidden
   * card returns only when the fingerprint changes, not on log entries,
   * retries, unrelated comments or assignee changes.
   */
  changeFingerprint: string;
  project: AttentionProjectRef | null;
  workspace: AttentionWorkspaceRef | null;
  expiresAt: string | null;
  ruleKey: string | null;
  originAgentName: string | null;
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
   * The sidebar badge: distinct items that either surfaced today ("new today")
   * or carry an explicit decide-by deadline that is due today/past ("overdue").
   * Computed before pagination so a small first page still reflects the
   * company-wide load. The desk no longer editorializes about what "can wait".
   */
  deskBadgeCount: number;
  nextCursor: string | null;
  countsBySourceKind: Record<AttentionSourceKind, number>;
  items: AttentionItem[];
}
/** Read-only projection of canonical task decisions; never a second write store. */
export interface DecisionHistoryItem {
  id: string;
  sourceKind: "issue_thread_interaction" | "decision";
  sourceId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  agentId: string | null;
  agentName: string | null;
  projectId: string | null;
  projectName: string | null;
  title: string;
  outcome: string;
  label: string;
  resolvedAt: string;
  resolvedByUserId: string | null;
  resolvedByAgentId: string | null;
  href: string;
  target: { kind: "issue_document"; issueId?: string; key: string; revisionId: string } | { kind: "issue_attachment"; attachmentId: string } | null;
}

export interface DecisionHistoryQuery {
  cursor?: string;
  limit?: number;
  search?: string;
  outcome?: string;
  agentId?: string;
  projectId?: string;
  sort?: "newest" | "oldest";
  since?: string;
}

export interface DecisionHistoryPage {
  items: DecisionHistoryItem[];
  nextCursor: string | null;
}
