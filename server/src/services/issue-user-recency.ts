import { and, desc, eq, sql } from "drizzle-orm";
import {
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueThreadInteractions,
  issueUserRecency,
  issues,
  type Db,
} from "@paperclipai/db";
import type { IssueStatus, IssueUserRecencyKind, RecentIssue } from "@paperclipai/shared";
import type { LogActivityInput } from "./activity-log.js";
import { visibleIssueCondition } from "./issue-visibility.js";

export const RECENT_ISSUES_MAX_LIMIT = 25;
export const RECENT_ISSUES_WINDOW_DAYS = 30;

const EDIT_FIELDS = new Set(["status", "assigneeAgentId", "assigneeUserId", "priority", "title"]);

export function issueRecencyKindForActivity(
  input: Pick<LogActivityInput, "actorType" | "action" | "entityType" | "details">,
): IssueUserRecencyKind | null {
  if (input.actorType !== "user") return null;
  if (input.entityType === "approval") {
    return ["approval.approved", "approval.rejected", "approval.revision_requested"].includes(input.action)
      ? "approval"
      : null;
  }
  if (input.entityType !== "issue") return null;
  if (input.action === "issue.created") return "created";
  if (input.action === "issue.comment_added") return "commented";
  if ([
    "issue.thread_interaction_accepted",
    "issue.thread_interaction_rejected",
    "issue.thread_interaction_answered",
    "issue.thread_interaction_item_verdicts_submitted",
  ].includes(input.action)) return "interaction";
  if (["issue.document_created", "issue.document_updated", "issue.document_restored"].includes(input.action)) {
    return "document";
  }
  if (input.action !== "issue.updated") return null;

  const details = input.details ?? {};
  const changes = details.changes && typeof details.changes === "object" && !Array.isArray(details.changes)
    ? details.changes as Record<string, unknown>
    : {};
  return [...EDIT_FIELDS].some((field) => field in changes || field in details) ? "edited" : null;
}

export async function recordIssueUserRecency(
  db: Db,
  input: {
    companyId: string;
    userId: string;
    issueIds: string[];
    kind: IssueUserRecencyKind;
    interactedAt?: Date;
  },
) {
  const issueIds = [...new Set(input.issueIds.filter(Boolean))];
  if (issueIds.length === 0 || input.userId.trim().length === 0) return;
  const interactedAt = input.interactedAt ?? new Date();
  await db
    .insert(issueUserRecency)
    .values(issueIds.map((issueId) => ({
      companyId: input.companyId,
      userId: input.userId,
      issueId,
      kind: input.kind,
      lastInteractedAt: interactedAt,
    })))
    .onConflictDoUpdate({
      target: [issueUserRecency.userId, issueUserRecency.companyId, issueUserRecency.issueId],
      set: { kind: input.kind, lastInteractedAt: interactedAt },
    });
}

export async function recordIssueUserRecencyFromActivity(db: Db, input: LogActivityInput) {
  const kind = issueRecencyKindForActivity(input);
  if (!kind) return;

  const issueIds = input.entityType === "approval"
    ? await db
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .where(and(eq(issueApprovals.companyId, input.companyId), eq(issueApprovals.approvalId, input.entityId)))
        .then((rows) => rows.map((row) => row.issueId))
    : [input.entityId];

  await recordIssueUserRecency(db, {
    companyId: input.companyId,
    userId: input.actorId,
    issueIds,
    kind,
  });
}

export function issueUserRecencyService(db: Db) {
  return {
    listRecentIssues: async (
      companyId: string,
      userId: string,
      requestedLimit = RECENT_ISSUES_MAX_LIMIT,
    ): Promise<RecentIssue[]> => {
      const limit = Math.min(RECENT_ISSUES_MAX_LIMIT, Math.max(1, Math.floor(requestedLimit)));
      const rows = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: sql<IssueStatus>`${issues.status}`,
          lastInteractedAt: issueUserRecency.lastInteractedAt,
          kind: issueUserRecency.kind,
          hasActiveRun: sql<boolean>`exists (
            select 1 from ${heartbeatRuns} live_run
            where live_run.company_id = ${companyId}
              and live_run.status in ('queued', 'running')
              and live_run.context_snapshot ->> 'issueId' = ${issues.id}::text
          )`,
          attentionHref: sql<string | null>`coalesce(
            (
              select '/issues/' || coalesce(${issues.identifier}, ${issues.id}::text)
                || '#interaction-' || pending_interaction.id::text
              from ${issueThreadInteractions} pending_interaction
              where pending_interaction.company_id = ${companyId}
                and pending_interaction.issue_id = ${issues.id}
                and pending_interaction.status = 'pending'
                and not (
                  pending_interaction.effective_resolver_policy = 'not_creator'
                  and pending_interaction.created_by_user_id = ${userId}
                )
              order by pending_interaction.updated_at desc, pending_interaction.id desc
              limit 1
            ),
            (
              select '/approvals/' || pending_approval.id::text
              from ${issueApprovals} pending_issue_approval
              inner join ${approvals} pending_approval on pending_approval.id = pending_issue_approval.approval_id
              where pending_issue_approval.company_id = ${companyId}
                and pending_issue_approval.issue_id = ${issues.id}
                and pending_approval.company_id = ${companyId}
                and pending_approval.status in ('pending', 'revision_requested')
              order by pending_approval.updated_at desc, pending_approval.id desc
              limit 1
            )
          )`,
        })
        .from(issueUserRecency)
        .innerJoin(issues, and(
          eq(issues.id, issueUserRecency.issueId),
          eq(issues.companyId, issueUserRecency.companyId),
        ))
        .where(and(
          eq(issueUserRecency.companyId, companyId),
          eq(issueUserRecency.userId, userId),
          sql`${issueUserRecency.lastInteractedAt} > now() - interval '30 days'`,
          visibleIssueCondition(),
        ))
        .orderBy(desc(issueUserRecency.lastInteractedAt), desc(issueUserRecency.issueId))
        .limit(limit);
      return rows.map((row) => ({
        ...row,
        needsAttention: row.attentionHref !== null,
      }));
    },
  };
}
