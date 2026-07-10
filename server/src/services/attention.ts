import { and, desc, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  invites,
  issueApprovals,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  joinRequests,
} from "@paperclipai/db";
import type {
  AttentionDecisionVerb,
  AttentionFeed,
  AttentionItem,
  AttentionSeverity,
  AttentionSourceKind,
  AttentionSubject,
} from "@paperclipai/shared";
import { PRODUCTIVITY_REVIEW_ORIGIN_KIND } from "./productivity-review.js";
import { budgetService } from "./budgets.js";
import { issueService } from "./issues.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

const ATTENTION_SOURCE_KINDS: AttentionSourceKind[] = [
  "approval",
  "issue_thread_interaction",
  "join_request",
  "recovery_action",
  "productivity_review",
  "blocker_attention",
  "review",
  "failed_run",
  "budget_alert",
  "agent_error_alert",
];

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SOURCE_RANK: Record<AttentionSourceKind, number> = {
  failed_run: 0,
  recovery_action: 1,
  blocker_attention: 2,
  budget_alert: 3,
  agent_error_alert: 4,
  approval: 5,
  issue_thread_interaction: 6,
  review: 7,
  productivity_review: 8,
  join_request: 9,
};

const PENDING_INTERACTION_STATUSES = ["pending"] as const;
const OPEN_RECOVERY_STATUSES = ["active", "escalated"] as const;
const HUMAN_RECOVERY_OWNER_TYPES = ["user", "board"] as const;
const PRODUCTIVITY_REVIEW_TERMINAL_STATUSES = ["done", "cancelled"] as const;
const FAILED_RUN_STATUSES = ["failed", "timed_out"] as const;

type IssueSummaryRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type AttentionListOptions = {
  userId?: string | null;
  includeDismissed?: boolean;
};

function emptyCounts(): Record<AttentionSourceKind, number> {
  return Object.fromEntries(ATTENTION_SOURCE_KINDS.map((kind) => [kind, 0])) as Record<AttentionSourceKind, number>;
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function timestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function isDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  dismissalKey: string,
  activityAt: string,
) {
  const dismissedAt = dismissedAtByKey.get(dismissalKey);
  return dismissedAt != null && dismissedAt >= timestamp(activityAt);
}

function issueHref(prefix: string, issue: Pick<IssueSummaryRow, "id" | "identifier">) {
  return `/${prefix}/issues/${issue.identifier ?? issue.id}`;
}

function issueSubject(prefix: string, issue: IssueSummaryRow): AttentionSubject {
  return {
    kind: "issue",
    id: issue.id,
    companyId: issue.companyId,
    title: issue.title,
    identifier: issue.identifier,
    status: issue.status,
    href: issueHref(prefix, issue),
    metadata: {
      priority: issue.priority,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
    },
  };
}

function itemId(sourceKind: AttentionSourceKind, dedupKey: string) {
  return `${sourceKind}:${dedupKey}`;
}

function decisionVerbs(...verbs: AttentionDecisionVerb[]): AttentionDecisionVerb[] {
  return verbs;
}

function createItem(input: Omit<AttentionItem, "id" | "dismissalKey" | "rank">): AttentionItem {
  return {
    ...input,
    id: itemId(input.sourceKind, input.dedupKey),
    dismissalKey: `attention:${input.dedupKey}`,
    rank: 0,
  };
}

function compareAttentionItems(left: AttentionItem, right: AttentionItem) {
  const severityDiff = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severityDiff !== 0) return severityDiff;
  const sourceDiff = SOURCE_RANK[left.sourceKind] - SOURCE_RANK[right.sourceKind];
  if (sourceDiff !== 0) return sourceDiff;
  const timeDiff = timestamp(right.activityAt) - timestamp(left.activityAt);
  if (timeDiff !== 0) return timeDiff;
  return left.dedupKey.localeCompare(right.dedupKey);
}

function betterDuplicate(left: AttentionItem, right: AttentionItem) {
  return compareAttentionItems(left, right) <= 0 ? left : right;
}

function approvalTitle(type: string, payload: Record<string, unknown>) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title) return title;
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (summary) return summary;
  return type.replaceAll("_", " ");
}

