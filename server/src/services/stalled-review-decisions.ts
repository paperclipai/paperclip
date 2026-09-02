import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";

export interface StalledReviewDecisionActor {
  userId: string;
  runId?: string | null;
}

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  note?: string;
  actor: StalledReviewDecisionActor;
}

export function stalledReviewDecisionService(db: Db) {
  const svc = issueService(db);
  return {
    decide: async (input: DecideStalledReviewInput) => {
      const postCommitActivityPublications: ActivityPublication[] = [];
      const postCommitIssueActions: IssuePostCommitAction[] = [];
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const lockedIssue = await tx
          .select()
          .from(issues)
          .where(and(
            eq(issues.id, input.issueId),
            eq(issues.companyId, input.companyId),
            visibleIssueCondition(),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);

        if (!lockedIssue) throw notFound("Issue not found");
        if (lockedIssue.status !== "in_review") {
          throw conflict("Issue is no longer a stalled review", {
            issueId: lockedIssue.id,
            currentStatus: lockedIssue.status,
          });
        }

        const reviewAttention = await svc
          .listReviewAttention(lockedIssue.companyId, [lockedIssue], tx)
          .then((rows) => rows.get(lockedIssue.id));
        if (reviewAttention?.state !== "stalled") {
          throw conflict("Issue is no longer a stalled review", {
            issueId: lockedIssue.id,
            reviewAttentionState: reviewAttention?.state ?? "none",
          });
        }

        const comment = input.note
          ? await svc.addComment(
              lockedIssue.id,
              input.note,
              { userId: input.actor.userId, runId: input.actor.runId ?? null },
              { authorType: "user" },
              tx,
            )
          : null;
        const status = input.action === "approve" ? "done" : "todo";
        const updated = await svc.update(
          lockedIssue.id,
          {
            status,
            actorUserId: input.actor.userId,
          },
          tx,
          postCommitActivityPublications,
          postCommitIssueActions,
        );
        if (!updated) throw notFound("Issue not found");

        if (comment) {
          await logActivity(txDb, {
            companyId: updated.companyId,
            actorType: "user",
            actorId: input.actor.userId,
            runId: input.actor.runId ?? null,
            action: "issue.comment_added",
            entityType: "issue",
            entityId: updated.id,
            issueId: updated.id,
            details: {
              commentId: comment.id,
              authorUserId: input.actor.userId,
              source: "stalled_review_decision",
            },
          });
        }
        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: "user",
          actorId: input.actor.userId,
          runId: input.actor.runId ?? null,
          action: "issue.stalled_review_decided",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            action: input.action,
            status,
            identifier: updated.identifier,
            commentId: comment?.id ?? null,
            authorUserId: comment ? input.actor.userId : null,
            _previous: { status: lockedIssue.status },
          },
        });

        return { issue: updated, comment };
      });
      for (const publication of postCommitActivityPublications) publishActivity(publication);
      await executeIssuePostCommitActions(db, postCommitIssueActions);
      return result;
    },
  };
}
