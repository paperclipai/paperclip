import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import type { IssueReviewPolicy } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

export interface IssueReviewVerdictActor {
  type: "agent" | "user";
  id: string;
}

interface IssueReviewRequester extends IssueReviewVerdictActor {
  reviewInteractionId: string | null;
}

interface ReviewPolicyIssue {
  id: string;
  companyId: string;
  reviewPolicy?: IssueReviewPolicy | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

async function findReviewRequester(
  db: Db,
  issue: ReviewPolicyIssue,
): Promise<IssueReviewRequester | null> {
  const transition = await db
    .select({
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      details: activityLog.details,
    })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, issue.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issue.id),
      eq(activityLog.action, "issue.updated"),
      sql`(
        (
          ${activityLog.details} ->> 'status' = 'in_review'
          AND ${activityLog.details} -> '_previous' ->> 'status' IS NOT NULL
          AND ${activityLog.details} -> '_previous' ->> 'status' <> 'in_review'
        )
        OR
        (
          ${activityLog.details} -> 'changes' -> 'status' ->> 'to' = 'in_review'
          AND ${activityLog.details} -> 'changes' -> 'status' ->> 'from' IS NOT NULL
          AND ${activityLog.details} -> 'changes' -> 'status' ->> 'from' <> 'in_review'
        )
      )`,
    ))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (transition?.actorType === "agent" || transition?.actorType === "user") {
    const reviewInteractionId = typeof transition.details?.reviewInteractionId === "string"
      ? transition.details.reviewInteractionId
      : null;
    return { type: transition.actorType, id: transition.actorId, reviewInteractionId };
  }
  if (issue.createdByAgentId && !issue.createdByUserId) {
    return { type: "agent", id: issue.createdByAgentId, reviewInteractionId: null };
  }
  if (issue.createdByUserId && !issue.createdByAgentId) {
    return { type: "user", id: issue.createdByUserId, reviewInteractionId: null };
  }
  return null;
}

export async function isIssueReviewVerdictInteraction(
  db: Db,
  input: {
    issue: ReviewPolicyIssue;
    interaction: {
      id: string;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    };
  },
): Promise<boolean> {
  const requester = await findReviewRequester(db, input.issue);
  if (!requester?.reviewInteractionId || requester.reviewInteractionId !== input.interaction.id) return false;
  return requester.type === "agent"
    ? input.interaction.createdByAgentId === requester.id
    : input.interaction.createdByUserId === requester.id;
}

export async function assertIssueReviewVerdictActorAllowed(
  db: Db,
  input: {
    issue: ReviewPolicyIssue;
    actor: IssueReviewVerdictActor;
    reviewPolicy?: IssueReviewPolicy | null;
  },
): Promise<void> {
  const policy = input.reviewPolicy ?? input.issue.reviewPolicy ?? "anyone";
  if (policy === "anyone") return;

  if (policy === "human_only") {
    if (input.actor.type === "user") return;
    throw forbidden(
      "Review policy `human_only` allows only an authenticated user to approve or reject this review.",
      {
        code: "review_policy_denied",
        policy,
        allowedActor: "authenticated_user_with_issue_write_access",
        remediation: "Have an authenticated user with issue write access submit the verdict, or change reviewPolicy to `anyone`.",
      },
    );
  }

  const requester = await findReviewRequester(db, input.issue);
  if (!requester) {
    throw forbidden(
      "Review policy `not_creator` requires a different writer, but the review requester could not be determined.",
      {
        code: "review_policy_denied",
        policy,
        allowedActor: "writer_other_than_review_requester",
        remediation: "Change reviewPolicy to `anyone`, or move the issue out of and back into `in_review` to record a requester before another writer submits the verdict.",
      },
    );
  }
  if (requester.type !== input.actor.type || requester.id !== input.actor.id) return;

  throw forbidden(
    "Review policy `not_creator` requires someone other than the writer who moved the issue into `in_review` to approve or reject it.",
    {
      code: "review_policy_denied",
      policy,
      allowedActor: "writer_other_than_review_requester",
      remediation: "Have another writer with issue write access submit the verdict, or change reviewPolicy to `anyone`.",
    },
  );
}