function interactionLabel(kind: string) {
  switch (kind) {
    case "request_confirmation":
      return "Confirmation requested";
    case "request_checkbox_confirmation":
      return "Selection confirmation requested";
    case "ask_user_questions":
      return "Questions need answers";
    case "suggest_tasks":
      return "Suggested tasks need a decision";
    default:
      return "Interaction needs a decision";
  }
}

function interactionVerbs(kind: string) {
  if (kind === "ask_user_questions") {
    return decisionVerbs({
      id: "respond",
      label: "Respond",
      description: "Submit answers to the pending questions.",
    });
  }
  return decisionVerbs(
    {
      id: "accept",
      label: "Accept",
      description: "Accept the pending interaction.",
    },
    {
      id: "reject",
      label: "Reject",
      description: "Reject the pending interaction and provide a reason when required.",
    },
  );
}

function budgetObservedPercent(amountObserved: number, amountLimit: number) {
  return amountLimit > 0 ? Math.round((amountObserved / amountLimit) * 10_000) / 100 : 0;
}

async function companyPrefix(db: Db, companyId: string) {
  const row = await db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  return row?.issuePrefix ?? "PAP";
}

async function dismissedAtByKey(db: Db, companyId: string, userId: string | null | undefined) {
  if (!userId) return new Map<string, number>();
  const rows = await db
    .select({ itemKey: inboxDismissals.itemKey, dismissedAt: inboxDismissals.dismissedAt })
    .from(inboxDismissals)
    .where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId, userId)));
  return new Map(rows.map((row) => [row.itemKey, timestamp(row.dismissedAt)]));
}

async function issueSummaryMap(db: Db, companyId: string, issueIds: Array<string | null | undefined>) {
  const ids = [...new Set(issueIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map<string, IssueSummaryRow>();
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids), isNull(issues.hiddenAt)));
  return new Map(rows.map((row) => [row.id, row]));
}

