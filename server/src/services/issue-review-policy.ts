import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import type { IssueReviewPolicy } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

export interface IssueReviewVerdictActor {
  type: "agent" | "user";
  id: string;
}

export interface IssueReviewRequester extends IssueReviewVerdictActor {
  reviewInteractionId: string | null;
}

interface ReviewPolicyIssue {
  id: string;
  companyId: string;
  reviewPolicy?: IssueReviewPolicy | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

export async function resolveIssueReviewRequester(
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
  const requester = await resolveIssueReviewRequester(db, input.issue);
  if (!requester) return false;
  if (requester.reviewInteractionId && requester.reviewInteractionId !== input.interaction.id) return false;
  // Older review transitions did not persist the interaction binding. In that
  // case, an unattributed confirmation is ambiguous and must fail closed.
  // Confirmations attributed to an unrelated writer remain independently
  // resolvable, while requester-created confirmations inherit the issue policy.
  if (!requester.reviewInteractionId
    && !input.interaction.createdByAgentId
    && !input.interaction.createdByUserId) {
    return true;
  }
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
      "Only a signed-in person can approve or reject this review; an agent cannot submit the verdict.",
      {
        code: "review_policy_denied",
        policy,
        allowedActor: "authenticated_user_with_issue_write_access",
        remediation: "Ask a person with access to this task to approve or reject it in Paperclip.",
      },
    );
  }

  const requester = await resolveIssueReviewRequester(db, input.issue);
  if (!requester) {
    throw forbidden(
      "Someone other than whoever sent this task for review must decide it, and Paperclip could not tell who sent it.",
      {
        code: "review_policy_denied",
        policy,
        allowedActor: "writer_other_than_review_requester",
        remediation: "Move the task out of review and back into review so Paperclip records who sent it, then have someone else submit the verdict.",
      },
    );
  }
  if (requester.type !== input.actor.type || requester.id !== input.actor.id) return;

  throw forbidden(
    "Whoever sent this task for review cannot also approve or reject it; someone else must submit the verdict.",
    {
      code: "review_policy_denied",
      policy,
      allowedActor: "writer_other_than_review_requester",
      remediation: "Have someone else with access to this task submit the verdict.",
    },
  );
}
