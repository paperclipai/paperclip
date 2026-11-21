import { and, eq, isNull } from "drizzle-orm";
import { issueComments, type Db, type heartbeatRuns } from "@paperclipai/db";
import { extractWakeCommentIds } from "../../modules/run-dispatch/index.js";

type SourceRun = Pick<typeof heartbeatRuns.$inferSelect, "status" | "companyId" | "contextSnapshot" | "nativeIssueId">;

export type RunSourceCommentCandidate = {
  companyId: string;
  issueId: string;
  commentId: string;
  kind: "issue_comment" | "plugin_human_comment";
};

const ISSUE_COMMENT_WAKE_SOURCES = new Set(["issue.comment", "issue.comment.reopen"]);
const ISSUE_COMMENT_WAKE_REASONS = new Set(["issue_commented", "issue_reopened_via_comment"]);
const PLUGIN_COMMENT_WAKE_SOURCE = /^plugin:[^:\s]+$/;
const PLUGIN_FOREIGN_CONTEXT_KEYS = ["pluginId", "pluginKey", "interactionId", "approvalId"] as const;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readCommentWakeKind(context: Record<string, unknown>, commentId: string): RunSourceCommentCandidate["kind"] | null {
  const source = readString(context.source);
  const reason = readString(context.wakeReason);
  if (source && reason && ISSUE_COMMENT_WAKE_SOURCES.has(source) && ISSUE_COMMENT_WAKE_REASONS.has(reason)) {
    return "issue_comment";
  }
  if (
    source && PLUGIN_COMMENT_WAKE_SOURCE.test(source) &&
    reason === "issue_commented" &&
    readString(context.sourceCommentId) === commentId &&
    PLUGIN_FOREIGN_CONTEXT_KEYS.every((key) => context[key] == null)
  ) {
    return "plugin_human_comment";
  }
  return null;
}

export function readRunSourceCommentCandidate(run: SourceRun | null | undefined): RunSourceCommentCandidate | null {
  if (!run || run.status !== "running") return null;
  const context = readObject(run.contextSnapshot);
  const commentIds = extractWakeCommentIds(context);
  if (commentIds.length !== 1) return null;
  const commentId = commentIds[0]!;
  const companyId = readString(run.companyId);
  const issueId = readString(context.issueId);
  const nativeIssueId = readString(run.nativeIssueId);
  if (!companyId || !issueId || (nativeIssueId && nativeIssueId !== issueId)) return null;
  const kind = readCommentWakeKind(context, commentId);
  return kind ? { companyId, issueId, commentId, kind } : null;
}

export async function resolveRunSourceCommentId(db: Db, run: SourceRun): Promise<string | null> {
  const candidate = readRunSourceCommentCandidate(run);
  if (!candidate) return null;
  const rows = await db
    .select({ id: issueComments.id, authorUserId: issueComments.authorUserId, authorAgentId: issueComments.authorAgentId })
    .from(issueComments)
    .where(and(
      eq(issueComments.id, candidate.commentId),
      eq(issueComments.companyId, candidate.companyId),
      eq(issueComments.issueId, candidate.issueId),
      isNull(issueComments.deletedAt),
    ))
    .limit(2);
  if (rows.length !== 1) return null;
  const [row] = rows;
  if (candidate.kind === "plugin_human_comment" && (!readString(row!.authorUserId) || row!.authorAgentId != null)) {
    return null;
  }
  return row!.id;
}