function readRunIssueId(contextSnapshot: Record<string, unknown> | null) {
  const issueId = contextSnapshot?.issueId ?? contextSnapshot?.taskId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

function runAttentionPairKey(agentId: string, issueId: string | null | undefined) {
  return `${agentId}:${issueId ?? ""}`;
}

export function attentionService(db: Db) {
  return {
    list: async (companyId: string, options: AttentionListOptions = {}): Promise<AttentionFeed> => {
      const prefix = await companyPrefix(db, companyId);
      const dismissed = await dismissedAtByKey(db, companyId, options.userId);
      const includeDismissed = options.includeDismissed === true;
      const collected: AttentionItem[] = [];

      const add = (item: AttentionItem) => {
        if (!includeDismissed && isDismissed(dismissed, item.dismissalKey, item.activityAt)) return;
        collected.push(item);
      };

      const pendingApprovals = await db
        .select({
          id: approvals.id,
          type: approvals.type,
          status: approvals.status,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          payload: approvals.payload,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
        })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .orderBy(desc(approvals.updatedAt), desc(approvals.id));

      for (const approval of pendingApprovals) {
        const dedupKey = `approval:${approval.id}`;
        const title = approvalTitle(approval.type, approval.payload);
        add(createItem({
          companyId,
          sourceKind: "approval",
          subject: {
            kind: "approval",
            id: approval.id,
            companyId,
            title,
            identifier: null,
            status: approval.status,
            href: `/${prefix}/approvals/${approval.id}`,
            metadata: {
              type: approval.type,
              requestedByAgentId: approval.requestedByAgentId,
              requestedByUserId: approval.requestedByUserId,
            },
          },
          whyNow: "Approval is pending a board decision.",
          decisionVerbs: decisionVerbs(
            { id: "approve", label: "Approve", description: "Approve the request." },
            { id: "reject", label: "Reject", description: "Reject the request." },
            { id: "request_revision", label: "Request revision", description: "Send the request back for changes." },
          ),
          inlineResolvable: approval.type !== "request_board_approval",
          entryRule: "approvals.status = 'pending'",
          exitRule: "Approval leaves pending status.",
          dedupKey,
          severity: "medium",
          activityAt: toIso(approval.updatedAt),
          createdAt: toIso(approval.createdAt),
          updatedAt: toIso(approval.updatedAt),
          relatedIssue: null,
        }));
      }

      const interactionRows = await db
        .select({
          id: issueThreadInteractions.id,
          issueId: issueThreadInteractions.issueId,
          kind: issueThreadInteractions.kind,
          status: issueThreadInteractions.status,
          title: issueThreadInteractions.title,
          summary: issueThreadInteractions.summary,
          createdAt: issueThreadInteractions.createdAt,
          updatedAt: issueThreadInteractions.updatedAt,
        })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          inArray(issueThreadInteractions.status, [...PENDING_INTERACTION_STATUSES]),
        ))
        .orderBy(desc(issueThreadInteractions.updatedAt), desc(issueThreadInteractions.id));
      const interactionIssueMap = await issueSummaryMap(db, companyId, interactionRows.map((row) => row.issueId));

      for (const interaction of interactionRows) {
        const issue = interactionIssueMap.get(interaction.issueId) ?? null;
        const dedupKey = `interaction:${interaction.id}`;
        add(createItem({
          companyId,
          sourceKind: "issue_thread_interaction",
          subject: {
            kind: "interaction",
            id: interaction.id,
            companyId,
            title: interaction.title ?? interaction.summary ?? interactionLabel(interaction.kind),
            identifier: null,
            status: interaction.status,
            href: issue ? `${issueHref(prefix, issue)}#interaction-${interaction.id}` : null,
            metadata: { kind: interaction.kind, issueId: interaction.issueId },
          },
          whyNow: `${interactionLabel(interaction.kind)} on an issue thread.`,
          decisionVerbs: interactionVerbs(interaction.kind),
          inlineResolvable: true,
          entryRule: "issue_thread_interactions.status = 'pending'",
          exitRule: "Interaction resolves, expires, fails, or is cancelled.",
          dedupKey,
          severity: "medium",
          activityAt: toIso(interaction.updatedAt),
          createdAt: toIso(interaction.createdAt),
          updatedAt: toIso(interaction.updatedAt),
          relatedIssue: issue ? issueSubject(prefix, issue) : null,
        }));
      }

      const pendingJoins = await db
        .select({
          id: joinRequests.id,
          requestType: joinRequests.requestType,
          status: joinRequests.status,
          requestingUserId: joinRequests.requestingUserId,
          requestEmailSnapshot: joinRequests.requestEmailSnapshot,
          agentName: joinRequests.agentName,
          adapterType: joinRequests.adapterType,
          createdAt: joinRequests.createdAt,
          updatedAt: joinRequests.updatedAt,
        })
        .from(joinRequests)
        .innerJoin(invites, eq(joinRequests.inviteId, invites.id))
        .where(and(
          eq(joinRequests.companyId, companyId),
          eq(invites.companyId, companyId),
          eq(joinRequests.status, "pending_approval"),
        ))
        .orderBy(desc(joinRequests.updatedAt), desc(joinRequests.id));

      for (const join of pendingJoins) {
        const label = join.requestType === "agent"
          ? join.agentName ?? "Agent join request"
          : join.requestEmailSnapshot ?? join.requestingUserId ?? "Human join request";
        const dedupKey = `join:${join.id}`;
        add(createItem({
          companyId,
          sourceKind: "join_request",
          subject: {
            kind: "join_request",
            id: join.id,
            companyId,
            title: label,
            identifier: null,
            status: join.status,
            href: `/${prefix}/settings/access`,
            metadata: {
              requestType: join.requestType,
              requestingUserId: join.requestingUserId,
              adapterType: join.adapterType,
            },
          },
          whyNow: "Join request is pending approval.",
          decisionVerbs: decisionVerbs(
            { id: "approve", label: "Approve", description: "Approve this join request." },
            { id: "reject", label: "Reject", description: "Reject this join request." },
          ),
          inlineResolvable: true,
          entryRule: "join_requests.status = 'pending_approval'",
          exitRule: "Join request is approved or rejected.",
          dedupKey,
          severity: "medium",
          activityAt: toIso(join.updatedAt),
          createdAt: toIso(join.createdAt),
          updatedAt: toIso(join.updatedAt),
          relatedIssue: null,
        }));
      }

      const recoveryRows = await db
        .select()
        .from(issueRecoveryActions)
        .where(and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.status, [...OPEN_RECOVERY_STATUSES]),
          inArray(issueRecoveryActions.ownerType, [...HUMAN_RECOVERY_OWNER_TYPES]),
        ))
        .orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id));
      const recoveryIssueMap = await issueSummaryMap(
        db,
        companyId,
        recoveryRows.flatMap((row) => [row.sourceIssueId, row.recoveryIssueId]),
      );

      for (const recovery of recoveryRows) {
        const sourceIssue = recoveryIssueMap.get(recovery.sourceIssueId) ?? null;
        const recoveryIssue = recovery.recoveryIssueId ? recoveryIssueMap.get(recovery.recoveryIssueId) ?? null : null;
        const dedupKey = `recovery:${recovery.kind}:${recovery.sourceIssueId}:${recovery.cause}:${recovery.fingerprint}`;
        add(createItem({
          companyId,
          sourceKind: "recovery_action",
          subject: {
            kind: "recovery_action",
            id: recovery.id,
            companyId,
            title: recovery.nextAction,
            identifier: null,
            status: recovery.status,
            href: recoveryIssue ? issueHref(prefix, recoveryIssue) : sourceIssue ? issueHref(prefix, sourceIssue) : null,
            metadata: {
              kind: recovery.kind,
              cause: recovery.cause,
              ownerType: recovery.ownerType,
              ownerUserId: recovery.ownerUserId,
              sourceIssueId: recovery.sourceIssueId,
              recoveryIssueId: recovery.recoveryIssueId,
            },
          },
          whyNow: recovery.status === "escalated"
            ? "Recovery action escalated to a human owner."
            : "Recovery action is assigned to a human owner.",
          decisionVerbs: decisionVerbs(
            { id: "resolve", label: "Resolve", description: "Record the recovery outcome." },
            { id: "reassign", label: "Reassign", description: "Move the recovery to another owner." },
            { id: "cancel", label: "Cancel", description: "Cancel the recovery action." },
          ),
          inlineResolvable: false,
          entryRule: "issue_recovery_actions.status in ('active','escalated') and owner_type in ('user','board')",
          exitRule: "Recovery action resolves, is cancelled, or moves back to an agent/system owner.",
          dedupKey,
          severity: recovery.status === "escalated" ? "high" : "medium",
          activityAt: toIso(recovery.updatedAt),
          createdAt: toIso(recovery.createdAt),
          updatedAt: toIso(recovery.updatedAt),
          relatedIssue: sourceIssue ? issueSubject(prefix, sourceIssue) : null,
        }));
      }

      const productivityRows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          originId: issues.originId,
          originFingerprint: issues.originFingerprint,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          isNull(issues.hiddenAt),
          isNotNull(issues.assigneeUserId),
          notInArray(issues.status, [...PRODUCTIVITY_REVIEW_TERMINAL_STATUSES]),
        ))
        .orderBy(desc(issues.updatedAt), desc(issues.id));
      const productivitySourceMap = await issueSummaryMap(db, companyId, productivityRows.map((row) => row.originId));

      for (const review of productivityRows) {
        const reviewIssue: IssueSummaryRow = review;
        const sourceIssue = review.originId ? productivitySourceMap.get(review.originId) ?? null : null;
        const dedupKey = `productivity_review:${review.originFingerprint ?? review.originId ?? review.id}`;
        add(createItem({
          companyId,
          sourceKind: "productivity_review",
          subject: issueSubject(prefix, reviewIssue),
          whyNow: "Productivity review is awaiting a human decision.",
          decisionVerbs: decisionVerbs(
            { id: "resolve", label: "Resolve", description: "Record a productivity review outcome." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this review for now." },
            { id: "reassign", label: "Reassign", description: "Move the review to another owner." },
          ),
          inlineResolvable: false,
          entryRule: "Open issue_productivity_review issue assigned to a user.",
          exitRule: "Review issue is done/cancelled or no longer assigned to a user.",
          dedupKey,
          severity: review.priority === "critical" ? "critical" : review.priority === "high" ? "high" : "medium",
          activityAt: toIso(review.updatedAt),
          createdAt: toIso(review.createdAt),
          updatedAt: toIso(review.updatedAt),
          relatedIssue: sourceIssue ? issueSubject(prefix, sourceIssue) : null,
        }));
      }

      const blockedIssues = await issueService(db).list(companyId, { status: "blocked", includeBlockedBy: true });
      for (const issue of blockedIssues as Array<IssueSummaryRow & { blockerAttention?: { state?: string; sampleStalledBlockerIdentifier?: string | null; sampleBlockerIdentifier?: string | null } | null }>) {
        const blockerAttention = issue.blockerAttention;
        if (blockerAttention?.state !== "stalled") continue;
        const sample = blockerAttention.sampleStalledBlockerIdentifier ?? blockerAttention.sampleBlockerIdentifier ?? issue.identifier ?? issue.id;
        const dedupKey = `blocker:${issue.id}:${sample}`;
        add(createItem({
          companyId,
          sourceKind: "blocker_attention",
          subject: issueSubject(prefix, issue),
          whyNow: "Blocked dependency chain is stalled and needs a human to choose the next owner or action.",
          decisionVerbs: decisionVerbs(
            { id: "unblock", label: "Unblock", description: "Repair or replace the stalled blocker path." },
            { id: "reassign", label: "Reassign", description: "Assign the stalled blocker to a live owner." },
            { id: "nudge", label: "Nudge", description: "Wake or prompt the current owner." },
          ),
          inlineResolvable: false,
          entryRule: "blocked issue has blockerAttention.state = 'stalled'",
          exitRule: "Blocker chain is no longer stalled or the issue leaves blocked status.",
          dedupKey,
          severity: "high",
          activityAt: toIso(issue.updatedAt),
          createdAt: toIso(issue.createdAt),
          updatedAt: toIso(issue.updatedAt),
          relatedIssue: null,
        }));
      }

      const reviewRows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          executionState: issues.executionState,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "in_review"), isNull(issues.hiddenAt)))
        .orderBy(desc(issues.updatedAt), desc(issues.id));
      const reviewIssueIds = reviewRows.map((row) => row.id);
      const pendingReviewApprovalRows = reviewIssueIds.length === 0
        ? []
        : await db
          .select({ issueId: issueApprovals.issueId, approvalId: approvals.id })
          .from(issueApprovals)
          .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
          .where(and(
            eq(issueApprovals.companyId, companyId),
            eq(approvals.companyId, companyId),
            inArray(issueApprovals.issueId, reviewIssueIds),
            eq(approvals.status, "pending"),
          ));
      const pendingApprovalByIssueId = new Map(pendingReviewApprovalRows.map((row) => [row.issueId, row.approvalId]));

      for (const review of reviewRows) {
        const state = parseIssueExecutionState(review.executionState);
        const currentParticipant = state?.status === "pending" ? state.currentParticipant : null;
        const hasHumanParticipant = currentParticipant?.type === "user";
        const pendingApprovalId = pendingApprovalByIssueId.get(review.id) ?? null;
        if (!hasHumanParticipant && !review.assigneeUserId && !pendingApprovalId) continue;
        const issue: IssueSummaryRow = review;
        const dedupKey = `review:${review.id}`;
        add(createItem({
          companyId,
          sourceKind: "review",
          subject: issueSubject(prefix, issue),
          whyNow: pendingApprovalId
            ? "Issue is in review with a linked pending approval."
            : hasHumanParticipant
              ? "Issue is in review and the current execution participant is a user."
              : "Issue is in review and assigned to a user.",
          decisionVerbs: decisionVerbs(
            { id: "approve", label: "Approve", description: "Approve the review and advance the issue." },
            { id: "request_changes", label: "Request changes", description: "Return the issue to the assignee with changes requested." },
          ),
          inlineResolvable: false,
          entryRule: "issues.status = 'in_review' and human reviewer, user assignee, or linked pending approval exists.",
          exitRule: "Issue leaves in_review or the human review path resolves.",
          dedupKey,
          severity: "medium",
          activityAt: toIso(review.updatedAt),
          createdAt: toIso(review.createdAt),
          updatedAt: toIso(review.updatedAt),
          relatedIssue: null,
        }));
      }

      const exhaustedRunRows = await db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          agentName: agents.name,
          status: heartbeatRuns.status,
          error: heartbeatRuns.error,
          errorCode: heartbeatRuns.errorCode,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          createdAt: heartbeatRuns.createdAt,
          updatedAt: heartbeatRuns.updatedAt,
          finishedAt: heartbeatRuns.finishedAt,
          exhaustionMessage: heartbeatRunEvents.message,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .innerJoin(heartbeatRunEvents, eq(heartbeatRunEvents.runId, heartbeatRuns.id))
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(agents.companyId, companyId),
          notInArray(agents.status, ["terminated"]),
          inArray(heartbeatRuns.status, [...FAILED_RUN_STATUSES]),
          eq(heartbeatRunEvents.companyId, companyId),
          eq(heartbeatRunEvents.eventType, "lifecycle"),
          sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
        ))
        .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRunEvents.id));

      const latestExhaustedByRunId = new Map<string, (typeof exhaustedRunRows)[number]>();
      for (const row of exhaustedRunRows) {
        if (!latestExhaustedByRunId.has(row.id)) latestExhaustedByRunId.set(row.id, row);
      }
      const failedRows = [...latestExhaustedByRunId.values()];
      const failedIssueIdByRunId = new Map(failedRows.map((row) => [row.id, readRunIssueId(row.contextSnapshot)]));
      const failedIssueMap = await issueSummaryMap(db, companyId, [...failedIssueIdByRunId.values()]);
      const failedAgentIds = [...new Set(failedRows.map((row) => row.agentId))];
      const earliestFailedAt = failedRows.reduce<Date | null>((earliest, row) => {
        if (earliest == null || row.createdAt.getTime() < earliest.getTime()) return row.createdAt;
        return earliest;
      }, null);
      const latestRunCreatedAtByPair = new Map<string, Date>();
      if (earliestFailedAt && failedAgentIds.length > 0) {
        const newerRunRows = await db
          .select({
            agentId: heartbeatRuns.agentId,
            issueKey: sql<string>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId', '')`,
            createdAt: heartbeatRuns.createdAt,
          })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.agentId, failedAgentIds),
            gt(heartbeatRuns.createdAt, earliestFailedAt),
          ));

        for (const row of newerRunRows) {
          const key = runAttentionPairKey(row.agentId, row.issueKey);
          const current = latestRunCreatedAtByPair.get(key);
          if (!current || row.createdAt.getTime() > current.getTime()) {
            latestRunCreatedAtByPair.set(key, row.createdAt);
          }
        }
      }

      for (const run of failedRows) {
        const issueId = failedIssueIdByRunId.get(run.id) ?? null;
        const latestRunCreatedAt = latestRunCreatedAtByPair.get(runAttentionPairKey(run.agentId, issueId));
        if (latestRunCreatedAt && latestRunCreatedAt.getTime() > run.createdAt.getTime()) continue;

        const issue = issueId ? failedIssueMap.get(issueId) ?? null : null;
        const dedupKey = `run:${run.id}`;
        add(createItem({
          companyId,
          sourceKind: "failed_run",
          subject: {
            kind: "run",
            id: run.id,
            companyId,
            title: `${run.agentName} run ${run.status}`,
            identifier: null,
            status: run.status,
            href: `/${prefix}/agents/${run.agentId}/runs/${run.id}`,
            metadata: {
              agentId: run.agentId,
              agentName: run.agentName,
              issueId,
              errorCode: run.errorCode,
              error: run.error,
              retryExhaustedReason: run.exhaustionMessage,
            },
          },
          whyNow: "Run failed after automatic retries were exhausted.",
          decisionVerbs: decisionVerbs(
            { id: "retry", label: "Retry", description: "Retry the failed run or issue." },
            { id: "reassign", label: "Reassign", description: "Move the work to another owner." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this failed-run attention row." },
          ),
          inlineResolvable: true,
          entryRule: "latest failed/timed_out run has a Bounded retry exhausted lifecycle event.",
          exitRule: "A newer run exists for the same issue/agent pair or the row is dismissed.",
          dedupKey,
          severity: "high",
          activityAt: toIso(run.finishedAt ?? run.updatedAt ?? run.createdAt),
          createdAt: toIso(run.createdAt),
          updatedAt: toIso(run.updatedAt),
          relatedIssue: issue ? issueSubject(prefix, issue) : null,
        }));
      }

      const budgetOverview = await budgetService(db).overview(companyId);
      for (const incident of budgetOverview.activeIncidents) {
        const observedPercent = budgetObservedPercent(incident.amountObserved, incident.amountLimit);
        if (incident.thresholdType !== "hard" && observedPercent < 85) continue;
        const dedupKey = `budget:${incident.policyId}:${toIso(incident.windowStart)}:${incident.thresholdType}`;
        add(createItem({
          companyId,
          sourceKind: "budget_alert",
          subject: {
            kind: "budget_incident",
            id: incident.id,
            companyId,
            title: `${incident.scopeName} budget ${incident.thresholdType === "hard" ? "hard stop" : "warning"}`,
            identifier: null,
            status: incident.status,
            href: `/${prefix}/costs`,
            metadata: {
              policyId: incident.policyId,
              scopeType: incident.scopeType,
              scopeId: incident.scopeId,
              thresholdType: incident.thresholdType,
              amountObserved: incident.amountObserved,
              amountLimit: incident.amountLimit,
              observedPercent,
              approvalId: incident.approvalId,
              approvalStatus: incident.approvalStatus,
            },
          },
          whyNow: incident.thresholdType === "hard"
            ? "Budget hard stop was reached."
            : "Budget crossed the 85% warning threshold.",
          decisionVerbs: decisionVerbs(
            { id: "raise_budget_and_resume", label: "Raise budget", description: "Raise the budget and resume paused work." },
            { id: "keep_paused", label: "Keep paused", description: "Dismiss or keep the budget stop in place." },
          ),
          inlineResolvable: true,
          entryRule: "open budget incident is hard, or soft with observed spend >= 85% of limit.",
          exitRule: "Budget incident is resolved or dismissed.",
          dedupKey,
          severity: incident.thresholdType === "hard" ? "high" : "medium",
          activityAt: toIso(incident.updatedAt),
          createdAt: toIso(incident.createdAt),
          updatedAt: toIso(incident.updatedAt),
          relatedIssue: null,
        }));
      }

      const erroredAgents = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          role: agents.role,
          status: agents.status,
          errorReason: agents.errorReason,
          createdAt: agents.createdAt,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.status, "error")))
        .orderBy(desc(agents.updatedAt), desc(agents.id));

      for (const agent of erroredAgents) {
        const dedupKey = `agent_error:${agent.id}`;
        add(createItem({
          companyId,
          sourceKind: "agent_error_alert",
          subject: {
            kind: "agent",
            id: agent.id,
            companyId,
            title: agent.name,
            identifier: null,
            status: agent.status,
            href: `/${prefix}/agents/${agent.id}`,
            metadata: { role: agent.role, errorReason: agent.errorReason },
          },
          whyNow: "Agent is in error status and needs operator action or dismissal.",
          decisionVerbs: decisionVerbs(
            { id: "inspect", label: "Inspect", description: "Inspect the agent error." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this alert." },
          ),
          inlineResolvable: true,
          entryRule: "agents.status = 'error'",
          exitRule: "Agent leaves error status or the row is dismissed.",
          dedupKey,
          severity: "high",
          activityAt: toIso(agent.updatedAt),
          createdAt: toIso(agent.createdAt),
          updatedAt: toIso(agent.updatedAt),
          relatedIssue: null,
        }));
      }

      const deduped = new Map<string, AttentionItem>();
      for (const item of collected) {
        const current = deduped.get(item.dedupKey);
        deduped.set(item.dedupKey, current ? betterDuplicate(current, item) : item);
      }

      const items = [...deduped.values()]
        .sort(compareAttentionItems)
        .map((item, index) => ({ ...item, rank: index + 1 }));
      const countsBySourceKind = emptyCounts();
      for (const item of items) countsBySourceKind[item.sourceKind] += 1;

      return {
        companyId,
        generatedAt: new Date().toISOString(),
        totalCount: items.length,
        countsBySourceKind,
        items,
      };
    },
  };
}
