import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  addIssueCommentSchema,
  createIssueAttachmentMetadataSchema,
  createIssueWorkProductSchema,
  createIssueLabelSchema,
  checkoutIssueSchema,
  createIssueSchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  upsertIssueFeedbackVoteSchema,
  linkIssueApprovalSchema,
  issueDocumentKeySchema,
  restoreIssueDocumentRevisionSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  updateIssueSchema,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  type ExecutionWorkspace,
} from "@paperclipai/shared";
import type { IssueWorkProduct } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  executionWorkspaceService,
  feedbackService,
  goalService,
  heartbeatService,
  instanceSettingsService,
  issueApprovalService,
  issueService,
  documentService,
  logActivity,
  projectService,
  routineService,
  workProductService,
} from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { forbidden, HttpError, notFound, unauthorized } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { REVIEW_DISPATCH_ORIGIN_KIND, reviewDispatchService } from "../services/review-dispatch.js";
import { classifyTechnicalReviewOutcome } from "../services/technical-review-outcome.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
/** Cap parallel `listComments` calls when scanning many technical-review child issues. */
const MAX_TECHNICAL_REVIEW_CHILDREN_COMMENT_FETCH = 25;

export function issueRoutes(
  db: Db,
  storage: StorageService,
  opts?: {
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
  },
) {
  const router = Router();
  const svc = issueService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const feedback = feedbackService(db);
  const instanceSettings = instanceSettingsService(db);
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const routinesSvc = routineService(db);
  const reviewDispatch = reviewDispatchService(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Invalid ${field} query value`);
    }
    return parsed;
  }

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function isMergedPullRequestProduct(product: IssueWorkProduct) {
    if (product.type !== "pull_request") return false;
    if (product.status === "merged") return true;
    if (product.status !== "closed") return false;
    const metadata = isRecord(product.metadata) ? product.metadata : null;
    return (
      metadata?.merged === true
      || metadata?.isMerged === true
      || metadata?.state === "merged"
      || metadata?.status === "merged"
      || (typeof metadata?.mergedAt === "string" && metadata.mergedAt.trim().length > 0)
      || (typeof metadata?.merged_at === "string" && metadata.merged_at.trim().length > 0)
    );
  }

  function isDraftPullRequestProduct(product: IssueWorkProduct) {
    if (product.type !== "pull_request") return false;
    if (product.status === "draft") return true;
    const metadata = isRecord(product.metadata) ? product.metadata : null;
    return (
      metadata?.draft === true
      || metadata?.isDraft === true
      || metadata?.state === "draft"
      || metadata?.status === "draft"
    );
  }

  function isDirectMergeEligiblePullRequestProduct(product: IssueWorkProduct) {
    if (product.type !== "pull_request") return false;
    const metadata = isRecord(product.metadata) ? product.metadata : null;
    return metadata?.directMergeEligible === true;
  }

  async function getIssuePullRequestProduct(issueId: string) {
    const products = await workProductsSvc.listForIssue(issueId);
    return products.find((product) => product.type === "pull_request") ?? null;
  }

  async function resolveTechnicalReviewOutcome(
    reviewIssueId: string,
    commentBody: string | null | undefined,
  ) {
    const directOutcome = classifyTechnicalReviewOutcome(commentBody);
    if (directOutcome) return directOutcome;

    const recentComments = await svc.listComments(reviewIssueId, {
      order: "desc",
      limit: 10,
    });
    for (const comment of recentComments) {
      const fallbackOutcome = classifyTechnicalReviewOutcome(comment.body);
      if (fallbackOutcome) return fallbackOutcome;
    }
    return null;
  }

  type TechnicalReviewSignal = {
    outcome: "approved" | "blocking";
    createdAt: Date;
    source: "issue_comment" | "review_issue_comment";
    commentId: string;
    reviewIssueId?: string;
    reviewIssueIdentifier?: string | null;
  };

  function pickLatestTechnicalReviewSignal(
    current: TechnicalReviewSignal | null,
    candidate: TechnicalReviewSignal | null,
  ) {
    if (!candidate) return current;
    if (!current) return candidate;
    return candidate.createdAt.getTime() > current.createdAt.getTime() ? candidate : current;
  }

  async function findLatestTechnicalReviewSignal(sourceIssue: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    let latest: TechnicalReviewSignal | null = null;

    const sourceComments = await svc.listComments(sourceIssue.id, {
      order: "desc",
      limit: 20,
    });
    for (const comment of sourceComments) {
      const outcome = classifyTechnicalReviewOutcome(comment.body);
      if (!outcome) continue;
      latest = pickLatestTechnicalReviewSignal(latest, {
        outcome,
        createdAt: comment.createdAt,
        source: "issue_comment",
        commentId: comment.id,
      });
    }

    const childIssues = await svc.list(sourceIssue.companyId, { parentId: sourceIssue.id });
    const reviewChildren = childIssues
      .filter((child) => isTechnicalReviewChildIssueCandidate(child) && child.status === "done");
    const cappedReviewChildren = reviewChildren.slice(0, MAX_TECHNICAL_REVIEW_CHILDREN_COMMENT_FETCH);
    if (reviewChildren.length > cappedReviewChildren.length) {
      logger.warn(
        {
          parentIssueId: sourceIssue.id,
          totalReviewChildren: reviewChildren.length,
          cap: MAX_TECHNICAL_REVIEW_CHILDREN_COMMENT_FETCH,
        },
        "technical review signal scan capped parallel child comment fetches",
      );
    }
    const childCommentResults = await Promise.allSettled(
      cappedReviewChildren.map((child) =>
        svc.listComments(child.id, {
          order: "desc",
          limit: 10,
        })),
    );
    const childCommentLists: Awaited<ReturnType<typeof svc.listComments>>[] = [];
    for (let i = 0; i < childCommentResults.length; i++) {
      const settled = childCommentResults[i];
      const child = cappedReviewChildren[i];
      if (settled.status === "fulfilled") {
        childCommentLists.push(settled.value);
        continue;
      }
      logger.warn(
        {
          err: settled.reason,
          parentIssueId: sourceIssue.id,
          childIssueId: child.id,
        },
        "technical review signal scan: failed to list comments for review child",
      );
      childCommentLists.push([]);
    }
    for (let i = 0; i < cappedReviewChildren.length; i++) {
      const child = cappedReviewChildren[i];
      const childComments = childCommentLists[i];
      for (const comment of childComments) {
        const outcome = classifyTechnicalReviewOutcome(comment.body);
        if (!outcome) continue;
        latest = pickLatestTechnicalReviewSignal(latest, {
          outcome,
          createdAt: comment.createdAt,
          source: "review_issue_comment",
          commentId: comment.id,
          reviewIssueId: child.id,
          reviewIssueIdentifier: child.identifier,
        });
      }
    }

    return latest;
  }

  async function reconcileApprovedReviewLane(input: {
    issue: NonNullable<Awaited<ReturnType<typeof svc.getById>>>;
    targetStatus: string;
  }) {
    const { issue, targetStatus } = input;
    if (isTechnicalReviewChildIssueCandidate(issue)) return null;
    if (!["handoff_ready", "technical_review"].includes(issue.status)) return null;
    if (!["human_review", "done"].includes(targetStatus)) return null;

    const latestSignal = await findLatestTechnicalReviewSignal(issue);
    if (!latestSignal || latestSignal.outcome !== "approved") return null;
    const pullRequestProduct = await getIssuePullRequestProduct(issue.id);

    const transitions: string[] = [];
    let current = issue;
    let deferredHumanReviewBecausePullRequestDraft = false;

    if (current.status === "handoff_ready") {
      const next = await svc.update(current.id, { status: "technical_review" });
      if (!next) return null;
      current = next;
      transitions.push("handoff_ready->technical_review");
    }

    if (current.status === "technical_review") {
      if (pullRequestProduct && isDraftPullRequestProduct(pullRequestProduct)) {
        deferredHumanReviewBecausePullRequestDraft = true;
      } else {
        const next = await svc.update(current.id, { status: "human_review" });
        if (!next) return null;
        current = next;
        transitions.push("technical_review->human_review");
      }
    }

    if (targetStatus === "done" && current.status === "human_review") {
      const next = await svc.update(current.id, { status: "done" });
      if (!next) return null;
      current = next;
      transitions.push("human_review->done");
    }

    return transitions.length > 0 || deferredHumanReviewBecausePullRequestDraft
      ? {
        issue: current,
        transitions,
        signal: latestSignal,
        deferredHumanReviewBecausePullRequestDraft,
        pullRequestProductId: pullRequestProduct?.id ?? null,
        pullRequestStatus: pullRequestProduct?.status ?? null,
      }
      : null;
  }

  function isTechnicalReviewChildIssueCandidate(issue: {
    originKind?: string | null;
    parentId?: string | null;
    title?: string | null;
  }) {
    if (!issue.parentId) return false;
    if (issue.originKind === REVIEW_DISPATCH_ORIGIN_KIND) return true;
    return typeof issue.title === "string" && /^revisar pr #\d+ de /i.test(issue.title.trim());
  }

  async function reconcileTechnicalReviewChildOutcome(input: {
    reviewIssueBefore: Awaited<ReturnType<typeof svc.getById>>;
    reviewIssueAfter: Awaited<ReturnType<typeof svc.getById>>;
    commentBody: string | null | undefined;
    actor: ReturnType<typeof getActorInfo>;
  }) {
    const reviewIssueBefore = input.reviewIssueBefore;
    const reviewIssueAfter = input.reviewIssueAfter;
    if (!reviewIssueBefore || !reviewIssueAfter) return null;
    if (reviewIssueAfter.status !== "done") return null;
    if (!isTechnicalReviewChildIssueCandidate(reviewIssueBefore)) return null;

    const outcome = await resolveTechnicalReviewOutcome(
      reviewIssueAfter.id,
      input.commentBody,
    );
    if (!outcome) {
      logger.warn(
        {
          reviewIssueId: reviewIssueAfter.id,
          reviewIssueIdentifier: reviewIssueAfter.identifier,
          parentIssueId: reviewIssueBefore.parentId ?? null,
        },
        "technical review child closed but outcome text did not classify; parent issue left unchanged for manual follow-up",
      );
      await logActivity(db, {
        companyId: reviewIssueAfter.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.review_outcome_unparsed",
        entityType: "issue",
        entityId: reviewIssueAfter.id,
        details: {
          parentIssueId: reviewIssueBefore.parentId ?? null,
          reviewIssueIdentifier: reviewIssueAfter.identifier,
          reason: "no_classified_outcome",
        },
      });
      return null;
    }
    if (!reviewIssueBefore.parentId) return null;

    const parent = await svc.getById(reviewIssueBefore.parentId);
    if (!parent || parent.status === "done" || parent.status === "cancelled") return null;

    if (outcome === "approved") {
      const pullRequestProduct = await getIssuePullRequestProduct(parent.id);
      const transitions: string[] = [];
      let current = parent;
      let deferredHumanReviewBecausePullRequestDraft = false;

      if (current.status === "handoff_ready") {
        const next = await svc.update(current.id, { status: "technical_review" });
        if (!next) return current;
        current = next;
        transitions.push("handoff_ready->technical_review");
      }

      if (current.status === "technical_review") {
        if (pullRequestProduct && isDraftPullRequestProduct(pullRequestProduct)) {
          deferredHumanReviewBecausePullRequestDraft = true;
        } else {
          const next = await svc.update(current.id, { status: "human_review" });
          if (!next) return current;
          current = next;
          transitions.push("technical_review->human_review");
        }
      }

      if (transitions.length === 0 && !deferredHumanReviewBecausePullRequestDraft) return current;

      const mergeDelegateEligible =
        current.status === "human_review"
        && !deferredHumanReviewBecausePullRequestDraft
        && typeof parent.assigneeAgentId === "string"
        && parent.assigneeAgentId.trim().length > 0
        && pullRequestProduct !== null
        && isDirectMergeEligiblePullRequestProduct(pullRequestProduct);

      await routinesSvc.syncRunStatusForIssue(current.id);
      await logActivity(db, {
        companyId: current.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.review_outcome_reconciled",
        entityType: "issue",
        entityId: current.id,
        details: {
          outcome: "approved",
          reviewIssueId: reviewIssueAfter.id,
          reviewIssueIdentifier: reviewIssueAfter.identifier,
          transitions,
          deferredHumanReviewBecausePullRequestDraft,
          pullRequestProductId: pullRequestProduct?.id ?? null,
          pullRequestStatus: pullRequestProduct?.status ?? null,
          mergeDelegateWakeupEnqueued: mergeDelegateEligible,
        },
      });

      if (mergeDelegateEligible && parent.assigneeAgentId) {
        const wpMeta = isRecord(pullRequestProduct.metadata) ? pullRequestProduct.metadata : null;
        const prNumberFromMeta = typeof wpMeta?.prNumber === "number" ? wpMeta.prNumber : null;
        const prNumberFromExternal =
          typeof pullRequestProduct.externalId === "string"
            ? Number.parseInt(pullRequestProduct.externalId, 10)
            : NaN;
        const pullRequestNumber = Number.isFinite(prNumberFromMeta)
          ? prNumberFromMeta
          : Number.isFinite(prNumberFromExternal)
            ? prNumberFromExternal
            : null;

        try {
          await heartbeat.wakeup(parent.assigneeAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "issue_status_changed",
            payload: {
              issueId: parent.id,
              reviewIssueId: reviewIssueAfter.id,
              mutation: "review_approved_merge_delegate",
            },
            requestedByActorType: input.actor.actorType,
            requestedByActorId: input.actor.actorId,
            contextSnapshot: {
              issueId: parent.id,
              taskId: parent.id,
              source: "issue.review_outcome",
              reviewIssueId: reviewIssueAfter.id,
              reviewOutcome: "approved",
              pullRequestUrl: pullRequestProduct.url,
              pullRequestNumber,
              workProductId: pullRequestProduct.id,
            },
          });
        } catch (err) {
          logger.warn(
            { err, issueId: parent.id, agentId: parent.assigneeAgentId },
            "failed to wake executor for direct merge delegate",
          );
          await logActivity(db, {
            companyId: current.companyId,
            actorType: input.actor.actorType,
            actorId: input.actor.actorId,
            agentId: input.actor.agentId,
            runId: input.actor.runId,
            action: "issue.merge_delegate_wakeup_failed",
            entityType: "issue",
            entityId: parent.id,
            details: {
              reviewIssueId: reviewIssueAfter.id,
              reviewIssueIdentifier: reviewIssueAfter.identifier,
              assigneeAgentId: parent.assigneeAgentId,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      return current;
    }

    if (!parent.assigneeAgentId) return null;

    const resumedRun = await heartbeat.wakeup(parent.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_status_changed",
      payload: {
        issueId: parent.id,
        reviewIssueId: reviewIssueAfter.id,
        mutation: "review_blocking_findings",
      },
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId,
      contextSnapshot: {
        issueId: parent.id,
        taskId: parent.id,
        source: "issue.review_outcome",
        reviewIssueId: reviewIssueAfter.id,
        reviewOutcome: "blocking",
      },
    });
    if (!resumedRun) {
      logger.warn(
        {
          parentIssueId: parent.id,
          assigneeAgentId: parent.assigneeAgentId,
          reviewIssueId: reviewIssueAfter.id,
          wakeReason: "issue_status_changed",
          mutation: "review_blocking_findings",
          detail: "heartbeat.wakeup returned null",
        },
        "review outcome blocking path: wake did not resume a run",
      );
      return null;
    }

    const checkedOut = await svc.checkout(
      parent.id,
      parent.assigneeAgentId,
      [parent.status],
      resumedRun.id,
    );
    if (!checkedOut) {
      logger.warn(
        {
          parentIssueId: parent.id,
          assigneeAgentId: parent.assigneeAgentId,
          reviewIssueId: reviewIssueAfter.id,
          wakeReason: "issue_status_changed",
          mutation: "review_blocking_findings",
          resumedRunId: resumedRun.id,
          detail: "svc.checkout returned null",
        },
        "review outcome blocking path: checkout failed after wake",
      );
      return null;
    }

    await routinesSvc.syncRunStatusForIssue(checkedOut.id);
    await logActivity(db, {
      companyId: checkedOut.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: "issue.review_outcome_reconciled",
      entityType: "issue",
      entityId: checkedOut.id,
      details: {
        outcome: "blocking",
        reviewIssueId: reviewIssueAfter.id,
        reviewIssueIdentifier: reviewIssueAfter.identifier,
        resumedRunId: resumedRun.id,
        transition: `${parent.status}->in_progress`,
      },
    });
    return checkedOut;
  }

  async function reconcileMergedPullRequestIssue(input: {
    issueId: string;
    workProduct: IssueWorkProduct;
    actor: ReturnType<typeof getActorInfo>;
  }) {
    const issuePreview = await svc.getById(input.issueId);
    if (!issuePreview) return null;
    if (issuePreview.status === "done" || issuePreview.status === "cancelled") return issuePreview;

    try {
      const { current, transitions, cancelledChildIds, completedMergeReconcile } = await db.transaction(
        async (tx) => {
          const scopedIssues = issueService(tx as unknown as Db);
          const issue = await scopedIssues.getById(input.issueId);
          if (!issue) {
            return {
              current: null as Awaited<ReturnType<typeof svc.getById>>,
              transitions: [] as string[],
              cancelledChildIds: [] as string[],
              completedMergeReconcile: false,
            };
          }
          if (issue.status === "done" || issue.status === "cancelled") {
            return {
              current: issue,
              transitions: [] as string[],
              cancelledChildIds: [] as string[],
              completedMergeReconcile: false,
            };
          }

          const transitions: string[] = [];
          let current = issue;

          if (current.status === "handoff_ready") {
            const next = await scopedIssues.update(current.id, { status: "technical_review" });
            if (!next) {
              return { current, transitions, cancelledChildIds: [], completedMergeReconcile: false };
            }
            current = next;
            transitions.push("handoff_ready->technical_review");
          }

          if (current.status === "technical_review") {
            const next = await scopedIssues.update(current.id, { status: "human_review" });
            if (!next) {
              return { current, transitions, cancelledChildIds: [], completedMergeReconcile: false };
            }
            current = next;
            transitions.push("technical_review->human_review");
          }

          if (current.status === "human_review") {
            const next = await scopedIssues.update(current.id, { status: "done" });
            if (!next) {
              return { current, transitions, cancelledChildIds: [], completedMergeReconcile: false };
            }
            current = next;
            transitions.push("human_review->done");
          }

          if (transitions.length === 0 || current.status !== "done") {
            return { current, transitions, cancelledChildIds: [], completedMergeReconcile: false };
          }

          const childIssues = await scopedIssues.list(current.companyId, { parentId: current.id });
          const openReviewChildren = childIssues.filter((child) =>
            isTechnicalReviewChildIssueCandidate(child)
            && child.status !== "done"
            && child.status !== "cancelled",
          );

          const cancelledChildIds: string[] = [];
          for (const child of openReviewChildren) {
            try {
              const updated = await scopedIssues.update(child.id, { status: "cancelled" });
              if (!updated) {
                logger.warn(
                  { childIssueId: child.id, parentIssueId: current.id },
                  "merge reconcile: cancel review child returned no row",
                );
                continue;
              }
              cancelledChildIds.push(child.id);
            } catch (err) {
              logger.warn(
                { err, childIssueId: child.id, parentIssueId: current.id },
                "merge reconcile: failed to cancel review child issue",
              );
            }
          }

          return { current, transitions, cancelledChildIds, completedMergeReconcile: true };
        },
      );

      if (!current) return null;

      if (!completedMergeReconcile) {
        return current;
      }

      try {
        await routinesSvc.syncRunStatusForIssue(current.id);
      } catch (err) {
        logger.warn(
          { err, issueId: current.id, workProductId: input.workProduct.id },
          "routine sync failed after PR merge auto-complete (parent)",
        );
      }
      for (const childId of cancelledChildIds) {
        try {
          await routinesSvc.syncRunStatusForIssue(childId);
        } catch (err) {
          logger.warn(
            { err, issueId: current.id, childIssueId: childId, workProductId: input.workProduct.id },
            "routine sync failed after PR merge auto-complete child cancel",
          );
        }
      }

      await logActivity(db, {
        companyId: current.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: current.id,
        details: {
          status: "done",
          identifier: current.identifier,
          source: "work_product",
          autoCompletedFromPullRequest: true,
          workProductId: input.workProduct.id,
          workProductStatus: input.workProduct.status,
          transitions,
          cancelledChildIssueIds: cancelledChildIds,
        },
      });

      logger.info(
        {
          event: "issue.pr_merge_auto_complete",
          issueId: current.id,
          workProductId: input.workProduct.id,
          transitions,
          cancelledChildIssueCount: cancelledChildIds.length,
          cancelledChildIssueIds: cancelledChildIds,
        },
        "PR merge auto-complete committed",
      );

      return current;
    } catch (err) {
      logger.warn(
        {
          err,
          issueId: input.issueId,
          workProductId: input.workProduct.id,
        },
        "PR merge auto-complete transaction failed",
      );
      throw err;
    }
  }

  async function reconcileDraftPullRequestIssue(input: {
    issueId: string;
    workProduct: IssueWorkProduct;
    actor: ReturnType<typeof getActorInfo>;
  }) {
    const issue = await svc.getById(input.issueId);
    if (!issue) return null;
    if (issue.status !== "human_review") return issue;

    const next = await svc.update(issue.id, { status: "technical_review" });
    if (!next) return issue;

    await routinesSvc.syncRunStatusForIssue(next.id);
    await logActivity(db, {
      companyId: next.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: next.id,
      details: {
        status: "technical_review",
        identifier: next.identifier,
        source: "work_product",
        resolvedFromPullRequestDraft: true,
        workProductId: input.workProduct.id,
        workProductStatus: input.workProduct.status,
        statusTransitionPath: ["human_review->technical_review"],
      },
    });

    return next;
  }

  async function assertCanManageIssueApprovalLinks(req: Request, res: Response, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return true;
    if (!req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    if (actorAgent.role === "ceo" || Boolean(actorAgent.permissions?.canCreateAgents)) return true;
    res.status(403).json({ error: "Missing permission to link approvals" });
    return false;
  }

  function actorCanAccessCompany(req: Request, companyId: string) {
    if (req.actor.type === "none") return false;
    if (req.actor.type === "agent") return req.actor.companyId === companyId;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return (req.actor.companyIds ?? []).includes(companyId);
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (agent.role === "ceo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanAssignTasks(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const allowedByGrant = await access.hasPermission(companyId, "agent", req.actor.agentId, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await agentsSvc.getById(req.actor.agentId);
      if (actorAgent && actorAgent.companyId === companyId && canCreateAgentsLegacy(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  function requireAgentRunId(req: Request, res: Response) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (runId) return runId;
    res.status(401).json({ error: "Agent run id required" });
    return null;
  }

  async function assertAgentRunCheckoutOwnership(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (issue.status !== "in_progress" || issue.assigneeAgentId !== actorAgentId) {
      return true;
    }
    const runId = requireAgentRunId(req, res);
    if (!runId) return false;
    const ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.checkout_lock_adopted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      });
    }
    return true;
  }

  async function resolveActiveIssueRun(issue: {
    id: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  }) {
    let runToInterrupt = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;

    if ((!runToInterrupt || runToInterrupt.status !== "running") && issue.assigneeAgentId) {
      const activeRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const activeIssueId =
        activeRun &&
        activeRun.contextSnapshot &&
        typeof activeRun.contextSnapshot === "object" &&
        typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
          ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
          : null;
      if (activeRun && activeRun.status === "running" && activeIssueId === issue.id) {
        runToInterrupt = activeRun;
      }
    }

    return runToInterrupt?.status === "running" ? runToInterrupt : null;
  }

  async function getClosedIssueExecutionWorkspace(issue: { executionWorkspaceId?: string | null }) {
    if (!issue.executionWorkspaceId) return null;
    const workspace = await executionWorkspacesSvc.getById(issue.executionWorkspaceId);
    if (!workspace || !isClosedIsolatedExecutionWorkspace(workspace)) return null;
    return workspace;
  }

  function respondClosedIssueExecutionWorkspace(
    res: Response,
    workspace: Pick<ExecutionWorkspace, "closedAt" | "id" | "mode" | "name" | "status">,
  ) {
    res.status(409).json({
      error: getClosedIsolatedExecutionWorkspaceMessage(workspace),
      executionWorkspace: workspace,
    });
  }

  async function normalizeIssueIdentifier(rawId: string): Promise<string> {
    const trimmed = rawId.trim();
    if (/^[A-Z]+-\d+$/i.test(trimmed)) {
      const issue = await svc.getByIdentifier(trimmed);
      if (issue) {
        return issue.id;
      }
      throw notFound("Issue not found");
    }
    const idParse = z.string().uuid().safeParse(trimmed);
    if (!idParse.success) {
      throw notFound("Issue not found");
    }
    return idParse.data;
  }

  async function resolveIssueProjectAndGoal(issue: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = issue.projectId ? projectsSvc.getById(issue.projectId) : Promise.resolve(null);
    const directGoalPromise = issue.goalId ? goalsSvc.getById(issue.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    const projectGoalId = project?.goalId ?? project?.goalIds[0] ?? null;
    if (projectGoalId) {
      const projectGoal = await goalsSvc.getById(projectGoalId);
      return { project, goal: projectGoal };
    }

    if (!issue.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(issue.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/companies/:companyId/issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const assigneeUserFilterRaw = req.query.assigneeUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const inboxArchivedByUserFilterRaw = req.query.inboxArchivedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : assigneeUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : touchedByUserFilterRaw;
    const inboxArchivedByUserId =
      inboxArchivedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : inboxArchivedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : unreadForUserFilterRaw;

    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (inboxArchivedByUserFilterRaw === "me" && (!inboxArchivedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "inboxArchivedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }

    const result = await svc.list(companyId, {
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId: req.query.projectId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      q: req.query.q as string | undefined,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listLabels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/labels", validate(createIssueLabelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const label = await svc.createLabel(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const [{ project, goal }, ancestors, mentionedProjectIds, documentPayload] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id),
      documentsSvc.getIssueDocumentPayload(issue),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json({
      ...issue,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      ...documentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace,
      workProducts,
    });
  });

  router.get("/issues/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const wakeCommentId =
      typeof req.query.wakeCommentId === "string" && req.query.wakeCommentId.trim().length > 0
        ? req.query.wakeCommentId.trim()
        : null;

    const [{ project, goal }, ancestors, commentCursor, wakeComment] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.getCommentCursor(issue.id),
      wakeCommentId ? svc.getComment(wakeCommentId) : null,
    ]);

    res.json({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: goal?.id ?? issue.goalId,
        parentId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        currentOwner: issue.currentOwner ?? null,
        updatedAt: issue.updatedAt,
      },
      ancestors: ancestors.map((ancestor) => ({
        id: ancestor.id,
        identifier: ancestor.identifier,
        title: ancestor.title,
        status: ancestor.status,
        priority: ancestor.priority,
      })),
      project: project
        ? {
            id: project.id,
            name: project.name,
            status: project.status,
            targetDate: project.targetDate,
          }
        : null,
      goal: goal
        ? {
            id: goal.id,
            title: goal.title,
            status: goal.status,
            level: goal.level,
            parentId: goal.parentId,
          }
        : null,
      commentCursor,
      wakeComment:
        wakeComment && wakeComment.issueId === issue.id
          ? wakeComment
          : null,
    });
  });

  router.get("/issues/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json(workProducts);
  });

  router.get("/issues/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const docs = await documentsSvc.listIssueDocuments(issue.id);
    res.json(docs);
  });

  router.get("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  });

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type === "agent" && !requireAgentRunId(req, res)) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
    });
    const doc = result.document;

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
      },
    });

    res.status(result.created ? 201 : 200).json(doc);
  });

  router.get("/issues/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, keyParsed.data);
    res.json(revisions);
  });

  router.post(
    "/issues/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreIssueDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const revisionId = req.params.revisionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      const actor = getActorInfo(req);
      const result = await documentsSvc.restoreIssueDocumentRevision({
        issueId: issue.id,
        key: keyParsed.data,
        revisionId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.document_restored",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          format: result.document.format,
          revisionNumber: result.document.latestRevisionNumber,
          restoredFromRevisionId: result.restoredFromRevisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        },
      });

      res.json(result.document);
    },
  );

  router.delete("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
      },
    });
    res.json({ ok: true });
  });

  router.post("/issues/:id/work-products", validate(createIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type === "agent" && !requireAgentRunId(req, res)) return;
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, {
      ...req.body,
      projectId: req.body.projectId ?? issue.projectId ?? null,
    });
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    if (isMergedPullRequestProduct(product)) {
      await reconcileMergedPullRequestIssue({
        issueId: issue.id,
        workProduct: product,
        actor,
      });
    } else if (isDraftPullRequestProduct(product)) {
      await reconcileDraftPullRequestIssue({
        issueId: issue.id,
        workProduct: product,
        actor,
      });
    }
    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (req.actor.type === "agent" && !requireAgentRunId(req, res)) return;
    const product = await workProductsSvc.update(id, req.body);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, changedKeys: Object.keys(req.body).sort() },
    });
    if (isMergedPullRequestProduct(product)) {
      await reconcileMergedPullRequestIssue({
        issueId: existing.issueId,
        workProduct: product,
        actor,
      });
    } else if (isDraftPullRequestProduct(product)) {
      await reconcileDraftPullRequestIssue({
        issueId: existing.issueId,
        workProduct: product,
        actor,
      });
    }
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await workProductsSvc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: removed.id, type: removed.type },
    });
    res.json(removed);
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.markUnread(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_unmarked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: issue.id, removed });
  });

  router.post("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const archiveState = await svc.archiveInbox(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_archived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, archivedAt: archiveState.archivedAt },
    });
    res.json(archiveState);
  });

  router.delete("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.unarchiveInbox(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_unarchived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json(removed ?? { ok: true });
  });

  router.get("/issues/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.json(approvals);
  });

  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;
    if (req.actor.type === "agent" && !requireAgentRunId(req, res)) return;

    const actor = getActorInfo(req);
    await issueApprovalsSvc.link(id, req.body.approvalId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_linked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId: req.body.approvalId },
    });

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.status(201).json(approvals);
  });

  router.delete("/issues/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;
    if (req.actor.type === "agent" && !requireAgentRunId(req, res)) return;

    await issueApprovalsSvc.unlink(id, approvalId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/issues", validate(createIssueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, companyId);
    }
    if (req.actor.type === "agent" && !requireAgentRunId(req, res)) return;

    const actor = getActorInfo(req);
    const issue = await svc.create(companyId, {
      ...req.body,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: { title: issue.title, identifier: issue.identifier },
    });

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    res.status(201).json(issue);
  });

  router.patch("/issues/:id", validate(updateIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const assigneeWillChange =
      (req.body.assigneeAgentId !== undefined && req.body.assigneeAgentId !== existing.assigneeAgentId) ||
      (req.body.assigneeUserId !== undefined && req.body.assigneeUserId !== existing.assigneeUserId);

    const isAgentReturningIssueToCreator =
      req.actor.type === "agent" &&
      !!req.actor.agentId &&
      existing.assigneeAgentId === req.actor.agentId &&
      req.body.assigneeAgentId === null &&
      typeof req.body.assigneeUserId === "string" &&
      !!existing.createdByUserId &&
      req.body.assigneeUserId === existing.createdByUserId;

    if (assigneeWillChange) {
      if (!isAgentReturningIssueToCreator) {
        await assertCanAssignTasks(req, existing.companyId);
      }
    }
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;

    const actor = getActorInfo(req);
    const isClosed = existing.status === "done" || existing.status === "cancelled";
    const {
      comment: commentBody,
      expectedIdentifier: expectedIdentifierRaw,
      reopen: reopenRequested,
      interrupt: interruptRequested,
      hiddenAt: hiddenAtRaw,
      ...updateFields
    } = req.body;
    const expectedIdentifierQuery =
      typeof req.query.expectedIdentifier === "string" ? req.query.expectedIdentifier.trim() : null;
    const expectedIdentifier = expectedIdentifierRaw?.trim() || expectedIdentifierQuery;
    if (
      expectedIdentifier &&
      typeof existing.identifier === "string" &&
      expectedIdentifier.toUpperCase() !== existing.identifier.toUpperCase()
    ) {
      res.status(409).json({
        error: `Issue identifier mismatch: expected ${expectedIdentifier}, got ${existing.identifier}`,
      });
      return;
    }
    let interruptedRunId: string | null = null;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(existing);
    const isAgentWorkUpdate = req.actor.type === "agent" && Object.keys(updateFields).length > 0;

    if (closedExecutionWorkspace && (commentBody || isAgentWorkUpdate)) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    if (interruptRequested) {
      if (!commentBody) {
        res.status(400).json({ error: "Interrupt is only supported when posting a comment" });
        return;
      }
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(existing);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: existing.id },
          });
        }
      }
    }

    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
    }
    if (commentBody && reopenRequested === true && isClosed && updateFields.status === undefined) {
      updateFields.status = "todo";
    }
    let issue;
    let reviewLaneReconciliation:
      | Awaited<ReturnType<typeof reconcileApprovedReviewLane>>
      | null = null;
    try {
      if (typeof updateFields.status === "string") {
        reviewLaneReconciliation = await reconcileApprovedReviewLane({
          issue: existing,
          targetStatus: updateFields.status,
        });
      }
      const patchAfterReconciliation =
        reviewLaneReconciliation?.deferredHumanReviewBecausePullRequestDraft
          ? Object.fromEntries(
              Object.entries(updateFields).filter(([key]) => key !== "status"),
            ) as typeof updateFields
          : updateFields;
      let patchToApply: typeof updateFields = { ...patchAfterReconciliation };
      if (reviewLaneReconciliation?.deferredHumanReviewBecausePullRequestDraft) {
        patchToApply = {
          ...patchToApply,
          status: reviewLaneReconciliation.issue.status,
        };
      }
      if (Object.keys(patchToApply).length === 0) {
        issue = reviewLaneReconciliation?.issue ?? (await svc.getById(id));
      } else {
        // Always persist the merged patch after lane reconciliation so user-supplied fields
        // (title, description, priority, etc.) are never dropped when a no-op shortcut would
        // match the reconciled row only on a subset of columns.
        issue = await svc.update(id, patchToApply);
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            issueId: id,
            companyId: existing.companyId,
            assigneePatch: {
              assigneeAgentId:
                req.body.assigneeAgentId === undefined ? "__omitted__" : req.body.assigneeAgentId,
              assigneeUserId:
                req.body.assigneeUserId === undefined ? "__omitted__" : req.body.assigneeUserId,
            },
            currentAssignee: {
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
            },
            error: err.message,
            details: err.details,
          },
          "issue update rejected with 422",
        );
      }
      throw err;
    }
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await routinesSvc.syncRunStatusForIssue(issue.id);

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue activity"));
    }

    // Build activity details with previous values for changed fields
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(updateFields)) {
      if (key in existing && (existing as Record<string, unknown>)[key] !== (updateFields as Record<string, unknown>)[key]) {
        previous[key] = (existing as Record<string, unknown>)[key];
      }
    }

    const hasFieldChanges = Object.keys(previous).length > 0;
    const reopened =
      commentBody &&
      reopenRequested === true &&
      isClosed &&
      previous.status !== undefined &&
      issue.status === "todo";
    const reopenFromStatus = reopened ? existing.status : null;
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        ...updateFields,
        identifier: issue.identifier,
        ...(reviewLaneReconciliation
          ? {
              resolvedFromApprovedTechnicalReview: true,
              statusTransitionPath: reviewLaneReconciliation.transitions,
              technicalReviewSignalSource: reviewLaneReconciliation.signal.source,
              technicalReviewSignalCommentId: reviewLaneReconciliation.signal.commentId,
              technicalReviewSignalReviewIssueId: reviewLaneReconciliation.signal.reviewIssueId,
              technicalReviewSignalReviewIssueIdentifier:
                reviewLaneReconciliation.signal.reviewIssueIdentifier,
              deferredHumanReviewBecausePullRequestDraft:
                reviewLaneReconciliation.deferredHumanReviewBecausePullRequestDraft,
              pullRequestProductId: reviewLaneReconciliation.pullRequestProductId,
              pullRequestStatus: reviewLaneReconciliation.pullRequestStatus,
            }
          : {}),
        ...(commentBody ? { source: "comment" } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        _previous: hasFieldChanges ? previous : undefined,
      },
    });

    if (issue.status === "done" && existing.status !== "done") {
      const tc = getTelemetryClient();
      if (tc && actor.agentId) {
        const actorAgent = await agentsSvc.getById(actor.agentId);
        if (actorAgent) {
          trackAgentTaskCompleted(tc, { agentRole: actorAgent.role });
        }
      }
    }

    let comment = null;
    if (commentBody) {
      comment = await svc.addComment(id, commentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          ...(hasFieldChanges ? { updated: true } : {}),
        },
      });

    }

    try {
      await reconcileTechnicalReviewChildOutcome({
        reviewIssueBefore: existing,
        reviewIssueAfter: issue,
        commentBody,
        actor,
      });
    } catch (err) {
      logger.warn({ err, issueId: issue.id }, "failed to reconcile technical review outcome");
    }

    const shouldAttemptReviewDispatch =
      (issue.status === "handoff_ready" || issue.status === "technical_review") &&
      issue.originKind !== REVIEW_DISPATCH_ORIGIN_KIND;
    if (shouldAttemptReviewDispatch) {
      try {
        const dispatch = await reviewDispatch.dispatchForIssue({
          issueId: issue.id,
          commentId: comment?.id ?? null,
        });

        if (dispatch.kind === "created") {
          await logActivity(db, {
            companyId: dispatch.reviewIssue.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.created",
            entityType: "issue",
            entityId: dispatch.reviewIssue.id,
            details: {
              title: dispatch.reviewIssue.title,
              identifier: dispatch.reviewIssue.identifier,
              parentId: issue.id,
              originKind: dispatch.reviewIssue.originKind,
              originId: dispatch.reviewIssue.originId,
            },
          });

          await logActivity(db, {
            companyId: issue.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.review_dispatch_created",
            entityType: "issue",
            entityId: issue.id,
            details: {
              reviewIssueId: dispatch.reviewIssue.id,
              reviewIssueIdentifier: dispatch.reviewIssue.identifier,
              prUrl: dispatch.artifact.pullRequest.url,
              prNumber: dispatch.artifact.pullRequest.prNumber,
              diffIdentity: dispatch.artifact.diffIdentity,
            },
          });

          void queueIssueAssignmentWakeup({
            heartbeat,
            issue: dispatch.reviewIssue,
            reason: "issue_assigned",
            mutation: "review_dispatch",
            contextSource: "issue.review_dispatch",
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
          });
        } else if (dispatch.kind === "reused" || dispatch.kind === "already_reviewed") {
          const reconciledIssue = dispatch.kind === "already_reviewed" && dispatch.reviewIssue.status === "done"
            ? await reconcileTechnicalReviewChildOutcome({
              reviewIssueBefore: dispatch.reviewIssue,
              reviewIssueAfter: dispatch.reviewIssue,
              commentBody: null,
              actor,
            })
            : null;
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.review_dispatch_reused",
            entityType: "issue",
            entityId: issue.id,
            details: {
              outcome: dispatch.kind,
              reviewIssueId: dispatch.reviewIssue.id,
              reviewIssueIdentifier: dispatch.reviewIssue.identifier,
              prUrl: dispatch.artifact.pullRequest.url,
              prNumber: dispatch.artifact.pullRequest.prNumber,
              diffIdentity: dispatch.artifact.diffIdentity,
              duplicatePrevented: true,
              dedupReason: dispatch.dedupReason ?? null,
              reconciledSourceStatus: reconciledIssue?.status ?? null,
            },
          });

          if (dispatch.kind === "reused") {
            void queueIssueAssignmentWakeup({
              heartbeat,
              issue: dispatch.reviewIssue,
              reason: "issue_status_changed",
              mutation: "review_dispatch_reuse",
              contextSource: "issue.review_dispatch",
              requestedByActorType: actor.actorType,
              requestedByActorId: actor.actorId,
            });
          }
        } else if (dispatch.kind === "noop") {
          const observableNoops = new Set([
            "reviewer_not_found",
            "reviewer_ambiguous",
            "pull_request_not_found",
          ]);
          if (observableNoops.has(dispatch.reason)) {
            await logActivity(db, {
              companyId: issue.companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue.review_dispatch_noop",
              entityType: "issue",
              entityId: issue.id,
              details: {
                reason: dispatch.reason,
                identifier: issue.identifier,
                title: issue.title,
              },
            });
          }
        }
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "failed to dispatch technical review");
      }
    }

    const assigneeChanged = assigneeWillChange;
    const statusChangedFromBacklog =
      existing.status === "backlog" &&
      issue.status !== "backlog" &&
      req.body.status !== undefined;

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();

      if (assigneeChanged && issue.assigneeAgentId && issue.status !== "backlog") {
        wakeups.set(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (!assigneeChanged && statusChangedFromBacklog && issue.assigneeAgentId) {
        wakeups.set(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_status_changed",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.status_change",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (commentBody && comment) {
        let mentionedIds: string[] = [];
        try {
          mentionedIds = await svc.findMentionedAgents(issue.companyId, commentBody);
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }

        for (const mentionedId of mentionedIds) {
          if (wakeups.has(mentionedId)) continue;
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          wakeups.set(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
            },
          });
        }
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();

    res.json({ ...issue, comment });
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (req.actor.type === "agent" && !requireAgentRunId(req, res)) return;
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    res.json(issue);
  });

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (issue.projectId) {
      const project = await projectsSvc.getById(issue.projectId);
      if (project?.pausedAt) {
        res.status(409).json({
          error:
            project.pauseReason === "budget"
              ? "Project is paused because its budget hard-stop was reached"
              : "Project is paused",
        });
        return;
      }
    }

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: req.body.agentId },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        actorType: req.actor.type,
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    res.json(updated);
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;
    const actorRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !actorRunId) return;

    const released = await svc.release(
      id,
      req.actor.type === "agent" ? req.actor.agentId : undefined,
      actorRunId,
    );
    if (!released) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    res.json(released);
  });

  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const afterCommentId =
      typeof req.query.after === "string" && req.query.after.trim().length > 0
        ? req.query.after.trim()
        : typeof req.query.afterCommentId === "string" && req.query.afterCommentId.trim().length > 0
          ? req.query.afterCommentId.trim()
          : null;
    const order =
      typeof req.query.order === "string" && req.query.order.trim().toLowerCase() === "asc"
        ? "asc"
        : "desc";
    const limitRaw =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : null;
    const limit =
      limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_ISSUE_COMMENT_LIMIT)
        : null;
    const comments = await svc.listComments(id, {
      afterCommentId,
      order,
      limit,
    });
    res.json(comments);
  });

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.get("/issues/:id/feedback-votes", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback votes" });
      return;
    }

    const votes = await feedback.listIssueVotesForUser(id, req.actor.userId ?? "local-board");
    res.json(votes);
  });

  router.get("/issues/:id/feedback-traces", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const targetType = targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined;
    const vote = voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined;
    const status = statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId: issue.companyId,
      issueId: issue.id,
      targetType,
      vote,
      status,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.get("/feedback-traces/:traceId", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }
    const includePayload = parseBooleanQuery(req.query.includePayload) || req.query.includePayload === undefined;
    const trace = await feedback.getFeedbackTraceById(traceId, includePayload);
    if (!trace || !actorCanAccessCompany(req, trace.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(trace);
  });

  router.get("/feedback-traces/:traceId/bundle", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback trace bundles" });
      return;
    }
    const bundle = await feedback.getFeedbackTraceBundle(traceId);
    if (!bundle || !actorCanAccessCompany(req, bundle.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(bundle);
  });

  router.post("/issues/:id/comments", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, issue))) return;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const actor = getActorInfo(req);
    const reopenRequested = req.body.reopen === true;
    const interruptRequested = req.body.interrupt === true;
    const isClosed = issue.status === "done" || issue.status === "cancelled";
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;

    if (reopenRequested && isClosed) {
      const reopenedIssue = await svc.update(id, { status: "todo" });
      if (!reopenedIssue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      reopened = true;
      reopenFromStatus = issue.status;
      currentIssue = reopenedIssue;

      await logActivity(db, {
        companyId: currentIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          status: "todo",
          reopened: true,
          reopenedFrom: reopenFromStatus,
          source: "comment",
          identifier: currentIssue.identifier,
        },
      });
    }

    if (interruptRequested) {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      type HeartbeatRunRecord = NonNullable<Awaited<ReturnType<typeof heartbeat.getRun>>>;
      let runToInterrupt: HeartbeatRunRecord | null = currentIssue.executionRunId
        ? (await heartbeat.getRun(currentIssue.executionRunId)) as HeartbeatRunRecord | null
        : null;

      if (
        (!runToInterrupt || runToInterrupt.status !== "running") &&
        currentIssue.assigneeAgentId
      ) {
        const activeRun = await heartbeat.getActiveRunForAgent(currentIssue.assigneeAgentId);
        const activeIssueId =
          activeRun &&
            activeRun.contextSnapshot &&
            typeof activeRun.contextSnapshot === "object" &&
            typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
            ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
            : null;
        if (activeRun && activeRun.status === "running" && activeIssueId === currentIssue.id) {
          runToInterrupt = activeRun as HeartbeatRunRecord;
        }
      }

      if (runToInterrupt && runToInterrupt.status === "running") {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: currentIssue.id },
          });
        }
      }
    }

    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
      runId: actor.runId,
    });

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue comment"));
    }

    await logActivity(db, {
      companyId: currentIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
    });

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const skipWake = selfComment || isClosed;
      if (assigneeId && (reopened || !skipWake)) {
        if (reopened) {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_reopened_via_comment",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              source: "issue.comment.reopen",
              wakeReason: "issue_reopened_via_comment",
              reopenedFrom: reopenFromStatus,
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              source: "issue.comment",
              wakeReason: "issue_commented",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      let mentionedIds: string[] = [];
      try {
        mentionedIds = await svc.findMentionedAgents(issue.companyId, req.body.body);
      } catch (err) {
        logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
      }

      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        wakeups.set(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: id,
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_comment_mentioned",
            source: "comment.mention",
          },
        });
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    res.status(201).json(comment);
  });

  router.post("/issues/:id/feedback-votes", validate(upsertIssueFeedbackVoteSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can vote on AI feedback" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await feedback.saveIssueVote({
      issueId: id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      vote: req.body.vote,
      reason: req.body.reason,
      authorUserId: req.actor.userId ?? "local-board",
      allowSharing: req.body.allowSharing === true,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.feedback_vote_saved",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        targetType: result.vote.targetType,
        targetId: result.vote.targetId,
        vote: result.vote.vote,
        hasReason: Boolean(result.vote.reason),
        sharingEnabled: result.sharingEnabled,
      },
    });

    if (result.consentEnabledNow) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.feedback_data_sharing_updated",
        entityType: "company",
        entityId: issue.companyId,
        details: {
          feedbackDataSharingEnabled: true,
          source: "issue_feedback_vote",
        },
      });
    }

    if (result.persistedSharingPreference) {
      const settings = await instanceSettings.get();
      const companyIds = await instanceSettings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: settings.id,
            details: {
              general: settings.general,
              changedKeys: ["feedbackDataSharingPreference"],
              source: "issue_feedback_vote",
            },
          }),
        ),
      );
    }

    if (result.sharingEnabled && result.traceId && feedbackExportService) {
      try {
        await feedbackExportService.flushPendingFeedbackTraces({
          companyId: issue.companyId,
          traceId: result.traceId,
          limit: 1,
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, traceId: result.traceId }, "failed to flush shared feedback trace immediately");
      }
    }

    res.status(201).json(result.vote);
  });

  router.get("/issues/:id/attachments", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const attachments = await svc.listAttachments(issueId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/issues/:issueId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }
    if (req.actor.type === "agent" && !requireAgentRunId(req, res)) return;

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = (file.mimetype || "").toLowerCase();
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported attachment type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_added",
      entityType: "issue",
      entityId: issueId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);

    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    res.setHeader("Content-Type", attachment.contentType || object.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    const filename = attachment.originalFilename ?? "attachment";
    res.setHeader("Content-Disposition", `inline; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
