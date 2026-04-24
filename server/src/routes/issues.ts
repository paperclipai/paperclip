import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueExecutionDecisions } from "@paperclipai/db";
import type {
  IssueExecutionDecisionOutcome,
  IssueExecutionPolicy,
  IssueExecutionState,
  IssueListSort,
  IssueQaGateReasonCode,
  IssueStatus,
  IssueWorkflowTemplateKey,
} from "@paperclipai/shared";
import {
  ISSUE_LIST_SORTS,
  addIssueCommentSchema,
  applyIssueWorkflowTemplateSchema,
  buildAgentMentionHref,
  issueActionSchema,
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
  type IssueActionRequest,
  type IssueActionResult,
  type IssueComment,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  type ExecutionWorkspace,
} from "@paperclipai/shared";
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import * as services from "../services/index.js";
import {
  accessService,
  agentService,
  executionGateService,
  executionWorkspaceService,
  feedbackService,
  goalService,
  heartbeatService,
  instanceSettingsService,
  issueApprovalService,
  issueService,
  issueWorkflowService,
  documentService,
  logActivity,
  projectService,
  routineService,
  workProductService,
} from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { logOpsInfo, logOpsWarn } from "../ops-log.js";
import { forbidden, HttpError, unauthorized } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import {
  isInlineAttachmentContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupWarning,
} from "../services/issue-assignment-wakeup.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { parseProjectExecutionWorkspacePolicy } from "../services/execution-workspace-policy.js";
import { issueMergeService } from "../services/issue-merge.js";
import { getAgentNotInvokableStatus, isAgentNotInvokableWakeupError } from "../services/wakeup-errors.js";
import {
  buildIssueQaGate,
  isDeliveryScopedIssue,
  issueQaGateReasonMessage,
  qaCommentHasQaPassMarker,
  qaCommentHasReleaseConfirmedMarker,
  qaCommentHasExplicitSummaryTokens,
  qaCommentHasExplicitTestCoverageVerdict,
  qaCommentHasExplicitVerificationTokens,
  parseQaSummary,
  parseQaVerification,
  qaSummaryNeedsExplicitTestCoverageVerdict,
  qaCommentHasFailingReview,
  qaCommentHasFailingVerification,
} from "../services/qa-gate.js";
import { buildIssueRoutingText } from "../services/issue-routing-heuristics.js";
import { computeIssueBoardStateMap } from "../services/issue-board-state.js";
import { synthesizeWorkflowBoardState } from "../services/issue-workflows.js";
import { finalizeQaValidatedIssueFromComment } from "../services/issue-qa-finalization.js";
import {
  buildDeliveryQaExecutionPolicy,
  buildQaOpenIssueCountByAgentId,
  orderPooledQaReviewers,
  QA_OPEN_LOAD_STATUSES,
  resolvePreferredQaReviewerAgentId,
} from "../services/qa-reviewer-pool.js";
import {
  classifyIssueTruthFromCommentBody,
  hasReadyForQaTruthFromCommentBody,
  resolveLatestStructuredTruthComment,
} from "../services/heartbeat.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
const AUTO_FIX_ATTEMPT_MARKER = "[AUTO-FIX ATTEMPT]";
const AUTO_FIX_MAX_ATTEMPTS = 2;
const AUTO_FIX_WINDOW_MS = 24 * 60 * 60 * 1000;
const QA_ROUTE_COMMENT_MARKER = "[qa-routing]";
const QA_ASSIGNMENT_REQUIRED_COMMENT_MARKER = "[qa-assignment-required]";
const RECOVERY_SUCCESSOR_NOTE_MARKER = "[recovery-successor-note]";
const QA_MERGE_BLOCKED_MARKER = "[merge-blocked]";
const SECURITY_FAIL_MARKER_REGEX = /\[(SECURITY FAIL|SECURITY BLOCKED)\]/i;
const QA_ASSIGNMENT_REQUIRED_COMMENT_LOOKBACK = 25;
const QA_PASS_MARKER_REGEX = /\[QA PASS\]/i;
const RELEASE_CONFIRMED_MARKER_REGEX = /\[RELEASE CONFIRMED\]/i;
const ISSUE_ACTIVITY_DETAIL_KEYS = [
  "title",
  "description",
  "projectId",
  "goalId",
  "parentId",
  "status",
  "priority",
  "assigneeAgentId",
  "assigneeUserId",
  "requestDepth",
  "billingCode",
  "assigneeAdapterOverrides",
  "executionPolicy",
  "executionWorkspaceId",
  "executionWorkspacePreference",
  "executionWorkspaceSettings",
  "hiddenAt",
  "startedAt",
  "completedAt",
  "cancelledAt",
  "labelIds",
] as const;
const ISSUE_FILE_PREVIEW_MAX_BYTES = 4096;

const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".html",
  ".css",
  ".scss",
  ".sh",
]);

const IMAGE_PREVIEW_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
});
const archiveClosedIssuesRouteSchema = z.object({
  olderThanDays: z.number().int().min(1).max(365).optional(),
});

export function issueRoutes(
  db: Db,
  storage: StorageService,
  opts?: {
    awaitAsyncPostResponseHooks?: boolean;
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
  const executionGate = executionGateService(db);
  const feedback = feedbackService(db);
  const instanceSettings = instanceSettingsService(db);
  const agentsSvc = agentService(db);
  const companyServiceFactory =
    Object.prototype.hasOwnProperty.call(services, "companyService")
      ? services.companyService
      : undefined;
  const companiesSvc =
    typeof companyServiceFactory === "function"
      ? companyServiceFactory(db)
      : { getById: async () => null as null };
  const issueMerge = issueMergeService();
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const issueWorkflowsSvc = issueWorkflowService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const documentsSvc = documentService(db);
  const issueActionServiceFactory =
    Object.prototype.hasOwnProperty.call(services, "issueActionService")
      ? services.issueActionService
      : undefined;
  const issueActions =
    typeof issueActionServiceFactory === "function"
      ? issueActionServiceFactory({
        db,
        issues: svc,
        agents: agentsSvc,
        companies: companiesSvc,
        projects: projectsSvc,
        issueWorkflow: issueWorkflowsSvc,
        issueMerge,
        executionWorkspaces: executionWorkspacesSvc,
        documents: documentsSvc,
        logActivity,
      })
      : null;
  const workProductsSvc = workProductService(db);
  const routinesSvc = routineService(db);
  const feedbackExportService = opts?.feedbackExportService;
  type PersistedIssue = NonNullable<Awaited<ReturnType<typeof svc.getById>>>;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  async function settleAsyncRouteTask(task: Promise<unknown>) {
    if (opts?.awaitAsyncPostResponseHooks) {
      await task;
      return;
    }
    void task;
  }

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

  function parseOptionalQueryString(value: unknown) {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    if (!normalized) return undefined;
    const lower = normalized.toLowerCase();
    if (lower === "null" || lower === "undefined") return undefined;
    return normalized;
  }

  function contentTypeForPreviewPath(filePath: string) {
    const extension = path.extname(filePath).toLowerCase();
    if (IMAGE_PREVIEW_CONTENT_TYPES[extension]) return IMAGE_PREVIEW_CONTENT_TYPES[extension];
    if (TEXT_PREVIEW_EXTENSIONS.has(extension)) return "text/plain; charset=utf-8";
    return "application/octet-stream";
  }

  async function resolveIssueProjectRoot(issueId: string, companyId: string) {
    const issue = await svc.getById(issueId);
    if (!issue) return { issue: null, root: null as string | null };
    if (issue.companyId !== companyId) return { issue, root: null as string | null };
    if (!issue.projectId) return { issue, root: null as string | null };
    const project = await projectsSvc.getById(issue.projectId);
    const root = project?.companyId === companyId ? project.codebase?.effectiveLocalFolder ?? null : null;
    return { issue, root };
  }

  async function readIssueFilePreview(issueId: string, companyId: string, rawRelativePath: string) {
    const normalizedRelativePath = rawRelativePath.trim().replace(/\\/g, "/");
    if (!normalizedRelativePath) {
      throw new HttpError(400, "Missing path query value");
    }
    const normalizedSafePath = path.posix.normalize(normalizedRelativePath);
    if (
      !normalizedSafePath
      || normalizedSafePath === "."
      || normalizedSafePath === ".."
      || normalizedSafePath.startsWith("../")
      || normalizedSafePath.includes("/../")
      || normalizedSafePath.startsWith("/")
    ) {
      throw new HttpError(422, "Path must stay within the issue project root");
    }

    const { issue, root } = await resolveIssueProjectRoot(issueId, companyId);
    if (!issue) throw new HttpError(404, "Issue not found");
    if (!root) throw new HttpError(422, "Issue project has no local codebase");

    const absoluteRoot = path.resolve(root);
    const absolutePath = path.resolve(absoluteRoot, normalizedSafePath);
    const relativeFromRoot = path.relative(absoluteRoot, absolutePath);
    if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
      throw new HttpError(422, "Path must stay within the issue project root");
    }

    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats || !stats.isFile()) {
      return {
        issue,
        root: absoluteRoot,
        absolutePath,
        preview: {
          path: normalizedSafePath,
          absolutePath: null,
          exists: false,
          kind: "missing" as const,
          contentType: null,
          byteSize: null,
          snippet: null,
          contentPath: null,
        },
      };
    }

    const contentType = contentTypeForPreviewPath(absolutePath);
    const imageContentType = IMAGE_PREVIEW_CONTENT_TYPES[path.extname(absolutePath).toLowerCase()];
    if (imageContentType) {
      return {
        issue,
        root: absoluteRoot,
        absolutePath,
        preview: {
          path: normalizedSafePath,
          absolutePath,
          exists: true,
          kind: "image" as const,
          contentType,
          byteSize: stats.size,
          snippet: null,
          contentPath: `/api/issues/${issueId}/file-preview/content?path=${encodeURIComponent(normalizedSafePath)}`,
        },
      };
    }

    const isTextPreview = TEXT_PREVIEW_EXTENSIONS.has(path.extname(absolutePath).toLowerCase());
    if (!isTextPreview) {
      return {
        issue,
        root: absoluteRoot,
        absolutePath,
        preview: {
          path: normalizedSafePath,
          absolutePath,
          exists: true,
          kind: "unsupported" as const,
          contentType,
          byteSize: stats.size,
          snippet: null,
          contentPath: null,
        },
      };
    }

    const raw = await fs.readFile(absolutePath);
    return {
      issue,
      root: absoluteRoot,
      absolutePath,
      preview: {
        path: normalizedSafePath,
        absolutePath,
        exists: true,
        kind: "text" as const,
        contentType,
        byteSize: stats.size,
        snippet: raw.subarray(0, ISSUE_FILE_PREVIEW_MAX_BYTES).toString("utf8"),
        contentPath: null,
      },
    };
  }

  function respondIssueUpdate422(
    res: Response,
    reasonCode: IssueQaGateReasonCode,
    message = issueQaGateReasonMessage(reasonCode),
  ) {
    res.status(422).json({
      error: message,
      message,
      reasonCode,
    });
  }

  function maybeRespondIssueAction422(res: Response, err: unknown) {
    if (!(err instanceof HttpError) || err.status !== 422) return false;
    const reasonCode =
      err.details &&
      typeof err.details === "object" &&
      typeof (err.details as Record<string, unknown>).reasonCode === "string"
        ? ((err.details as Record<string, unknown>).reasonCode as string)
        : null;
    if (!reasonCode) return false;
    respondIssueUpdate422(res, reasonCode as IssueQaGateReasonCode, err.message);
    return true;
  }

  async function getAgentRecord(agentId: string, companyId: string) {
    if (typeof (agentsSvc as { getById?: unknown }).getById !== "function") return null;
    return await Promise.resolve((agentsSvc as { getById: (id: string) => unknown }).getById(agentId))
      .then((agent) => {
        const candidate = agent as {
          companyId?: unknown;
          role?: unknown;
          name?: unknown;
          status?: unknown;
        } | null;
        if (!candidate || typeof candidate.companyId !== "string") return null;
        if (candidate.companyId !== companyId) return null;
        return {
          role: typeof candidate.role === "string" ? candidate.role : null,
          name: typeof candidate.name === "string" ? candidate.name : null,
          status: typeof candidate.status === "string" ? candidate.status : null,
        };
      })
      .catch(() => null);
  }

  async function getAgentRole(agentId: string, companyId: string) {
    return (await getAgentRecord(agentId, companyId))?.role ?? null;
  }

  async function getAgentName(agentId: string, companyId: string) {
    return (await getAgentRecord(agentId, companyId))?.name ?? null;
  }

  async function listCompanyQaReviewerPool(companyId: string) {
    const [company, companyAgents, openIssues] = await Promise.all([
      companiesSvc.getById(companyId),
      typeof (agentsSvc as { list?: unknown }).list === "function"
        ? Promise.resolve(
            (agentsSvc as {
              list: (id: string) => Promise<Array<{
                id: string;
                companyId: string;
                role?: string | null;
                status?: string | null;
                name?: string | null;
                title?: string | null;
              }>>;
            }).list(companyId),
          )
        : Promise.resolve([]),
      Promise.resolve(svc.list(companyId, { status: QA_OPEN_LOAD_STATUSES.join(",") }))
        .then((rows) => rows ?? [])
        .catch(() => []),
    ]);

    const reviewers = companyAgents.filter((agent) =>
      agent.companyId === companyId
      && agent.role === "qa");
    return {
      reviewers,
      preferredReviewerAgentId: resolvePreferredQaReviewerAgentId(
        reviewers,
        company?.releaseGateQaAgentId ?? null,
      ),
      openIssueCountByAgentId: buildQaOpenIssueCountByAgentId(
        openIssues,
        reviewers.map((reviewer) => reviewer.id),
      ),
    };
  }

  async function buildDeliveryQaReviewPlan(input: {
    companyId: string;
    stickyReviewerAgentId?: string | null;
  }) {
    const pool = await listCompanyQaReviewerPool(input.companyId);
    const selection = orderPooledQaReviewers({
      reviewers: pool.reviewers,
      stickyReviewerAgentId: input.stickyReviewerAgentId ?? null,
      preferredReviewerAgentId: pool.preferredReviewerAgentId,
      openIssueCountByAgentId: pool.openIssueCountByAgentId,
    });
    return {
      ...selection,
      executionPolicy: buildDeliveryQaExecutionPolicy(selection.orderedReviewers),
    };
  }

  function sameActivityValue(left: unknown, right: unknown): boolean {
    if (left instanceof Date || right instanceof Date) {
      const leftTime = left instanceof Date ? left.getTime() : (left == null ? null : new Date(left as string).getTime());
      const rightTime = right instanceof Date ? right.getTime() : (right == null ? null : new Date(right as string).getTime());
      return leftTime === rightTime;
    }
    if (typeof left === "object" || typeof right === "object") {
      return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
    }
    return left === right;
  }

  function buildIssueActivityFieldDelta(
    existing: Record<string, unknown>,
    updated: Record<string, unknown>,
  ) {
    const previous: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const key of ISSUE_ACTIVITY_DETAIL_KEYS) {
      if (sameActivityValue(existing[key], updated[key])) continue;
      previous[key] = existing[key];
      next[key] = updated[key];
    }
    return { previous, next };
  }

  function buildQaRoutingComment(
    agentId: string,
    agentName: string | null | undefined,
    opts?: { alreadyAssigned?: boolean },
  ) {
    const mentionLabel = `@${(agentName ?? "qa-agent").trim() || "qa-agent"}`;
    const mention = `[${mentionLabel}](${buildAgentMentionHref(agentId)})`;
    return [
      QA_ROUTE_COMMENT_MARKER,
      opts?.alreadyAssigned
        ? `QA ownership stays with ${mention} because this delivery issue entered in_review.`
        : `Routed to QA ${mention} because this delivery issue entered in_review.`,
      "QA now owns the release gate for this issue.",
    ].join("\n");
  }

  function buildQaAssignmentRequiredComment(input: {
    eligibleQaAgents: Array<{ name?: string | null }>;
    blockingReason?: string | null;
  }) {
    const reason =
      input.blockingReason
      ?? "No healthy QA reviewer is currently available for automatic routing.";
    const eligibleQaNames = input.eligibleQaAgents
      .map((agent) => agent.name?.trim())
      .filter((name): name is string => Boolean(name));

    return [
      QA_ASSIGNMENT_REQUIRED_COMMENT_MARKER,
      "Workflow gate: waiting for an eligible QA reviewer before entering in_review.",
      reason,
      eligibleQaNames.length > 0 ? `Eligible QA agents: ${eligibleQaNames.join(", ")}.` : null,
      "Board action required: add or resume QA capacity, then retry QA routing.",
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  async function maybeAddQaAssignmentRequiredComment(input: {
    issueId: string;
    eligibleQaAgents: Array<{ name?: string | null }>;
    blockingReason?: string | null;
  }) {
    type QaAssignmentCommentRecord = {
      body: string | null | undefined;
      createdAt: Date | string | null | undefined;
    };
    type QaAssignmentCommentService = {
      listComments?: (
        issueId: string,
        opts?: { order?: "asc" | "desc"; limit?: number | null },
      ) => Promise<QaAssignmentCommentRecord[]>;
      hasCommentContaining?: (
        issueId: string,
        fragment: string,
      ) => Promise<boolean>;
    };
    const commentService = svc as unknown as QaAssignmentCommentService;
    const listComments =
      typeof commentService.listComments === "function"
        ? commentService.listComments.bind(commentService)
        : null;
    const listRecentComments = async () => {
      if (!listComments) return [] as QaAssignmentCommentRecord[];
      return await listComments(input.issueId, {
        order: "desc",
        limit: QA_ASSIGNMENT_REQUIRED_COMMENT_LOOKBACK,
      });
    };

    const hasMarkerInRecentWindow = async () => {
      const recentComments = await listRecentComments();
      const recentCommentsForTruth = recentComments.filter((comment) => typeof comment.body === "string");
      if (recentCommentsForTruth.length > 0) {
        const latestStructuredTruthComment = resolveLatestStructuredTruthComment(recentCommentsForTruth);
        if (latestStructuredTruthComment) {
          const latestTruthCreatedAt = new Date(latestStructuredTruthComment.createdAt ?? 0).getTime();
          if (Number.isFinite(latestTruthCreatedAt)) {
            for (const comment of recentCommentsForTruth) {
              const body = comment.body ?? "";
              const createdAt = new Date(comment.createdAt ?? 0).getTime();
              if (!Number.isFinite(createdAt) || createdAt < latestTruthCreatedAt) continue;
              if (body.includes(QA_ASSIGNMENT_REQUIRED_COMMENT_MARKER)) return true;
            }
            return false;
          }
        }
      }
      return recentComments.some((comment) =>
        typeof comment.body === "string" && comment.body.includes(QA_ASSIGNMENT_REQUIRED_COMMENT_MARKER));
    };

    const recentWindowMarkerState = listComments ? await hasMarkerInRecentWindow() : null;
    if (recentWindowMarkerState === true) return;
    if (recentWindowMarkerState === false) {
      await svc.addComment(
        input.issueId,
        buildQaAssignmentRequiredComment(input),
        {},
      );
      return;
    }

    const hasMarker =
      typeof commentService.hasCommentContaining === "function"
        ? await commentService.hasCommentContaining(input.issueId, QA_ASSIGNMENT_REQUIRED_COMMENT_MARKER)
        : false;
    if (hasMarker) return;
    await svc.addComment(
      input.issueId,
      buildQaAssignmentRequiredComment(input),
      {},
    );
  }

  async function maybePromoteCommentReadyForQa<
    TIssue extends {
      id: string;
      companyId: string;
      status: string;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      workIntent?: string | null;
      qaReviewerAgentId?: string | null;
      identifier?: string | null;
      title?: string | null;
      description?: string | null;
      executionPolicy?: Record<string, unknown> | IssueExecutionPolicy | null;
      executionState?: Record<string, unknown> | IssueExecutionState | null;
      workflowTemplateKey?: string | null;
      workflowLaneRole?: string | null;
    },
  >(input: {
    issue: TIssue;
    comment: Pick<IssueComment, "authorAgentId" | "body">;
    actor: {
      actorType: "agent" | "user";
      actorId: string;
      agentId: string | null;
      runId: string | null;
    };
  }) {
    if (input.issue.status !== "in_progress") {
      return { issue: input.issue, qaAutoRouting: null as { agentId: string; agentName: string | null } | null };
    }
    if (input.issue.workflowTemplateKey || input.issue.workflowLaneRole) {
      return { issue: input.issue, qaAutoRouting: null };
    }
    if (input.issue.assigneeAgentId == null || input.comment.authorAgentId !== input.issue.assigneeAgentId) {
      return { issue: input.issue, qaAutoRouting: null };
    }
    const commentBody = input.comment.body ?? "";
    const truthType = classifyIssueTruthFromCommentBody(commentBody);
    const readyForQa =
      hasReadyForQaTruthFromCommentBody(commentBody)
      || truthType === "completion";
    if (!readyForQa) {
      return { issue: input.issue, qaAutoRouting: null };
    }

    const assigneeRole = await getAgentRole(input.issue.assigneeAgentId, input.issue.companyId);
    const issueText = buildIssueRoutingText({
      identifier: input.issue.identifier ?? null,
      title: input.issue.title ?? "",
      description: input.issue.description ?? null,
    });
    if (!isDeliveryScopedIssue({ workIntent: input.issue.workIntent, assigneeRole, issueText })) {
      return { issue: input.issue, qaAutoRouting: null };
    }

    const stickyReviewerAgentId =
      input.issue.qaReviewerAgentId
      ?? (assigneeRole === "qa" ? input.issue.assigneeAgentId : null);
    const qaReviewPlan = await buildDeliveryQaReviewPlan({
      companyId: input.issue.companyId,
      stickyReviewerAgentId,
    });
    const effectiveExecutionPolicy = qaReviewPlan.executionPolicy;

    if (!effectiveExecutionPolicy) {
      await maybeAddQaAssignmentRequiredComment({
        issueId: input.issue.id,
        eligibleQaAgents: [],
        blockingReason: "No eligible QA reviewer is available for automatic routing.",
      });
      return { issue: input.issue, qaAutoRouting: null };
    }

    const transition = applyIssueExecutionPolicyTransition({
      issue: input.issue,
      policy: effectiveExecutionPolicy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: {
        agentId: input.actor.agentId ?? null,
        userId: input.actor.actorType === "user" ? input.actor.actorId : null,
      },
      commentBody,
    });
    const promotedReviewerAgentId =
      typeof transition.patch.assigneeAgentId === "string"
        ? transition.patch.assigneeAgentId
        : null;
    if (!promotedReviewerAgentId) {
      return { issue: input.issue, qaAutoRouting: null };
    }

    const promotedIssue = await svc.update(input.issue.id, {
      ...transition.patch,
      qaReviewerAgentId: promotedReviewerAgentId,
      executionPolicy: effectiveExecutionPolicy as unknown as Record<string, unknown>,
      actorAgentId: input.actor.agentId ?? null,
      actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
    });
    if (!promotedIssue) {
      return { issue: input.issue, qaAutoRouting: null };
    }

    await routinesSvc.syncRunStatusForIssue(promotedIssue.id);

    await logActivity(db, {
      companyId: promotedIssue.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: promotedIssue.id,
      details: {
        status: "in_review",
        assigneeAgentId: promotedReviewerAgentId,
        assigneeUserId: null,
        identifier: promotedIssue.identifier,
        source: "comment",
        _previous: {
          status: input.issue.status,
          assigneeAgentId: input.issue.assigneeAgentId,
          assigneeUserId: input.issue.assigneeUserId,
        },
      },
    });

    return {
      issue: promotedIssue as unknown as TIssue,
      qaAutoRouting: {
        agentId: promotedReviewerAgentId,
        agentName: await getAgentName(promotedReviewerAgentId, input.issue.companyId),
      },
    };
  }

  function formatIssueReference(issue: { id: string; identifier?: string | null }) {
    const identifier = issue.identifier?.trim();
    return identifier && identifier.length > 0 ? identifier : issue.id;
  }

  function humanizeIssueStatus(status: string) {
    return status.replace(/_/g, " ");
  }

  async function maybeNormalizeRecoverySourceComment(input: {
    issue: {
      id: string;
      companyId: string;
      identifier?: string | null;
      status: string;
      recoverySuccessor?: { id: string; identifier?: string | null } | null;
    };
    body: string;
    actor: {
      actorType: "agent" | "user";
      agentId: string | null;
      runId: string | null;
    };
  }) {
    if (input.actor.actorType !== "agent" || !input.actor.agentId || !input.actor.runId) {
      return input.body;
    }
    if (input.body.includes(RECOVERY_SUCCESSOR_NOTE_MARKER)) {
      return input.body;
    }

    const run = await heartbeat.getRun(input.actor.runId);
    if (!run || run.companyId !== input.issue.companyId || run.agentId !== input.actor.agentId) {
      return input.body;
    }
    if (!run.contextSnapshot || typeof run.contextSnapshot !== "object") {
      return input.body;
    }

    const snapshot = run.contextSnapshot as Record<string, unknown>;
    const runIssueId = typeof snapshot.issueId === "string" ? snapshot.issueId : null;
    if (!runIssueId || runIssueId === input.issue.id) {
      return input.body;
    }

    const runIssue = await svc.getById(runIssueId);
    if (!runIssue || runIssue.companyId !== input.issue.companyId) {
      return input.body;
    }

    const isRecoveryPair = input.issue.recoverySuccessor?.id === runIssue.id;
    if (!isRecoveryPair) {
      return input.body;
    }

    const successorRef = formatIssueReference(runIssue);
    const sourceRef = formatIssueReference(input.issue);
    const looksLikeCompletion =
      classifyIssueTruthFromCommentBody(input.body) === "completion"
      || runIssue.status === "done";
    const summaryLine = looksLikeCompletion
      ? `Successor issue ${successorRef} completed. ${sourceRef} remains ${humanizeIssueStatus(input.issue.status)} as the recovery source.`
      : `This note was posted from successor issue ${successorRef}. ${sourceRef} remains ${humanizeIssueStatus(input.issue.status)} as the recovery source.`;

    return [
      RECOVERY_SUCCESSOR_NOTE_MARKER,
      summaryLine,
      "",
      "Original note:",
      input.body,
    ].join("\n");
  }

  async function readLatestIssueCommentStatus(issue: { executionRunId?: string | null }) {
    if (!issue.executionRunId) return null;
    const run = await db
      .select({ issueCommentStatus: heartbeatRuns.issueCommentStatus })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, issue.executionRunId))
      .then((rows) => rows[0] ?? null);
    return run?.issueCommentStatus === "not_applicable"
      || run?.issueCommentStatus === "satisfied"
      || run?.issueCommentStatus === "retry_queued"
      || run?.issueCommentStatus === "retry_exhausted"
      ? run.issueCommentStatus
      : null;
  }
  async function listQaCommentsForIssue(input: {
    issueId: string;
    companyId: string;
    limit: number;
    authorAgentId?: string | null;
  }) {
    if (typeof (svc as { listComments?: unknown }).listComments !== "function") {
      return [] as IssueComment[];
    }
    const comments = await svc.listComments(input.issueId, {
      order: "desc",
      limit: input.limit,
    });
    const authorIds = [...new Set(
      comments
        .map((comment) => comment.authorAgentId)
        .filter((agentId): agentId is string => typeof agentId === "string" && agentId.length > 0),
    )];
    const roleByAuthorId = new Map<string, string | null>();
    await Promise.all(
      authorIds.map(async (authorId) => {
        roleByAuthorId.set(authorId, await getAgentRole(authorId, input.companyId));
      }),
    );
    return comments.filter((comment) => {
      if (!comment.authorAgentId) return false;
      if (roleByAuthorId.get(comment.authorAgentId) !== "qa") return false;
      if (input.authorAgentId && comment.authorAgentId !== input.authorAgentId) return false;
      return true;
    }) satisfies IssueComment[];
  }

  function getCurrentParticipantAgentId(executionState: unknown) {
    if (!executionState || typeof executionState !== "object") return null;
    const currentParticipant = (executionState as {
      currentParticipant?: { type?: string; agentId?: string | null } | null;
    }).currentParticipant ?? null;
    if (currentParticipant?.type !== "agent") return null;
    return currentParticipant.agentId ?? null;
  }

  function getLastDecisionOutcome(executionState: unknown) {
    if (!executionState || typeof executionState !== "object") return null;
    return (executionState as {
      lastDecisionOutcome?: IssueExecutionDecisionOutcome | null;
    }).lastDecisionOutcome ?? null;
  }

  async function computeIssueQaGate(
    issue: {
      id: string;
      companyId: string;
      status: string;
      assigneeAgentId: string | null;
      assigneeUserId?: string | null;
      workIntent?: string | null;
      qaReviewerAgentId?: string | null;
      identifier?: string | null;
      title?: string;
      description?: string | null;
      projectId?: string | null;
      workflowLaneRole?: string | null;
      executionState?: Record<string, unknown> | IssueExecutionState | null;
    },
    opts?: { commentLimit?: number },
  ) {
    const assigneeRole = issue.assigneeAgentId
      ? await getAgentRole(issue.assigneeAgentId, issue.companyId)
      : null;
    const projectName =
      issue.projectId
        ? (await projectsSvc.getById(issue.projectId).catch(() => null))?.name ?? null
        : null;
    const authorizedReviewerAgentId =
      issue.workflowLaneRole === "qa"
        ? issue.assigneeAgentId
        : getCurrentParticipantAgentId(issue.executionState)
          ?? issue.qaReviewerAgentId
          ?? (assigneeRole === "qa" ? issue.assigneeAgentId : null);
    const qaComments = await listQaCommentsForIssue({
      issueId: issue.id,
      companyId: issue.companyId,
      limit: opts?.commentLimit ?? MAX_ISSUE_COMMENT_LIMIT,
      authorAgentId: authorizedReviewerAgentId,
    });
    const latestDecisionOutcome = getLastDecisionOutcome(issue.executionState);
    const qaGate = buildIssueQaGate({
      issue: { status: issue.status as IssueStatus },
      workIntent: issue.workIntent,
      assigneeRole,
      issueText: buildIssueRoutingText({
        identifier: issue.identifier ?? null,
        title: issue.title ?? "",
        description: issue.description ?? null,
        projectName,
      }),
      qaComments,
      latestDecisionOutcome,
    });
    if (!qaGate.isDeliveryScoped || !["in_review", "done"].includes(issue.status)) {
      return qaGate;
    }

    const qaOwnershipFailure: IssueQaGateReasonCode | null =
      !authorizedReviewerAgentId || issue.assigneeUserId || issue.assigneeAgentId !== authorizedReviewerAgentId
        ? "qa_gate_requires_qa_assignee"
        : null;
    if (!qaOwnershipFailure || qaGate.missingRequirements.includes(qaOwnershipFailure)) {
      return qaGate;
    }

    return {
      ...qaGate,
      canShip: false,
      missingRequirements: [qaOwnershipFailure, ...qaGate.missingRequirements],
    };
  }

  async function validateQaVerdictComment(input: {
    issue: {
      id: string;
      companyId: string;
      status: string;
      assigneeAgentId: string | null;
      assigneeUserId?: string | null;
      workIntent?: string | null;
      qaReviewerAgentId?: string | null;
      identifier?: string | null;
      title?: string;
      description?: string | null;
      projectId?: string | null;
      executionState?: Record<string, unknown> | IssueExecutionState | null;
      workflowTemplateKey?: string | null;
      workflowLaneRole?: string | null;
    };
    body: string;
    actor: {
      actorType: "agent" | "user";
      actorId: string;
      agentId: string | null;
    };
  }): Promise<null | { reasonCode?: IssueQaGateReasonCode; error: string }> {
    const hasExplicitQaPassMarker = QA_PASS_MARKER_REGEX.test(input.body);
    const hasExplicitReleaseConfirmedMarker = RELEASE_CONFIRMED_MARKER_REGEX.test(input.body);
    const hasQaPassSignal = qaCommentHasQaPassMarker(input.body);
    const hasReleaseConfirmedSignal = qaCommentHasReleaseConfirmedMarker(input.body);
    if (!hasQaPassSignal && !hasReleaseConfirmedSignal) return null;

    const assigneeRole = input.issue.assigneeAgentId
      ? await getAgentRole(input.issue.assigneeAgentId, input.issue.companyId)
      : null;
    const projectName =
      input.issue.projectId
        ? (await projectsSvc.getById(input.issue.projectId).catch(() => null))?.name ?? null
        : null;
    const latestDecisionOutcome = getLastDecisionOutcome(input.issue.executionState);
    const qaScope = buildIssueQaGate({
      issue: { status: input.issue.status as IssueStatus },
      workIntent: input.issue.workIntent,
      assigneeRole,
      issueText: buildIssueRoutingText({
        identifier: input.issue.identifier ?? null,
        title: input.issue.title ?? "",
        description: input.issue.description ?? null,
        projectName,
      }),
      qaComments: [],
      latestDecisionOutcome,
    });
    if (!qaScope.isDeliveryScoped && input.issue.workflowLaneRole !== "qa") {
      return null;
    }

    const authorizedReviewerAgentId =
      input.issue.workflowLaneRole === "qa"
        ? input.issue.assigneeAgentId
        : getCurrentParticipantAgentId(input.issue.executionState)
          ?? input.issue.qaReviewerAgentId
          ?? (assigneeRole === "qa" ? input.issue.assigneeAgentId : null);
    if (!authorizedReviewerAgentId || input.issue.assigneeUserId) {
      return {
        error: "No active QA reviewer is assigned to this issue.",
      };
    }
    if (input.actor.agentId !== authorizedReviewerAgentId) {
      return {
        error: "Only the active QA reviewer can post [QA PASS] or [RELEASE CONFIRMED] verdict comments.",
      };
    }
    if (!input.issue.workflowTemplateKey && !input.issue.workflowLaneRole && input.issue.status !== "in_review") {
      return {
        reasonCode: "qa_gate_requires_in_review",
        error: issueQaGateReasonMessage("qa_gate_requires_in_review"),
      };
    }

    const summary = parseQaSummary(input.body);
    if (!qaCommentHasExplicitSummaryTokens(input.body)) {
      return {
        reasonCode: "qa_gate_missing_qa_summary",
        error: issueQaGateReasonMessage("qa_gate_missing_qa_summary"),
      };
    }
    if (!qaCommentHasExplicitTestCoverageVerdict(input.body) || qaSummaryNeedsExplicitTestCoverageVerdict(summary)) {
      return {
        reasonCode: "qa_gate_missing_test_coverage_verdict",
        error: issueQaGateReasonMessage("qa_gate_missing_test_coverage_verdict"),
      };
    }
    if (summary.overall === "fail") {
      return {
        reasonCode: "qa_gate_failing_review",
        error: issueQaGateReasonMessage("qa_gate_failing_review"),
      };
    }

    const verification = parseQaVerification(input.body);
    if (!qaCommentHasExplicitVerificationTokens(input.body) || !verification.complete) {
      return {
        reasonCode: "qa_gate_missing_verification",
        error: issueQaGateReasonMessage("qa_gate_missing_verification"),
      };
    }
    if (verification.overall !== "pass") {
      return {
        reasonCode: "qa_gate_failing_verification",
        error: issueQaGateReasonMessage("qa_gate_failing_verification"),
      };
    }

    if (!hasExplicitQaPassMarker) {
      return {
        reasonCode: "qa_gate_missing_qa_pass",
        error: issueQaGateReasonMessage("qa_gate_missing_qa_pass"),
      };
    }
    if (!hasExplicitReleaseConfirmedMarker) {
      return {
        reasonCode: "qa_gate_missing_release_confirmation",
        error: issueQaGateReasonMessage("qa_gate_missing_release_confirmation"),
      };
    }

    return null;
  }

  type LegacyWorkflowWriteRejection = {
    suggestedActionType: IssueActionRequest["type"];
    error: string;
    details?: Record<string, unknown>;
  };

  function buildLegacyWorkflowWriteError(actionType: IssueActionRequest["type"], routeLabel: string) {
    return `${routeLabel} no longer accepts workflow-control writes. Use POST /issues/:id/actions with type="${actionType}".`;
  }

  function detectLegacyWorkflowControlFromIssuePatch(input: {
    issue: {
      status: string;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
    };
    reopenRequested?: boolean;
    forceDoneRequested?: boolean;
    updateFields: Record<string, unknown>;
  }): LegacyWorkflowWriteRejection | null {
    if (input.forceDoneRequested) return null;

    const definedUpdateFieldEntries = Object.entries(input.updateFields)
      .filter(([, value]) => value !== undefined);
    const requestedStatus = typeof input.updateFields.status === "string"
      ? input.updateFields.status
      : undefined;
    const nextAssigneeAgentId =
      input.updateFields.assigneeAgentId === undefined
        ? input.issue.assigneeAgentId ?? null
        : (input.updateFields.assigneeAgentId as string | null);
    const nextAssigneeUserId =
      input.updateFields.assigneeUserId === undefined
        ? input.issue.assigneeUserId ?? null
        : (input.updateFields.assigneeUserId as string | null);
    const assigneeWillChange =
      nextAssigneeAgentId !== (input.issue.assigneeAgentId ?? null)
      || nextAssigneeUserId !== (input.issue.assigneeUserId ?? null);
    const suggestedReopenAction = assigneeWillChange ? "handoff_issue" : "reopen_issue";

    if (requestedStatus && requestedStatus !== input.issue.status) {
      if (requestedStatus === "in_review") {
        return {
          suggestedActionType: "enter_review",
          error: buildLegacyWorkflowWriteError("enter_review", "PATCH /issues/:id"),
          details: { requestedStatus },
        };
      }
      if (requestedStatus === "done") {
        return {
          suggestedActionType: "complete_issue",
          error: buildLegacyWorkflowWriteError("complete_issue", "PATCH /issues/:id"),
          details: { requestedStatus },
        };
      }
      if (isTerminalIssueStatus(input.issue.status) && !isTerminalIssueStatus(requestedStatus)) {
        return {
          suggestedActionType: suggestedReopenAction,
          error: buildLegacyWorkflowWriteError(suggestedReopenAction, "PATCH /issues/:id"),
          details: { requestedStatus },
        };
      }
    }

    if (isTerminalIssueStatus(input.issue.status) && input.reopenRequested === true) {
      return {
        suggestedActionType: suggestedReopenAction,
        error: buildLegacyWorkflowWriteError(suggestedReopenAction, "PATCH /issues/:id"),
        details: { reopenRequested: true },
      };
    }

    return null;
  }

  function detectLegacyWorkflowControlFromComment(input: {
    body: string;
    reopenRequested?: boolean;
  }): LegacyWorkflowWriteRejection | null {
    if (input.reopenRequested) {
      return {
        suggestedActionType: "reopen_issue",
        error: buildLegacyWorkflowWriteError("reopen_issue", "POST /issues/:id/comments"),
        details: { reopenRequested: true },
      };
    }
    if (qaCommentHasQaPassMarker(input.body) || qaCommentHasReleaseConfirmedMarker(input.body)) {
      return {
        suggestedActionType: "submit_qa_verdict",
        error: buildLegacyWorkflowWriteError("submit_qa_verdict", "POST /issues/:id/comments"),
      };
    }
    return null;
  }

  function respondLegacyWorkflowWriteRejected(
    res: Response,
    input: {
      issue: { id: string; companyId: string; status: string };
      actor: { actorType: "agent" | "user"; actorId: string; agentId: string | null };
      route: "patch" | "comment";
      rejection: LegacyWorkflowWriteRejection;
    },
  ) {
    logOpsWarn("issue.legacy_workflow_write_rejected", {
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      issueStatus: input.issue.status,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId ?? undefined,
      route: input.route,
      suggestedActionType: input.rejection.suggestedActionType,
      ...input.rejection.details,
    });
    res.status(422).json({
      error: input.rejection.error,
      suggestedActionType: input.rejection.suggestedActionType,
    });
  }

  async function computeIssueMergeStatusSafe(
    issue: {
      id: string;
      companyId: string;
      projectId?: string | null;
      status: string;
      assigneeAgentId: string | null;
      executionState?: { lastDecisionOutcome?: IssueExecutionDecisionOutcome | null } | null;
      executionRunId?: string | null;
      executionWorkspaceId?: string | null;
    },
    opts?: {
      qaGate?: Awaited<ReturnType<typeof computeIssueQaGate>> | null;
      executionWorkspace?: ExecutionWorkspace | null;
    },
  ) {
    try {
      const qaGate = opts?.qaGate ?? await computeIssueQaGateSafe(issue);
      if (!issue.projectId && !issue.executionWorkspaceId) return null;
      const [project, executionWorkspace, lastIssueCommentStatus] = await Promise.all([
        issue.projectId ? projectsSvc.getById(issue.projectId) : Promise.resolve(null),
        opts?.executionWorkspace !== undefined
          ? Promise.resolve(opts.executionWorkspace)
          : issue.executionWorkspaceId
            ? executionWorkspacesSvc.getById(issue.executionWorkspaceId)
            : Promise.resolve(null),
        readLatestIssueCommentStatus(issue),
      ]);
      return await issueMerge.getIssueMergeStatus({
        issueStatus: issue.status,
        projectPolicy: parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy ?? null),
        executionWorkspace,
        qaCanShip: qaGate?.canShip === true,
        lastIssueCommentStatus,
      });
    } catch (err) {
      logger.warn({ err, issueId: issue.id, companyId: issue.companyId }, "failed to synthesize issue merge status");
      return null;
    }
  }

  async function applyWorkflowTemplateAndWakeChildren(input: {
    companyId: string;
    templateKey: IssueWorkflowTemplateKey;
    parentIssue: {
      id: string;
      companyId: string;
      parentId: string | null;
      projectId: string | null;
      goalId: string | null;
      priority: string;
      title: string;
      description: string | null;
      identifier: string | null;
      workflowTemplateKey?: string | null;
    };
    actor: ReturnType<typeof getActorInfo>;
    dbOrTx?: any;
    queueWakeups?: boolean;
  }) {
    const applied = await issueWorkflowsSvc.applyTemplate({
      companyId: input.companyId,
      templateKey: input.templateKey,
      parentIssue: input.parentIssue!,
      actorAgentId: input.actor.agentId ?? null,
      actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
      createIssue: (data, dbOrTx) => svc.create(input.companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
      dbOrTx: input.dbOrTx,
    });

    const logDb = input.dbOrTx ?? db;
    for (const child of applied.createdChildren) {
      await logActivity(logDb, {
        companyId: input.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.created",
        entityType: "issue",
        entityId: child.id,
        details: {
          title: child.title,
          identifier: child.identifier,
          parentId: child.parentId,
          workflowTemplateKey: child.workflowTemplateKey,
          workflowLaneRole: child.workflowLaneRole,
          workflowGenerated: true,
        },
      });
    }

    await logActivity(logDb, {
      companyId: input.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: "issue.workflow_template_applied",
      entityType: "issue",
      entityId: applied.parentIssue.id,
      details: {
        workflowTemplateKey: input.templateKey,
        childIssueIds: applied.createdChildren.map((child) => child.id),
      },
    });

    if (input.queueWakeups !== false) {
      for (const child of applied.createdChildren) {
        if (child.status === "blocked") {
          continue;
        }

        void queueIssueAssignmentWakeup({
          heartbeat,
          issue: child,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "issue.workflow_template",
          requestedByActorType: input.actor.actorType,
          requestedByActorId: input.actor.actorId,
        });
      }
    }

    return applied;
  }

  async function runIssueMutationTransaction<T>(fn: (dbOrTx: any) => Promise<T>) {
    if (typeof (db as { transaction?: unknown }).transaction === "function") {
      return await (db as { transaction: (cb: (tx: any) => Promise<T>) => Promise<T> }).transaction(fn);
    }
    return await fn(db);
  }

  async function queueWorkflowTemplateChildWakeups(input: {
    createdChildren: Array<{ id: string; assigneeAgentId: string | null; status: string }>;
    actor: ReturnType<typeof getActorInfo>;
  }) {
    for (const child of input.createdChildren) {
      if (child.status === "blocked") {
        continue;
      }

      void queueIssueAssignmentWakeup({
        heartbeat,
        issue: child,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.workflow_template",
        requestedByActorType: input.actor.actorType,
        requestedByActorId: input.actor.actorId,
      });
    }
  }

  async function persistExecutionWorkspaceMergeStatus(
    workspace: ExecutionWorkspace | null,
    mergeStatus: Awaited<ReturnType<typeof computeIssueMergeStatusSafe>>,
  ) {
    if (!workspace || !mergeStatus) return workspace;
    const metadata = {
      ...((workspace.metadata as Record<string, unknown> | null) ?? {}),
      merge: {
        state: mergeStatus.state,
        targetBranch: mergeStatus.targetBranch,
        sourceBranch: mergeStatus.sourceBranch,
        repoRoot: mergeStatus.repoRoot,
        reason: mergeStatus.reason,
        mergedCommit: mergeStatus.mergedCommit,
        mergedAt: mergeStatus.mergedAt?.toISOString() ?? null,
        lastAttemptedAt: mergeStatus.lastAttemptedAt?.toISOString() ?? null,
      },
    };
    return await executionWorkspacesSvc.update(workspace.id, { metadata });
  }

  async function maybeAutoMergeValidatedIssue<
    TIssue extends {
      id: string;
      companyId: string;
      projectId: string | null;
      status: string;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      executionState?: { lastDecisionOutcome?: IssueExecutionDecisionOutcome | null } | null;
      parentId?: string | null;
      identifier?: string | null;
      title?: string;
      executionRunId?: string | null;
      executionWorkspaceId?: string | null;
      workflowTemplateKey?: string | null;
    },
  >(input: {
    issue: TIssue;
    comment: IssueComment;
    actor: {
      actorType: "agent" | "user";
      actorId: string;
      agentId: string | null;
      runId: string | null;
    };
  }) {
    const result = await finalizeQaValidatedIssueFromComment({
      db,
      issue: input.issue,
      comment: input.comment,
      actor: input.actor,
      logActivity,
      issues: {
        update: async (issueId, patch) => await svc.update(issueId, patch),
        addComment: async (issueId, body, opts) => await svc.addComment(issueId, body, opts),
        listComments: async (issueId) => await svc.listComments(issueId, { order: "desc", limit: MAX_ISSUE_COMMENT_LIMIT }),
      },
      issueMerge,
      projects: {
        getById: async (projectId) => await projectsSvc.getById(projectId),
      },
      executionWorkspaces: {
        getById: async (workspaceId) => await executionWorkspacesSvc.getById(workspaceId),
      },
      persistExecutionWorkspaceMergeStatus,
      workflow: {
        evaluateLaneCompletion: async (issue) => await issueWorkflowsSvc.evaluateLaneCompletion(issue),
        getWakeableParentAfterChildCompletion: async (parentIssueId) =>
          await svc.getWakeableParentAfterChildCompletion(parentIssueId),
      },
    });
    return {
      issue: result.issue as unknown as TIssue,
      mergeStatus: result.mergeStatus,
      parentWakeup: result.parentWakeup,
    };
  }
  async function computeIssueQaGateSafe(
    issue: {
      id: string;
      companyId: string;
      status: string;
      assigneeAgentId: string | null;
      executionState?: { lastDecisionOutcome?: IssueExecutionDecisionOutcome | null } | null;
    },
    opts?: { commentLimit?: number },
  ) {
    try {
      return await computeIssueQaGate(issue, opts);
    } catch (err) {
      logger.warn({ err, issueId: issue.id, companyId: issue.companyId }, "failed to synthesize qa gate");
      return null;
    }
  }

  async function maybeTriggerQaAutoFix(
    issue: {
      id: string;
      companyId: string;
      status: string;
      assigneeAgentId: string | null;
      executionState?: { lastDecisionOutcome?: IssueExecutionDecisionOutcome | null } | null;
      identifier?: string | null;
      title?: string;
      workflowTemplateKey?: string | null;
      workflowLaneRole?: string | null;
    },
    actor: {
      actorType: "agent" | "user";
      actorId: string;
      agentId: string | null;
      runId: string | null;
    },
    source: "patch_update" | "comment",
  ) {
    if (!issue.assigneeAgentId) return;
    if (issue.status !== "in_review") return;
    if (issue.workflowTemplateKey || issue.workflowLaneRole) return;
    if (typeof (svc as { listComments?: unknown }).listComments !== "function") return;

    const qaGate = await computeIssueQaGateSafe(issue);
    if (!qaGate) return;
    if (!qaGate.isDeliveryScoped) return;
    if (qaGate.review.overall !== "fail") return;

    const comments = await svc.listComments(issue.id, {
      order: "desc",
      limit: MAX_ISSUE_COMMENT_LIMIT,
    });
    const now = Date.now();
    const recentAttempts = comments.filter((comment) => {
      if (typeof comment.body !== "string" || !comment.body.includes(AUTO_FIX_ATTEMPT_MARKER)) return false;
      const createdAt = new Date(comment.createdAt).getTime();
      return Number.isFinite(createdAt) && now - createdAt <= AUTO_FIX_WINDOW_MS;
    });
    if (recentAttempts.length >= AUTO_FIX_MAX_ATTEMPTS) return;

    const attemptNumber = recentAttempts.length + 1;
    const commands = ["pnpm -r typecheck", "pnpm test:run", "pnpm build"];
    const summaryBody = [
      `${AUTO_FIX_ATTEMPT_MARKER} ${attemptNumber}/${AUTO_FIX_MAX_ATTEMPTS}`,
      "Automatic fix attempt requested from QA failure synthesis.",
      `Source: ${source}`,
      "",
      "Required verification commands:",
      ...commands.map((command) => `- ${command}`),
      "",
      "Rules:",
      "- Keep issue status in in_review if all verification commands pass.",
      "- If any verification command fails, move issue to in_progress and post a blocker summary with failed command output.",
      "- Never auto-close this issue to done.",
      "- Stop if runtime reaches 30 minutes.",
      "",
      "Expected completion comment: [AUTO-FIX READY FOR QA] or [AUTO-FIX BLOCKED].",
    ].join("\n");

    await svc.addComment(issue.id, summaryBody, {});
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.qa_autofix_triggered",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier ?? null,
        source,
        attempt: attemptNumber,
        maxAttempts: AUTO_FIX_MAX_ATTEMPTS,
        maxDurationMinutes: 30,
        commands,
      },
    });

    await heartbeat
      .wakeup(issue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "qa_autofix_requested",
        payload: {
          issueId: issue.id,
          attempt: attemptNumber,
          maxAttempts: AUTO_FIX_MAX_ATTEMPTS,
          maxDurationMinutes: 30,
          commands,
          qaReview: qaGate.review,
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          wakeReason: "qa_autofix_requested",
          source: "issue.qa_autofix",
          qaReview: qaGate.review,
        },
      })
      .catch((err) =>
        logWakeupFailure(
          err,
          {
            companyId: issue.companyId,
            issueId: issue.id,
            agentId: issue.assigneeAgentId ?? undefined,
            reason: "qa_autofix_requested",
          },
          "failed to wake assignee for qa auto-fix",
        ));
  }

  async function maybeHandleWorkflowHandbackFromComment<
    TIssue extends {
      id: string;
      companyId: string;
      status: string;
      assigneeAgentId: string | null;
      assigneeUserId?: string | null;
      parentId?: string | null;
      workflowTemplateKey?: string | null;
      workflowLaneRole?: string | null;
      identifier?: string | null;
      title?: string;
      executionState?: { lastDecisionOutcome?: IssueExecutionDecisionOutcome | null } | null;
    },
  >(input: {
    issue: TIssue;
    comment: Pick<IssueComment, "body" | "id" | "authorAgentId" | "authorUserId">;
    actor: {
      actorType: "agent" | "user";
      actorId: string;
      agentId: string | null;
      runId: string | null;
    };
  }) {
    if (!input.issue.workflowTemplateKey || !input.issue.workflowLaneRole) {
      return { issue: input.issue, handback: null as null | Awaited<ReturnType<typeof issueWorkflowsSvc.handbackWorkflowLane>> };
    }
    if (!input.issue.assigneeAgentId || input.comment.authorAgentId !== input.issue.assigneeAgentId) {
      return { issue: input.issue, handback: null as null | Awaited<ReturnType<typeof issueWorkflowsSvc.handbackWorkflowLane>> };
    }
    if (input.issue.status === "blocked" || input.issue.status === "cancelled") {
      return { issue: input.issue, handback: null as null | Awaited<ReturnType<typeof issueWorkflowsSvc.handbackWorkflowLane>> };
    }

    let shouldHandback = false;
    if (input.issue.workflowLaneRole === "security") {
      shouldHandback = SECURITY_FAIL_MARKER_REGEX.test(input.comment.body ?? "");
    } else if (input.issue.workflowLaneRole === "qa") {
      shouldHandback =
        qaCommentHasFailingReview(input.comment.body)
        || qaCommentHasFailingVerification(input.comment.body);
    }
    if (!shouldHandback) {
      return { issue: input.issue, handback: null };
    }

    const handback = await issueWorkflowsSvc.handbackWorkflowLane(input.issue.id);
    if (!handback?.targetIssue) {
      return { issue: input.issue, handback };
    }

    const refreshedSourceIssue = handback.invalidatedDescendants.find((candidate) => candidate.id === input.issue.id)
      ?? input.issue;

    logOpsInfo("workflow.handback", {
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      rootIssueId: handback.targetIssue.parentId ?? input.issue.parentId ?? null,
      templateKey: input.issue.workflowTemplateKey,
      sourceLaneRole: input.issue.workflowLaneRole,
      targetLaneRole: handback.targetIssue.workflowLaneRole ?? null,
      targetIssueId: handback.targetIssue.id,
      invalidatedIssueIds: handback.invalidatedDescendants.map((candidate) => candidate.id),
      commentId: input.comment.id,
    });

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: "issue.workflow_handback",
      entityType: "issue",
      entityId: handback.targetIssue.id,
      details: {
        identifier: handback.targetIssue.identifier,
        parentId: handback.targetIssue.parentId,
        sourceIssueId: input.issue.id,
        sourceLaneRole: input.issue.workflowLaneRole,
        targetLaneRole: handback.targetIssue.workflowLaneRole,
        invalidatedIssueIds: handback.invalidatedDescendants.map((candidate) => candidate.id),
        commentId: input.comment.id,
      },
    });

    for (const invalidatedIssue of handback.invalidatedDescendants) {
      logOpsInfo("workflow.lane.invalidated", {
        companyId: invalidatedIssue.companyId,
        issueId: invalidatedIssue.id,
        rootIssueId: invalidatedIssue.parentId ?? handback.targetIssue.parentId ?? null,
        templateKey: invalidatedIssue.workflowTemplateKey ?? input.issue.workflowTemplateKey,
        laneRole: invalidatedIssue.workflowLaneRole ?? null,
        sourceLaneRole: input.issue.workflowLaneRole,
        targetLaneRole: handback.targetIssue.workflowLaneRole ?? null,
        targetIssueId: handback.targetIssue.id,
        reason: "workflow_handback",
        commentId: input.comment.id,
        status: invalidatedIssue.status,
      });
      await logActivity(db, {
        companyId: invalidatedIssue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.workflow_lane_invalidated",
        entityType: "issue",
        entityId: invalidatedIssue.id,
        details: {
          identifier: invalidatedIssue.identifier,
          parentId: invalidatedIssue.parentId,
          sourceIssueId: input.issue.id,
          sourceLaneRole: input.issue.workflowLaneRole,
          targetIssueId: handback.targetIssue.id,
          targetLaneRole: handback.targetIssue.workflowLaneRole,
          status: invalidatedIssue.status,
          commentId: input.comment.id,
        },
      });
    }

    if (handback.targetIssue.assigneeAgentId) {
      await heartbeat.wakeup(handback.targetIssue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: {
          issueId: handback.targetIssue.id,
          workflowHandbackFromIssueId: input.issue.id,
          sourceIssueId: input.issue.id,
          sourceLaneRole: input.issue.workflowLaneRole,
          targetLaneRole: handback.targetIssue.workflowLaneRole,
          commentId: input.comment.id,
        },
        requestedByActorType: input.actor.actorType,
        requestedByActorId: input.actor.actorId,
        contextSnapshot: {
          issueId: handback.targetIssue.id,
          taskId: handback.targetIssue.id,
          wakeReason: "issue_status_changed",
          source: "issue.workflow_handback",
          workflowHandbackFromIssueId: input.issue.id,
          sourceLaneRole: input.issue.workflowLaneRole,
          targetLaneRole: handback.targetIssue.workflowLaneRole,
          commentId: input.comment.id,
        },
      }).catch((err) =>
        logWakeupFailure(
          err,
          {
            companyId: handback.targetIssue?.companyId ?? input.issue.companyId,
            issueId: handback.targetIssue?.id ?? input.issue.id,
            agentId: handback.targetIssue?.assigneeAgentId ?? undefined,
            reason: "issue_status_changed",
          },
          "failed to wake workflow handback target",
        ));
    }

    return {
      issue: refreshedSourceIssue as TIssue,
      handback,
    };
  }

  async function maybeHandleStandaloneReviewHandbackFromComment<
    TIssue extends {
      id: string;
      companyId: string;
      status: string;
      assigneeAgentId: string | null;
      assigneeUserId?: string | null;
      qaReviewerAgentId?: string | null;
      identifier?: string | null;
      title?: string;
      workflowTemplateKey?: string | null;
      workflowLaneRole?: string | null;
      executionPolicy?: Record<string, unknown> | IssueExecutionPolicy | null;
      executionState?: Record<string, unknown> | IssueExecutionState | null;
    },
  >(input: {
    issue: TIssue;
    comment: Pick<IssueComment, "body" | "id" | "authorAgentId" | "authorUserId">;
    actor: {
      actorType: "agent" | "user";
      actorId: string;
      agentId: string | null;
      runId: string | null;
    };
  }) {
    if (input.issue.workflowTemplateKey || input.issue.workflowLaneRole) {
      return { issue: input.issue, handbacked: false };
    }
    if (input.issue.status !== "in_review") {
      return { issue: input.issue, handbacked: false };
    }
    if (input.actor.actorType !== "agent" || !input.comment.authorAgentId) {
      return { issue: input.issue, handbacked: false };
    }

    const executionPolicy = normalizeIssueExecutionPolicy(input.issue.executionPolicy ?? null);
    if (!executionPolicy) {
      return { issue: input.issue, handbacked: false };
    }

    const activeReviewerAgentId = getCurrentParticipantAgentId(input.issue.executionState);
    if (!activeReviewerAgentId || input.comment.authorAgentId !== activeReviewerAgentId) {
      return { issue: input.issue, handbacked: false };
    }

    const shouldHandback =
      qaCommentHasFailingReview(input.comment.body)
      || qaCommentHasFailingVerification(input.comment.body);
    if (!shouldHandback) {
      return { issue: input.issue, handbacked: false };
    }

    const transition = applyIssueExecutionPolicyTransition({
      issue: input.issue,
      policy: executionPolicy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: {
        agentId: input.actor.agentId ?? null,
        userId: null,
      },
      commentBody: input.comment.body ?? null,
    });
    if (transition.patch.status !== "in_progress") {
      return { issue: input.issue, handbacked: false };
    }

    const decisionId = transition.decision ? randomUUID() : null;
    if (decisionId) {
      const nextExecutionState = transition.patch.executionState;
      if (!nextExecutionState || typeof nextExecutionState !== "object") {
        throw new Error("Execution policy decision patch is missing executionState");
      }
      transition.patch.executionState = {
        ...nextExecutionState,
        lastDecisionId: decisionId,
      };
    }

    const reviewerAgentId = input.issue.qaReviewerAgentId ?? activeReviewerAgentId;
    const updatedIssue = await db.transaction(async (tx) => {
      const updated = await svc.update(input.issue.id, {
        ...transition.patch,
        qaReviewerAgentId: reviewerAgentId,
        actorAgentId: input.actor.agentId ?? null,
        actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
      }, tx);
      if (!updated) return null;

      if (transition.decision && decisionId) {
        await tx.insert(issueExecutionDecisions).values({
          id: decisionId,
          companyId: updated.companyId,
          issueId: updated.id,
          stageId: transition.decision.stageId,
          stageType: transition.decision.stageType,
          actorAgentId: input.actor.agentId ?? null,
          actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
          outcome: transition.decision.outcome,
          body: transition.decision.body,
          createdByRunId: input.actor.runId ?? null,
        });
      }

      return updated;
    });
    if (!updatedIssue) {
      return { issue: input.issue, handbacked: false };
    }

    await routinesSvc.syncRunStatusForIssue(updatedIssue.id);

    await logActivity(db, {
      companyId: updatedIssue.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: updatedIssue.id,
      details: {
        status: updatedIssue.status,
        assigneeAgentId: updatedIssue.assigneeAgentId,
        assigneeUserId: updatedIssue.assigneeUserId,
        qaReviewerAgentId: reviewerAgentId,
        identifier: updatedIssue.identifier,
        source: "comment",
        _previous: {
          status: input.issue.status,
          assigneeAgentId: input.issue.assigneeAgentId,
          assigneeUserId: input.issue.assigneeUserId ?? null,
        },
      },
    });

    return {
      issue: updatedIssue as unknown as TIssue,
      handbacked: true,
    };
  }

  function getWorkflowDependentBlockerIssueIds(candidate: unknown) {
    const value = (candidate as { blockedByIssueIds?: unknown } | null)?.blockedByIssueIds;
    if (!Array.isArray(value)) return undefined;
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  function isTerminalIssueStatus(status: string) {
    return status === "done" || status === "cancelled";
  }

  async function applyIssueActionFollowUps(input: {
    existingIssue: PersistedIssue;
    action: IssueActionRequest;
    result: IssueActionResult;
    commentBody?: string | null;
    actor: {
      actorType: "agent" | "user";
      actorId: string;
      agentId: string | null;
      runId: string | null;
    };
  }) {
    const warnings = [...(input.result.warnings ?? [])];
    let nextIssue = input.result.issue as PersistedIssue;
    const assigneeChanged =
      nextIssue.assigneeAgentId !== input.existingIssue.assigneeAgentId
      || nextIssue.assigneeUserId !== input.existingIssue.assigneeUserId;
    const statusChanged = nextIssue.status !== input.existingIssue.status;

    if (statusChanged || assigneeChanged) {
      await routinesSvc.syncRunStatusForIssue(nextIssue.id);
    }

    if (input.actor.runId) {
      await heartbeat.reportRunActivity(input.actor.runId).catch((err) =>
        logger.warn({ err, runId: input.actor.runId }, "failed to clear detached run warning after typed issue action"));
    }

    if (
      assigneeChanged
      && input.action.type !== "enter_review"
      && nextIssue.assigneeAgentId
      && nextIssue.status !== "backlog"
      && !isTerminalIssueStatus(nextIssue.status)
    ) {
      const assigneeWakeup = await queueIssueAssignmentWakeup({
        heartbeat,
        issue: nextIssue,
        reason: "issue_assigned",
        mutation: "update",
        contextSource: `issue.action.${input.action.type}`,
        requestedByActorType: input.actor.actorType,
        requestedByActorId: input.actor.actorId,
      });
      if (assigneeWakeup.status === "warning" && assigneeWakeup.warning) {
        warnings.push(assigneeWakeup.warning);
      }
    }

    if (
      input.action.type === "enter_review"
      && input.existingIssue.status !== "in_review"
      && nextIssue.status === "in_review"
      && nextIssue.assigneeAgentId
      && nextIssue.assigneeAgentId !== input.actor.agentId
    ) {
      const assigneeWakeup = await queueIssueAssignmentWakeup({
        heartbeat,
        issue: nextIssue,
        reason: assigneeChanged ? "issue_assigned" : "issue_status_changed",
        mutation: "update",
        contextSource: assigneeChanged ? "issue.action.enter_review.assignment" : "issue.action.enter_review",
        requestedByActorType: input.actor.actorType,
        requestedByActorId: input.actor.actorId,
      });
      if (assigneeWakeup.status === "warning" && assigneeWakeup.warning) {
        warnings.push(assigneeWakeup.warning);
      }
    }

    const reopenedWorkflowLane =
      Boolean(nextIssue.workflowLaneRole)
      && isTerminalIssueStatus(input.existingIssue.status)
      && !isTerminalIssueStatus(nextIssue.status);
    if (reopenedWorkflowLane) {
      const invalidation = await issueWorkflowsSvc.invalidateWorkflowDescendants({
        issueId: nextIssue.id,
        invalidateSelf: true,
      });
      if (invalidation.invalidatedSelf) {
        nextIssue = {
          ...nextIssue,
          ...invalidation.invalidatedSelf,
        };
      }
      for (const invalidatedIssue of invalidation.invalidatedDescendants) {
        logOpsInfo("workflow.lane.invalidated", {
          companyId: invalidatedIssue.companyId,
          issueId: invalidatedIssue.id,
          rootIssueId: invalidatedIssue.parentId ?? nextIssue.parentId ?? null,
          templateKey: invalidatedIssue.workflowTemplateKey ?? nextIssue.workflowTemplateKey,
          laneRole: invalidatedIssue.workflowLaneRole ?? null,
          sourceLaneRole: nextIssue.workflowLaneRole ?? null,
          reason: "lane_reopened",
          status: invalidatedIssue.status,
        });
        await logActivity(db, {
          companyId: invalidatedIssue.companyId,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: input.actor.agentId,
          runId: input.actor.runId,
          action: "issue.workflow_lane_invalidated",
          entityType: "issue",
          entityId: invalidatedIssue.id,
          details: {
            identifier: invalidatedIssue.identifier,
            parentId: invalidatedIssue.parentId,
            sourceIssueId: nextIssue.id,
            sourceLaneRole: nextIssue.workflowLaneRole ?? null,
            status: invalidatedIssue.status,
            reason: "lane_reopened",
          },
        });
      }
    }

    const becameTerminalForDependents =
      !isTerminalIssueStatus(input.existingIssue.status) && isTerminalIssueStatus(nextIssue.status);
    if (becameTerminalForDependents) {
      const promotedWorkflowDependents = await issueWorkflowsSvc.advanceWorkflowDependents(nextIssue.id);
      const promotedWorkflowDependentIds = new Set(promotedWorkflowDependents.map((dependent) => dependent.id));
      for (const dependent of promotedWorkflowDependents) {
        const blockerIssueIds = getWorkflowDependentBlockerIssueIds(dependent);
        logOpsInfo("workflow.lane.unblocked", {
          companyId: dependent.companyId,
          issueId: dependent.id,
          rootIssueId: dependent.parentId ?? null,
          templateKey: dependent.workflowTemplateKey ?? nextIssue.workflowTemplateKey,
          laneRole: dependent.workflowLaneRole ?? null,
          resolvedBlockerIssueId: nextIssue.id,
          blockerIssueIds,
        });
        await logActivity(db, {
          companyId: dependent.companyId,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: input.actor.agentId,
          runId: input.actor.runId,
          action: "issue.workflow_lane_unblocked",
          entityType: "issue",
          entityId: dependent.id,
          details: {
            identifier: dependent.identifier,
            parentId: dependent.parentId,
            resolvedBlockerIssueId: nextIssue.id,
            blockerIssueIds,
            laneRole: dependent.workflowLaneRole ?? null,
          },
        });
        if (!dependent.assigneeAgentId) continue;
        heartbeat
          .wakeup(dependent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_blockers_resolved",
            payload: {
              issueId: dependent.id,
              resolvedBlockerIssueId: nextIssue.id,
              blockerIssueIds,
            },
            requestedByActorType: input.actor.actorType,
            requestedByActorId: input.actor.actorId,
            contextSnapshot: {
              issueId: dependent.id,
              taskId: dependent.id,
              wakeReason: "issue_blockers_resolved",
              source: "issue.blockers_resolved",
              resolvedBlockerIssueId: nextIssue.id,
              blockerIssueIds,
            },
          })
          .catch((err) =>
            logWakeupFailure(
              err,
              {
                companyId: dependent.companyId,
                issueId: dependent.id,
                agentId: dependent.assigneeAgentId ?? undefined,
                reason: "issue_blockers_resolved",
              },
              "failed to wake workflow dependent after typed issue action",
            ));
      }

      const dependents = await svc.listWakeableBlockedDependents(nextIssue.id);
      for (const dependent of dependents) {
        if (promotedWorkflowDependentIds.has(dependent.id)) continue;
        heartbeat
          .wakeup(dependent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_blockers_resolved",
            payload: {
              issueId: dependent.id,
              resolvedBlockerIssueId: nextIssue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
            requestedByActorType: input.actor.actorType,
            requestedByActorId: input.actor.actorId,
            contextSnapshot: {
              issueId: dependent.id,
              taskId: dependent.id,
              wakeReason: "issue_blockers_resolved",
              source: "issue.blockers_resolved",
              resolvedBlockerIssueId: nextIssue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
          })
          .catch((err) =>
            logWakeupFailure(
              err,
              {
                companyId: nextIssue.companyId,
                issueId: dependent.id,
                agentId: dependent.assigneeAgentId ?? undefined,
                reason: "issue_blockers_resolved",
              },
              "failed to wake blocked dependent after typed issue action",
            ));
      }

      if (nextIssue.parentId) {
        const parent = await svc.getWakeableParentAfterChildCompletion(nextIssue.parentId);
        if (parent?.assigneeAgentId) {
          heartbeat
            .wakeup(parent.assigneeAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "issue_children_completed",
              payload: {
                issueId: parent.id,
                completedChildIssueId: nextIssue.id,
                childIssueIds: parent.childIssueIds,
              },
              requestedByActorType: input.actor.actorType,
              requestedByActorId: input.actor.actorId,
              contextSnapshot: {
                issueId: parent.id,
                taskId: parent.id,
                wakeReason: "issue_children_completed",
                source: "issue.children_completed",
                completedChildIssueId: nextIssue.id,
                childIssueIds: parent.childIssueIds,
              },
            })
            .catch((err) =>
              logWakeupFailure(
                err,
                {
                  companyId: nextIssue.companyId,
                  issueId: parent.id,
                  agentId: parent.assigneeAgentId ?? undefined,
                  reason: "issue_children_completed",
                },
                "failed to wake parent after typed issue completion",
              ));
        }
      }
    }

    if (nextIssue.status === "done" && input.existingIssue.status !== "done") {
      const tc = getTelemetryClient();
      if (tc && input.actor.agentId) {
        const actorAgent = await agentsSvc.getById(input.actor.agentId);
        if (actorAgent) {
          trackAgentTaskCompleted(tc, { agentRole: actorAgent.role });
        }
      }
    }

    const reopenedViaTypedAction =
      isTerminalIssueStatus(input.existingIssue.status) && !isTerminalIssueStatus(nextIssue.status);
    if (
      input.result.comment
      && ["append_note", "reopen_issue", "handoff_issue"].includes(input.action.type)
      && !assigneeChanged
      && nextIssue.assigneeAgentId
      && nextIssue.assigneeAgentId !== input.actor.agentId
      && !isTerminalIssueStatus(nextIssue.status)
    ) {
      await heartbeat.wakeup(nextIssue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: reopenedViaTypedAction ? "issue_reopened_via_comment" : "issue_commented",
        payload: {
          issueId: nextIssue.id,
          commentId: input.result.comment.id,
          mutation: "comment",
          source: "comment",
          ...(reopenedViaTypedAction ? { reopenedFrom: input.existingIssue.status } : {}),
        },
        requestedByActorType: input.actor.actorType,
        requestedByActorId: input.actor.actorId,
        contextSnapshot: {
          issueId: nextIssue.id,
          taskId: nextIssue.id,
          commentId: input.result.comment.id,
          wakeCommentId: input.result.comment.id,
          source: reopenedViaTypedAction ? "issue.action.reopen" : "issue.action.comment",
          wakeReason: reopenedViaTypedAction ? "issue_reopened_via_comment" : "issue_commented",
          ...(reopenedViaTypedAction ? { reopenedFrom: input.existingIssue.status } : {}),
        },
      }).catch((err) =>
        logger.warn({ err, issueId: nextIssue.id }, "failed to wake assignee after typed issue note"));
    }

    if (input.result.comment && input.commentBody) {
      let mentionedIds: string[] = [];
      try {
        mentionedIds = await svc.findMentionedAgents(nextIssue.companyId, input.commentBody);
      } catch (err) {
        logger.warn({ err, issueId: nextIssue.id }, "failed to resolve @-mentions for typed issue action");
      }

      for (const mentionedId of mentionedIds) {
        if (input.actor.actorType === "agent" && input.actor.actorId === mentionedId) continue;
        heartbeat
          .wakeup(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: nextIssue.id, commentId: input.result.comment.id },
            requestedByActorType: input.actor.actorType,
            requestedByActorId: input.actor.actorId,
            contextSnapshot: {
              issueId: nextIssue.id,
              taskId: nextIssue.id,
              commentId: input.result.comment.id,
              wakeCommentId: input.result.comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
            },
          })
          .catch((err) =>
            logWakeupFailure(
              err,
              {
                companyId: nextIssue.companyId,
                issueId: nextIssue.id,
                agentId: mentionedId,
                reason: "issue_comment_mentioned",
              },
              "failed to wake mentioned agent after typed issue action",
            ));
      }
    }

    return {
      ...input.result,
      issue: nextIssue,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async function evaluateWorkflowRootCompletion(issue: PersistedIssue) {
    if (!issue.workflowTemplateKey || issue.workflowLaneRole) return null;
    const decoratedIssue = await issueWorkflowsSvc.decorateIssue(issue);
    const workflowSummary = decoratedIssue.workflowSummary;
    if (!workflowSummary) return null;

    const blockingReasons = [...workflowSummary.blockingReasons];
    for (const lane of workflowSummary.lanes) {
      if (!lane.issueId) {
        blockingReasons.push(`${lane.role.toUpperCase()}: lane issue is missing.`);
        continue;
      }
      if (lane.status !== "done") {
        blockingReasons.push(`${lane.role.toUpperCase()}: lane must be done before the workflow can close.`);
      }
    }

    const uniqueReasons = Array.from(new Set(blockingReasons));
    return {
      canComplete: uniqueReasons.length === 0,
      blockingReasons: uniqueReasons,
      workflowSummary,
    };
  }

  function logWakeupFailure(
    err: unknown,
    context: { companyId?: string; issueId: string; agentId?: string; reason?: string | null },
    message: string,
  ) {
    const errorCode =
      err instanceof HttpError && err.details && typeof err.details === "object"
        ? ((err.details as Record<string, unknown>).code as string | undefined)
          ?? ((err.details as Record<string, unknown>).status as string | undefined)
        : undefined;
    if (isAgentNotInvokableWakeupError(err)) {
      logOpsInfo("heartbeat.wakeup.skipped_not_invokable", {
        companyId: context.companyId,
        issueId: context.issueId,
        agentId: context.agentId,
        reason: context.reason ?? undefined,
        agentStatus: getAgentNotInvokableStatus(err),
      });
      return;
    }
    logOpsWarn("heartbeat.wakeup.failed", {
      companyId: context.companyId,
      issueId: context.issueId,
      agentId: context.agentId,
      reason: context.reason ?? undefined,
      errorCode,
      errorMessage: err instanceof Error ? err.message : message,
    });
  }

  type IssueMutationWakeupWarning = IssueAssignmentWakeupWarning & { reason: string; agentId: string };

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
      });
  }

  function hasQueryableDb(candidate: unknown): candidate is Db {
    return typeof (candidate as { select?: unknown } | null)?.select === "function";
  }

  async function decorateIssueListWithBoardState<TIssue extends { id: string }>(
    companyId: string,
    issueList: TIssue[],
  ) {
    if (issueList.length === 0) return issueList;
    if (!hasQueryableDb(db)) return issueList;
    const boardStateMap = await computeIssueBoardStateMap(
      db,
      companyId,
      issueList.map((issue) => issue.id),
      { includePaths: false },
    ).catch((err) => {
      logger.warn(
        { err, companyId, issueIds: issueList.map((issue) => issue.id) },
        "failed to compute board state for issue list response",
      );
      return null;
    });
    if (!boardStateMap) return issueList;
    return issueList.map((issue) => {
      const computed = boardStateMap.get(issue.id);
      if (!computed) return issue;
      return {
        ...issue,
        boardState: computed.boardState,
        primaryBlocker: computed.primaryBlocker,
      };
    });
  }

  async function decorateIssueDetailWithBoardState<TIssue extends { id: string; companyId: string }>(
    issue: TIssue,
  ) {
    if (!hasQueryableDb(db)) {
      const workflowBoardState = synthesizeWorkflowBoardState(issue as never);
      return workflowBoardState ? { ...issue, boardState: workflowBoardState } : issue;
    }
    const boardStateMap = await computeIssueBoardStateMap(db, issue.companyId, [issue.id], { includePaths: true })
      .catch((err) => {
        logger.warn(
          { err, companyId: issue.companyId, issueId: issue.id },
          "failed to compute board state for issue detail response",
        );
        return null;
      });
    if (!boardStateMap) {
      const workflowBoardState = synthesizeWorkflowBoardState(issue as never);
      return workflowBoardState ? { ...issue, boardState: workflowBoardState } : issue;
    }
    const computed = boardStateMap.get(issue.id);
    const decorated = computed
      ? {
          ...issue,
          ...computed,
        }
      : issue;
    const workflowBoardState = synthesizeWorkflowBoardState(decorated as never);
    return workflowBoardState ? { ...decorated, boardState: workflowBoardState } : decorated;
  }

  function hasCreateRecoveryFields(body: {
    recoveryFromIssueId?: string | null;
    recoveryDisposition?: string | null;
  }) {
    return Boolean(body.recoveryFromIssueId) || Boolean(body.recoveryDisposition);
  }

  function hasRecoveryPatch(body: { recovery?: unknown }) {
    return body.recovery !== undefined;
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

  function respondExecutionBlocked(
    res: Response,
    block: {
      message: string;
      code: string;
      scopeType: string;
      scopeId: string;
    },
  ) {
    res.status(409).json({
      error: block.message,
      message: block.message,
      code: block.code,
      scopeType: block.scopeType,
      scopeId: block.scopeId,
    });
  }

  async function assertAgentExecutionMutationAllowed(
    req: Request,
    res: Response,
    input: {
      companyId: string;
      issueId?: string | null;
      projectId?: string | null;
    },
  ) {
    if (req.actor.type !== "agent") return true;
    if (!req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }

    const block = await executionGate.getExecutionBlock(input.companyId, req.actor.agentId, {
      issueId: input.issueId ?? null,
      projectId: input.projectId ?? null,
    });
    if (!block) return true;

    respondExecutionBlocked(res, block);
    return false;
  }

  async function assertExecutionStartAllowed(
    res: Response,
    input: {
      companyId: string;
      agentId: string;
      issueId?: string | null;
      projectId?: string | null;
    },
  ) {
    const block = await executionGate.getExecutionBlock(input.companyId, input.agentId, {
      issueId: input.issueId ?? null,
      projectId: input.projectId ?? null,
    });
    if (!block) return true;

    respondExecutionBlocked(res, block);
    return false;
  }

  async function resolveAssignmentScopedRunContext(req: Request, companyId: string) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (!runId) return null;
    const run = await heartbeat.getRun(runId);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return null;
    if (!run.contextSnapshot || typeof run.contextSnapshot !== "object") return null;
    const snapshot = run.contextSnapshot as Record<string, unknown>;
    const wakeReason = typeof snapshot.wakeReason === "string" ? snapshot.wakeReason : null;
    const issueId = typeof snapshot.issueId === "string" ? snapshot.issueId : null;
    if (wakeReason !== "issue_assigned" || !issueId) return null;
    return { runId, issueId };
  }

  async function resolveInheritedCreateProjectId(
    req: Request,
    companyId: string,
    explicitProjectId: string | null | undefined,
  ) {
    if (explicitProjectId) return explicitProjectId;
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (!runId || !req.actor.agentId) return null;

    const run = await heartbeat.getRun(runId);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) {
      return null;
    }
    if (!run.contextSnapshot || typeof run.contextSnapshot !== "object") {
      return null;
    }

    const snapshot = run.contextSnapshot as Record<string, unknown>;
    const issueId = typeof snapshot.issueId === "string" ? snapshot.issueId : null;
    if (issueId) {
      const sourceIssue = await svc.getById(issueId);
      if (sourceIssue && sourceIssue.companyId === companyId && sourceIssue.projectId) {
        return sourceIssue.projectId;
      }
    }

    const snapshotProjectId = typeof snapshot.projectId === "string" ? snapshot.projectId.trim() : "";
    return snapshotProjectId.length > 0 ? snapshotProjectId : null;
  }

  async function resolveRootIssueWorkflowTemplateKeyForCreate(input: {
    companyId: string;
    projectId: string | null;
    parentId: string | null | undefined;
    explicitWorkflowTemplateKey: IssueWorkflowTemplateKey | null | undefined;
  }) {
    if (input.parentId) return null;
    if (input.explicitWorkflowTemplateKey) {
      return input.explicitWorkflowTemplateKey;
    }

    const [company, project] = await Promise.all([
      companiesSvc.getById(input.companyId),
      input.projectId ? projectsSvc.getById(input.projectId) : Promise.resolve(null),
    ]);

    const projectDeliveryMode =
      project && project.companyId === input.companyId
        ? project.defaultRootIssueDeliveryMode ?? "inherit"
        : "inherit";

    if (projectDeliveryMode !== "inherit") {
      return projectDeliveryMode === "engineering" ? "engineering_delivery_v1" : null;
    }

    if (!company) return null;

    const companyDeliveryMode = company.defaultRootIssueDeliveryMode ?? "engineering";
    const effectiveDeliveryMode = companyDeliveryMode;

    return effectiveDeliveryMode === "engineering" ? "engineering_delivery_v1" : null;
  }

  function queryHasNonEmptyValue(value: unknown) {
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.some((entry) => typeof entry === "string" && entry.trim().length > 0);
    return false;
  }

  function hasAssignmentContextualIssueListFilter(req: Request) {
    return [
      req.query.projectId,
      req.query.executionWorkspaceId,
      req.query.parentId,
      req.query.labelId,
      req.query.originKind,
      req.query.originId,
      req.query.participantAgentId,
      req.query.assigneeUserId,
      req.query.touchedByUserId,
      req.query.inboxArchivedByUserId,
      req.query.unreadForUserId,
    ].some(queryHasNonEmptyValue);
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
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      const issue = await svc.getByIdentifier(rawId);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
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
    const assignmentScopedRun = await resolveAssignmentScopedRunContext(req, companyId);
    if (assignmentScopedRun && !hasAssignmentContextualIssueListFilter(req)) {
      res.status(409).json({
        error: "assignment mode forbids discovery queries; fetch /issues/:id directly",
        code: "assignment_mode_forbids_discovery",
        issueId: assignmentScopedRun.issueId,
      });
      return;
    }
    const includeClosed = parseBooleanQuery(req.query.includeClosed);
    const includeRelations = parseBooleanQuery(req.query.includeRelations);
    const excludeRecoverySourcesWithOpenSuccessors = parseBooleanQuery(
      req.query.excludeRecoverySourcesWithOpenSuccessors,
    );
    const assigneeAgentId = parseOptionalQueryString(req.query.assigneeAgentId);
    const participantAgentId = parseOptionalQueryString(req.query.participantAgentId);
    const projectId = parseOptionalQueryString(req.query.projectId);
    const executionWorkspaceId = parseOptionalQueryString(req.query.executionWorkspaceId);
    const parentId = parseOptionalQueryString(req.query.parentId);
    const ids = parseOptionalQueryString(req.query.ids)
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const labelId = parseOptionalQueryString(req.query.labelId);
    const originKind = parseOptionalQueryString(req.query.originKind);
    const originId = parseOptionalQueryString(req.query.originId);
    const sortRaw = parseOptionalQueryString(req.query.sort);
    const sort = sortRaw && ISSUE_LIST_SORTS.includes(sortRaw as IssueListSort)
      ? sortRaw as IssueListSort
      : undefined;
    const includeReviewSignals = parseBooleanQuery(req.query.includeReviewSignals);
    const assigneeUserFilterRaw = parseOptionalQueryString(req.query.assigneeUserId);
    const touchedByUserFilterRaw = parseOptionalQueryString(req.query.touchedByUserId);
    const inboxArchivedByUserFilterRaw = parseOptionalQueryString(req.query.inboxArchivedByUserId);
    const unreadForUserFilterRaw = parseOptionalQueryString(req.query.unreadForUserId);
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
    const rawLimit = req.query.limit as string | undefined;
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : null;
    const limit = parsedLimit ?? undefined;

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
    if (rawLimit !== undefined && (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      res.status(400).json({ error: "limit must be a positive integer" });
      return;
    }
    if (sortRaw && !sort) {
      res.status(400).json({ error: `sort must be one of: ${ISSUE_LIST_SORTS.join(", ")}` });
      return;
    }

    const result = await svc.list(companyId, {
      status: req.query.status as string | undefined,
      ids,
      sort,
      includeClosed,
      includeRelations,
      excludeRecoverySourcesWithOpenSuccessors,
      assigneeAgentId,
      participantAgentId,
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId,
      executionWorkspaceId,
      parentId,
      labelId,
      originKind,
      originId,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      q: req.query.q as string | undefined,
      limit,
    });
    if (!includeReviewSignals) {
      res.json(await decorateIssueListWithBoardState(companyId, result));
      return;
    }
    const withQaGate = await Promise.all(
      result.map(async (issue) => {
        const qaGate =
          issue.status === "in_review" || issue.status === "done"
            ? await computeIssueQaGateSafe(issue, { commentLimit: 120 })
            : null;
        return {
          ...issue,
          qaGate,
          mergeStatus:
            issue.status === "in_review" || issue.status === "done"
              ? await computeIssueMergeStatusSafe(issue, { qaGate })
              : null,
        };
      }),
    );
    res.json(await decorateIssueListWithBoardState(companyId, withQaGate));
  });

  router.post(
    "/companies/:companyId/issues/archive-closed",
    validate(archiveClosedIssuesRouteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board") {
        throw forbidden("Only board actors can archive closed issues");
      }
      const olderThanDays = req.body.olderThanDays as number | undefined;
      const result = await svc.archiveClosed(companyId, { olderThanDays });
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.closed_archived_bulk",
        entityType: "company",
        entityId: companyId,
        details: {
          archivedCount: result.archivedCount,
          olderThanDays: result.olderThanDays,
          archivedAt: result.archivedAt.toISOString(),
          cutoff: result.cutoff.toISOString(),
          issueIds: result.issueIds,
        },
      });
      res.json(result);
    },
  );

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
    const [{ project, goal }, ancestors, mentionedProjectIds, documentPayload, relations] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id),
      documentsSvc.getIssueDocumentPayload(issue),
      svc.getRelationSummaries(issue.id),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    const qaGate = await computeIssueQaGateSafe(issue);
    const mergeStatus = await computeIssueMergeStatusSafe(issue, {
      qaGate,
      executionWorkspace: currentExecutionWorkspace,
    });
    const workflowDecorated = await issueWorkflowsSvc.decorateIssue({
      ...issue,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      blockedBy: relations.blockedBy,
      blocks: relations.blocks,
      recoverySource: relations.recoverySource,
      recoverySuccessor: relations.recoverySuccessor,
      ...documentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace,
      workProducts,
      qaGate,
      mergeStatus,
    });
    res.json(await decorateIssueDetailWithBoardState(workflowDecorated));
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

    const [{ project, goal }, ancestors, commentCursor, wakeComment, relations, attachments] =
      await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.getCommentCursor(issue.id),
      wakeCommentId ? svc.getComment(wakeCommentId) : null,
      svc.getRelationSummaries(issue.id),
      svc.listAttachments(issue.id),
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
        blockedBy: relations.blockedBy,
        blocks: relations.blocks,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
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
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.originalFilename,
        contentType: a.contentType,
        byteSize: a.byteSize,
        contentPath: withContentPath(a).contentPath,
        createdAt: a.createdAt,
      })),
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
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId: issue.companyId,
      issueId: issue.id,
      projectId: issue.projectId,
    }))) return;
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

  router.get("/issues/:id/file-preview", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const requestedPath = parseOptionalQueryString(req.query.path);
    if (!requestedPath) {
      res.status(400).json({ error: "Missing path query value" });
      return;
    }

    const { preview } = await readIssueFilePreview(issue.id, issue.companyId, requestedPath);
    res.json(preview);
  });

  router.get("/issues/:id/file-preview/content", async (req, res, next) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const requestedPath = parseOptionalQueryString(req.query.path);
    if (!requestedPath) {
      res.status(400).json({ error: "Missing path query value" });
      return;
    }

    const { preview, absolutePath } = await readIssueFilePreview(issue.id, issue.companyId, requestedPath);
    if (!preview.exists || !absolutePath) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    if (preview.kind !== "image") {
      res.status(422).json({ error: "File preview content is only available for image files" });
      return;
    }

    try {
      const raw = await fs.readFile(absolutePath);
      res.setHeader("Content-Type", preview.contentType ?? "application/octet-stream");
      res.setHeader("Content-Length", String(raw.byteLength));
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${path.basename(preview.path).replaceAll("\"", "")}"`,
      );
      if (preview.contentType === SVG_CONTENT_TYPE) {
        res.setHeader(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        );
      }
      res.end(raw);
    } catch (err) {
      next(err);
    }
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
      if (!(await assertAgentExecutionMutationAllowed(req, res, {
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
      }))) return;

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
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId: issue.companyId,
      issueId: issue.id,
      projectId: req.body.projectId ?? issue.projectId ?? null,
    }))) return;
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
    const workProductIssue = existing.issueId ? await svc.getById(existing.issueId) : null;
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId: existing.companyId,
      issueId: existing.issueId ?? null,
      projectId: existing.projectId ?? workProductIssue?.projectId ?? null,
    }))) return;
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
    const workProductIssue = existing.issueId ? await svc.getById(existing.issueId) : null;
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId: existing.companyId,
      issueId: existing.issueId ?? null,
      projectId: existing.projectId ?? workProductIssue?.projectId ?? null,
    }))) return;
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
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId: issue.companyId,
      issueId: issue.id,
      projectId: issue.projectId,
    }))) return;
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

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
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId: issue.companyId,
      issueId: issue.id,
      projectId: issue.projectId,
    }))) return;
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

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
    const resolvedProjectId = await resolveInheritedCreateProjectId(req, companyId, req.body.projectId ?? null);
    const workflowTemplateKey = await resolveRootIssueWorkflowTemplateKeyForCreate({
      companyId,
      projectId: resolvedProjectId,
      parentId: req.body.parentId ?? null,
      explicitWorkflowTemplateKey: req.body.workflowTemplateKey ?? null,
    });
    if (hasCreateRecoveryFields(req.body) && req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can create recovery continuation issues" });
      return;
    }
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId,
      projectId: resolvedProjectId,
    }))) return;
    if (
      req.actor.type !== "board"
      && (req.body.recoveryFromIssueId != null || req.body.recoveryDisposition != null)
    ) {
      throw forbidden("Only board users can create or apply recovery successor issues");
    }
    if (req.body.workflowTemplateKey && req.body.parentId) {
      res.status(422).json({ error: "Workflow templates can only be applied to root issues" });
      return;
    }
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, companyId);
    }

    const actor = getActorInfo(req);
    const { workflowTemplateKey: _workflowTemplateKey, ...createBody } = req.body;
    const createIssueInput = {
      ...createBody,
      projectId: resolvedProjectId,
      executionPolicy: normalizeIssueExecutionPolicy(createBody.executionPolicy),
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    };

    let issue;
    let workflowCreatedChildren: Array<{ id: string; assigneeAgentId: string | null; status: string }> = [];
    if (workflowTemplateKey) {
      const created = await runIssueMutationTransaction(async (tx) => {
        const createdIssue = await svc.create(companyId, createIssueInput, tx);

        const applied = await applyWorkflowTemplateAndWakeChildren({
          companyId,
          templateKey: workflowTemplateKey,
          parentIssue: createdIssue,
          actor,
          dbOrTx: tx,
          queueWakeups: false,
        });

        await logActivity(tx, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.created",
          entityType: "issue",
          entityId: createdIssue.id,
          details: {
            title: createdIssue.title,
            identifier: createdIssue.identifier,
            workflowTemplateKey,
            ...(Array.isArray(req.body.blockedByIssueIds) ? { blockedByIssueIds: req.body.blockedByIssueIds } : {}),
            ...(req.body.recoveryFromIssueId ? { recoveryFromIssueId: req.body.recoveryFromIssueId } : {}),
            ...(req.body.recoveryDisposition ? { recoveryDisposition: req.body.recoveryDisposition } : {}),
          },
        });

        return {
          issue: createdIssue,
          createdChildren: applied.createdChildren.map((child) => ({
            id: child.id,
            assigneeAgentId: child.assigneeAgentId ?? null,
            status: child.status,
          })),
        };
      });
      issue = created.issue;
      workflowCreatedChildren = created.createdChildren;
      await queueWorkflowTemplateChildWakeups({
        createdChildren: workflowCreatedChildren,
        actor,
      });
    } else {
      issue = await svc.create(companyId, createIssueInput);

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.created",
        entityType: "issue",
        entityId: issue.id,
        details: {
          title: issue.title,
          identifier: issue.identifier,
          ...(Array.isArray(req.body.blockedByIssueIds) ? { blockedByIssueIds: req.body.blockedByIssueIds } : {}),
          ...(req.body.recoveryFromIssueId ? { recoveryFromIssueId: req.body.recoveryFromIssueId } : {}),
          ...(req.body.recoveryDisposition ? { recoveryDisposition: req.body.recoveryDisposition } : {}),
        },
      });
    }

    const assigneeWakeup = await queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });
    const warning = assigneeWakeup.status === "warning" && assigneeWakeup.warning ? assigneeWakeup.warning : null;

    const decoratedIssue = workflowTemplateKey
      ? await svc.getById(issue.id).then(async (refreshed) => (refreshed ? issueWorkflowsSvc.decorateIssue(refreshed) : issue))
      : issue;
    const issuePayload = await decorateIssueDetailWithBoardState(decoratedIssue);
    res.status(201).json({
      ...issuePayload,
      ...(warning ? { warnings: [warning] } : {}),
    });
  });

  router.post("/issues/:id/apply-workflow-template", validate(applyIssueWorkflowTemplateSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId: existing.companyId,
      issueId: existing.id,
      projectId: existing.projectId,
    }))) return;
    const actor = getActorInfo(req);
    await applyWorkflowTemplateAndWakeChildren({
      companyId: existing.companyId,
      templateKey: req.body.workflowTemplateKey,
      parentIssue: existing,
      actor,
    });
    const refreshed = await svc.getById(existing.id);
    const decorated = refreshed ? await issueWorkflowsSvc.decorateIssue(refreshed) : existing;
    res.json(await decorateIssueDetailWithBoardState(decorated));
  });

  router.post("/issues/:id/actions", validate(issueActionSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId: issue.companyId,
      issueId: issue.id,
      projectId: issue.projectId,
    }))) return;
    if (!(await assertAgentRunCheckoutOwnership(req, res, issue))) return;
    if (req.body.type === "handoff_issue") {
      const nextAssigneeAgentId =
        req.body.payload.assigneeAgentId === undefined ? issue.assigneeAgentId : req.body.payload.assigneeAgentId;
      const nextAssigneeUserId =
        req.body.payload.assigneeUserId === undefined ? issue.assigneeUserId : req.body.payload.assigneeUserId;
      const assigneeWillChange =
        nextAssigneeAgentId !== issue.assigneeAgentId || nextAssigneeUserId !== issue.assigneeUserId;
      const isAgentReturningIssueToCreator =
        req.actor.type === "agent"
        && !!req.actor.agentId
        && issue.assigneeAgentId === req.actor.agentId
        && nextAssigneeAgentId === null
        && typeof nextAssigneeUserId === "string"
        && !!issue.createdByUserId
        && nextAssigneeUserId === issue.createdByUserId;
      if (assigneeWillChange && !isAgentReturningIssueToCreator) {
        await assertCanAssignTasks(req, issue.companyId);
      }
    }
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    const allowsClosedWorkspaceReopenAction =
      req.body.type === "reopen_issue"
      || (req.body.type === "handoff_issue" && req.body.payload.reopen === true);
    if (closedExecutionWorkspace && !allowsClosedWorkspaceReopenAction) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const actor = getActorInfo(req);
    if (!issueActions) {
      throw new Error("Issue action service is not configured");
    }

    try {
      const result = await issueActions.execute({
        issue,
        actor,
        action: req.body,
      });
      const finalizedResult = await applyIssueActionFollowUps({
        existingIssue: issue,
        action: req.body,
        result,
        commentBody: "payload" in req.body && req.body.payload && typeof req.body.payload === "object"
          && "body" in req.body.payload && typeof req.body.payload.body === "string"
          ? req.body.payload.body
          : null,
        actor,
      });
      res.json(finalizedResult);
    } catch (err) {
      if (maybeRespondIssueAction422(res, err)) return;
      throw err;
    }
  });

  router.patch("/issues/:id", validate(updateIssueRouteSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (hasRecoveryPatch(req.body) && req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can manage issue recovery transitions" });
      return;
    }
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId: existing.companyId,
      issueId: existing.id,
      projectId: existing.projectId,
    }))) return;
    if (req.actor.type !== "board" && req.body.recovery !== undefined) {
      throw forbidden("Only board users can create or apply recovery successor issues");
    }
    const {
      comment: commentBody,
      reopen: reopenRequested,
      interrupt: interruptRequested,
      forceDone: forceDoneRaw,
      overrideReason: overrideReasonRaw,
      hiddenAt: hiddenAtRaw,
      ...updateFields
    } = req.body;
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;

    const actor = getActorInfo(req);
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
    const isClosed = existing.status === "done" || existing.status === "cancelled";
    const existingRelations =
      Array.isArray(req.body.blockedByIssueIds)
        ? await svc.getRelationSummaries(existing.id)
        : null;
    const forceDoneRequested = forceDoneRaw === true;
    const overrideReason = typeof overrideReasonRaw === "string" ? overrideReasonRaw.trim() : "";
    let interruptedRunId: string | null = null;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(existing);
    const isAgentWorkUpdate = req.actor.type === "agent" && Object.keys(updateFields).length > 0;
    const legacyWorkflowPatchRejection = issueActions
      ? detectLegacyWorkflowControlFromIssuePatch({
        issue: existing,
        reopenRequested,
        forceDoneRequested,
        updateFields,
      })
      : null;

    if (legacyWorkflowPatchRejection) {
      respondLegacyWorkflowWriteRejected(res, {
        issue: existing,
        actor,
        route: "patch",
        rejection: legacyWorkflowPatchRejection,
      });
      return;
    }

    if (assigneeWillChange) {
      if (!isAgentReturningIssueToCreator) {
        await assertCanAssignTasks(req, existing.companyId);
      }
    }

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
    if (forceDoneRequested) {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can override QA gate shipping" });
        return;
      }
      if (!overrideReason) {
        res.status(400).json({ error: "overrideReason is required when forceDone=true" });
        return;
      }
      if (reopenRequested) {
        res.status(400).json({ error: "reopen cannot be combined with forceDone" });
        return;
      }
      if (typeof updateFields.status === "string" && updateFields.status !== "done") {
        res.status(400).json({ error: "forceDone only supports status=done transitions" });
        return;
      }
      updateFields.status = "done";
    }
    if (commentBody && reopenRequested === true && isClosed && updateFields.status === undefined) {
      updateFields.status = "todo";
    }
    const reopensClosedIssueViaStatus =
      typeof updateFields.status === "string" && !["done", "cancelled"].includes(updateFields.status);
    if (
      commentBody &&
      isClosed &&
      req.actor.type === "agent" &&
      reopenRequested !== true &&
      !reopensClosedIssueViaStatus
    ) {
      res.status(409).json({ error: "Issue is closed. Reopen it before posting agent updates." });
      return;
    }
    if (req.body.executionPolicy !== undefined) {
      updateFields.executionPolicy = normalizeIssueExecutionPolicy(req.body.executionPolicy);
    }

    const requestedStatusBeforeExecutionTransition =
      typeof updateFields.status === "string" ? updateFields.status : existing.status;
    let effectiveExecutionPolicy =
      updateFields.executionPolicy !== undefined
        ? (updateFields.executionPolicy as NonNullable<typeof updateFields.executionPolicy> | null)
        : normalizeIssueExecutionPolicy(existing.executionPolicy ?? null);
    if (
      requestedStatusBeforeExecutionTransition === "in_review"
      && existing.status !== "in_review"
      && effectiveExecutionPolicy == null
      && !existing.workflowTemplateKey
      && !existing.workflowLaneRole
    ) {
      const hasExplicitAssigneeAgentPatch = req.body.assigneeAgentId !== undefined;
      const hasExplicitAssigneeUserPatch = req.body.assigneeUserId !== undefined;
      const requestedAssigneeAgentId =
        hasExplicitAssigneeAgentPatch ? (req.body.assigneeAgentId as string | null) : existing.assigneeAgentId;
      const requestedAssigneeUserId =
        hasExplicitAssigneeUserPatch ? (req.body.assigneeUserId as string | null) : existing.assigneeUserId;
      const requestedAssigneeRole =
        requestedAssigneeAgentId ? await getAgentRole(requestedAssigneeAgentId, existing.companyId) : null;
      const prospectiveRole =
        requestedAssigneeAgentId
          ? requestedAssigneeRole
          : requestedAssigneeUserId
            ? "user"
            : existing.assigneeAgentId
              ? await getAgentRole(existing.assigneeAgentId, existing.companyId)
              : existing.assigneeUserId
                ? "user"
                : null;

      const issueText = buildIssueRoutingText({
        identifier: existing.identifier ?? null,
        title: existing.title ?? "",
        description: existing.description ?? null,
      });
      if (isDeliveryScopedIssue({ workIntent: existing.workIntent, assigneeRole: prospectiveRole, issueText })) {
        if (
          (hasExplicitAssigneeUserPatch && requestedAssigneeUserId)
          || (hasExplicitAssigneeAgentPatch && requestedAssigneeAgentId && requestedAssigneeRole !== "qa")
        ) {
          respondIssueUpdate422(res, "qa_gate_requires_qa_assignee");
          return;
        }

        const existingQaAssigneeId =
          existing.assigneeAgentId && await getAgentRole(existing.assigneeAgentId, existing.companyId) === "qa"
            ? existing.assigneeAgentId
            : null;
        const qaReviewPlan = await buildDeliveryQaReviewPlan({
          companyId: existing.companyId,
          stickyReviewerAgentId: existing.qaReviewerAgentId ?? requestedAssigneeAgentId ?? existingQaAssigneeId,
        });
        if (!qaReviewPlan.executionPolicy || !qaReviewPlan.selectedReviewer) {
          respondIssueUpdate422(res, "qa_gate_no_eligible_qa_agent");
          return;
        }
        effectiveExecutionPolicy = qaReviewPlan.executionPolicy;
        updateFields.executionPolicy = effectiveExecutionPolicy;
      }
    }
    const closesWithoutExecutionPolicy =
      existing.status !== "done"
      && requestedStatusBeforeExecutionTransition === "done"
      && effectiveExecutionPolicy == null
      && !existing.workflowTemplateKey
      && !existing.workflowLaneRole;
    if (closesWithoutExecutionPolicy && !forceDoneRequested) {
      const activeQaReviewerAgentId = getCurrentParticipantAgentId(existing.executionState);
      if (
        activeQaReviewerAgentId
        && (
          existing.assigneeUserId
          || existing.assigneeAgentId !== activeQaReviewerAgentId
        )
      ) {
        respondIssueUpdate422(res, "qa_gate_requires_qa_assignee");
        return;
      }
      const existingQaGate = await computeIssueQaGate(existing, { commentLimit: MAX_ISSUE_COMMENT_LIMIT });
      const gateFailure = existingQaGate.isDeliveryScoped
        ? (existingQaGate.missingRequirements[0] ?? null)
        : null;
      if (gateFailure) {
        respondIssueUpdate422(res, gateFailure);
        return;
      }
    }

    const transition = applyIssueExecutionPolicyTransition({
      issue: existing,
      policy: effectiveExecutionPolicy,
      requestedStatus: typeof updateFields.status === "string" ? updateFields.status : undefined,
      requestedAssigneePatch: {
        assigneeAgentId:
          req.body.assigneeAgentId === undefined ? undefined : (req.body.assigneeAgentId as string | null),
        assigneeUserId:
          req.body.assigneeUserId === undefined ? undefined : (req.body.assigneeUserId as string | null),
      },
      actor: {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
      commentBody,
    });
    const decisionId = transition.decision ? randomUUID() : null;
    if (decisionId) {
      const nextExecutionState = transition.patch.executionState;
      if (!nextExecutionState || typeof nextExecutionState !== "object") {
        throw new Error("Execution policy decision patch is missing executionState");
      }
      transition.patch.executionState = {
        ...nextExecutionState,
        lastDecisionId: decisionId,
      };
    }
    Object.assign(updateFields, transition.patch);
    if (transition.decision) {
      updateFields.qaReviewerAgentId =
        existing.qaReviewerAgentId
        ?? getCurrentParticipantAgentId(existing.executionState)
        ?? null;
    }
    if (forceDoneRequested) {
      updateFields.status = "done";
    }

    let qaAutoRouting: { agentId: string; agentName: string | null; alreadyAssigned?: boolean } | null = null;
    const requestedNextStatus =
      typeof updateFields.status === "string" ? updateFields.status : existing.status;
    if (requestedNextStatus === "in_review" && existing.status !== "in_review") {
      const requestedAssigneeAgentId =
        updateFields.assigneeAgentId !== undefined
          ? (updateFields.assigneeAgentId as string | null)
          : existing.assigneeAgentId;
      const requestedAssigneeUserId =
        updateFields.assigneeUserId !== undefined
          ? (updateFields.assigneeUserId as string | null)
          : existing.assigneeUserId;
      const prospectiveRole = requestedAssigneeAgentId
        ? await getAgentRole(requestedAssigneeAgentId, existing.companyId)
        : requestedAssigneeUserId
          ? "user"
          : existing.assigneeAgentId
            ? await getAgentRole(existing.assigneeAgentId, existing.companyId)
          : existing.assigneeUserId
              ? "user"
              : null;
      const issueText = buildIssueRoutingText({
        identifier: existing.identifier ?? null,
        title: existing.title ?? "",
        description: existing.description ?? null,
      });
      if (isDeliveryScopedIssue({ workIntent: existing.workIntent, assigneeRole: prospectiveRole, issueText })) {
        if (requestedAssigneeUserId || !requestedAssigneeAgentId) {
          respondIssueUpdate422(res, "qa_gate_requires_qa_assignee");
          return;
        }
        const assigneeRole = await getAgentRole(requestedAssigneeAgentId, existing.companyId);
        if (assigneeRole !== "qa") {
          respondIssueUpdate422(res, "qa_gate_requires_qa_assignee");
          return;
        }
        qaAutoRouting = {
          agentId: requestedAssigneeAgentId,
          agentName: await getAgentName(requestedAssigneeAgentId, existing.companyId),
          alreadyAssigned: requestedAssigneeAgentId === existing.assigneeAgentId,
        };
        updateFields.qaReviewerAgentId = requestedAssigneeAgentId;
      }
    }
    const isDoneTransition = existing.status !== "done" && requestedNextStatus === "done";
    let qaGateSnapshot = null as Awaited<ReturnType<typeof computeIssueQaGate>> | null;
    if (isDoneTransition) {
      if (existing.workflowTemplateKey && !existing.workflowLaneRole && !forceDoneRequested) {
        const workflowRootGate = await evaluateWorkflowRootCompletion(existing);
        if (workflowRootGate && !workflowRootGate.canComplete) {
          logOpsInfo("workflow.root.close_blocked", {
            companyId: existing.companyId,
            issueId: existing.id,
            rootIssueId: existing.id,
            templateKey: existing.workflowTemplateKey,
            blockingReasons: workflowRootGate.blockingReasons,
            activeRoles: workflowRootGate.workflowSummary?.activeRoles ?? [],
          });
          res.status(422).json({
            error: workflowRootGate.blockingReasons[0] ?? "Workflow root cannot be closed while specialist lanes remain incomplete",
            blockingReasons: workflowRootGate.blockingReasons,
          });
          return;
        }
      }
      if (existing.workflowLaneRole && (existing.workflowRequiredArtifacts?.length ?? 0) > 0 && !forceDoneRequested) {
        const workflowGate = await issueWorkflowsSvc.evaluateLaneCompletion(existing);
        if (!workflowGate.canComplete) {
          logOpsInfo("workflow.lane.close_blocked", {
            companyId: existing.companyId,
            issueId: existing.id,
            rootIssueId: existing.parentId ?? existing.id,
            templateKey: existing.workflowTemplateKey,
            laneRole: existing.workflowLaneRole,
            blockingReasons: workflowGate.blockingReasons,
          });
          res.status(422).json({
            error: workflowGate.blockingReasons[0] ?? "Workflow requirements are not satisfied",
            blockingReasons: workflowGate.blockingReasons,
          });
          return;
        }
      }
      const usesWorkflowCompletionRules = Boolean(existing.workflowTemplateKey || existing.workflowLaneRole);
      if (!usesWorkflowCompletionRules) {
        qaGateSnapshot = await computeIssueQaGate(existing, { commentLimit: MAX_ISSUE_COMMENT_LIMIT });
        if (qaGateSnapshot.isDeliveryScoped && !forceDoneRequested) {
          const gateFailure = qaGateSnapshot.missingRequirements[0] ?? null;
          if (gateFailure) {
            respondIssueUpdate422(res, gateFailure);
            return;
          }
        }
      }
    }

    let issue;
    try {
      if (transition.decision && decisionId) {
        const decision = transition.decision;
        issue = await db.transaction(async (tx) => {
          const updated = await svc.update(
            id,
            {
              ...updateFields,
              actorAgentId: actor.agentId ?? null,
              actorUserId: actor.actorType === "user" ? actor.actorId : null,
              completionGuardrailsSatisfied: isDoneTransition ? true : undefined,
            },
            tx,
          );
          if (!updated) return null;

          await tx.insert(issueExecutionDecisions).values({
            id: decisionId,
            companyId: updated.companyId,
            issueId: updated.id,
            stageId: decision.stageId,
            stageType: decision.stageType,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
            outcome: decision.outcome,
            body: decision.body,
            createdByRunId: actor.runId ?? null,
          });

          return updated;
        });
      } else {
        issue = await svc.update(id, {
          ...updateFields,
          actorAgentId: actor.agentId ?? null,
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
          completionGuardrailsSatisfied: isDoneTransition ? true : undefined,
        });
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        const reasonCode =
          err.details &&
          typeof err.details === "object" &&
          typeof (err.details as Record<string, unknown>).reasonCode === "string"
            ? ((err.details as Record<string, unknown>).reasonCode as string)
            : null;
        if (reasonCode === "invalid_status_transition") {
          respondIssueUpdate422(res, "invalid_status_transition");
          return;
        }
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
    let issueResponse: typeof issue & { blockedBy?: unknown; blocks?: unknown } = issue;
    if (issue && Array.isArray(req.body.blockedByIssueIds)) {
      const updatedRelations = await svc.getRelationSummaries(issue.id);
      issueResponse = {
        ...issue,
        blockedBy: updatedRelations.blockedBy,
        blocks: updatedRelations.blocks,
      };
    }
    await routinesSvc.syncRunStatusForIssue(issue.id);

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue activity"));
    }

    // Build activity details from the persisted issue delta so implicit service
    // normalization, like blocked -> todo, is visible in the timeline.
    const { previous, next } = buildIssueActivityFieldDelta(
      existing as Record<string, unknown>,
      issue as Record<string, unknown>,
    );
    if (Array.isArray(req.body.blockedByIssueIds)) {
      const beforeBlockedByIds = existingRelations?.blockedBy.map((relation) => relation.id) ?? [];
      const afterBlockedByIds = issueResponse.blockedBy && Array.isArray(issueResponse.blockedBy)
        ? (issueResponse.blockedBy as Array<{ id: string }>).map((relation) => relation.id)
        : [];
      if (!sameActivityValue([...beforeBlockedByIds].sort(), [...afterBlockedByIds].sort())) {
        previous.blockedByIssueIds = beforeBlockedByIds;
        next.blockedByIssueIds = afterBlockedByIds;
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
    if (hasFieldChanges) {
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
          ...next,
          identifier: issue.identifier,
          parentId: issue.parentId,
          ...(commentBody ? { source: "comment" } : {}),
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          _previous: previous,
        },
      });
    }

    if (forceDoneRequested && existing.status !== "done" && issue.status === "done") {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.qa_gate_overridden",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          overrideReason,
          previousStatus: existing.status,
          appliedStatus: issue.status,
          isDeliveryScoped: qaGateSnapshot?.isDeliveryScoped ?? true,
          missingRequirements: qaGateSnapshot?.missingRequirements ?? [],
        },
      });
    }

    if (Array.isArray(req.body.blockedByIssueIds)) {
      const previousBlockedByIds = new Set((existingRelations?.blockedBy ?? []).map((relation) => relation.id));
      const nextBlockedByIds = new Set(req.body.blockedByIssueIds as string[]);
      const addedBlockedByIssueIds = [...nextBlockedByIds].filter((candidate) => !previousBlockedByIds.has(candidate));
      const removedBlockedByIssueIds = [...previousBlockedByIds].filter((candidate) => !nextBlockedByIds.has(candidate));
      if (addedBlockedByIssueIds.length > 0 || removedBlockedByIssueIds.length > 0) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.blockers_updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            blockedByIssueIds: req.body.blockedByIssueIds,
            addedBlockedByIssueIds,
            removedBlockedByIssueIds,
          },
        });
      }
    }

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
      const normalizedCommentBody = await maybeNormalizeRecoverySourceComment({
        issue: {
          ...(existing as Record<string, unknown>),
          ...(issue as Record<string, unknown>),
          recoverySuccessor:
            (issue as { recoverySuccessor?: unknown }).recoverySuccessor
            ?? (existing as { recoverySuccessor?: unknown }).recoverySuccessor
            ?? null,
        } as Parameters<typeof maybeNormalizeRecoverySourceComment>[0]["issue"],
        body: commentBody,
        actor: {
          actorType: actor.actorType,
          agentId: actor.agentId ?? null,
          runId: actor.runId,
        },
      });
      comment = await svc.addComment(id, normalizedCommentBody, {
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
          parentId: issue.parentId,
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          ...(hasFieldChanges ? { updated: true } : {}),
        },
      });

    }
    if (qaAutoRouting) {
      await svc.addComment(
        issue.id,
        buildQaRoutingComment(
          qaAutoRouting.agentId,
          qaAutoRouting.agentName,
          { alreadyAssigned: qaAutoRouting.alreadyAssigned === true },
        ),
        {},
      );
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "qa-routing",
        action: "issue.qa_routed",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          qaAgentId: qaAutoRouting.agentId,
          qaAgentName: qaAutoRouting.agentName,
          alreadyAssigned: qaAutoRouting.alreadyAssigned === true,
        },
      });
    }

    const reopenedWorkflowLane =
      Boolean(issue.workflowLaneRole)
      && ["done", "cancelled"].includes(existing.status)
      && !["done", "cancelled"].includes(issue.status);
    if (reopenedWorkflowLane) {
      const invalidation = await issueWorkflowsSvc.invalidateWorkflowDescendants({
        issueId: issue.id,
        invalidateSelf: true,
      });
      if (invalidation.invalidatedSelf) {
        issue = {
          ...issue,
          ...invalidation.invalidatedSelf,
        };
        issueResponse = {
          ...issueResponse,
          ...invalidation.invalidatedSelf,
        };
      }
      for (const invalidatedIssue of invalidation.invalidatedDescendants) {
        logOpsInfo("workflow.lane.invalidated", {
          companyId: invalidatedIssue.companyId,
          issueId: invalidatedIssue.id,
          rootIssueId: invalidatedIssue.parentId ?? issue.parentId ?? null,
          templateKey: invalidatedIssue.workflowTemplateKey ?? issue.workflowTemplateKey,
          laneRole: invalidatedIssue.workflowLaneRole ?? null,
          sourceLaneRole: issue.workflowLaneRole ?? null,
          reason: "lane_reopened",
          status: invalidatedIssue.status,
        });
        await logActivity(db, {
          companyId: invalidatedIssue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.workflow_lane_invalidated",
          entityType: "issue",
          entityId: invalidatedIssue.id,
          details: {
            identifier: invalidatedIssue.identifier,
            parentId: invalidatedIssue.parentId,
            sourceIssueId: issue.id,
            sourceLaneRole: issue.workflowLaneRole ?? null,
            status: invalidatedIssue.status,
            reason: "lane_reopened",
          },
        });
      }
    }

    if (comment) {
      const workflowHandback = await maybeHandleWorkflowHandbackFromComment({
        issue,
        comment,
        actor,
      });
      issue = workflowHandback.issue;
      issueResponse = { ...issueResponse, ...issue };

      const standaloneHandback = await maybeHandleStandaloneReviewHandbackFromComment({
        issue,
        comment,
        actor,
      });
      issue = standaloneHandback.issue;
      issueResponse = { ...issueResponse, ...issue };
    }

    let mergeStatus = await computeIssueMergeStatusSafe(issue, { qaGate: qaGateSnapshot });
    if (comment) {
      const mergeResult = await maybeAutoMergeValidatedIssue({
        issue,
        comment,
        actor,
      });
      issue = mergeResult.issue;
      issueResponse = { ...issueResponse, ...issue };
      mergeStatus = mergeResult.mergeStatus ?? await computeIssueMergeStatusSafe(issue);
    }
    const assigneeChanged =
      issue.assigneeAgentId !== existing.assigneeAgentId || issue.assigneeUserId !== existing.assigneeUserId;
    const wakeupWarnings: IssueMutationWakeupWarning[] = [];
    if (
      assigneeChanged &&
      issue.assigneeAgentId &&
      !["backlog", "done", "cancelled"].includes(issue.status)
    ) {
      const assigneeWakeup = await queueIssueAssignmentWakeup({
        heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "update",
        contextSource: "issue.update",
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        wakeupPayload: interruptedRunId ? { interruptedRunId } : undefined,
      });
      if (assigneeWakeup.status === "warning" && assigneeWakeup.warning) {
        wakeupWarnings.push({ ...assigneeWakeup.warning, reason: "issue_assigned", agentId: issue.assigneeAgentId });
      }
    }
    const enteredInReview =
      existing.status !== "in_review" && issue.status === "in_review";
    const statusChangedFromBacklog =
      existing.status === "backlog" &&
      issue.status !== "backlog" &&
      req.body.status !== undefined;

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.
    await settleAsyncRouteTask((async () => {
      type WakeupRequest = NonNullable<Parameters<typeof heartbeat.wakeup>[1]>;
      const wakeups = new Map<string, { agentId: string; wakeup: WakeupRequest }>();
      const addWakeup = (agentId: string, wakeup: WakeupRequest) => {
        const wakeIssueId =
          wakeup.payload && typeof wakeup.payload === "object" && typeof wakeup.payload.issueId === "string"
            ? wakeup.payload.issueId
            : issue.id;
        wakeups.set(`${agentId}:${wakeIssueId}`, { agentId, wakeup });
      };

      if (!assigneeChanged && statusChangedFromBacklog && issue.assigneeAgentId && !["done", "cancelled"].includes(issue.status)) {
        addWakeup(issue.assigneeAgentId, {
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

      if (
        enteredInReview &&
        !assigneeChanged &&
        !statusChangedFromBacklog &&
        qaAutoRouting?.alreadyAssigned === true &&
        issue.assigneeAgentId &&
        !["done", "cancelled"].includes(issue.status)
      ) {
        addWakeup(issue.assigneeAgentId, {
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
            source: "issue.qa_entry",
            wakeReason: "issue_status_changed",
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
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          addWakeup(mentionedId, {
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

      const becameTerminalForDependents =
        !["done", "cancelled"].includes(existing.status) && ["done", "cancelled"].includes(issue.status);
      if (becameTerminalForDependents) {
        const promotedWorkflowDependents = await issueWorkflowsSvc.advanceWorkflowDependents(issue.id);
        const promotedWorkflowDependentIds = new Set(promotedWorkflowDependents.map((dependent) => dependent.id));
        for (const dependent of promotedWorkflowDependents) {
          const blockerIssueIds = getWorkflowDependentBlockerIssueIds(dependent);
          logOpsInfo("workflow.lane.unblocked", {
            companyId: dependent.companyId,
            issueId: dependent.id,
            rootIssueId: dependent.parentId ?? null,
            templateKey: dependent.workflowTemplateKey ?? issue.workflowTemplateKey,
            laneRole: dependent.workflowLaneRole ?? null,
            resolvedBlockerIssueId: issue.id,
            blockerIssueIds,
          });
          await logActivity(db, {
            companyId: dependent.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.workflow_lane_unblocked",
            entityType: "issue",
            entityId: dependent.id,
            details: {
              identifier: dependent.identifier,
              parentId: dependent.parentId,
              status: dependent.status,
              resolvedBlockerIssueId: issue.id,
              blockerIssueIds,
              workflowLaneRole: dependent.workflowLaneRole ?? null,
            },
          });
          if (!dependent.assigneeAgentId) continue;
          addWakeup(dependent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_blockers_resolved",
            payload: {
              issueId: dependent.id,
              resolvedBlockerIssueId: issue.id,
              blockerIssueIds,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: dependent.id,
              taskId: dependent.id,
              wakeReason: "issue_blockers_resolved",
              source: "issue.blockers_resolved",
              resolvedBlockerIssueId: issue.id,
              blockerIssueIds,
            },
          });
        }

        const dependents = await svc.listWakeableBlockedDependents(issue.id);
        for (const dependent of dependents) {
          if (promotedWorkflowDependentIds.has(dependent.id)) continue;
          addWakeup(dependent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_blockers_resolved",
            payload: {
              issueId: dependent.id,
              resolvedBlockerIssueId: issue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: dependent.id,
              taskId: dependent.id,
              wakeReason: "issue_blockers_resolved",
              source: "issue.blockers_resolved",
              resolvedBlockerIssueId: issue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
          });
        }
      }

      const becameTerminal =
        !["done", "cancelled"].includes(existing.status) && ["done", "cancelled"].includes(issue.status);
      if (becameTerminal && issue.parentId) {
        const parent = await svc.getWakeableParentAfterChildCompletion(issue.parentId);
        if (parent) {
          addWakeup(parent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_children_completed",
            payload: {
              issueId: parent.id,
              completedChildIssueId: issue.id,
              childIssueIds: parent.childIssueIds,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: parent.id,
              taskId: parent.id,
              wakeReason: "issue_children_completed",
              source: "issue.children_completed",
              completedChildIssueId: issue.id,
              childIssueIds: parent.childIssueIds,
            },
          });
        }
      }

      for (const { agentId, wakeup } of wakeups.values()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) =>
            logWakeupFailure(
              err,
              {
                companyId: issue.companyId,
                issueId: issue.id,
                agentId,
                reason: wakeup.reason ?? null,
              },
              "failed to wake agent on issue update",
            ));
      }
    })());
    await settleAsyncRouteTask(
      maybeTriggerQaAutoFix(issue, actor, "patch_update").catch((err) =>
        logger.warn({ err, issueId: issue.id }, "failed to trigger qa auto-fix after issue update")),
    );

    const qaGate = await computeIssueQaGateSafe(issue);
    const finalMergeStatus = mergeStatus ?? await computeIssueMergeStatusSafe(issue, { qaGate });
    const workflowDecoratedIssue = await issueWorkflowsSvc.decorateIssue({
      ...issueResponse,
      qaGate,
      mergeStatus: finalMergeStatus,
      comment,
      ...(wakeupWarnings.length > 0 ? { warnings: wakeupWarnings } : {}),
    });
    res.json(await decorateIssueDetailWithBoardState(workflowDecoratedIssue));
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
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

    if (!(await assertExecutionStartAllowed(res, {
      companyId: issue.companyId,
      agentId: req.body.agentId,
      issueId: issue.id,
      projectId: issue.projectId,
    }))) return;

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
        .catch((err) =>
          logWakeupFailure(
            err,
            {
              companyId: issue.companyId,
              issueId: issue.id,
              agentId: req.body.agentId,
              reason: "issue_checked_out",
            },
            "failed to wake assignee on issue checkout",
          ));
    }

    res.json(await decorateIssueDetailWithBoardState(updated));
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId: existing.companyId,
      issueId: existing.id,
      projectId: existing.projectId,
    }))) return;
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

    res.json(await decorateIssueDetailWithBoardState(released));
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
    if (!(await assertAgentExecutionMutationAllowed(req, res, {
      companyId: issue.companyId,
      issueId: issue.id,
      projectId: issue.projectId,
    }))) return;
    if (!(await assertAgentRunCheckoutOwnership(req, res, issue))) return;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const actor = getActorInfo(req);
    const reopenRequested = req.body.reopen === true;
    const interruptRequested = req.body.interrupt === true;
    const legacyWorkflowCommentRejection = issueActions
      ? detectLegacyWorkflowControlFromComment({
        body: req.body.body,
        reopenRequested,
      })
      : null;
    if (legacyWorkflowCommentRejection) {
      respondLegacyWorkflowWriteRejected(res, {
        issue,
        actor,
        route: "comment",
        rejection: legacyWorkflowCommentRejection,
      });
      return;
    }
    const isClosed = issue.status === "done" || issue.status === "cancelled";
    if (isClosed && reopenRequested !== true && req.actor.type === "agent") {
      res.status(409).json({ error: "Issue is closed. Reopen it before posting agent updates." });
      return;
    }
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

      const runToInterrupt = await resolveActiveIssueRun(currentIssue);
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
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: currentIssue.id },
          });
        }
      }
    }

    const normalizedCommentBody = await maybeNormalizeRecoverySourceComment({
      issue: currentIssue,
      body: req.body.body,
      actor: {
        actorType: actor.actorType,
        agentId: actor.agentId,
        runId: actor.runId,
      },
    });

    const qaVerdictValidation = await validateQaVerdictComment({
      issue: currentIssue,
      body: normalizedCommentBody,
      actor,
    });
    if (qaVerdictValidation) {
      if (qaVerdictValidation.reasonCode) {
        respondIssueUpdate422(res, qaVerdictValidation.reasonCode, qaVerdictValidation.error);
      } else {
        res.status(422).json({ error: qaVerdictValidation.error });
      }
      return;
    }

    const comment = await svc.addComment(id, normalizedCommentBody, {
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
        source: currentIssue.originKind === "board_copilot_thread" ? "board_copilot" : "comment",
        originKind: currentIssue.originKind ?? "manual",
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        ...(reopened
          ? {
              reopened: true,
              reopenedFrom: reopenFromStatus,
              ...(currentIssue.originKind === "board_copilot_thread" ? {} : { source: "comment" }),
            }
          : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
    });

    const readyForQaPromotion = await maybePromoteCommentReadyForQa({
      issue: currentIssue,
      comment,
      actor,
    });
    currentIssue = readyForQaPromotion.issue;

    if (readyForQaPromotion.qaAutoRouting) {
      await svc.addComment(
        currentIssue.id,
        buildQaRoutingComment(
          readyForQaPromotion.qaAutoRouting.agentId,
          readyForQaPromotion.qaAutoRouting.agentName,
        ),
        {},
      );
      await logActivity(db, {
        companyId: currentIssue.companyId,
        actorType: "system",
        actorId: "qa-routing",
        action: "issue.qa_routed",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          identifier: currentIssue.identifier,
          qaAgentId: readyForQaPromotion.qaAutoRouting.agentId,
          qaAgentName: readyForQaPromotion.qaAutoRouting.agentName,
        },
      });
    }

    const workflowHandback = await maybeHandleWorkflowHandbackFromComment({
      issue: currentIssue,
      comment,
      actor,
    });
    currentIssue = workflowHandback.issue;

    const standaloneHandback = await maybeHandleStandaloneReviewHandbackFromComment({
      issue: currentIssue,
      comment,
      actor,
    });
    currentIssue = standaloneHandback.issue;

    const mergeResult = await maybeAutoMergeValidatedIssue({
      issue: currentIssue,
      comment,
      actor,
    });
    currentIssue = mergeResult.issue;

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    await settleAsyncRouteTask((async () => {
      const wakeups = new Map<string, NonNullable<Parameters<typeof heartbeat.wakeup>[1]>>();
      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const currentIssueIsClosed = currentIssue.status === "done" || currentIssue.status === "cancelled";
      const skipWake = selfComment || currentIssueIsClosed;
      const isBoardCopilotThread = currentIssue.originKind === "board_copilot_thread";
      if (mergeResult.parentWakeup) {
        wakeups.set(mergeResult.parentWakeup.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_children_completed",
          payload: {
            issueId: mergeResult.parentWakeup.id,
            completedChildIssueId: currentIssue.id,
            childIssueIds: mergeResult.parentWakeup.childIssueIds,
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: mergeResult.parentWakeup.id,
            taskId: mergeResult.parentWakeup.id,
            wakeReason: "issue_children_completed",
            source: "issue.children_completed",
            completedChildIssueId: currentIssue.id,
            childIssueIds: mergeResult.parentWakeup.childIssueIds,
          },
        });
      }
      if (assigneeId && (reopened || !skipWake)) {
        if (reopened) {
          wakeups.set(assigneeId, {
            source: isBoardCopilotThread ? "on_demand" : "automation",
            triggerDetail: isBoardCopilotThread ? "manual" : "system",
            reason: isBoardCopilotThread ? "board_copilot_message" : "issue_reopened_via_comment",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              source: isBoardCopilotThread ? "board_copilot" : "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: isBoardCopilotThread ? "board.copilot" : "issue.comment.reopen",
              wakeReason: isBoardCopilotThread ? "board_copilot_message" : "issue_reopened_via_comment",
              ...(isBoardCopilotThread
                ? {
                    taskKey: `board-copilot-thread:${currentIssue.id}`,
                    priority: 100,
                  }
                : {}),
              reopenedFrom: reopenFromStatus,
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          wakeups.set(assigneeId, {
            source: isBoardCopilotThread ? "on_demand" : "automation",
            triggerDetail: isBoardCopilotThread ? "manual" : "system",
            reason: isBoardCopilotThread ? "board_copilot_message" : "issue_commented",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              mutation: "comment",
              source: isBoardCopilotThread ? "board_copilot" : "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: isBoardCopilotThread ? "board.copilot" : "issue.comment",
              wakeReason: isBoardCopilotThread ? "board_copilot_message" : "issue_commented",
              ...(isBoardCopilotThread
                ? {
                    taskKey: `board-copilot-thread:${currentIssue.id}`,
                    priority: 100,
                  }
                : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      let mentionedIds: string[] = [];
      try {
        mentionedIds = await svc.findMentionedAgents(currentIssue.companyId, req.body.body);
      } catch (err) {
        logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
      }

      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        wakeups.set(mentionedId, {
          source: isBoardCopilotThread ? "on_demand" : "automation",
          triggerDetail: isBoardCopilotThread ? "manual" : "system",
          reason: isBoardCopilotThread ? "board_copilot_message" : "issue_comment_mentioned",
          payload: {
            issueId: id,
            commentId: comment.id,
            source: isBoardCopilotThread ? "board_copilot" : "comment",
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: id,
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: isBoardCopilotThread ? "board_copilot_message" : "issue_comment_mentioned",
            source: isBoardCopilotThread ? "board.copilot" : "comment.mention",
            ...(isBoardCopilotThread
              ? {
                  taskKey: `board-copilot-thread:${id}`,
                  priority: 100,
                }
              : {}),
          },
        });
      }

      await Promise.all(
        Array.from(wakeups.entries()).map(async ([agentId, wakeup]) => {
          try {
            await heartbeat.wakeup(agentId, wakeup);
          } catch (err) {
            logWakeupFailure(
              err,
              {
                companyId: currentIssue.companyId,
                issueId: currentIssue.id,
                agentId,
                reason: wakeup.reason ?? null,
              },
              "failed to wake agent on issue comment",
            );
          }
        }),
      );
    })());
    await settleAsyncRouteTask(
      maybeTriggerQaAutoFix(currentIssue, actor, "comment").catch((err) =>
        logger.warn({ err, issueId: currentIssue.id }, "failed to trigger qa auto-fix after issue comment")),
    );

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
    const contentType = normalizeContentType(file.mimetype);
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
    const responseContentType = normalizeContentType(attachment.contentType || object.contentType);
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === SVG_CONTENT_TYPE) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = attachment.originalFilename ?? "attachment";
    const disposition = isInlineAttachmentContentType(responseContentType) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${filename.replaceAll("\"", "")}\"`);

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
