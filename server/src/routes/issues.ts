import { createHash, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companyMemberships,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueRelations,
  issueThreadInteractions,
  issues as issueRows,
  issueWorkProducts,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  pipelines,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  addIssueCommentSchema,
  acceptIssueThreadInteractionSchema,
  attachmentArtifactWorkProductMetadataSchema,
  cancelIssueThreadInteractionSchema,
  skipIssueThreadInteractionSchema,
  withdrawIssueThreadInteractionSchema,
  companySearchExtractQuerySchema,
  companySearchQuerySchema,
  createIssueAttachmentMetadataSchema,
  createIssueThreadInteractionSchema,
  createIssueWorkProductSchema,
  createIssueLabelSchema,
  createAcceptedPlanDecompositionSchema,
  checkoutIssueSchema,
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  createChildIssueSchema,
  createIssueSchema,
  resolveCreateIssueStatusDefault,
  resolveIssueRecoveryActionSchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  upsertIssueFeedbackVoteSchema,
  upsertIssueWatchdogSchema,
  linkIssueApprovalSchema,
  issueDocumentKeySchema,
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  ISSUE_WATCHDOG_DISCOVERY_KINDS,
  TASK_WATCHDOG_PRODUCT_BUG_ORIGIN_KIND,
  ONBOARDING_FIRST_TASK_ORIGIN_KIND,
  rejectIssueThreadInteractionSchema,
  restoreIssueDocumentRevisionSchema,
  respondIssueThreadInteractionSchema,
  stalledReviewDecisionSchema,
  submitIssueThreadInteractionVerdictsSchema,
  updateIssueWorkProductSchema,
  updateDocumentAnnotationThreadSchema,
  upsertIssueDocumentSchema,
  updateIssueSchema,
  isClosedIsolatedExecutionWorkspace,
  isMarkdownArtifactWorkProduct,
  isMarkdownAttachmentContent,
  isUuidLike,
  normalizeIssueIdentifier as normalizeIssueReferenceIdentifier,
  type CompactIssue,
  type CompanySearchExtractQuery,
  type CompanySearchExtractResponse,
  type CompanySearchQuery,
  type CompanySearchResponse,
  type ExecutionWorkspace,
  type IssueBlockerDiagnosticFlag,
  type IssueBlockerDiagnosticIssueSummary,
  type IssueBlockerDiagnosticNode,
  type IssueBlockerDiagnosticsReadiness,
  type IssueBlockerDiagnosticsResponse,
  type IssueSubtreeDiagnosticEdge,
  type IssueSubtreeDiagnosticNode,
  type IssueSubtreeDiagnosticsResponse,
  type IssueWakeDiagnosticActivityRecord,
  type IssueWakeDiagnosticEvent,
  type IssueWakeDiagnosticWakeFailureClass,
  type IssueWakeDiagnosticWakeRequest,
  type IssueWakeDiagnosticsResponse,
  type IssueRelationIssueSummary,
  type IssueReviewPolicy,
  type IssueThreadInteractionCanonicalResolverPolicy,
  type IssueCommentPresentation,
  type IssueQueuedCommentQueue,
  type IssueWatchdogDiscoveryKind,
  type ProjectWorkspace,
  type SourceTrustMetadata,
  type SuggestTasksInteraction,
  type SuccessfulRunHandoffState,
  type WorkspaceRuntimeService,
  issueWriteDenialCodeForResponsibleUserDenial,
  issueWriteDenialResponse,
  type IssueWriteDenialCode,
  type IssueWriteDenialContext,
} from "@paperclipai/shared";
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { isUniqueViolation } from "../db-errors.js";
import type { StorageService } from "../storage/types.js";
import { validate, validateIssueMutationBody } from "../middleware/validate.js";
import * as serviceIndex from "../services/index.js";
import {
  accessService,
  agentService,
  budgetService,
  companySkillService,
  companyService,
  companySearchService,
  executionWorkspaceService,
  goalService,
  heartbeatService,
  issueApprovalService,
  issueRecoveryActionService,
  issueThreadInteractionService,
  inboxAgentPolicyService,
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_MAX_LIMIT,
  issueReferenceService,
  issueService,
  type ActivityPublication,
  type IssueFilters,
  clampIssueListLimit,
  documentService,
  documentAnnotationService,
  logActivity,
  publishActivity,
  projectService,
  routineService,
  workProductService,
} from "../services/index.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";
import { artifactReviewDocumentService } from "../services/artifact-review-documents.js";
import { assertCanResolveProposal } from "../services/secret-proposal-authorization.js";
import { buildDocumentReviewContext, buildPlanReviewContext } from "../services/plan-review-context.js";
import {
  decideIssueReviewPathRecovery,
  ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
  isReviewPathRecoveryIdempotencyConflict,
  REVIEW_PATH_RECOVERY_INSTRUCTION,
} from "../services/recovery/review-path-recovery.js";
import { hydrateSuccessfulRunHandoffLiveness } from "../services/successful-run-handoff-state.js";
import {
  TASK_WATCHDOG_ORIGIN_KIND,
  resolveTaskWatchdogMutationScope,
  taskWatchdogScopeAllowsIssueMutation,
} from "../services/task-watchdog-scope.js";
import type { TaskWatchdogServiceDeps, taskWatchdogService } from "../services/task-watchdogs.js";
import { logger } from "../middleware/logger.js";
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized, unprocessable } from "../errors.js";
import { privateJsonEtag } from "../middleware/private-json-etag.js";
import { createRequestPromiseMemo } from "../lib/request-promise-memo.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectIssueWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import {
  formatAttachmentSize,
  GENERIC_ATTACHMENT_CONTENT_TYPES,
  isInlineAttachmentContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeContentType,
  normalizeUploadAttachmentContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";
import { notifySecretProposalResolution } from "../services/secret-proposal-notifications.js";
import {
  buildOnboardingGreeting,
  ONBOARDING_GREETING_AUTHORIZATION_REASON,
} from "../services/onboarding-greeting.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  buildIssueBlockersResolvedWakeStateKey,
  findExistingIssueBlockersResolvedWakeForReadyState,
} from "../services/issue-dependency-wakeups.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import {
  executionWorkspaceService as executionWorkspaceServiceDirect,
  STALE_REOPEN_PENDING_CONSUMPTION_GRACE_MS,
} from "../services/execution-workspaces.js";
import { decisionTrainingService } from "../services/decision-training.js";
import { feedbackService } from "../services/feedback.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
  ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS,
  ISSUE_WAKE_DIAGNOSTICS_MAX_ACTIVITY_RECORDS,
  ISSUE_WAKE_DIAGNOSTICS_MAX_WAKE_REQUESTS,
  readAcceptedPlanConfirmationTarget,
  type IssuePostCommitAction,
} from "../services/issues.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { stalledReviewDecisionService } from "../services/stalled-review-decisions.js";
import { environmentService } from "../services/environments.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { redactSensitiveText } from "../redaction.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import {
  deliverNativeQuestionResponse,
  requestNativeQuestionRunCancellation,
  validateNativeQuestionResponseInput,
} from "../services/native-runtime/native-question-bridge.js";
import {
  createCompanySearchRateLimiter,
  type CompanySearchRateLimiter,
} from "../services/company-search-rate-limit.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  redactIssueMonitorExternalRef,
  setIssueExecutionPolicyMonitorScheduledBy,
} from "../services/issue-execution-policy.js";
import { parseIssueExecutionWorkspaceSettings } from "../services/execution-workspace-policy.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  buildPromotedSourceTrust,
  isLowTrustQuarantined,
  redactQuarantinedBodyForHigherTrust,
  resolveActorSourceTrustForIssue,
  sanitizeQuarantinedCommentForHigherTrust,
} from "../services/source-trust.js";
import {
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH,
  resolveCoreTrustPreset,
  type TrustPresetResolution,
} from "../services/trust-preset-resolver.js";
import { externalObjectService } from "../services/external-objects.js";
import { deliverAgentUnblockNotification } from "../services/routable-blocked.js";
import {
  assertIssueReviewVerdictActorAllowed,
  isIssueReviewVerdictInteraction,
  resolveIssueReviewRequester,
} from "../services/issue-review-policy.js";
import {
  evaluateIssueThreadInteractionResolverAudience,
  issueThreadInteractionAttentionAgentAllowed,
  type IssueThreadInteractionResolverAudienceDecision,
  type IssueThreadInteractionResolverRestriction,
} from "../services/issue-thread-interaction-resolution.js";
import { resolveSelectedSuggestedTasks } from "../services/issue-thread-interactions.js";
import {
  crossIssueInfluenceLimitError,
  crossIssueInfluenceRunContextError,
  observeCrossIssueInfluence,
  type CrossIssueInfluenceKind,
} from "../services/cross-issue-influence-limit.js";
import {
  getNativeSessionSteeringState,
  NativeSessionSteeringError,
  steerNativeSession,
} from "../services/native-runtime/native-session-executor.js";
import {
  queuedCommentIdsFromWakePayload,
  withQueuedCommentIdsInRunContext,
  withQueuedCommentIdsInWakePayload,
} from "../services/issue-queued-comment-queue.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
});
const queuedCommentMutationTargetSchema = z.object({
  queueId: z.string().min(1),
  revision: z.string().min(1),
});
const queuedCommentSteeringTargetSchema = queuedCommentMutationTargetSchema.extend({
  targetRunId: z.string().min(1),
});
const editQueuedCommentSchema = queuedCommentMutationTargetSchema.extend({
  body: z
    .string()
    .min(1)
    .max(200_000)
    .refine((value) => value.trim().length > 0, "Queued message cannot be empty"),
});
const reorderQueuedCommentsSchema = queuedCommentMutationTargetSchema.extend({
  orderedCommentIds: z.array(z.string().min(1)).max(MAX_ISSUE_COMMENT_LIMIT),
});

function prefersMinimalIssueUpdateResponse(req: Request) {
  return (req.get("Prefer") ?? "")
    .split(",")
    .some((preference) => preference.trim().toLowerCase() === "return=minimal");
}

const refreshExternalObjectsSchema = z.object({
  objectIds: z.array(z.string().guid()).max(50).optional(),
}).strict();
const inboxArchiveBodySchema = z.object({
  userId: z.string().trim().min(1).optional(),
}).strict().default({});
const externalObjectSummariesSchema = z.object({
  issueIds: z.array(z.string().guid()).max(1000),
}).strict();

const promoteLowTrustOutputSchema = z.object({
  sourceArtifactKind: z.enum(["comment", "document", "work_product", "issue"]),
  sourceArtifactId: z.string().guid(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(8_000),
});

async function listIssueLinkedCases(db: Db, companyId: string, issueId: string) {
  const rows = await db
    .select({
      link: pipelineCaseIssueLinks,
      case: pipelineCases,
      pipeline: pipelines,
      stage: pipelineStages,
    })
    .from(pipelineCaseIssueLinks)
    .innerJoin(pipelineCases, eq(pipelineCaseIssueLinks.caseId, pipelineCases.id))
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .where(and(
      eq(pipelineCaseIssueLinks.companyId, companyId),
      eq(pipelineCaseIssueLinks.issueId, issueId),
      eq(pipelineCases.companyId, companyId),
      eq(pipelines.companyId, companyId),
    ));
  return rows.map((row) => ({
    id: row.case.id,
    caseKey: row.case.caseKey,
    title: row.case.title,
    status: row.case.terminalKind ?? "open",
    role: row.link.role,
    pipeline: {
      id: row.pipeline.id,
      key: row.pipeline.key,
      name: row.pipeline.name,
    },
    stage: {
      id: row.stage.id,
      key: row.stage.key,
      name: row.stage.name,
      kind: row.stage.kind,
    },
  }));
}

type ParsedExecutionState = NonNullable<ReturnType<typeof parseIssueExecutionState>>;
type NormalizedExecutionPolicy = NonNullable<ReturnType<typeof normalizeIssueExecutionPolicy>>;
type IssueRouteSnapshot = typeof issueRows.$inferSelect;
type RecoveryRevalidationTrigger =
  | "issue_update"
  | "comment"
  | "document"
  | "work_product"
  | "read_projection";
type CompanySearchService = {
  extract(companyId: string, query: CompanySearchExtractQuery): Promise<CompanySearchExtractResponse>;
  search(companyId: string, query: CompanySearchQuery): Promise<CompanySearchResponse>;
};
type ActivityIssueRelationSummary = {
  id: string;
  identifier: string | null;
  title: string;
};
type ActivityExecutionParticipant = Pick<
  NormalizedExecutionPolicy["stages"][number]["participants"][number],
  "type" | "agentId" | "userId"
>;
type ExecutionStageWakeContext = {
  wakeRole: "reviewer" | "approver" | "executor";
  stageId: string | null;
  stageType: ParsedExecutionState["currentStageType"];
  currentParticipant: ParsedExecutionState["currentParticipant"];
  returnAssignee: ParsedExecutionState["returnAssignee"];
  reviewRequest: ParsedExecutionState["reviewRequest"];
  lastDecisionOutcome: ParsedExecutionState["lastDecisionOutcome"];
  allowedActions: string[];
};
type SuccessfulRunHandoffActivityRow = {
  entityId: string;
  action: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
};
type TaskWatchdogService = ReturnType<typeof taskWatchdogService>;
type TaskWatchdogServiceFactory = typeof taskWatchdogService;

function applyCreateIssueStatusDefault(req: Request, res: Response, next: () => void) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    next();
    return;
  }

  const resolution = resolveCreateIssueStatusDefault(req.body as Record<string, unknown>);
  res.locals.createIssueStatusDefault = resolution;
  if (resolution.defaulted) {
    req.body = {
      ...req.body,
      status: resolution.status,
    };
  }
  next();
}

function noopTaskWatchdogService(): TaskWatchdogService {
  return {
    getActiveForIssue: async () => null,
    listActiveSummariesForIssues: async () => new Map(),
    upsertForIssue: async () => {
      throw unprocessable("Task watchdog service is unavailable");
    },
    disableForIssue: async () => null,
    reconcileTaskWatchdogs: async () => ({
      checked: 0,
      triggered: 0,
      live: 0,
      pendingFirstRun: 0,
      alreadyReviewed: 0,
      skipped: 0,
      watchdogIssueIds: [],
    }),
    reconcileForIssueAndAncestors: async () => ({
      checked: 0,
      triggered: 0,
      pendingFirstRun: 0,
      skipped: 0,
      watchdogIssueIds: [],
    }),
    revalidateMutationScope: async () => ({
      allowed: true,
      classification: {
        state: "stopped",
        reason: "Task watchdog service unavailable in this route context.",
        includedIssueIds: [],
        stopFingerprint: "task_watchdog_stop:unavailable",
        stoppedLeaves: [],
        stopSnapshot: {
          version: 2,
          fingerprint: "task_watchdog_stop:unavailable",
          materialLeaves: [],
          waitsByIssueId: {},
        },
        pendingInteractionsByIssueId: {},
      },
    }),
  };
}

function buildAttachmentContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

const GENERIC_RESPONSE_ATTACHMENT_CONTENT_TYPES = new Set(GENERIC_ATTACHMENT_CONTENT_TYPES);

function inferVideoContentTypeFromFilename(filename: string | null | undefined): string | null {
  const lower = (filename ?? "").toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov") || lower.endsWith(".qt") || lower.endsWith(".quicktime")) return "video/quicktime";
  return null;
}

function resolveAttachmentResponseContentType(input: {
  storedContentType: string | null | undefined;
  objectContentType?: string | null;
  originalFilename?: string | null;
}) {
  const storedContentType = normalizeContentType(input.storedContentType || input.objectContentType);
  if (!GENERIC_RESPONSE_ATTACHMENT_CONTENT_TYPES.has(storedContentType)) return storedContentType;
  return inferVideoContentTypeFromFilename(input.originalFilename) ?? storedContentType;
}

function requiresPaperclipAttachmentMetadata(input: {
  type?: unknown;
  provider?: unknown;
}, fallback?: {
  type?: string | null;
  provider?: string | null;
}) {
  const type = typeof input.type === "string" ? input.type : fallback?.type ?? null;
  const provider = typeof input.provider === "string" ? input.provider : fallback?.provider ?? null;
  return type === "artifact" && provider === "paperclip";
}

const attachmentArtifactMetadataInputSchema = z.object({
  attachmentId: z.string().guid(),
}).passthrough();

function buildCreateIssueActivityStatusDetails(
  issue: { assigneeAgentId: string | null; status: string },
  res: Response,
) {
  const statusDefault = res.locals.createIssueStatusDefault as
    | ReturnType<typeof resolveCreateIssueStatusDefault>
    | undefined;
  const assignmentWakeSkipped = !issue.assigneeAgentId || issue.status === "backlog";
  return {
    status: issue.status,
    statusDefaulted: statusDefault?.defaulted ?? false,
    statusDefaultReason: statusDefault?.reason ?? "explicit",
    assignmentWakeSkipped,
    assignmentWakeSkipReason: assignmentWakeSkipped
      ? issue.assigneeAgentId
        ? "assigned_backlog"
        : "no_agent_assignee"
      : null,
  };
}

const SUCCESSFUL_RUN_HANDOFF_ACTIONS = [
  "issue.successful_run_handoff_required",
  "issue.successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated",
] as const;

const ISSUE_WORKSPACE_AUDIT_FIELDS = new Set([
  "projectWorkspaceId",
  "executionWorkspaceId",
  "executionWorkspacePreference",
  "executionWorkspaceSettings",
]);

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

async function auditAgentIssueCreateAttributionSpoof(input: {
  db: Db;
  req: Request;
  companyId: string;
  entityId?: string | null;
  surface: string;
  field: "responsibleUserId" | "createdByUserId";
  action: "rejected" | "stripped";
  requestedValue: string | null;
}) {
  const actor = getActorInfo(input.req);
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId,
    action: input.action === "rejected"
      ? "issue.attribution_spoof_rejected"
      : "issue.attribution_spoof_stripped",
    entityType: input.entityId ? "issue" : "company",
    entityId: input.entityId ?? input.companyId,
    details: {
      surface: input.surface,
      field: input.field,
      requestedValue: input.requestedValue,
      derivedFrom: "authenticated_actor",
    },
  });
}

async function auditAgentIssueCommentAttributionSpoof(input: {
  db: Db;
  req: Request;
  issue: { id: string; companyId: string; identifier: string | null };
  surface: "issue.comment.create" | "issue.patch.comment";
  requestedValue: string | null;
}) {
  const actor = getActorInfo(input.req);
  await logActivity(input.db, {
    companyId: input.issue.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId,
    responsibleUserIdOverride: authenticatedActorResponsibleUserId(input.req),
    action: "issue.attribution_spoof_rejected",
    entityType: "issue",
    entityId: input.issue.id,
    details: {
      identifier: input.issue.identifier,
      surface: input.surface,
      field: "onBehalfOfUserId",
      requestedValue: input.requestedValue,
      derivedFrom: "authenticated_actor",
    },
  });
}

async function sanitizeIssueCreateAttribution<T extends object>(
  db: Db,
  req: Request,
  res: Response,
  companyId: string,
  input: T,
  options: { surface: string; entityId?: string | null },
) {
  const sanitized = { ...input } as T & Record<string, unknown>;
  if (req.actor.type !== "agent") return sanitized;

  if (hasOwn(sanitized, "responsibleUserId") && sanitized.responsibleUserId != null) {
    await auditAgentIssueCreateAttributionSpoof({
      db,
      req,
      companyId,
      entityId: options.entityId,
      surface: options.surface,
      field: "responsibleUserId",
      action: "rejected",
      requestedValue: readNonEmptyString(sanitized.responsibleUserId),
    });
    res.status(422).json({ error: "Agent-created issues cannot set responsibleUserId" });
    return null;
  }

  if (hasOwn(sanitized, "createdByUserId") && sanitized.createdByUserId != null) {
    await auditAgentIssueCreateAttributionSpoof({
      db,
      req,
      companyId,
      entityId: options.entityId,
      surface: options.surface,
      field: "createdByUserId",
      action: "stripped",
      requestedValue: readNonEmptyString(sanitized.createdByUserId),
    });
    delete sanitized.createdByUserId;
  }

  delete sanitized.responsibleUserId;
  return sanitized;
}

function authenticatedActorResponsibleUserId(req: Request) {
  return req.actor.type === "agent" ? req.actor.onBehalfOfUserId ?? null : undefined;
}

// Matches the partial unique index that guarantees at most one onboarding
// first-task issue per company (packages/db/src/schema/issues.ts).
function isOnboardingFirstTaskConflict(error: unknown): boolean {
  for (
    let current = error, depth = 0;
    current && typeof current === "object" && depth < 5;
    current = (current as { cause?: unknown }).cause, depth += 1
  ) {
    const candidate = current as { code?: string; constraint?: string; message?: string };
    if (
      candidate.code === "23505" &&
      (candidate.constraint === "issues_onboarding_first_task_uq" ||
        (typeof candidate.message === "string" &&
          candidate.message.includes("issues_onboarding_first_task_uq")))
    ) {
      return true;
    }
  }
  return false;
}

function issueWriteAuthorizationReason(
  req: Request,
  decision: true | { reason?: string | null },
) {
  if (decision !== true && decision.reason) return decision.reason;
  return req.actor.type === "agent" ? "allow_scoped_agent_write" : "allow_board_actor";
}

function readPlanConfirmationTargetForIssue(payload: unknown, issueId: string) {
  const target = readObject(readObject(payload).target);
  if (target.type !== "issue_document" || target.key !== "plan") return null;
  if (readNonEmptyString(target.issueId) !== issueId) return null;
  return {
    issueId,
    documentId: readNonEmptyString(target.documentId),
    key: "plan",
    revisionId: readNonEmptyString(target.revisionId),
    revisionNumber: typeof target.revisionNumber === "number" ? target.revisionNumber : null,
  };
}

function readConfirmationResultForWake(result: unknown) {
  const parsed = readObject(result);
  if (Object.keys(parsed).length === 0) return null;
  return {
    outcome: readNonEmptyString(parsed.outcome),
    reason: readNonEmptyString(parsed.reason) ?? readNonEmptyString(parsed.rejectionReason),
    commentId: readNonEmptyString(parsed.commentId),
  };
}

function readNativeCompletionReviewForWake(input: {
  payload: unknown;
  result: unknown;
  status: string;
}) {
  const target = readObject(readObject(input.payload).target);
  if (target.type !== "custom" || target.key !== "native_completion_review") return null;
  const result = readConfirmationResultForWake(input.result);
  return {
    decisionId: readNonEmptyString(target.revisionId),
    outcome: result?.outcome ?? input.status,
    reviewerReason: result?.reason ?? null,
    instruction: input.status === "rejected"
      ? "Address only the reviewer rejection for the accepted source run. Use the existing result and evidence; do not redo completed implementation or unrelated work."
      : "The completion review was resolved; preserve the accepted source-run result and disposition lineage.",
  };
}

function hasIssueWorkspaceAuditChange(previous: Record<string, unknown>) {
  return Object.keys(previous).some((key) => ISSUE_WORKSPACE_AUDIT_FIELDS.has(key));
}

function labelIssueWorkspaceMode(mode: string | null) {
  switch (mode) {
    case "shared_workspace":
      return "Project default";
    case "isolated_workspace":
      return "New isolated workspace";
    case "operator_branch":
      return "Operator branch";
    case "reuse_existing":
      return "Reuse existing workspace";
    case "agent_default":
      return "Agent default";
    case "inherit":
      return "Inherited workspace";
    default:
      return "No workspace";
  }
}

type IssueWorkspaceAuditInput = {
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: unknown;
};

type WorkspaceNameMaps = {
  projectWorkspaceNames: Map<string, string>;
  executionWorkspaceNames: Map<string, string>;
};

function emptyWorkspaceNameMaps(): WorkspaceNameMaps {
  return {
    projectWorkspaceNames: new Map(),
    executionWorkspaceNames: new Map(),
  };
}

function summarizeIssueWorkspaceForActivity(
  issue: IssueWorkspaceAuditInput,
  names: WorkspaceNameMaps,
) {
  const settings = parseIssueExecutionWorkspaceSettings(issue.executionWorkspaceSettings, { includeEnvironmentId: true });
  const mode = settings?.mode ?? issue.executionWorkspacePreference ?? null;
  const executionWorkspaceId = issue.executionWorkspaceId ?? null;
  const projectWorkspaceId = issue.projectWorkspaceId ?? null;

  const label = (() => {
    if (executionWorkspaceId) {
      return names.executionWorkspaceNames.get(executionWorkspaceId) ?? `Workspace ${executionWorkspaceId.slice(0, 8)}`;
    }
    if (projectWorkspaceId) {
      return names.projectWorkspaceNames.get(projectWorkspaceId) ?? `Workspace ${projectWorkspaceId.slice(0, 8)}`;
    }
    return labelIssueWorkspaceMode(mode);
  })();

  return {
    label,
    projectWorkspaceId,
    executionWorkspaceId,
    mode,
  };
}

async function buildIssueWorkspaceChangeActivityDetails(
  db: Db,
  companyId: string,
  previousIssue: IssueWorkspaceAuditInput,
  nextIssue: IssueWorkspaceAuditInput,
) {
  const projectWorkspaceIds = [
    previousIssue.projectWorkspaceId,
    nextIssue.projectWorkspaceId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const executionWorkspaceIds = [
    previousIssue.executionWorkspaceId,
    nextIssue.executionWorkspaceId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const [projectRows, executionRows] = await Promise.all([
    projectWorkspaceIds.length > 0
      ? db
          .select({ id: projectWorkspaces.id, name: projectWorkspaces.name })
          .from(projectWorkspaces)
          .where(and(eq(projectWorkspaces.companyId, companyId), inArray(projectWorkspaces.id, projectWorkspaceIds)))
      : Promise.resolve([]),
    executionWorkspaceIds.length > 0
      ? db
          .select({ id: executionWorkspaces.id, name: executionWorkspaces.name })
          .from(executionWorkspaces)
          .where(and(eq(executionWorkspaces.companyId, companyId), inArray(executionWorkspaces.id, executionWorkspaceIds)))
      : Promise.resolve([]),
  ]);

  const names: WorkspaceNameMaps = {
    projectWorkspaceNames: new Map(projectRows.map((row) => [row.id, row.name])),
    executionWorkspaceNames: new Map(executionRows.map((row) => [row.id, row.name])),
  };

  return {
    from: summarizeIssueWorkspaceForActivity(previousIssue, names),
    to: summarizeIssueWorkspaceForActivity(nextIssue, names),
  };
}

function hasExecutionParticipant(value: unknown) {
  const state = parseIssueExecutionState(value);
  if (!state || state.status !== "pending") return false;
  const participant = state.currentParticipant;
  if (!participant) return false;
  if (participant.type === "agent") return Boolean(participant.agentId);
  if (participant.type === "user") return Boolean(participant.userId);
  return false;
}

function hasScheduledMonitor(input: {
  existingMonitorNextCheckAt?: Date | null;
  patchMonitorNextCheckAt?: unknown;
  executionPolicy?: unknown;
}) {
  if (input.patchMonitorNextCheckAt instanceof Date && !Number.isNaN(input.patchMonitorNextCheckAt.getTime())) return true;
  if (input.patchMonitorNextCheckAt === undefined && input.existingMonitorNextCheckAt) return true;
  const policy = normalizeIssueExecutionPolicy(input.executionPolicy ?? null);
  return Boolean(policy?.monitor?.nextCheckAt);
}

function successfulRunHandoffStateFromActivity(row: {
  action: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}): SuccessfulRunHandoffState | null {
  const details = row.details ?? {};
  const state =
    row.action === "issue.successful_run_handoff_required"
      ? "required"
      : row.action === "issue.successful_run_handoff_resolved"
        ? "resolved"
        : row.action === "issue.successful_run_handoff_escalated"
          ? "escalated"
          : null;
  if (!state) return null;

  const detectedProgressSummary =
    readNonEmptyString(details.detectedProgressSummary)
    ?? readNonEmptyString(details.detected_progress_summary)
    ?? null;

  return {
    state,
    required: state === "required",
    hasLiveContinuation: false,
    sourceRunId:
      readNonEmptyString(details.sourceRunId)
      ?? readNonEmptyString(details.source_run_id)
      ?? readNonEmptyString(details.resumeFromRunId)
      ?? row.runId
      ?? null,
    correctiveRunId:
      readNonEmptyString(details.correctiveRunId)
      ?? readNonEmptyString(details.corrective_run_id)
      ?? (state !== "required" ? row.runId : null),
    assigneeAgentId:
      readNonEmptyString(details.assigneeAgentId)
      ?? readNonEmptyString(details.agentId)
      ?? row.agentId
      ?? null,
    detectedProgressSummary: detectedProgressSummary
      ? redactSensitiveText(detectedProgressSummary)
      : null,
    createdAt: row.createdAt,
  };
}

async function listSuccessfulRunHandoffStates(
  db: Db,
  companyId: string,
  issueIds: string[],
  options?: { hydrateLiveness?: boolean },
): Promise<Map<string, SuccessfulRunHandoffState>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .select({
      entityId: activityLog.entityId,
      action: activityLog.action,
      agentId: activityLog.agentId,
      runId: activityLog.runId,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, "issue"),
      inArray(activityLog.entityId, issueIds),
      inArray(activityLog.action, [...SUCCESSFUL_RUN_HANDOFF_ACTIONS]),
    ))
    .orderBy(activityLog.entityId, desc(activityLog.createdAt), desc(activityLog.id)) as SuccessfulRunHandoffActivityRow[];

  const states = new Map<string, SuccessfulRunHandoffState>();
  for (const row of rows) {
    if (states.has(row.entityId)) continue;
    const state = successfulRunHandoffStateFromActivity(row);
    if (state) states.set(row.entityId, state);
  }
  return options?.hydrateLiveness === false
    ? states
    : hydrateSuccessfulRunHandoffLiveness(db, companyId, states);
}

type RecoveryActionsLister = {
  listActiveForIssues: (
    companyId: string,
    sourceIssueIds: string[],
  ) => Promise<Map<string, NonNullable<IssueRelationIssueSummary["activeRecoveryAction"]>>>;
};

async function relationRecoveryActionMap(
  recoveryActionsSvc: RecoveryActionsLister,
  companyId: string,
  relations: { blockedBy: IssueRelationIssueSummary[]; blocks: IssueRelationIssueSummary[] },
): Promise<Map<string, NonNullable<IssueRelationIssueSummary["activeRecoveryAction"]>>> {
  const candidates: IssueRelationIssueSummary[] = [];
  const visit = (summary: IssueRelationIssueSummary) => {
    candidates.push(summary);
    for (const terminal of summary.terminalBlockers ?? []) {
      visit(terminal);
    }
  };
  for (const blocker of relations.blockedBy) visit(blocker);
  for (const blocking of relations.blocks) visit(blocking);
  if (candidates.length === 0) return new Map();
  const ids = [...new Set(candidates.map((summary) => summary.id))];
  return recoveryActionsSvc.listActiveForIssues(companyId, ids);
}

function withRecoveryActionsOnRelationSummaries(
  relations: { blockedBy: IssueRelationIssueSummary[]; blocks: IssueRelationIssueSummary[] },
  recoveryActionByIssueId: Map<string, NonNullable<IssueRelationIssueSummary["activeRecoveryAction"]>>,
) {
  const augment = (summary: IssueRelationIssueSummary): IssueRelationIssueSummary => ({
    ...summary,
    activeRecoveryAction: recoveryActionByIssueId.get(summary.id) ?? summary.activeRecoveryAction ?? null,
    terminalBlockers: summary.terminalBlockers?.map(augment),
  });
  return {
    blockedBy: relations.blockedBy.map(augment),
    blocks: relations.blocks.map(augment),
  };
}

type IssueBlockerDiagnosticReadableIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

type IssueBlockerDiagnosticAuthzIssue = IssueBlockerDiagnosticReadableIssue & {
  companyId: string;
  projectId: string | null;
  parentId: string | null;
};

function toIssueBlockerDiagnosticSummary(
  issue: IssueBlockerDiagnosticReadableIssue,
): IssueBlockerDiagnosticIssueSummary {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status as IssueBlockerDiagnosticIssueSummary["status"],
    priority: issue.priority as IssueBlockerDiagnosticIssueSummary["priority"],
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
  };
}

function blockerDiagnosticLabel(issue: IssueBlockerDiagnosticIssueSummary) {
  return issue.identifier ?? issue.title;
}

function buildIssueBlockerDiagnosticsResponse(input: {
  issue: IssueBlockerDiagnosticReadableIssue;
  blockers: IssueBlockerDiagnosticAuthzIssue[];
  visibleBlockers: IssueBlockerDiagnosticAuthzIssue[];
  readiness: {
    allBlockersDone: boolean;
    isDependencyReady: boolean;
    unresolvedBlockerIssueIds: string[];
    pendingFinalizeBlockerIssueIds: string[];
  };
  truncated: boolean;
  maxBlockers?: number;
}): IssueBlockerDiagnosticsResponse {
  const issue = toIssueBlockerDiagnosticSummary(input.issue);
  const visibleBlockerIds = new Set(input.visibleBlockers.map((blocker) => blocker.id));
  const omittedUnauthorizedBlockerCount = input.blockers.filter(
    (blocker) => !visibleBlockerIds.has(blocker.id),
  ).length;
  const completeVisibleSet = !input.truncated && omittedUnauthorizedBlockerCount === 0;
  const unresolvedIds = new Set(input.readiness.unresolvedBlockerIssueIds);
  const pendingFinalizeIds = new Set(input.readiness.pendingFinalizeBlockerIssueIds);

  const blockers: IssueBlockerDiagnosticNode[] = input.visibleBlockers.map((blockerRow) => {
    const blocker = toIssueBlockerDiagnosticSummary(blockerRow);
    const isPendingFinalize = pendingFinalizeIds.has(blocker.id);
    const isUnresolved = unresolvedIds.has(blocker.id);
    const flags: IssueBlockerDiagnosticFlag[] = [];
    if (issue.status === "blocked" && blocker.status === "done") flags.push("done_but_blocking");
    if (blocker.status === "cancelled") flags.push("cancelled_blocker_in_set");
    if (isPendingFinalize) flags.push("workspace_finalize_pending");

    return {
      ...blocker,
      isUnresolved,
      isPendingFinalize,
      isDependencyReady: blocker.status === "done" && !isPendingFinalize,
      flags,
    };
  });

  const readiness: IssueBlockerDiagnosticsReadiness | null = completeVisibleSet
    ? {
        allBlockersDone: input.readiness.allBlockersDone,
        isDependencyReady: input.readiness.isDependencyReady,
        unresolvedBlockerCount: input.readiness.unresolvedBlockerIssueIds.length,
        pendingFinalizeBlockerCount: input.readiness.pendingFinalizeBlockerIssueIds.length,
      }
    : null;
  const reportedOmittedUnauthorizedBlockerCount = input.truncated
    ? null
    : omittedUnauthorizedBlockerCount;

  return {
    issue,
    diagnosis: buildIssueBlockerDiagnosis({
      issue,
      blockers,
      readiness,
      omittedUnauthorizedBlockerCount: reportedOmittedUnauthorizedBlockerCount,
      truncated: input.truncated,
      maxBlockers: input.maxBlockers ?? ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    }),
    readiness,
    blockers,
    omittedUnauthorizedBlockerCount: reportedOmittedUnauthorizedBlockerCount,
    truncated: input.truncated,
    caps: {
      maxBlockers: input.maxBlockers ?? ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    },
  };
}

function buildIssueBlockerDiagnosis(input: {
  issue: IssueBlockerDiagnosticIssueSummary;
  blockers: IssueBlockerDiagnosticNode[];
  readiness: IssueBlockerDiagnosticsReadiness | null;
  omittedUnauthorizedBlockerCount: number | null;
  truncated: boolean;
  maxBlockers: number;
}) {
  if (input.truncated) {
    return `Blocker diagnostics for ${blockerDiagnosticLabel(input.issue)} are truncated at ${
      input.maxBlockers
    } blockers, so readiness is not reported.`;
  }
  const omittedUnauthorizedBlockerCount = input.omittedUnauthorizedBlockerCount ?? 0;
  if (omittedUnauthorizedBlockerCount > 0) {
    return `One or more blockers for ${blockerDiagnosticLabel(
      input.issue,
    )} are outside this actor's authorization boundary, so this diagnosis only covers visible blockers.`;
  }
  if (input.blockers.length === 0) {
    return input.issue.status === "blocked"
      ? `${blockerDiagnosticLabel(input.issue)} is blocked but has no first-class blocker relations.`
      : null;
  }

  const pendingFinalize = input.blockers.find((blocker) => blocker.isPendingFinalize);
  if (pendingFinalize) {
    return `${blockerDiagnosticLabel(input.issue)} is waiting for ${blockerDiagnosticLabel(
      pendingFinalize,
    )} to finish workspace finalization.`;
  }

  const cancelled = input.blockers.find((blocker) => blocker.status === "cancelled");
  if (cancelled) {
    return `${blockerDiagnosticLabel(input.issue)} is blocked by ${blockerDiagnosticLabel(
      cancelled,
    )}, which is cancelled; cancelled blockers do not resolve until the blocker relation is removed or replaced.`;
  }

  const unresolved = input.blockers.find((blocker) => blocker.isUnresolved);
  if (unresolved) {
    return `${blockerDiagnosticLabel(input.issue)} is blocked by ${blockerDiagnosticLabel(
      unresolved,
    )}, which is ${unresolved.status}.`;
  }

  if (input.readiness?.isDependencyReady && input.issue.status === "blocked") {
    return `All blockers for ${blockerDiagnosticLabel(
      input.issue,
    )} are resolved, but the issue is still blocked; this is likely a stale blocker hold.`;
  }
  if (input.readiness?.isDependencyReady) {
    return `All blockers for ${blockerDiagnosticLabel(input.issue)} are resolved.`;
  }

  return null;
}

const ISSUE_WAKE_DIAGNOSTIC_KNOWN_SOURCES = new Set([
  "timer",
  "assignment",
  "on_demand",
  "automation",
]);

const ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS = new Set([
  "issue_assigned",
  "issue_blockers_resolved",
  "issue_commented",
  "issue_comment_mentioned",
  "issue_dependencies_blocked",
  "issue_tree_hold_active",
  "missing_issue_comment",
  "process_lost_retry",
  "run_liveness_continuation",
  "heartbeat.disabled",
  "heartbeat.timer.no_actionable_work",
  "heartbeat.wakeOnDemand.disabled",
]);

const ISSUE_WAKE_DIAGNOSTIC_KNOWN_STATUSES = new Set([
  "queued",
  "claimed",
  "coalesced",
  "skipped",
  "completed",
  "failed",
  "cancelled",
  "deferred_issue_execution",
]);

function dateToIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function projectWakeDiagnosticSource(value: string | null) {
  if (!value) return null;
  return ISSUE_WAKE_DIAGNOSTIC_KNOWN_SOURCES.has(value) ? value : "other";
}

function projectWakeDiagnosticReason(value: string | null) {
  if (!value) return null;
  return ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS.has(value) ? value : "other";
}

function projectWakeDiagnosticStatus(value: string) {
  return ISSUE_WAKE_DIAGNOSTIC_KNOWN_STATUSES.has(value) ? value : "other";
}

function wakeFailureClass(
  status: string,
  rawError: string | null,
): IssueWakeDiagnosticWakeFailureClass | null {
  if (status === "failed" || rawError) return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "skipped") return "skipped";
  return null;
}

function projectIssueWakeRequest(row: {
  agentId: string;
  source: string;
  reason: string | null;
  status: string;
  coalescedCount: number;
  runId: string | null;
  requestedAt: Date | string;
  claimedAt: Date | string | null;
  finishedAt: Date | string | null;
  error: string | null;
}, options: { includeInternalIds: boolean }): IssueWakeDiagnosticWakeRequest {
  const status = projectWakeDiagnosticStatus(row.status);
  return {
    kind: "wake_request",
    agentId: options.includeInternalIds ? row.agentId : null,
    source: projectWakeDiagnosticSource(row.source) ?? "other",
    reason: projectWakeDiagnosticReason(row.reason),
    status,
    coalescedCount: row.coalescedCount,
    runId: options.includeInternalIds ? row.runId : null,
    requestedAt: dateToIso(row.requestedAt)!,
    claimedAt: dateToIso(row.claimedAt),
    finishedAt: dateToIso(row.finishedAt),
    failureClass: wakeFailureClass(status, row.error),
  };
}

function wakeDiagnosticActivityAction(action: string) {
  return action === "issue.tree_hold_wakeup_deferred" ? action : "other";
}

function wakeDiagnosticActivityEntityType(entityType: string) {
  return entityType === "issue" || entityType === "agent_wakeup_request" ? entityType : "other";
}

function projectIssueWakeActivityRecord(
  row: {
    action: string;
    entityType: string;
    entityId: string;
    agentId: string | null;
    runId: string | null;
    details: Record<string, unknown> | null;
    createdAt: Date | string;
  },
  issueId: string,
  options: { includeInternalIds: boolean },
): IssueWakeDiagnosticActivityRecord {
  const details = row.details && typeof row.details === "object" ? row.details : {};
  const action = wakeDiagnosticActivityAction(row.action);
  const rootIssueId = readNonEmptyString(details["rootIssueId"]);
  const detailIssueId = readNonEmptyString(details["issueId"]);
  const projectedRootIssueId =
    rootIssueId === issueId || detailIssueId === issueId || (row.entityType === "issue" && row.entityId === issueId)
      ? issueId
      : null;

  return {
    kind: "activity",
    action,
    entityType: wakeDiagnosticActivityEntityType(row.entityType),
    agentId: options.includeInternalIds ? row.agentId ?? readNonEmptyString(details["agentId"]) : null,
    runId: options.includeInternalIds ? row.runId : null,
    createdAt: dateToIso(row.createdAt)!,
    source: projectWakeDiagnosticSource(readNonEmptyString(details["source"])),
    requestedReason: projectWakeDiagnosticReason(readNonEmptyString(details["requestedReason"])),
    previousReason: projectWakeDiagnosticReason(readNonEmptyString(details["previousReason"])),
    rootIssueId: projectedRootIssueId,
    holdId: options.includeInternalIds ? readNonEmptyString(details["holdId"]) : null,
    summary: action === "issue.tree_hold_wakeup_deferred"
      ? "Wake was deferred because an active issue-tree hold was present."
      : "Wake-related activity was recorded.",
  };
}

function issueWakeDiagnosticEventTimestamp(event: IssueWakeDiagnosticEvent) {
  const timestamp = event.kind === "wake_request" ? event.requestedAt : event.createdAt;
  return new Date(timestamp).getTime();
}

function wakeDiagnosticReasonPhrase(reason: string | null) {
  return reason ? ` for ${reason}` : "";
}

function buildIssueWakeDiagnosis(input: {
  issue: IssueBlockerDiagnosticIssueSummary;
  events: IssueWakeDiagnosticEvent[];
  blockerDiagnostics: IssueBlockerDiagnosticsResponse;
  truncated: boolean;
  maxWakeRequests: number;
  maxActivityRecords: number;
  lookbackDays: number;
}) {
  if (input.truncated) {
    return `Wake diagnostics for ${blockerDiagnosticLabel(input.issue)} are truncated to ${
      input.maxWakeRequests
    } wake requests and ${input.maxActivityRecords} activity records over ${
      input.lookbackDays
    } days, so the diagnosis only covers returned records.`;
  }

  const latest = input.events[0];
  if (latest?.kind === "activity" && latest.action === "issue.tree_hold_wakeup_deferred") {
    return `The most recent wake-related activity for ${blockerDiagnosticLabel(
      input.issue,
    )} was deferred by an active issue-tree hold.`;
  }
  if (latest?.kind === "wake_request") {
    if (latest.status === "deferred_issue_execution") {
      return `The most recent wake for ${blockerDiagnosticLabel(input.issue)} is deferred${wakeDiagnosticReasonPhrase(
        latest.reason,
      )}.`;
    }
    if (latest.status === "failed") {
      return `The most recent wake for ${blockerDiagnosticLabel(input.issue)} failed${wakeDiagnosticReasonPhrase(
        latest.reason,
      )}; raw error text is withheld.`;
    }
    if (latest.status === "skipped" || latest.status === "cancelled" || latest.status === "coalesced") {
      const coalesced =
        latest.coalescedCount > 0 ? ` and coalesced ${latest.coalescedCount} additional request(s)` : "";
      return `The most recent wake for ${blockerDiagnosticLabel(input.issue)} was ${latest.status}${wakeDiagnosticReasonPhrase(
        latest.reason,
      )}${coalesced}.`;
    }
    if (latest.status === "queued" || latest.status === "claimed") {
      return `The most recent wake for ${blockerDiagnosticLabel(input.issue)} is currently ${latest.status}${wakeDiagnosticReasonPhrase(
        latest.reason,
      )}.`;
    }
    if (latest.status === "completed") {
      return `The most recent wake for ${blockerDiagnosticLabel(input.issue)} completed${wakeDiagnosticReasonPhrase(
        latest.reason,
      )}.`;
    }
  }

  if (input.events.length > 0) return null;

  const blockerDiagnostics = input.blockerDiagnostics;
  if (blockerDiagnostics.truncated) {
    return `No wake rows are visible for ${blockerDiagnosticLabel(
      input.issue,
    )} in the bounded window, and blocker diagnostics are truncated, so no wake cause is inferred.`;
  }
  if ((blockerDiagnostics.omittedUnauthorizedBlockerCount ?? 0) > 0) {
    return `No wake rows are visible for ${blockerDiagnosticLabel(
      input.issue,
    )} in the bounded window, and one or more blockers are outside this actor's authorization boundary.`;
  }
  if (input.issue.status !== "blocked" || blockerDiagnostics.blockers.length === 0) return null;

  const pendingFinalize = blockerDiagnostics.blockers.find((blocker) => blocker.isPendingFinalize);
  if (pendingFinalize) {
    return `No wake row exists for ${blockerDiagnosticLabel(input.issue)} in the bounded window. ${blockerDiagnosticLabel(
      input.issue,
    )} is waiting for ${blockerDiagnosticLabel(pendingFinalize)} to finish workspace finalization, so issue_blockers_resolved has not fired.`;
  }

  const cancelled = blockerDiagnostics.blockers.find((blocker) => blocker.status === "cancelled");
  if (cancelled) {
    return `No wake row exists for ${blockerDiagnosticLabel(input.issue)} in the bounded window. ${blockerDiagnosticLabel(
      input.issue,
    )} is blocked by ${blockerDiagnosticLabel(cancelled)}, which is cancelled; cancelled blockers do not fire issue_blockers_resolved.`;
  }

  const unresolved = blockerDiagnostics.blockers.find((blocker) => blocker.isUnresolved);
  if (unresolved) {
    return `No wake row exists for ${blockerDiagnosticLabel(input.issue)} in the bounded window. ${blockerDiagnosticLabel(
      input.issue,
    )} is blocked by ${blockerDiagnosticLabel(unresolved)}, which is ${unresolved.status}, so issue_blockers_resolved has not fired.`;
  }

  if (blockerDiagnostics.readiness?.isDependencyReady) {
    return `No wake row exists for ${blockerDiagnosticLabel(
      input.issue,
    )} in the bounded window. All visible blockers are resolved, but the issue is still blocked; this is likely a stale blocker hold or an older wake outside the lookback window.`;
  }

  return null;
}

function buildIssueWakeDiagnosticsResponse(input: {
  issue: IssueBlockerDiagnosticReadableIssue;
  wakeRequests: Array<{
    agentId: string;
    source: string;
    reason: string | null;
    status: string;
    coalescedCount: number;
    runId: string | null;
    requestedAt: Date | string;
    claimedAt: Date | string | null;
    finishedAt: Date | string | null;
    error: string | null;
  }>;
  activityRecords: Array<{
    action: string;
    entityType: string;
    entityId: string;
    agentId: string | null;
    runId: string | null;
    details: Record<string, unknown> | null;
    createdAt: Date | string;
  }>;
  blockerDiagnostics: IssueBlockerDiagnosticsResponse;
  truncatedWakeRequests: boolean;
  truncatedActivityRecords: boolean;
  includeInternalIds: boolean;
  maxWakeRequests?: number;
  maxActivityRecords?: number;
  lookbackDays?: number;
}): IssueWakeDiagnosticsResponse {
  const issue = toIssueBlockerDiagnosticSummary(input.issue);
  const events: IssueWakeDiagnosticEvent[] = [
    ...input.wakeRequests.map((record) =>
      projectIssueWakeRequest(record, { includeInternalIds: input.includeInternalIds }),
    ),
    ...input.activityRecords.map((record) =>
      projectIssueWakeActivityRecord(record, issue.id, { includeInternalIds: input.includeInternalIds }),
    ),
  ].sort((left, right) => issueWakeDiagnosticEventTimestamp(right) - issueWakeDiagnosticEventTimestamp(left));
  const truncated = input.truncatedWakeRequests || input.truncatedActivityRecords;
  const maxWakeRequests = input.maxWakeRequests ?? ISSUE_WAKE_DIAGNOSTICS_MAX_WAKE_REQUESTS;
  const maxActivityRecords = input.maxActivityRecords ?? ISSUE_WAKE_DIAGNOSTICS_MAX_ACTIVITY_RECORDS;
  const lookbackDays = input.lookbackDays ?? ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS;
  const diagnosis = buildIssueWakeDiagnosis({
    issue,
    events,
    blockerDiagnostics: input.blockerDiagnostics,
    truncated,
    maxWakeRequests,
    maxActivityRecords,
    lookbackDays,
  });

  return {
    issue,
    diagnosis,
    likelyReason: diagnosis,
    events,
    wakeRequestCount: input.wakeRequests.length,
    activityRecordCount: input.activityRecords.length,
    truncated,
    truncatedSections: {
      wakeRequests: input.truncatedWakeRequests,
      activityRecords: input.truncatedActivityRecords,
    },
    caps: {
      maxWakeRequests,
      maxActivityRecords,
      lookbackDays,
    },
  };
}

type IssueSubtreeDiagnosticAuthzNode = IssueBlockerDiagnosticAuthzIssue & {
  depth: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type IssueSubtreeDiagnosticBlockerAuthzRow = IssueBlockerDiagnosticAuthzIssue & {
  blockedIssueId: string;
  relationCreatedAt: Date | string;
};

type IssueSubtreeDiagnosticWakeRequestRow = {
  issueId: string;
  agentId: string;
  source: string;
  reason: string | null;
  status: string;
  coalescedCount: number;
  runId: string | null;
  requestedAt: Date | string;
  claimedAt: Date | string | null;
  finishedAt: Date | string | null;
  error: string | null;
};

type IssueSubtreeDiagnosticActivityRow = {
  issueId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date | string;
};

function groupByIssueId<T extends { issueId: string }>(rows: T[]) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const issueRows = map.get(row.issueId) ?? [];
    issueRows.push(row);
    map.set(row.issueId, issueRows);
  }
  return map;
}

function groupBlockersByBlockedIssueId(rows: IssueSubtreeDiagnosticBlockerAuthzRow[]) {
  const map = new Map<string, IssueSubtreeDiagnosticBlockerAuthzRow[]>();
  for (const row of rows) {
    const issueRows = map.get(row.blockedIssueId) ?? [];
    issueRows.push(row);
    map.set(row.blockedIssueId, issueRows);
  }
  return map;
}

function issueSubtreeEdgeTimestamp(edge: IssueSubtreeDiagnosticEdge) {
  return edge.timestamp ? new Date(edge.timestamp).getTime() : 0;
}

function buildIssueSubtreeDiagnosis(input: {
  issue: IssueBlockerDiagnosticIssueSummary;
  nodes: IssueSubtreeDiagnosticNode[];
  omittedUnauthorizedNodeCount: number | null;
  truncated: boolean;
  caps: IssueSubtreeDiagnosticsResponse["caps"];
}) {
  if (input.truncated) {
    return `Subtree diagnostics for ${blockerDiagnosticLabel(input.issue)} are bounded to depth ${
      input.caps.maxDepth
    } and ${input.caps.maxNodes} nodes, so the diagnosis only covers returned visible nodes.`;
  }
  if ((input.omittedUnauthorizedNodeCount ?? 0) > 0) {
    return `One or more subtree nodes under ${blockerDiagnosticLabel(
      input.issue,
    )} are outside this actor's authorization boundary, so this diagnosis only covers visible nodes.`;
  }

  const blockedNodeWithDiagnosis = input.nodes.find((node) => node.issue.status === "blocked" && node.diagnosis);
  const firstNodeWithDiagnosis = blockedNodeWithDiagnosis ?? input.nodes.find((node) => node.diagnosis);
  if (!firstNodeWithDiagnosis?.diagnosis) return null;

  return `${blockerDiagnosticLabel(firstNodeWithDiagnosis.issue)} appears to be the subtree stall point: ${
    firstNodeWithDiagnosis.diagnosis
  }`;
}

function buildIssueSubtreeDiagnosticsResponse(input: {
  issue: IssueBlockerDiagnosticReadableIssue;
  nodes: IssueSubtreeDiagnosticAuthzNode[];
  visibleNodes: IssueSubtreeDiagnosticAuthzNode[];
  blockersByIssueId: Map<string, IssueSubtreeDiagnosticBlockerAuthzRow[]>;
  visibleBlockers: IssueSubtreeDiagnosticBlockerAuthzRow[];
  readinessByIssueId: Map<string, {
    allBlockersDone: boolean;
    isDependencyReady: boolean;
    unresolvedBlockerIssueIds: string[];
    pendingFinalizeBlockerIssueIds: string[];
  }>;
  wakeRequestsByIssueId: Map<string, IssueSubtreeDiagnosticWakeRequestRow[]>;
  activityRecordsByIssueId: Map<string, IssueSubtreeDiagnosticActivityRow[]>;
  truncatedNodes: boolean;
  truncatedDepth: boolean;
  truncatedBlockerIssueIds: Set<string>;
  truncatedWakeIssueIds: Set<string>;
  truncatedActivityIssueIds: Set<string>;
  includeInternalIds: boolean;
  caps: IssueSubtreeDiagnosticsResponse["caps"];
}): IssueSubtreeDiagnosticsResponse {
  const issue = toIssueBlockerDiagnosticSummary(input.issue);
  const visibleNodeIds = new Set(input.visibleNodes.map((node) => node.id));
  const visibleBlockerIdsByIssueId = groupBlockersByBlockedIssueId(input.visibleBlockers);
  const omittedUnauthorizedNodeCount = input.truncatedNodes || input.truncatedDepth
    ? null
    : input.nodes.filter((node) => !visibleNodeIds.has(node.id)).length;
  const nodeResponses: IssueSubtreeDiagnosticNode[] = [];
  const edges: IssueSubtreeDiagnosticEdge[] = [];

  for (const node of input.visibleNodes) {
    const rawBlockers = input.blockersByIssueId.get(node.id) ?? [];
    const visibleBlockers = visibleBlockerIdsByIssueId.get(node.id) ?? [];
    const blockerResponse = buildIssueBlockerDiagnosticsResponse({
      issue: node,
      blockers: rawBlockers,
      visibleBlockers,
      readiness: input.readinessByIssueId.get(node.id) ?? {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerIssueIds: [],
        pendingFinalizeBlockerIssueIds: [],
      },
      truncated: input.truncatedBlockerIssueIds.has(node.id),
      maxBlockers: input.caps.maxBlockersPerNode,
    });
    const wakeResponse = buildIssueWakeDiagnosticsResponse({
      issue: node,
      wakeRequests: input.wakeRequestsByIssueId.get(node.id) ?? [],
      activityRecords: input.activityRecordsByIssueId.get(node.id) ?? [],
      blockerDiagnostics: blockerResponse,
      truncatedWakeRequests: input.truncatedWakeIssueIds.has(node.id),
      truncatedActivityRecords: input.truncatedActivityIssueIds.has(node.id),
      includeInternalIds: input.includeInternalIds,
      maxWakeRequests: input.caps.maxWakeRequestsPerNode,
      maxActivityRecords: input.caps.maxActivityRecordsPerNode,
      lookbackDays: input.caps.lookbackDays,
    });
    const nodeDiagnosis = wakeResponse.diagnosis ?? blockerResponse.diagnosis;

    if (node.parentId && visibleNodeIds.has(node.parentId)) {
      edges.push({
        kind: "parent",
        fromIssueId: node.parentId,
        toIssueId: node.id,
        timestamp: dateToIso(node.createdAt),
      });
    }
    for (const blocker of visibleBlockers) {
      edges.push({
        kind: "blocks",
        fromIssueId: blocker.id,
        toIssueId: node.id,
        timestamp: dateToIso(blocker.relationCreatedAt),
      });
    }
    for (const event of wakeResponse.events) {
      if (event.kind === "wake_request") {
        edges.push({
          kind: "wake_request",
          issueId: node.id,
          agentId: event.agentId,
          reason: event.reason,
          status: event.status,
          timestamp: event.requestedAt,
        });
      } else {
        edges.push({
          kind: "activity",
          issueId: node.id,
          action: event.action,
          timestamp: event.createdAt,
        });
      }
    }

    nodeResponses.push({
      issue: toIssueBlockerDiagnosticSummary(node),
      parentId: node.parentId && visibleNodeIds.has(node.parentId) ? node.parentId : null,
      depth: node.depth,
      diagnosis: nodeDiagnosis,
      likelyReason: nodeDiagnosis,
      blockers: blockerResponse.blockers,
      blockerReadiness: blockerResponse.readiness,
      omittedUnauthorizedBlockerCount: blockerResponse.omittedUnauthorizedBlockerCount,
      wakeEvents: wakeResponse.events,
      wakeRequestCount: wakeResponse.wakeRequestCount,
      activityRecordCount: wakeResponse.activityRecordCount,
      truncated: blockerResponse.truncated || wakeResponse.truncated,
      truncatedSections: {
        blockers: blockerResponse.truncated,
        wakeRequests: wakeResponse.truncatedSections.wakeRequests,
        activityRecords: wakeResponse.truncatedSections.activityRecords,
      },
    });
  }

  edges.sort((left, right) => issueSubtreeEdgeTimestamp(right) - issueSubtreeEdgeTimestamp(left));
  const truncatedSections = {
    nodes: input.truncatedNodes,
    depth: input.truncatedDepth,
    blockers: input.truncatedBlockerIssueIds.size > 0,
    wakeRequests: input.truncatedWakeIssueIds.size > 0,
    activityRecords: input.truncatedActivityIssueIds.size > 0,
  };
  const truncated = Object.values(truncatedSections).some(Boolean);
  const diagnosis = buildIssueSubtreeDiagnosis({
    issue,
    nodes: nodeResponses,
    omittedUnauthorizedNodeCount,
    truncated,
    caps: input.caps,
  });

  return {
    issue,
    diagnosis,
    likelyReason: diagnosis,
    nodes: nodeResponses,
    edges,
    nodeCount: nodeResponses.length,
    omittedUnauthorizedNodeCount,
    truncated,
    truncatedSections,
    caps: input.caps,
  };
}

const ACTIVE_REVIEW_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);

const INVALID_AGENT_IN_REVIEW_DISPOSITION_MESSAGE =
  "invalid_issue_disposition: Agent-authored updates that move an issue to in_review must include a real review path. " +
  "This request would leave the issue in_review without anyone or anything owning the next action. " +
  "Keep working instead of moving to review, create a request_confirmation or ask_user_questions interaction, " +
  "link or request a pending approval, assign a human reviewer with assigneeUserId, set a typed executionState.currentParticipant through an execution policy, " +
  "or schedule an issue monitor for an external review/check. After creating one of those review paths, retry the status update.";

function executionPrincipalsEqual(
  left: ParsedExecutionState["currentParticipant"] | null,
  right: ParsedExecutionState["currentParticipant"] | null,
) {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === "agent" ? left.agentId === right.agentId : left.userId === right.userId;
}

function actorMatchesExecutionParticipant(
  actor: { actorType: "user" | "agent"; actorId: string },
  participant: ParsedExecutionState["currentParticipant"] | null,
) {
  if (!participant) return false;
  // Require the actor kind to match the participant kind before comparing ids. Without this
  // an agent and a user that happen to share an id value would falsely satisfy participant
  // gating on the auto-approval path.
  if (participant.type !== actor.actorType) return false;
  return participant.type === "agent" ? participant.agentId === actor.actorId : participant.userId === actor.actorId;
}

// Negation/rejection markers that invalidate an otherwise approval-looking heading.
// Match common phrasings ("NOT APPROVED", "Do not approve", "Not approving", "Changes requested",
// "Rejected", "Denied", "Blocked") so a reviewer comment intending to reject cannot auto-complete
// the issue. We rely on the heading being a single line, so testing the heading text alone is safe.
const APPROVAL_NEGATION_REGEX =
  /\b(?:NOT|REJECT(?:ED|ING|S)?|DENY|DENIED|DENYING|BLOCK(?:ED|ING|S)?|CHANGES?\s+REQUESTED)\b/i;

function isApprovalReviewComment(body: string) {
  const normalized = body.replace(/\r\n?/g, "\n");
  const headingMatch = normalized.match(/(?:^|\n)##\s*Review:\s*([^\n]*)/i);
  if (headingMatch) {
    const headingText = headingMatch[1];
    if (/\bAPPROVED\b/i.test(headingText) && !APPROVAL_NEGATION_REGEX.test(headingText)) {
      return true;
    }
  }
  // Require the `kind: review` and `decision: approved` lines to appear on truly consecutive
  // lines (no blank-line separation) so prose like "the previous sprint decision: approved"
  // can't combine with an unrelated `kind: review` line elsewhere in the body to trigger
  // auto-approval. Use `[ \t]*` between the lines so `\s*` does not silently swallow a newline.
  return (
    /^[ \t]*kind[ \t]*:[ \t]*review[ \t]*\n[ \t]*decision[ \t]*:[ \t]*approved[ \t]*$/im.test(normalized)
    || /^[ \t]*decision[ \t]*:[ \t]*approved[ \t]*\n[ \t]*kind[ \t]*:[ \t]*review[ \t]*$/im.test(normalized)
  );
}

function buildExecutionStageWakeContext(input: {
  state: ParsedExecutionState;
  wakeRole: ExecutionStageWakeContext["wakeRole"];
  allowedActions: string[];
}): ExecutionStageWakeContext {
  return {
    wakeRole: input.wakeRole,
    stageId: input.state.currentStageId,
    stageType: input.state.currentStageType,
    currentParticipant: input.state.currentParticipant,
    returnAssignee: input.state.returnAssignee,
    reviewRequest: input.state.reviewRequest ?? null,
    lastDecisionOutcome: input.state.lastDecisionOutcome,
    allowedActions: input.allowedActions,
  };
}

function summarizeIssueRelationForActivity(relation: {
  id: string;
  identifier: string | null;
  title: string;
}): ActivityIssueRelationSummary {
  return {
    id: relation.id,
    identifier: relation.identifier,
    title: relation.title,
  };
}

const defaultCompanySearchRateLimiter = createCompanySearchRateLimiter();

function companySearchRateLimitActor(req: Request, companyId: string) {
  if (req.actor.type === "agent") {
    return {
      companyId,
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? req.actor.keyId ?? "unknown-agent",
    };
  }
  return {
    companyId,
    actorType: "board" as const,
    actorId: req.actor.userId ?? req.actor.source ?? "board",
  };
}

function summarizeIssueReferenceActivityDetails(input:
  | {
      addedReferencedIssues: ActivityIssueRelationSummary[];
      removedReferencedIssues: ActivityIssueRelationSummary[];
      currentReferencedIssues: ActivityIssueRelationSummary[];
    }
  | null
  | undefined,
) {
  if (!input) return {};
  return {
    ...(input.addedReferencedIssues.length > 0 ? { addedReferencedIssues: input.addedReferencedIssues } : {}),
    ...(input.removedReferencedIssues.length > 0 ? { removedReferencedIssues: input.removedReferencedIssues } : {}),
    ...(input.currentReferencedIssues.length > 0 ? { currentReferencedIssues: input.currentReferencedIssues } : {}),
  };
}

function monitorPoliciesEqual(left: NormalizedExecutionPolicy | null, right: NormalizedExecutionPolicy | null) {
  return JSON.stringify(left?.monitor ?? null) === JSON.stringify(right?.monitor ?? null);
}

function applyActorMonitorScheduledBy(
  policy: NormalizedExecutionPolicy | null,
  actorType: "agent" | "user",
) {
  return setIssueExecutionPolicyMonitorScheduledBy(policy, actorType === "user" ? "board" : "assignee");
}

async function assertCanManageIssueMonitor(
  accessSvc: ReturnType<typeof accessService>,
  req: Request,
  companyId: string,
  assigneeAgentId: string | null,
  monitorChanged: boolean,
) {
  if (!monitorChanged) return;
  if (req.actor.type === "board") return;
  const runtimeDecision = await accessSvc.decide({
    actor: req.actor,
    action: "runtime:manage",
    resource: { type: "company", companyId },
  });
  if (!runtimeDecision.allowed) {
    throw forbidden(runtimeDecision.explanation, authorizationDeniedDetails(runtimeDecision));
  }
  if (req.actor.type === "agent" && req.actor.agentId && req.actor.agentId === assigneeAgentId) return;
  throw forbidden("Only the assignee agent or a board user can manage issue monitors");
}

function summarizeIssueMonitor(
  issue: {
    monitorNextCheckAt?: Date | null;
    monitorLastTriggeredAt?: Date | null;
    monitorAttemptCount?: number | null;
    monitorNotes?: string | null;
    monitorScheduledBy?: string | null;
    executionState?: unknown;
  },
  policy: NormalizedExecutionPolicy | null,
) {
  const state = parseIssueExecutionState(issue.executionState);
  return {
    nextCheckAt: issue.monitorNextCheckAt?.toISOString() ?? policy?.monitor?.nextCheckAt ?? null,
    lastTriggeredAt: issue.monitorLastTriggeredAt?.toISOString() ?? state?.monitor?.lastTriggeredAt ?? null,
    attemptCount: issue.monitorAttemptCount ?? state?.monitor?.attemptCount ?? 0,
    notes: policy?.monitor?.notes ?? issue.monitorNotes ?? state?.monitor?.notes ?? null,
    scheduledBy: issue.monitorScheduledBy ?? policy?.monitor?.scheduledBy ?? state?.monitor?.scheduledBy ?? null,
    kind: policy?.monitor?.kind ?? state?.monitor?.kind ?? null,
    serviceName: policy?.monitor?.serviceName ?? state?.monitor?.serviceName ?? null,
    externalRef: redactIssueMonitorExternalRef(policy?.monitor?.externalRef ?? state?.monitor?.externalRef ?? null),
    timeoutAt: policy?.monitor?.timeoutAt ?? state?.monitor?.timeoutAt ?? null,
    maxAttempts: policy?.monitor?.maxAttempts ?? state?.monitor?.maxAttempts ?? null,
    recoveryPolicy: policy?.monitor?.recoveryPolicy ?? state?.monitor?.recoveryPolicy ?? null,
    status: state?.monitor?.status ?? (policy?.monitor ? "scheduled" : null),
    clearReason: state?.monitor?.clearReason ?? null,
  };
}

function activityExecutionParticipantKey(participant: ActivityExecutionParticipant): string {
  return participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
}

function summarizeExecutionParticipants(
  policy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
): ActivityExecutionParticipant[] {
  const stage = policy?.stages.find((candidate) => candidate.type === stageType);
  return (
    stage?.participants.map((participant) => ({
      type: participant.type,
      agentId: participant.agentId ?? null,
      userId: participant.userId ?? null,
    })) ?? []
  );
}

function isClosedIssueStatus(status: string | null | undefined): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

function shouldImplicitlyMoveCommentedIssueToTodo(input: {
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
  actorRunId: string | null | undefined;
  checkoutRunId: string | null | undefined;
  executionRunId: string | null | undefined;
  requestAddsExplicitBlockers?: boolean;
}) {
  // A request that wires a non-empty blockedByIssueIds list is declaring that
  // the issue is waiting on other work. The implicit reopen exists for plain
  // conversational comments ("please continue"), not structured dependency
  // edits — flipping to todo here would contradict the caller's stated intent
  // in the same request.
  if (input.requestAddsExplicitBlockers) return false;
  // Local-CLI agents post comments under user auth, so the actor.type is "user"
  // even though the comment originates from the same heartbeat run that owns
  // the issue lock. Without this guard, an agent that closes its own issue and
  // then posts a follow-up comment in the same run silently reopens it.
  // Suppress the implicit move whenever the comment's source run matches the
  // issue's checkout/execution run.
  if (
    typeof input.actorRunId === "string"
    && input.actorRunId.length > 0
    && (input.actorRunId === input.checkoutRunId || input.actorRunId === input.executionRunId)
  ) {
    return false;
  }
  // Only human comments should implicitly reopen finished work.
  // Agent-authored comments remain communicative unless reopen was explicit.
  if (input.actorType !== "user") return false;
  if (!isClosedIssueStatus(input.issueStatus) && input.issueStatus !== "blocked") return false;
  if (typeof input.assigneeAgentId !== "string" || input.assigneeAgentId.length === 0) return false;
  return true;
}

function shouldHumanCommentResumeInProgressScheduledRetry(input: {
  hasComment: boolean;
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
}) {
  if (!input.hasComment) return false;
  if (input.actorType !== "user") return false;
  if (input.issueStatus !== "in_progress") return false;
  return typeof input.assigneeAgentId === "string" && input.assigneeAgentId.length > 0;
}

function isExplicitResumeCapableStatus(status: string | null | undefined) {
  return status === "done" || status === "cancelled" || status === "blocked" || status === "todo" || status === "in_progress";
}

// Log-class comment from the assignee agent on a terminal (done/cancelled)
// issue is not a reopen signal. When the caller did not pass `resume: true`,
// this forces the reopen path off even if `reopen: true` was sent.
function isAssigneeSelfCommentOnTerminalIssue(input: {
  hasCommentBody: boolean;
  resumeRequested: boolean;
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
}) {
  if (!input.hasCommentBody) return false;
  if (input.resumeRequested) return false;
  if (!isClosedIssueStatus(input.issueStatus)) return false;
  if (typeof input.assigneeAgentId !== "string" || input.assigneeAgentId.length === 0) return false;
  if (input.actorType !== "agent") return false;
  return input.actorId === input.assigneeAgentId;
}

function readToolActionExecutionStatus(value: unknown) {
  return value === "approved"
    || value === "executing"
    || value === "executed"
    || value === "failed"
    || value === "expired"
    ? value
    : null;
}

function secretProposalExecutionErrorCode(error: unknown) {
  if (error instanceof HttpError) {
    const details = readObject(error.details);
    return readNonEmptyString(details.code) ?? `http_${error.status}`;
  }
  return "secret_proposal_execution_failed";
}

function readToolActionContinuationContext(interaction: {
  status: string;
  payload?: unknown;
  result?: unknown;
}) {
  const payload = readObject(interaction.payload);
  const toolActionPayload = readObject(payload.toolAction);
  const toolName = readNonEmptyString(toolActionPayload.toolName);
  const actionRequestId = readNonEmptyString(toolActionPayload.actionRequestId);
  if (!toolName || !actionRequestId) return null;

  const result = readObject(interaction.result);
  const toolActionResult = readObject(result.toolAction);
  const declineReason = interaction.status === "rejected"
    ? readNonEmptyString(result.reason)
    : null;
  const error = readNonEmptyString(toolActionResult.errorMessage);
  const resultSummary = readNonEmptyString(toolActionResult.resultSummary);

  if (interaction.status === "rejected") {
    return {
      toolName,
      actionRequestId,
      decision: "rejected",
      executionStatus: "rejected",
      ...(declineReason ? { declineReason } : {}),
      instructions: `the action was declined${declineReason ? `: ${declineReason}` : ""}; do not retry the same call — adjust your approach or mark the task blocked/in_review with the decline reason.`,
    };
  }

  if (interaction.status !== "accepted") return null;
  const executionStatus = readToolActionExecutionStatus(toolActionResult.status);
  if (!executionStatus) return null;

  if (executionStatus === "executed") {
    return {
      toolName,
      actionRequestId,
      decision: "accepted",
      executionStatus,
      ...(resultSummary ? { resultSummary } : {}),
      instructions: `the approved ${toolName} action already ran — do not call the tool again; continue with this result.`,
    };
  }

  if (executionStatus === "failed") {
    const failureMessage = error ?? "an unknown error";
    return {
      toolName,
      actionRequestId,
      decision: "accepted",
      executionStatus,
      ...(error ? { error } : {}),
      instructions: `the approved action ran and failed with ${failureMessage}; adjust your approach — a fresh call will open a new approval.`,
    };
  }

  if (executionStatus === "expired") {
    const expirationMessage = error ? `: ${error}` : "";
    return {
      toolName,
      actionRequestId,
      decision: "accepted",
      executionStatus,
      ...(error ? { error } : {}),
      instructions: `the approved ${toolName} action expired before execution${expirationMessage}; if the task still requires it, call the tool again to request a fresh approval.`,
    };
  }

  return {
    toolName,
    actionRequestId,
    decision: "accepted",
    executionStatus,
    instructions: `the approved ${toolName} action is ${executionStatus}; do not call the tool again while this approval is being processed.`,
  };
}

function readSecretProposalContinuationContext(interaction: {
  status: string;
  payload?: unknown;
  result?: unknown;
}) {
  const payload = readObject(interaction.payload);
  const proposal = readObject(payload.secretProposal);
  const proposalId = readNonEmptyString(proposal.proposalId);
  const configPath = readNonEmptyString(proposal.configPath);
  if (!proposalId || !configPath) return null;
  const result = readObject(interaction.result);
  const execution = readObject(result.secretProposal);
  const executionStatus = readNonEmptyString(execution.status);
  const errorCode = readNonEmptyString(execution.errorCode);
  const sourceSecretLabel = readNonEmptyString(proposal.sourceSecretLabel);

  if (interaction.status === "rejected") {
    return {
      proposalId,
      configPath,
      decision: "rejected",
      executionStatus: "rejected",
      instructions: "the secret binding proposal was rejected; do not assume the alias exists.",
    };
  }
  if (interaction.status !== "accepted" || (executionStatus !== "executed" && executionStatus !== "failed")) {
    return null;
  }
  if (executionStatus === "executed") {
    return {
      proposalId,
      configPath,
      decision: "accepted",
      executionStatus,
      ...(sourceSecretLabel ? { sourceSecretLabel } : {}),
      instructions: `the binding was created at ${configPath}; verify it with GET /api/agents/me/secrets before using it.`,
    };
  }
  return {
    proposalId,
    configPath,
    decision: "accepted",
    executionStatus,
    ...(errorCode ? { errorCode } : {}),
    instructions: "the binding was not created; inspect the failure comment and submit a fresh proposal after fixing the cause.",
  };
}

const REQUEST_ITEM_VERDICTS_WAKE_COALESCE_WINDOW_MS = 2_000;

function buildRequestItemVerdictsWakeIdempotencyKey(args: {
  issueId: string;
  interactionId: string;
  at?: Date;
}) {
  const now = args.at ?? new Date();
  const bucket = Math.floor(now.getTime() / REQUEST_ITEM_VERDICTS_WAKE_COALESCE_WINDOW_MS);
  return `request_item_verdicts:${args.issueId}:${args.interactionId}:${bucket}`;
}

async function queueResolvedInteractionContinuationWakeup(input: {
  db: Db;
  heartbeat: ReturnType<typeof heartbeatService>;
  issue: { id: string; companyId: string; assigneeAgentId: string | null; status: string };
  interaction: {
    id: string;
    kind: string;
    status: string;
    continuationPolicy: string;
    sourceCommentId?: string | null;
    sourceRunId?: string | null;
    payload?: unknown;
    result?: unknown;
  };
  actor: { actorType: "user" | "agent"; actorId: string };
  source: string;
  forceFreshSession?: boolean;
  workspaceRefreshReason?: string | null;
  newlyResolvedItemIds?: string[];
  idempotencyKey?: string | null;
}) {
  if (!input.issue.assigneeAgentId || isClosedIssueStatus(input.issue.status)) return;

  const reviewPathLost = input.issue.status === "in_review"
    && (await issueService(input.db)
      .listReviewAttention(input.issue.companyId, [input.issue])
      .then((attention) => attention.get(input.issue.id)?.state === "stalled")
      .catch((err) => {
        logger.warn(
          { err, issueId: input.issue.id, interactionId: input.interaction.id },
          "failed to classify review path after issue interaction resolution",
        );
        return false;
      }));
  const continuationPolicyAllowsWake =
    input.interaction.continuationPolicy === "wake_assignee"
    || (
      input.interaction.continuationPolicy === "wake_assignee_on_accept"
      // Question interactions resolve as `answered`, not `accepted`. An
      // authoritative answer is the positive resolution that this policy is
      // waiting for, just as acceptance is for confirmation interactions.
      && (input.interaction.status === "accepted" || input.interaction.status === "answered")
    );
  const rejectedPlanNeedsRevision =
    input.interaction.status === "rejected"
    && input.interaction.kind === "request_confirmation"
    && readPlanConfirmationTargetForIssue(input.interaction.payload, input.issue.id) !== null;
  // A plan confirmation presents rejection as "Request changes". That action
  // is incomplete unless the plan author receives the requested revisions,
  // even when an adapter/model selected the accept-only continuation policy.
  // Keep this as a resolution-time invariant so existing pending interactions
  // and future providers receive the same behavior.
  if (!continuationPolicyAllowsWake && !rejectedPlanNeedsRevision && !reviewPathLost) return;
  if (input.interaction.status === "expired" && !reviewPathLost) return;
  // A normal interaction continuation is itself the durable recovery path.
  // Do not contaminate that wake with the fallback "review path lost"
  // instruction merely because the just-consumed interaction now appears
  // stalled before its continuation has had a chance to run.
  const reviewPathContext = reviewPathLost
    && !continuationPolicyAllowsWake
    && !rejectedPlanNeedsRevision
    ? {
        reviewPathLost: true,
        reviewPathConsumedRef: input.interaction.id,
        reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
      }
    : null;

  const forceFreshSession = input.forceFreshSession === true;
  const workspaceRefreshReason = readNonEmptyString(input.workspaceRefreshReason);
  const planTarget = readPlanConfirmationTargetForIssue(input.interaction.payload, input.issue.id);
  const interactionResult = readConfirmationResultForWake(input.interaction.result);
  const nativeCompletionReview = readNativeCompletionReviewForWake({
    payload: input.interaction.payload,
    result: input.interaction.result,
    status: input.interaction.status,
  });
  const checkboxSelection = readCheckboxSelectionForWake(input.interaction);
  const toolAction = readToolActionContinuationContext(input.interaction);
  const secretProposal = readSecretProposalContinuationContext(input.interaction);
  const newlyResolvedItemIds = input.newlyResolvedItemIds?.filter((value) => value.length > 0) ?? [];
  const itemVerdicts = newlyResolvedItemIds.length > 0
    ? {
        newlyResolvedItemIds,
        coalesceWindowMs: REQUEST_ITEM_VERDICTS_WAKE_COALESCE_WINDOW_MS,
      }
    : null;
  const planReviewInteraction =
    planTarget && input.interaction.kind === "request_confirmation"
      ? {
          id: input.interaction.id,
          kind: input.interaction.kind,
          status: input.interaction.status,
          target: planTarget,
          acceptedTargetRevision: input.interaction.status === "accepted" ? planTarget : null,
          result: interactionResult,
        }
      : null;
  void input.heartbeat.wakeup(input.issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: {
      issueId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      ...(planReviewInteraction ? { planReviewInteraction } : {}),
      ...(nativeCompletionReview ? { nativeCompletionReview } : {}),
      ...(checkboxSelection ? { checkboxSelection } : {}),
      ...(toolAction ? { toolAction } : {}),
      ...(secretProposal ? { secretProposal } : {}),
      ...(itemVerdicts ? { itemVerdicts, newlyResolvedItemIds } : {}),
      ...(reviewPathContext ?? {}),
      mutation: "interaction",
    },
    idempotencyKey: input.idempotencyKey ?? `interaction:${input.interaction.id}:${input.interaction.status}`,
    requestedByActorType: input.actor.actorType,
    requestedByActorId: input.actor.actorId,
    contextSnapshot: {
      issueId: input.issue.id,
      taskId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      ...(planReviewInteraction ? { planReviewInteraction } : {}),
      ...(nativeCompletionReview ? { nativeCompletionReview } : {}),
      ...(checkboxSelection ? { checkboxSelection } : {}),
      ...(toolAction ? { toolAction } : {}),
      ...(secretProposal ? { secretProposal } : {}),
      ...(itemVerdicts ? { itemVerdicts, newlyResolvedItemIds } : {}),
      ...(reviewPathContext ?? {}),
      wakeReason: "issue_commented",
      source: input.source,
      ...(forceFreshSession ? { forceFreshSession: true } : {}),
      ...(workspaceRefreshReason ? { workspaceRefreshReason } : {}),
    },
  }).catch((err) => logger.warn({
    err,
    issueId: input.issue.id,
    interactionId: input.interaction.id,
    agentId: input.issue.assigneeAgentId,
  }, "failed to wake assignee on issue interaction resolution"));
}

function readCheckboxSelectionForWake(input: {
  kind: string;
  payload?: unknown;
  result?: unknown;
}) {
  if (input.kind !== "request_checkbox_confirmation") return null;
  const result = readObject(input.result);
  if (result.outcome !== "accepted") return null;
  const selectedOptionIds = Array.isArray(result.selectedOptionIds)
    ? result.selectedOptionIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const payload = readObject(input.payload);
  const options = Array.isArray(payload.options)
    ? payload.options
        .map((value) => {
          const option = readObject(value);
          const id = readNonEmptyString(option.id);
          if (!id) return null;
          return {
            id,
            label: readNonEmptyString(option.label) ?? id,
            description: readNonEmptyString(option.description),
          };
        })
        .filter((value): value is { id: string; label: string; description: string | null } => Boolean(value))
    : [];
  const optionById = new Map(options.map((option) => [option.id, option]));

  return {
    prompt: readNonEmptyString(payload.prompt),
    selectedOptionIds,
    selectedOptions: selectedOptionIds.map((id) => optionById.get(id) ?? { id, label: id, description: null }),
  };
}

function diffExecutionParticipants(
  previousPolicy: NormalizedExecutionPolicy | null,
  nextPolicy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
) {
  const previousParticipants = summarizeExecutionParticipants(previousPolicy, stageType);
  const nextParticipants = summarizeExecutionParticipants(nextPolicy, stageType);
  const previousByKey = new Map(previousParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));
  const nextByKey = new Map(nextParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));

  return {
    participants: nextParticipants,
    addedParticipants: nextParticipants.filter((participant) => !previousByKey.has(activityExecutionParticipantKey(participant))),
    removedParticipants: previousParticipants.filter((participant) => !nextByKey.has(activityExecutionParticipantKey(participant))),
  };
}

function buildExecutionStageWakeup(input: {
  issueId: string;
  previousState: ParsedExecutionState | null;
  nextState: ParsedExecutionState | null;
  interruptedRunId: string | null;
  requestedByActorType: "user" | "agent";
  requestedByActorId: string;
}) {
  const { issueId, previousState, nextState, interruptedRunId } = input;
  if (!nextState) return null;

  if (nextState.status === "pending") {
    const agentId =
      nextState.currentParticipant?.type === "agent" ? (nextState.currentParticipant.agentId ?? null) : null;
    const stageChanged =
      previousState?.status !== "pending" ||
      previousState?.currentStageId !== nextState.currentStageId ||
      !executionPrincipalsEqual(previousState?.currentParticipant ?? null, nextState.currentParticipant ?? null);
    if (!agentId || !stageChanged) return null;

    const reason =
      nextState.currentStageType === "approval" ? "execution_approval_requested" : "execution_review_requested";
    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: nextState.currentStageType === "approval" ? "approver" : "reviewer",
      allowedActions: ["approve", "request_changes"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason,
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: reason,
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  if (nextState.status === "changes_requested") {
    const agentId = nextState.returnAssignee?.type === "agent" ? (nextState.returnAssignee.agentId ?? null) : null;
    const becameChangesRequested =
      previousState?.status !== "changes_requested" ||
      previousState?.lastDecisionId !== nextState.lastDecisionId ||
      !executionPrincipalsEqual(previousState?.returnAssignee ?? null, nextState.returnAssignee ?? null);
    if (!agentId || !becameChangesRequested) return null;

    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: "executor",
      allowedActions: ["address_changes", "resubmit"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason: "execution_changes_requested",
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_changes_requested",
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  return null;
}

class AutoApprovalIssueMissingError extends Error {
  constructor() {
    super("Issue not found during auto-approval transaction");
    this.name = "AutoApprovalIssueMissingError";
  }
}

function toCompactIssue(issue: any): CompactIssue {
  return {
    id: issue.id,
    companyId: issue.companyId,
    projectId: issue.projectId,
    projectWorkspaceId: issue.projectWorkspaceId,
    goalId: issue.goalId,
    parentId: issue.parentId,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    workMode: issue.workMode,
    priority: issue.priority,
    reviewPolicy: issue.reviewPolicy,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    checkoutRunId: issue.checkoutRunId,
    executionRunId: issue.executionRunId,
    executionAgentNameKey: issue.executionAgentNameKey,
    executionLockedAt: issue.executionLockedAt,
    createdByAgentId: issue.createdByAgentId,
    createdByUserId: issue.createdByUserId,
    issueNumber: issue.issueNumber,
    identifier: issue.identifier,
    originKind: issue.originKind,
    originId: issue.originId,
    originRunId: issue.originRunId,
    requestDepth: issue.requestDepth,
    billingCode: issue.billingCode,
    executionWorkspaceId: issue.executionWorkspaceId,
    startedAt: issue.startedAt,
    completedAt: issue.completedAt,
    cancelledAt: issue.cancelledAt,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    ...(issue.labelIds ? { labelIds: issue.labelIds } : {}),
    ...(issue.labels ? { labels: issue.labels } : {}),
    ...(issue.blockedBy ? { blockedBy: issue.blockedBy } : {}),
    ...(issue.blockerAttention ? { blockerAttention: issue.blockerAttention } : {}),
    ...(issue.reviewAttention ? { reviewAttention: issue.reviewAttention } : {}),
    ...(issue.blockedInboxAttention !== undefined ? { blockedInboxAttention: issue.blockedInboxAttention } : {}),
    ...(issue.productivityReview ? { productivityReview: issue.productivityReview } : {}),
    ...(issue.scheduledRetry ? { scheduledRetry: issue.scheduledRetry } : {}),
    ...(issue.liveDescendantCount !== undefined ? { liveDescendantCount: issue.liveDescendantCount } : {}),
    ...(issue.myLastTouchAt !== undefined ? { myLastTouchAt: issue.myLastTouchAt } : {}),
    ...(issue.lastExternalCommentAt !== undefined ? { lastExternalCommentAt: issue.lastExternalCommentAt } : {}),
    ...(issue.lastActivityAt !== undefined ? { lastActivityAt: issue.lastActivityAt } : {}),
    ...(issue.isUnreadForMe !== undefined ? { isUnreadForMe: issue.isUnreadForMe } : {}),
    activeRecoveryAction: issue.activeRecoveryAction ?? null,
    successfulRunHandoff: issue.successfulRunHandoff ?? null,
  };
}

function compactIssueListEtag(issues: CompactIssue[]): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(issues))
    .digest("base64url");
  return `"compact-issues:${hash}"`;
}

function requestMatchesEtag(ifNoneMatchHeader: string | undefined, etag: string): boolean {
  if (!ifNoneMatchHeader) return false;
  return ifNoneMatchHeader
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag || value === `W/${etag}`);
}

const ISSUE_LIST_SERVER_CACHE_TTL_MS = 2_000;
const ISSUE_LIST_SERVER_CACHE_STALE_MS = 5_000;
export const ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES = 256;
const ISSUE_LIST_STORM_WINDOW_MS = 500;
const ISSUE_LIST_STORM_THRESHOLD = 4;
const ISSUE_LIST_MAX_ACTOR_CLIENT_INFLIGHT = 8;

type IssueListPreparedResponse =
  | {
      kind: "compact";
      body: CompactIssue[];
      etag: string;
      cacheControl: string;
    }
  | {
      kind: "full";
      body: unknown[];
    };

type IssueListCacheStatus = "miss" | "hit" | "coalesced" | "stale" | "retry";

type IssueListStormEvent = {
  event: "request_storm_detected";
  route: string;
  companyId: string;
  actorType: string;
  actorIdentityHash: string;
  clientHash: string;
  cacheKeyHash: string;
  queryKeys: string[];
  identicalInFlightCount: number;
  windowMs: number;
  referer: string | null;
  visibilityHint: string | null;
};

type IssueListDiagnostics = {
  onComputeStart?: (context: { companyId: string; cacheKeyHash: string }) => void | Promise<void>;
  onStormDetected?: (event: IssueListStormEvent) => void;
};

type IssueListCacheEntry = {
  response: IssueListPreparedResponse;
  expiresAt: number;
  staleUntil: number;
};

type IssueListInflightEntry = {
  promise: Promise<IssueListPreparedResponse>;
  startedAt: number;
  waiterCount: number;
  stormLogged: boolean;
};

const issueListResponseCache = new Map<string, IssueListCacheEntry>();
const issueListInflight = new Map<string, IssueListInflightEntry>();
const issueListActorClientInflight = new Map<string, number>();

export function __getIssueListResponseCacheSizeForTests() {
  return issueListResponseCache.size;
}

export function __clearIssueListResponseCacheForTests() {
  issueListResponseCache.clear();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function normalizeIssueListCacheValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map(normalizeIssueListCacheValue).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  }
  if (typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const next = normalizeIssueListCacheValue(nestedValue);
      if (next !== undefined) normalized[key] = next;
    }
    return normalized;
  }
  return value;
}

function issueListActorIdentity(req: Request, companyId: string) {
  if (req.actor.type === "agent") {
    const onBehalfMembership = req.actor.onBehalfOfUserId
      ? req.actor.onBehalfOfMemberships?.find((membership) => membership.companyId === companyId) ?? null
      : null;
    const key = [
      "agent",
      companyId,
      req.actor.agentId ?? "unknown-agent",
      req.actor.keyId ?? req.actor.source ?? "agent-auth",
      req.actor.onBehalfOfUserId ?? "no-responsible-user",
      onBehalfMembership?.status ?? "no-responsible-user-status",
      onBehalfMembership?.membershipRole ?? "no-responsible-user-role",
    ].join(":");
    return { actorType: "agent", key, hash: shortHash(key) };
  }

  if (req.actor.type === "board") {
    const sessionPart = req.actor.source === "session"
      ? `cookie:${shortHash(String(req.headers.cookie ?? "no-cookie"))}`
      : req.actor.keyId ?? req.actor.source ?? "board";
    const key = [
      "board",
      companyId,
      req.actor.source ?? "board",
      req.actor.userId ?? "unknown-user",
      sessionPart,
    ].join(":");
    return { actorType: "board", key, hash: shortHash(key) };
  }

  const key = ["none", companyId, req.actor.source ?? "none"].join(":");
  return { actorType: "none", key, hash: shortHash(key) };
}

function issueListClientIdentity(req: Request) {
  const forwardedFor = Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"];
  const client = [
    String(forwardedFor ?? req.ip ?? "unknown-ip").split(",")[0]?.trim() ?? "unknown-ip",
    req.header("user-agent") ?? "unknown-agent",
  ].join(":");
  return { key: client, hash: shortHash(client) };
}

function safeRefererPath(req: Request): string | null {
  const referer = req.header("referer");
  if (!referer) return null;
  try {
    return new URL(referer).pathname;
  } catch {
    return referer.split("?")[0]?.slice(0, 160) ?? null;
  }
}

function issueListRequestKey(input: {
  req: Request;
  companyId: string;
  normalizedQuery: Record<string, unknown>;
}) {
  const route = "GET /api/companies/:companyId/issues";
  const actor = issueListActorIdentity(input.req, input.companyId);
  const client = issueListClientIdentity(input.req);
  const normalizedQuery = normalizeIssueListCacheValue(input.normalizedQuery) as Record<string, unknown>;
  const queryKeys = Object.keys(normalizedQuery).sort();
  const key = stableJson({
    actor: actor.key,
    companyId: input.companyId,
    query: normalizedQuery,
    route,
  });
  return {
    actor,
    client,
    key,
    keyHash: shortHash(key),
    queryKeys,
    route,
  };
}

function pruneIssueListResponseCache(now: number) {
  for (const [key, entry] of issueListResponseCache) {
    if (entry.staleUntil <= now) issueListResponseCache.delete(key);
  }
}

function touchIssueListResponseCacheEntry(key: string, entry: IssueListCacheEntry) {
  issueListResponseCache.delete(key);
  issueListResponseCache.set(key, entry);
}

function trimIssueListResponseCache() {
  while (issueListResponseCache.size > ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES) {
    const oldestKey = issueListResponseCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    issueListResponseCache.delete(oldestKey);
  }
}

function setIssueListResponseCacheEntry(key: string, entry: IssueListCacheEntry) {
  touchIssueListResponseCacheEntry(key, entry);
  trimIssueListResponseCache();
}

function decrementIssueListActorClientInflight(actorClientKey: string) {
  const next = (issueListActorClientInflight.get(actorClientKey) ?? 1) - 1;
  if (next <= 0) issueListActorClientInflight.delete(actorClientKey);
  else issueListActorClientInflight.set(actorClientKey, next);
}

async function coordinateIssueListGet(input: {
  req: Request;
  companyId: string;
  requestKey: ReturnType<typeof issueListRequestKey>;
  allowTtlCache: boolean;
  diagnostics?: IssueListDiagnostics;
  compute: () => Promise<IssueListPreparedResponse>;
}): Promise<{
  response: IssueListPreparedResponse | null;
  cacheStatus: IssueListCacheStatus;
  identicalInFlightCount: number;
  retryAfterSeconds?: number;
}> {
  const now = Date.now();
  pruneIssueListResponseCache(now);

  const cached = input.allowTtlCache ? issueListResponseCache.get(input.requestKey.key) : undefined;
  if (cached && cached.expiresAt > now) {
    touchIssueListResponseCacheEntry(input.requestKey.key, cached);
    return { response: cached.response, cacheStatus: "hit", identicalInFlightCount: 0 };
  }

  const existing = issueListInflight.get(input.requestKey.key);
  if (existing) {
    existing.waiterCount += 1;
    const identicalInFlightCount = existing.waiterCount + 1;
    if (
      !existing.stormLogged &&
      identicalInFlightCount >= ISSUE_LIST_STORM_THRESHOLD &&
      now - existing.startedAt <= ISSUE_LIST_STORM_WINDOW_MS
    ) {
      existing.stormLogged = true;
      const event: IssueListStormEvent = {
        event: "request_storm_detected",
        route: input.requestKey.route,
        companyId: input.companyId,
        actorType: input.requestKey.actor.actorType,
        actorIdentityHash: input.requestKey.actor.hash,
        clientHash: input.requestKey.client.hash,
        cacheKeyHash: input.requestKey.keyHash,
        queryKeys: input.requestKey.queryKeys,
        identicalInFlightCount,
        windowMs: now - existing.startedAt,
        referer: safeRefererPath(input.req),
        visibilityHint: input.req.header("x-paperclip-tab-visible") ?? null,
      };
      logger.warn(event, "request_storm_detected");
      input.diagnostics?.onStormDetected?.(event);
    }
    const response = await existing.promise;
    return { response, cacheStatus: "coalesced", identicalInFlightCount };
  }

  const actorClientKey = `${input.requestKey.actor.key}:${input.requestKey.client.key}`;
  const actorClientInflight = issueListActorClientInflight.get(actorClientKey) ?? 0;
  if (actorClientInflight >= ISSUE_LIST_MAX_ACTOR_CLIENT_INFLIGHT) {
    if (cached && cached.staleUntil > now) {
      touchIssueListResponseCacheEntry(input.requestKey.key, cached);
      return { response: cached.response, cacheStatus: "stale", identicalInFlightCount: 0 };
    }
    return { response: null, cacheStatus: "retry", identicalInFlightCount: 0, retryAfterSeconds: 1 };
  }

  issueListActorClientInflight.set(actorClientKey, actorClientInflight + 1);
  const promise = (async () => {
    await input.diagnostics?.onComputeStart?.({
      companyId: input.companyId,
      cacheKeyHash: input.requestKey.keyHash,
    });
    return input.compute();
  })();
  const inflightEntry: IssueListInflightEntry = {
    promise,
    startedAt: now,
    waiterCount: 0,
    stormLogged: false,
  };
  issueListInflight.set(input.requestKey.key, inflightEntry);

  try {
    const response = await promise;
    if (input.allowTtlCache) {
      setIssueListResponseCacheEntry(input.requestKey.key, {
        response,
        expiresAt: Date.now() + ISSUE_LIST_SERVER_CACHE_TTL_MS,
        staleUntil: Date.now() + ISSUE_LIST_SERVER_CACHE_STALE_MS,
      });
    }
    return { response, cacheStatus: "miss", identicalInFlightCount: 1 };
  } finally {
    if (issueListInflight.get(input.requestKey.key) === inflightEntry) {
      issueListInflight.delete(input.requestKey.key);
    }
    decrementIssueListActorClientInflight(actorClientKey);
  }
}

function estimatedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function logIssueListRequest(input: {
  req: Request;
  res: Response;
  companyId: string;
  requestKey: ReturnType<typeof issueListRequestKey>;
  startedAt: number;
  cacheStatus: IssueListCacheStatus;
  bodyBytes: number;
  etagOutcome: "none" | "fresh" | "not_modified";
  identicalInFlightCount: number;
}) {
  input.res.once("finish", () => {
    const contentEncoding = input.res.getHeader("content-encoding");
    const contentLength = Number(input.res.getHeader("content-length"));
    logger.debug({
      event: "safe_get_request_observed",
      route: input.requestKey.route,
      companyId: input.companyId,
      actorType: input.requestKey.actor.actorType,
      actorIdentityHash: input.requestKey.actor.hash,
      clientHash: input.requestKey.client.hash,
      cacheKeyHash: input.requestKey.keyHash,
      queryKeys: input.requestKey.queryKeys,
      requestCount: input.identicalInFlightCount,
      durationMs: Date.now() - input.startedAt,
      statusCode: input.res.statusCode,
      responseBytes: input.bodyBytes,
      compressedBytes: contentEncoding && Number.isFinite(contentLength) ? contentLength : null,
      contentEncoding: contentEncoding ? String(contentEncoding) : null,
      cacheStatus: input.cacheStatus,
      etagOutcome: input.etagOutcome,
      referer: safeRefererPath(input.req),
      visibilityHint: input.req.header("x-paperclip-tab-visible") ?? null,
    }, "safe authenticated GET observed");
  });
}

export function issueRoutes(
  db: Db,
  storage: StorageService,
  opts: {
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    searchService?: CompanySearchService;
    searchRateLimiter?: CompanySearchRateLimiter;
    pluginWorkerManager?: PluginWorkerManager;
    taskWatchdogEnqueueWakeup?: TaskWatchdogServiceDeps["enqueueWakeup"] | null;
    recoveryActionEnqueueWakeup?: (
      agentId: string,
      options: Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1],
    ) => ReturnType<ReturnType<typeof heartbeatService>["wakeup"]>;
    stalledReviewDecisionEnqueueWakeup?: (
      agentId: string,
      options: Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1],
    ) => ReturnType<ReturnType<typeof heartbeatService>["wakeup"]>;
    issueListDiagnostics?: IssueListDiagnostics;
    approveToolActionRequest?: (input: {
      companyId: string;
      issueId: string;
      interactionId: string;
      actionRequestId: string;
      actor: { agentId?: string | null; userId?: string | null };
    }) => Promise<unknown>;
    approveSecretProposal?: (input: {
      companyId: string;
      issueId: string;
      interactionId: string;
      proposalId: string;
      actor: { agentId?: string | null; userId?: string | null };
    }) => Promise<unknown>;
  } = {},
) {
  const router = Router();
  const svc = issueService(db);
  const runRedactions = createRunSecretRedactionRegistry(db);
  const access = accessService(db);
  const secretProposals = createSecretProposalsService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const commentWasCreatedByAssigneeRun = async (
    comment: { companyId: string; createdByRunId?: string | null },
    assigneeAgentId: string | null | undefined,
  ) => {
    // Legacy adapters can authenticate through the board while still stamping
    // the real source run on the comment. Treat that durable provenance as the
    // author identity for wake routing.
    if (!comment.createdByRunId || !assigneeAgentId) return false;
    const sourceRun = await heartbeat.getRun(comment.createdByRunId);
    return (
      sourceRun?.companyId === comment.companyId &&
      sourceRun.agentId === assigneeAgentId
    );
  };
  const enqueueStalledReviewDecisionWakeup = opts.stalledReviewDecisionEnqueueWakeup ?? heartbeat.wakeup;
  const enqueueRecoveryActionWakeup = opts.recoveryActionEnqueueWakeup ?? heartbeat.wakeup;
  const feedback = feedbackService(db);
  const companiesSvc = companyService(db);
  let searchSvc = opts.searchService ?? null;
  const getSearchService = () => {
    searchSvc ??= companySearchService(db);
    return searchSvc;
  };
  const searchRateLimiter = opts.searchRateLimiter ?? defaultCompanySearchRateLimiter;
  const instanceSettings = instanceSettingsService(db);
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const executionWorkspacesSvc = executionWorkspaceServiceDirect(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const artifactReviewDocumentsSvc = artifactReviewDocumentService(db, storage);
  const companySkillsSvc = companySkillService(db);
  const documentAnnotationsSvc = documentAnnotationService(db);
  const decisionTrainingSvc = decisionTrainingService(db);
  const issueReferencesSvc = issueReferenceService(db);
  const issueThreadInteractionsSvc = issueThreadInteractionService(db);
  const questionResponseDeliveries = questionResponseDeliveryService(db, {
    heartbeat,
    resolveNativeQuestion: (interaction) => deliverNativeQuestionResponse(db, interaction),
  });
  const flushIssuePostCommitActions = async (actions: readonly IssuePostCommitAction[]) => {
    if (actions.length === 0) return;
    const { executeIssuePostCommitActions } = await import("../services/issues.js");
    await executeIssuePostCommitActions(db, actions);
  };

  const memoizeIssueRead = createRequestPromiseMemo<Request, Awaited<ReturnType<typeof svc.getById>>>({
    shouldCache: (issue) => issue !== null,
  });
  const memoizeIssueReadDecision = createRequestPromiseMemo<Request, Awaited<ReturnType<typeof decideIssueAccess>>>();

  function getIssueById(req: Request, id: string) {
    if (req.method !== "GET") return svc.getById(id);
    return memoizeIssueRead(req, id, () => svc.getById(id));
  }

  const issueDetailEtag = privateJsonEtag();
  router.use((req, res, next) => {
    if (/^\/issues\/[^/]+(?:\/|$)/.test(req.path)) {
      issueDetailEtag(req, res, next);
      return;
    }
    next();
  });

  const taskWatchdogFactory: TaskWatchdogServiceFactory | undefined = Object.prototype.hasOwnProperty.call(
    serviceIndex,
    "taskWatchdogService",
  )
    ? serviceIndex.taskWatchdogService
    : undefined;
  const taskWatchdogsSvc = taskWatchdogFactory?.(db, {
    enqueueWakeup: opts.taskWatchdogEnqueueWakeup === undefined
      ? heartbeat.wakeup
      : opts.taskWatchdogEnqueueWakeup ?? undefined,
  }) ?? noopTaskWatchdogService();
  const externalObjectsSvc = externalObjectService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
    enabled: async () => (await instanceSettings.getExperimental()).enableExternalObjects === true,
  });
  const routinesSvc = routineService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const environmentRuntime = environmentRuntimeService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const issueTreeControlFactory = Object.prototype.hasOwnProperty.call(
    serviceIndex,
    "issueTreeControlService",
  )
    ? serviceIndex.issueTreeControlService
    : undefined;
  const treeControlSvc = issueTreeControlFactory?.(db) ?? {
    getActivePauseHoldGate: async () => null,
  };
  const feedbackExportService = opts?.feedbackExportService;
  const environmentsSvc = environmentService(db);

  async function queueTaskWatchdogEvaluation(issue: { id: string; companyId: string }, runId?: string | null) {
    await taskWatchdogsSvc
      .reconcileForIssueAndAncestors(issue.companyId, issue.id, { runId: runId ?? null })
      .catch((err) => {
        logger.warn({ err, issueId: issue.id }, "task watchdog evaluation hook failed");
      });
  }

  async function sourceTrustForActorWrite(
    issue: { id: string; companyId: string; projectId?: string | null; executionPolicy?: unknown },
    actor: ReturnType<typeof getActorInfo>,
  ) {
    return resolveActorSourceTrustForIssue({ db, issue, actor });
  }

  async function assertCrossIssueInfluenceWithinRunCap(
    req: Request,
    res: Response,
    issue: { id: string; identifier?: string | null; companyId: string },
    kind: CrossIssueInfluenceKind,
  ) {
    if (req.actor.type !== "agent") return true;
    if (!req.actor.agentId || !req.actor.runId) throw crossIssueInfluenceRunContextError();

    // The counter transaction locks and validates the persisted run before it
    // derives the source issue. Never trust the API-key run header by itself.
    const decision = await observeCrossIssueInfluence(db, {
      companyId: issue.companyId,
      runId: req.actor.runId,
      agentId: req.actor.agentId,
      responsibleUserId: req.actor.onBehalfOfUserId ?? null,
      targetIssueId: issue.id,
      targetIssueIdentifier: issue.identifier ?? null,
      kind,
    });
    if (!decision || decision.allowed) return true;

    const labels = await issueWriteDenialLabels(req, {
      identifier: issue.identifier ?? null,
      assigneeAgentId: null,
    });
    res.status(429).json(crossIssueInfluenceLimitError(decision, {
      actorLabel: labels.actorLabel,
      issueIdentifier: labels.issueIdentifier,
    }));
    return false;
  }

  function hasExplicitIssueWorkspaceCreateSelection(input: Record<string, unknown>) {
    return input.parentId !== undefined ||
      input.inheritExecutionWorkspaceFromIssueId !== undefined ||
      input.projectWorkspaceId !== undefined ||
      input.executionWorkspaceId !== undefined ||
      input.executionWorkspacePreference !== undefined ||
      input.executionWorkspaceSettings !== undefined;
  }

  async function resolveRunIssueWorkspaceInheritanceSource(
    companyId: string,
    actor: ReturnType<typeof getActorInfo>,
  ): Promise<string | null> {
    if (actor.actorType !== "agent" || !actor.agentId || !actor.runId) return null;
    const run = await db
      .select({
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, actor.runId),
        eq(heartbeatRuns.companyId, companyId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!run || run.agentId !== actor.agentId) return null;
    const context = run.contextSnapshot && typeof run.contextSnapshot === "object"
      ? run.contextSnapshot as Record<string, unknown>
      : null;
    if (!context || !readNonEmptyString(context.executionWorkspaceId)) return null;
    const paperclipIssue = context.paperclipIssue && typeof context.paperclipIssue === "object"
      ? context.paperclipIssue as Record<string, unknown>
      : null;
    return readNonEmptyString(context.issueId) ?? readNonEmptyString(paperclipIssue?.id);
  }

  async function resolveAgentTrustForIssue(
    input: {
      agentId: string | null | undefined;
      runId?: string | null;
    },
    companyId: string,
    issue?: { companyId: string; projectId?: string | null; executionPolicy?: unknown } | null,
  ): Promise<TrustPresetResolution | null> {
    if (!input.agentId) return null;
    const [agent, run] = await Promise.all([
      agentsSvc.getById(input.agentId),
      input.runId
        ? db
            .select({
              companyId: heartbeatRuns.companyId,
              agentId: heartbeatRuns.agentId,
              contextSnapshot: heartbeatRuns.contextSnapshot,
            })
            .from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, companyId)))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);
    if (!agent || agent.companyId !== companyId) return null;
    const runContext = run?.agentId === agent.id && run.contextSnapshot && typeof run.contextSnapshot === "object"
      ? run.contextSnapshot as Record<string, unknown>
      : null;
    const runExecutionPolicy = runContext?.executionPolicy && typeof runContext.executionPolicy === "object"
      ? runContext.executionPolicy as Record<string, unknown>
      : null;
    const project = issue?.projectId
      ? await projectsSvc.getById(issue.projectId)
      : null;
    return resolveCoreTrustPreset({
      companyId,
      agent,
      project: project?.companyId === companyId ? project : null,
      issue: issue
        ? {
            companyId: issue.companyId,
            executionPolicy: issue.executionPolicy,
          }
        : null,
      run: runExecutionPolicy ? { companyId, executionPolicy: runExecutionPolicy } : null,
    });
  }

  async function actorIsLowTrustReview(
    req: Request,
    companyId: string,
    issue?: { companyId: string; projectId?: string | null; executionPolicy?: unknown } | null,
  ) {
    if (req.actor.type !== "agent") return false;
    const resolution = await resolveAgentTrustForIssue({
      agentId: req.actor.agentId,
      runId: req.actor.runId,
    }, companyId, issue);
    if (resolution?.kind === "denied") {
      throw forbidden(resolution.detail);
    }
    return resolution?.kind === "low_trust_review";
  }

  async function directParentReportDisabledForIssue(issue: {
    companyId: string;
    projectId?: string | null;
    executionPolicy?: unknown;
    assigneeAgentId?: string | null;
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  }) {
    const resolution = issue.assigneeAgentId
      ? await resolveAgentTrustForIssue({
          agentId: issue.assigneeAgentId,
          runId: issue.checkoutRunId ?? issue.executionRunId,
        }, issue.companyId, issue)
      : null;
    if (resolution) return resolution.kind !== "standard";

    const project = issue.projectId ? await projectsSvc.getById(issue.projectId) : null;
    return resolveCoreTrustPreset({
      companyId: issue.companyId,
      project: project?.companyId === issue.companyId ? project : null,
      issue: {
        companyId: issue.companyId,
        executionPolicy: issue.executionPolicy,
      },
    }).kind !== "standard";
  }

  async function assertLowTrustControlPlaneDenied(
    req: Request,
    res: Response,
    companyId: string,
    issue?: { companyId: string; projectId?: string | null; executionPolicy?: unknown } | null,
  ) {
    if (!(await actorIsLowTrustReview(req, companyId, issue))) return false;
    res.status(403).json({ error: "Low-trust actors cannot use this control-plane surface" });
    return true;
  }

  async function shouldRedactLowTrustForHeartbeatContext(
    issue: { id: string; companyId: string; projectId?: string | null; executionPolicy?: unknown },
    actor: ReturnType<typeof getActorInfo>,
  ) {
    // Board users are trusted reviewers and intentionally receive raw quarantined output for promotion decisions.
    if (actor.actorType !== "agent") return false;
    const resolution = await resolveAgentTrustForIssue({
      agentId: actor.agentId,
      runId: actor.runId,
    }, issue.companyId, issue);
    if (resolution?.kind === "denied") {
      throw forbidden(resolution.detail);
    }
    if (resolution?.kind === "low_trust_review") return false;
    return true;
  }

  async function lookupLowTrustSourceArtifact(input: {
    issueId: string;
    artifactKind: "comment" | "document" | "work_product" | "issue";
    artifactId: string;
  }): Promise<SourceTrustMetadata | null> {
    if (input.artifactKind === "issue") {
      const row = await db
        .select({
          id: issueRows.id,
          companyId: issueRows.companyId,
          parentId: issueRows.parentId,
          sourceTrust: issueRows.sourceTrust,
        })
        .from(issueRows)
        .where(eq(issueRows.id, input.artifactId))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const sourceIssue = await db
        .select({ companyId: issueRows.companyId })
        .from(issueRows)
        .where(eq(issueRows.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!sourceIssue || row.companyId !== sourceIssue.companyId) return null;
      if (row.id !== input.issueId) {
        let cursor = row.parentId;
        let isDescendant = false;
        for (let depth = 0; cursor && depth < LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH; depth += 1) {
          if (cursor === input.issueId) {
            isDescendant = true;
            break;
          }
          const parent = await db
            .select({ id: issueRows.id, companyId: issueRows.companyId, parentId: issueRows.parentId })
            .from(issueRows)
            .where(eq(issueRows.id, cursor))
            .then((rows) => rows[0] ?? null);
          if (!parent || parent.companyId !== row.companyId) return null;
          cursor = parent.parentId;
        }
        if (!isDescendant) return null;
      }
      return row?.sourceTrust ?? null;
    }

    if (input.artifactKind === "comment") {
      const row = await db
        .select({ sourceTrust: issueComments.sourceTrust })
        .from(issueComments)
        .where(and(eq(issueComments.id, input.artifactId), eq(issueComments.issueId, input.issueId)))
        .then((rows) => rows[0] ?? null);
      return row?.sourceTrust ?? null;
    }

    if (input.artifactKind === "document") {
      const row = await db
        .select({ sourceTrust: documents.sourceTrust })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(and(eq(documents.id, input.artifactId), eq(issueDocuments.issueId, input.issueId)))
        .then((rows) => rows[0] ?? null);
      return row?.sourceTrust ?? null;
    }

    const row = await db
      .select({ sourceTrust: issueWorkProducts.sourceTrust })
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.id, input.artifactId), eq(issueWorkProducts.issueId, input.issueId)))
      .then((rows) => rows[0] ?? null);
    return row?.sourceTrust ?? null;
  }

  async function cancelScheduledRetrySupersededByComment(input: {
    scheduledRetryRunId: string | null | undefined;
    issue: { id: string; companyId: string };
    actor: ReturnType<typeof getActorInfo>;
  }) {
    const scheduledRetryRunId = readNonEmptyString(input.scheduledRetryRunId);
    if (!scheduledRetryRunId) return null;

    try {
      const cancelled = await heartbeat.cancelRun(scheduledRetryRunId);
      const cancelledRunId = cancelled?.id ?? scheduledRetryRunId;
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        agentApiKeyId: input.actor.agentApiKeyId,
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: cancelledRunId,
        issueId: input.issue.id,
        details: {
          source: "issue_comment_scheduled_retry_superseded",
          issueId: input.issue.id,
        },
      });
      return cancelledRunId;
    } catch (err) {
      logger.error(
        { err, issueId: input.issue.id, runId: scheduledRetryRunId },
        "failed to cancel scheduled retry superseded by issue comment",
      );
      throw err;
    }
  }

  async function classifySourceRecoveryRevalidation(input: {
    issue: IssueRouteSnapshot;
    trigger: RecoveryRevalidationTrigger;
    statusChanged?: boolean;
    assigneeChanged?: boolean;
    blockersChanged?: boolean;
    executionPolicyChanged?: boolean;
    monitorChanged?: boolean;
    documentChanged?: boolean;
    workProductChanged?: boolean;
    resumeRequested?: boolean;
    reopened?: boolean;
    blockedToTodoRecovery?: boolean;
  }): Promise<string | null> {
    const { issue } = input;
    if (issue.status === "done" || issue.status === "cancelled") {
      return `Recovery action became stale because the source issue reached ${issue.status}.`;
    }
    if (input.blockedToTodoRecovery === true) {
      return "Recovery action became stale because the source issue was manually moved from blocked to todo.";
    }

    if (input.trigger === "read_projection") return null;
    if (
      input.trigger === "comment" &&
      input.resumeRequested !== true &&
      input.reopened !== true &&
      input.statusChanged !== true
    ) {
      return null;
    }

    const durableSourceChange =
      input.statusChanged === true ||
      input.assigneeChanged === true ||
      input.blockersChanged === true ||
      input.executionPolicyChanged === true ||
      input.monitorChanged === true ||
      input.documentChanged === true ||
      input.workProductChanged === true ||
      input.resumeRequested === true ||
      input.reopened === true;
    if (!durableSourceChange) return null;

    if (issue.status === "blocked") {
      const readiness = await svc.getDependencyReadiness(issue.id);
      if (readiness.unresolvedBlockerCount > 0) {
        return "Recovery action became stale because the source issue now has unresolved first-class blockers.";
      }
      return null;
    }

    if (issue.assigneeUserId && issue.status !== "done" && issue.status !== "cancelled") {
      return "Recovery action became stale because the source issue now has a human owner.";
    }

    if ((issue.status === "todo" || issue.status === "in_progress") && issue.assigneeAgentId) {
      return `Recovery action became stale because the source issue is ${issue.status} with an agent owner.`;
    }

    if (issue.status === "in_review") {
      const executionState = parseIssueExecutionState(issue.executionState);
      const participant = executionState?.status === "pending" ? executionState.currentParticipant : null;
      if (
        (participant?.type === "agent" && readNonEmptyString(participant.agentId)) ||
        (participant?.type === "user" && readNonEmptyString(participant.userId))
      ) {
        return "Recovery action became stale because the source issue now has a typed review participant.";
      }

      const interactions = await issueThreadInteractionsSvc.listForIssue(issue.id);
      if (interactions.some((interaction) => interaction.status === "pending")) {
        return "Recovery action became stale because the source issue now has a pending issue interaction.";
      }

      const approvals = await issueApprovalsSvc.listApprovalsForIssue(issue.id);
      if (approvals.some((approval) => approval.status === "pending" || approval.status === "revision_requested")) {
        return "Recovery action became stale because the source issue now has a pending approval.";
      }
    }

    const monitor = summarizeIssueMonitor(issue, normalizeIssueExecutionPolicy(issue.executionPolicy ?? null));
    if (monitor.nextCheckAt && Date.parse(monitor.nextCheckAt) > Date.now()) {
      return "Recovery action became stale because the source issue now has a scheduled monitor.";
    }

    return null;
  }

  async function revalidateActiveSourceRecovery(input: {
    issue: IssueRouteSnapshot;
    trigger: RecoveryRevalidationTrigger;
    actor?: ReturnType<typeof getActorInfo> | null;
    activeRecoveryAction?: Awaited<ReturnType<typeof recoveryActionsSvc.getActiveForIssue>> | null;
    statusChanged?: boolean;
    assigneeChanged?: boolean;
    blockersChanged?: boolean;
    executionPolicyChanged?: boolean;
    monitorChanged?: boolean;
    documentChanged?: boolean;
    workProductChanged?: boolean;
    resumeRequested?: boolean;
    reopened?: boolean;
    blockedToTodoRecovery?: boolean;
  }) {
    const activeRecoveryAction =
      input.activeRecoveryAction === undefined
        ? await recoveryActionsSvc.getActiveForIssue(input.issue.companyId, input.issue.id)
        : input.activeRecoveryAction;
    if (!activeRecoveryAction) return null;

    const resolutionNote = await classifySourceRecoveryRevalidation(input);
    if (!resolutionNote) return activeRecoveryAction;

    const resolved = await recoveryActionsSvc.resolveActiveForIssue({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      actionId: activeRecoveryAction.id,
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote,
    });
    if (!resolved) return activeRecoveryAction;

    const actor = input.actor;
    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: actor?.actorType ?? "system",
      actorId: actor?.actorId ?? "system",
      agentId: actor?.agentId ?? null,
      runId: actor?.runId ?? null,
      action: "issue.recovery_action_resolved",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        recoveryActionId: resolved.id,
        recoveryActionStatus: resolved.status,
        outcome: resolved.outcome,
        sourceIssueStatus: input.issue.status,
        resolutionNote: resolved.resolutionNote,
        source: "source_revalidation",
        trigger: input.trigger,
      },
    });

    return null;
  }

  async function revalidateActiveSourceRecoveryForRead(input: Parameters<typeof revalidateActiveSourceRecovery>[0]) {
    try {
      return await revalidateActiveSourceRecovery(input);
    } catch (err) {
      logger.warn(
        { err, issueId: input.issue.id, trigger: input.trigger },
        "failed to revalidate recovery action during read projection",
      );
      return input.activeRecoveryAction ?? null;
    }
  }

  async function revalidateActiveSourceRecoveryAfterCommittedWrite(
    input: Parameters<typeof revalidateActiveSourceRecovery>[0],
  ) {
    try {
      return await revalidateActiveSourceRecovery(input);
    } catch (err) {
      logger.warn(
        { err, issueId: input.issue.id, trigger: input.trigger },
        "failed to revalidate recovery action after committed issue write",
      );
      return input.activeRecoveryAction ?? null;
    }
  }

  function withContentPath<T extends { id: string }>(attachment: T) {
    const contentPath = `/api/attachments/${attachment.id}/content`;
    return {
      ...attachment,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
    };
  }

  type ParsedAttachmentRange =
    | { kind: "none" }
    | { kind: "invalid" }
    | { kind: "range"; start: number; end: number };

  function parseAttachmentRangeHeader(raw: string | undefined, contentLength: number): ParsedAttachmentRange {
    if (!raw) return { kind: "none" };
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return { kind: "invalid" };

    const prefix = "bytes=";
    if (!raw.toLowerCase().startsWith(prefix)) return { kind: "invalid" };
    const spec = raw.slice(prefix.length).trim();
    if (!spec || spec.includes(",")) return { kind: "invalid" };

    const [startRaw, endRaw] = spec.split("-", 2);
    if (endRaw === undefined) return { kind: "invalid" };

    if (startRaw === "") {
      const suffixLength = Number.parseInt(endRaw, 10);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "invalid" };
      const start = Math.max(contentLength - suffixLength, 0);
      return { kind: "range", start, end: contentLength - 1 };
    }

    const start = Number.parseInt(startRaw, 10);
    if (!Number.isSafeInteger(start) || start < 0 || start >= contentLength) return { kind: "invalid" };
    const end = endRaw === "" ? contentLength - 1 : Number.parseInt(endRaw, 10);
    if (!Number.isSafeInteger(end) || end < start) return { kind: "invalid" };
    return { kind: "range", start, end: Math.min(end, contentLength - 1) };
  }

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function parseOptionalBooleanQuery(value: unknown) {
    if (value === undefined) return undefined;
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return null;
  }

  function shouldIncludeDocumentAnnotations(req: Request) {
    if (req.query.includeAnnotations === "false" || req.query.includeAnnotations === "0") return false;
    return req.actor.type === "agent" || parseBooleanQuery(req.query.includeAnnotations);
  }

  function shouldIncludeDocumentAnnotationComments(req: Request) {
    return parseBooleanQuery(req.query.includeAnnotationComments);
  }

  function annotationActorInput(req: Request) {
    const actor = getActorInfo(req);
    return {
      actor,
      annotationActor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      },
    };
  }

  async function canonicalizePaperclipArtifactMetadata(input: {
    issue: { id: string; companyId: string };
    metadata: Record<string, unknown> | null | undefined;
  }) {
    const parsed = attachmentArtifactMetadataInputSchema.safeParse(input.metadata);
    if (!parsed.success) {
      throw unprocessable("Invalid attachment artifact metadata", {
        code: "invalid_attachment_artifact_metadata",
        details: parsed.error.issues,
      });
    }

    const attachment = await svc.getAttachmentById(parsed.data.attachmentId);
    if (!attachment || attachment.companyId !== input.issue.companyId || attachment.issueId !== input.issue.id) {
      throw unprocessable("Attachment artifact must reference an attachment on the same issue", {
        code: "invalid_attachment_artifact_metadata",
        attachmentId: parsed.data.attachmentId,
      });
    }

    const contentPath = buildAttachmentContentPath(attachment.id);
    return attachmentArtifactWorkProductMetadataSchema.parse({
      attachmentId: attachment.id,
      contentType: normalizeContentType(attachment.contentType),
      byteSize: attachment.byteSize,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
      originalFilename: attachment.originalFilename ?? null,
    });
  }

  async function assertIssueEnvironmentSelection(
    companyId: string,
    environmentId: string | null | undefined,
  ) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(
      environmentsSvc,
      companyId,
      environmentId,
      { allowedDrivers: ["local", "ssh", "sandbox"] },
    );
  }

  async function assertInReviewReviewPath(input: {
    existing: {
      id: string;
      companyId: string;
      status: string;
      assigneeUserId?: string | null;
      executionState?: unknown;
      monitorNextCheckAt?: Date | null;
    };
    updateFields: Record<string, unknown>;
    actorType: "agent" | "user";
    actorId: string;
    actorAgentId?: string | null;
    actorRunId?: string | null;
    reviewInteractionId?: string;
  }) {
    const nextStatus = typeof input.updateFields.status === "string"
      ? input.updateFields.status
      : input.existing.status;
    if (input.existing.status === "in_review" || nextStatus !== "in_review") return null;
    if (input.actorType !== "agent" && !input.reviewInteractionId) return null;

    const interactions = await issueThreadInteractionService(db).listForIssue(input.existing.id);
    const pendingInteractions = interactions.filter((interaction) => interaction.status === "pending");
    if (input.reviewInteractionId) {
      const designatedReviewConfirmation = pendingInteractions.find((interaction) =>
        interaction.id === input.reviewInteractionId
        && (interaction.kind === "request_confirmation" || interaction.kind === "request_checkbox_confirmation")
        && (
          input.actorType === "agent"
            ? interaction.createdByAgentId === input.actorAgentId
              && interaction.sourceRunId === input.actorRunId
            : interaction.createdByUserId === input.actorId
        )
        && !(
          interaction.kind === "request_confirmation"
          && interaction.payload
          && typeof interaction.payload === "object"
          && (
            ("toolAction" in interaction.payload && interaction.payload.toolAction !== undefined)
            || ("secretProposal" in interaction.payload && interaction.payload.secretProposal !== undefined)
          )
        )
      );
      if (!designatedReviewConfirmation) {
        const creatorDescription = input.actorType === "agent"
          ? "this agent run"
          : "this user";
        throw unprocessable(`reviewInteractionId must identify a pending non-tool confirmation created by ${creatorDescription}`, {
          code: "invalid_review_interaction",
          reviewInteractionId: input.reviewInteractionId,
        });
      }
      return designatedReviewConfirmation.id;
    }

    if (input.actorType !== "agent") return null;

    const nextAssigneeUserId = input.updateFields.assigneeUserId === undefined
      ? input.existing.assigneeUserId
      : input.updateFields.assigneeUserId;
    if (typeof nextAssigneeUserId === "string" && nextAssigneeUserId.trim().length > 0) return null;

    const nextExecutionState = input.updateFields.executionState === undefined
      ? input.existing.executionState
      : input.updateFields.executionState;
    if (hasExecutionParticipant(nextExecutionState)) return null;

    const nextExecutionPolicy = input.updateFields.executionPolicy;
    if (hasScheduledMonitor({
      existingMonitorNextCheckAt: input.existing.monitorNextCheckAt ?? null,
      patchMonitorNextCheckAt: input.updateFields.monitorNextCheckAt,
      executionPolicy: nextExecutionPolicy,
    })) return null;

    if (pendingInteractions.length > 0) return null;

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(input.existing.id);
    if (approvals.some((approval) => ACTIVE_REVIEW_APPROVAL_STATUSES.has(String(approval.status)))) return null;

    throw unprocessable(INVALID_AGENT_IN_REVIEW_DISPOSITION_MESSAGE, {
      code: "invalid_issue_disposition",
      missing: "review_path",
      validReviewPaths: [
        "pending_issue_thread_interaction",
        "linked_pending_approval",
        "human_assignee_user_id",
        "typed_execution_state_current_participant",
        "scheduled_issue_monitor",
      ],
    });
  }

  async function logExpiredRequestConfirmations(input: {
    issue: { id: string; companyId: string; identifier?: string | null };
    interactions: Array<{ id: string; kind: string; status: string; result?: unknown }>;
    actor: ReturnType<typeof getActorInfo>;
    source: string;
  }) {
    for (const interaction of input.interactions) {
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        agentApiKeyId: input.actor.agentApiKeyId,
        action: "issue.thread_interaction_expired",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          identifier: input.issue.identifier ?? null,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          source: input.source,
          result: interaction.result ?? null,
        },
      });
    }
  }

  async function queueExpiredInteractionReviewPathRecovery(input: {
    issue: IssueRouteSnapshot;
    interactions: Array<{ id: string }>;
    actor: ReturnType<typeof getActorInfo>;
    source: string;
  }) {
    if (
      input.interactions.length === 0
      || input.issue.status !== "in_review"
      || !input.issue.assigneeAgentId
    ) {
      return null;
    }

    const reviewAttention = await svc
      .listReviewAttention(input.issue.companyId, [input.issue])
      .then((attention) => attention.get(input.issue.id));
    if (!reviewAttention || reviewAttention.state !== "stalled") return null;

    const interactionIds = [...new Set(input.interactions.map((interaction) => interaction.id))].sort();
    const consumedPathRef = interactionIds.length === 1
      ? interactionIds[0]!
      : `interactions:${interactionIds.join(",")}`;
    const decision = decideIssueReviewPathRecovery({
      issueId: input.issue.id,
      sourceRunId: input.actor.runId,
      assigneeAgentId: input.issue.assigneeAgentId,
      contextSnapshot: {
        source: input.source,
        reviewPathConsumedRef: consumedPathRef,
      },
      reviewAttention,
      existingWake: false,
    });
    if (decision.kind !== "enqueue") return null;

    const recoveryRun = await heartbeat.wakeup(input.issue.assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
      idempotencyKey: decision.idempotencyKey,
      payload: decision.payload,
      contextSnapshot: decision.contextSnapshot,
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId,
    }).catch((error: unknown) => {
      if (isReviewPathRecoveryIdempotencyConflict(error)) return null;
      throw error;
    });
    if (!recoveryRun) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "issue_route",
      agentId: input.issue.assigneeAgentId,
      runId: input.actor.runId,
      action: "issue.review_path_recovery_queued",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        source: input.source,
        recoveryRunId: recoveryRun.id,
        consumedPathRef,
        recoveryAttempt: 1,
        maxRecoveryAttempts: 1,
      },
    });
    return recoveryRun;
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Invalid ${field} query value`);
    }
    return parsed;
  }

  async function runSingleFileUpload(req: Request, res: Response, fileSizeLimit: number) {
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: fileSizeLimit, files: 1 },
    });
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
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

  type TaskAssignmentAuthorizationScope = {
    issueId?: string | null;
    projectId?: string | null;
    parentIssueId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
  };

  async function resolveAssignmentProjectId(input: {
    companyId: string;
    projectId: string | null | undefined;
    parentIssueId?: string | null;
  }) {
    if (input.projectId !== undefined) return input.projectId;
    if (!input.parentIssueId) return null;
    const parent = await svc.getById(input.parentIssueId);
    if (!parent || parent.companyId !== input.companyId) return null;
    return parent.projectId ?? null;
  }

  async function assertCanAssignTasks(
    req: Request,
    companyId: string,
    assignmentScope?: TaskAssignmentAuthorizationScope,
  ) {
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId,
        issueId: assignmentScope?.issueId ?? null,
        projectId: assignmentScope?.projectId ?? null,
        parentIssueId: assignmentScope?.parentIssueId ?? null,
        assigneeAgentId: assignmentScope?.assigneeAgentId ?? null,
        assigneeUserId: assignmentScope?.assigneeUserId ?? null,
      },
      scope: assignmentScope ?? null,
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  function isTaskBridgeKeyActor(req: Request) {
    return req.actor.type === "agent" && req.actor.source === "agent_key" && req.actor.keyScope?.kind === "task_bridge";
  }

  function isSkillTestScopedActor(req: Request) {
    return req.actor.type === "agent" && req.actor.keyScope?.kind === "skill_test";
  }

  function taskBridgeOriginForActor(req: Request) {
    return isTaskBridgeKeyActor(req) && req.actor.keyId
      ? { originKind: "task_bridge", originId: req.actor.keyId }
      : null;
  }

  async function assertTaskBridgeCreateAllowed(
    req: Request,
    companyId: string,
    assignmentScope: TaskAssignmentAuthorizationScope,
  ) {
    if (!isTaskBridgeKeyActor(req)) return;
    await assertCanAssignTasks(req, companyId, assignmentScope);
  }

  async function decideIssueAccess(
    req: Request,
    issue: {
      id: string;
      companyId: string;
      projectId: string | null;
      parentId: string | null;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      status: string;
    },
    action: "issue:comment" | "issue:read" | "issue:mutate",
  ) {
    return access.decide({
      actor: req.actor,
      action,
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
      scope: {
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
      },
    });
  }

  /**
   * Map an authorization denial onto the issue-write copy contract (plan §6).
   *
   * The two responsible-user ceiling codes are the most specific signal, so they
   * win. Actor-class walls (low-trust, skill-test, task-bridge scopes) stay shut
   * by design and get their own copy. Everything else reaching a write channel is
   * a visibility denial, because the default-open rule puts `issue:read` structurally
   * upstream of every standard-trust write.
   */
  function issueWriteDenialCodeForDecision(
    decision: Awaited<ReturnType<typeof decideIssueAccess>>,
  ): IssueWriteDenialCode {
    if (decision.code) return issueWriteDenialCodeForResponsibleUserDenial(decision.code);
    if (decision.reason === "deny_low_trust_boundary" || decision.reason === "deny_policy_restricted") {
      return "issue_write_actor_class_excluded";
    }
    return "issue_write_not_visible";
  }

  /**
   * Best-effort display names for denial copy. Denials are rare, so one extra
   * query buys an error that names who can act instead of printing raw uuids.
   * Any failure degrades to the copy contract's generic nouns.
   */
  async function issueWriteDenialLabels(
    req: Request,
    issue: { identifier?: string | null; assigneeAgentId: string | null },
  ): Promise<IssueWriteDenialContext> {
    const actorAgentId = req.actor.type === "agent" ? req.actor.agentId ?? null : null;
    const ids = [actorAgentId, issue.assigneeAgentId].filter((id): id is string => Boolean(id));
    const nameById = new Map<string, string>();
    if (ids.length > 0) {
      try {
        const rows = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, ids));
        for (const row of rows) if (row.name) nameById.set(row.id, row.name);
      } catch (err) {
        logger.warn({ err }, "failed to resolve agent names for issue write denial copy");
      }
    }
    return {
      actorLabel: actorAgentId ? nameById.get(actorAgentId) ?? null : null,
      assigneeLabel: issue.assigneeAgentId ? nameById.get(issue.assigneeAgentId) ?? null : null,
      issueIdentifier: issue.identifier ?? null,
      responsibleUserName: null,
    };
  }

  /** Respond to a denied issue write with copy that names boundary, who, and path. */
  async function denyIssueWrite(
    req: Request,
    res: Response,
    issue: { identifier?: string | null; assigneeAgentId: string | null },
    code: IssueWriteDenialCode,
    extraDetails: Record<string, unknown> = {},
  ) {
    const labels = await issueWriteDenialLabels(req, issue);
    const { status, body } = issueWriteDenialResponse(code, labels);
    res.status(status).json({
      error: body.error,
      details: { ...body.details, ...extraDetails },
    });
    return false as const;
  }

  async function assertIssueReadAllowed(req: Request, res: Response, issue: Parameters<typeof decideIssueAccess>[1]) {
    const key = `${issue.id}:${issue.companyId}:${issue.projectId ?? ""}:${issue.parentId ?? ""}:${issue.assigneeAgentId ?? ""}:${issue.assigneeUserId ?? ""}:${issue.status}`;
    const value = memoizeIssueReadDecision(req, key, () => decideIssueAccess(req, issue, "issue:read"));
    const decision = await value;
    if (decision.allowed) return true;
    res.status(403).json({ error: "Issue is outside this actor's authorization boundary" });
    return false;
  }

  async function assertIssueWriteInfluenceAllowed(
    req: Request,
    res: Response,
    issue: Parameters<typeof decideIssueAccess>[1],
  ) {
    if (req.actor.type !== "agent") return true;
    // Watchdog child creation keeps its dedicated subtree/revalidation grant;
    // assertTaskWatchdogCreateIssueAllowed performs that check immediately
    // after this generic collaboration gate at both create call sites.
    if ((await resolveTaskWatchdogMutationScope(db, req.actor)).kind !== "none") return true;
    const decision = await decideIssueAccess(req, issue, "issue:mutate");
    if (decision.allowed) return true;
    return denyIssueWrite(req, res, issue, issueWriteDenialCodeForDecision(decision));
  }

  async function assertAgentIssueCommentAllowed(
    req: Request,
    res: Response,
    issue: {
      id: string;
      companyId: string;
      projectId: string | null;
      parentId: string | null;
      status: string;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      /** Used only to name the task in denial copy (plan §6). */
      identifier?: string | null;
    },
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const watchdogScope = await resolveTaskWatchdogMutationScope(db, req.actor);
    if (watchdogScope.kind !== "none") {
      const scopeResult = await taskWatchdogScopeAllowsIssueMutation(db, watchdogScope, issue);
      if (scopeResult.kind === "invalid") {
        res.status(403).json({
          error: scopeResult.detail,
          details: {
            issueId: issue.id,
            securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
          },
        });
        return false;
      }
      return assertFreshTaskWatchdogSourceMutation(res, watchdogScope, issue);
    }
    const boundaryDecision = await decideIssueAccess(req, issue, "issue:comment");
    if (!boundaryDecision.allowed) {
      return denyIssueWrite(req, res, issue, issueWriteDenialCodeForDecision(boundaryDecision));
    }
    return boundaryDecision;
  }

  function isIssueMentionGrantDecision(decision: true | Awaited<ReturnType<typeof decideIssueAccess>>) {
    return decision !== true && decision.reason === "allow_issue_mention_grant";
  }

  function isDirectParentReportDecision(decision: true | Awaited<ReturnType<typeof decideIssueAccess>>) {
    return decision !== true && decision.reason === "allow_direct_parent_report";
  }

  function isDefaultOpenIssueWriteDecision(decision: true | Awaited<ReturnType<typeof decideIssueAccess>>) {
    return decision !== true && decision.reason === "allow_visible_issue_write";
  }

  async function filterIssuesForActor<T extends Parameters<typeof decideIssueAccess>[1]>(req: Request, rows: T[]) {
    const decisions = await Promise.all(rows.map((issue) => decideIssueAccess(req, issue, "issue:read")));
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  async function actorCanReadCompanyScope(req: Request, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    return decision.allowed;
  }

  function requireAgentRunId(req: Request, res: Response) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (runId) return runId;
    res.status(401).json({ error: "Agent run id required" });
    return null;
  }

  async function hasActiveCheckoutManagementOverride(
    actorAgentId: string,
    companyId: string,
    assigneeAgentId: string,
  ) {
    const decision = await access.decide({
      actor: { type: "agent", agentId: actorAgentId, companyId },
      action: "tasks:manage_active_checkouts",
      resource: { type: "issue", companyId, assigneeAgentId },
    });
    return decision.allowed;
  }

  async function assertAgentIssueMutationAllowed(
    req: Request,
    res: Response,
    issue: {
      id: string;
      companyId: string;
      projectId: string | null;
      parentId: string | null;
      status: string;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      reviewPolicy?: IssueReviewPolicy | null;
      /** Used only to name the task in denial copy (plan §6). */
      identifier?: string | null;
    },
    options: { allowVisibleIssueWrite?: boolean } = {},
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    // Task-watchdog runs receive a scoped *grant* to mutate issues inside the
    // watched subtree. This must be evaluated before the base assignee-ownership
    // boundary below: that boundary denies an agent mutating an issue owned by a
    // different agent, which is exactly the watchdog's primary job
    // (SPEC-implementation §9.9 — comment, transition, reassign within the
    // watched subtree). The watchdog scope can only widen access to the watched
    // subtree; downstream status-transition, assignment, recovery, and budget
    // guards in the route handlers still apply.
    const watchdogScope = await resolveTaskWatchdogMutationScope(db, req.actor);
    if (watchdogScope.kind !== "none") {
      const scopeResult = await taskWatchdogScopeAllowsIssueMutation(db, watchdogScope, issue);
      if (scopeResult.kind === "invalid") {
        res.status(403).json({
          error: scopeResult.detail,
          details: {
            issueId: issue.id,
            securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
          },
        });
        return false;
      }
      return assertFreshTaskWatchdogSourceMutation(res, watchdogScope, issue);
    }
    const boundaryDecision = await decideIssueAccess(req, issue, "issue:mutate");
    if (!boundaryDecision.allowed) {
      return denyIssueWrite(req, res, issue, issueWriteDenialCodeForDecision(boundaryDecision));
    }
    if (issue.assigneeAgentId === null) {
      return true;
    }
    if (issue.assigneeAgentId !== actorAgentId) {
      if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)) {
        return true;
      }
      if (issue.status === "in_progress") {
        // Run/checkout ownership stays assignee-scoped even though writes are
        // open, so this lock clears on its own — the copy routes to comments.
        return denyIssueWrite(req, res, issue, "issue_write_assignee_run_lock", {
          issueId: issue.id,
          assigneeAgentId: issue.assigneeAgentId,
          actorAgentId,
        });
      }
      // Past the run lock the issue is idle, so only channels that have not
      // adopted the default-open rule still refuse another agent's issue.
      if (!options.allowVisibleIssueWrite) {
        res.status(403).json({
          error: "Agent cannot mutate another agent's issue",
          details: {
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            actorAgentId,
            status: issue.status,
            securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
          },
        });
        return false;
      }
      return true;
    }
    if (issue.status !== "in_progress") {
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
        agentApiKeyId: actor.agentApiKeyId,
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

  async function assertFreshTaskWatchdogSourceMutation(
    res: Response,
    scope: Awaited<ReturnType<typeof resolveTaskWatchdogMutationScope>>,
    issue: { id: string },
  ) {
    if (scope.kind !== "watchdog") return true;
    if (scope.watchdogIssueId && issue.id === scope.watchdogIssueId) return true;

    const revalidated = await taskWatchdogsSvc.revalidateMutationScope(scope);
    if (revalidated.allowed) return true;
    res.status(409).json({
      error: revalidated.reason,
      details: {
        watchedIssueId: scope.watchedIssueId,
        watchdogId: scope.watchdogId,
        runStopFingerprint: scope.stopFingerprint,
        currentState: revalidated.classification?.state ?? null,
        currentStopFingerprint: revalidated.classification && "stopFingerprint" in revalidated.classification
          ? revalidated.classification.stopFingerprint
          : null,
      },
    });
    return false;
  }

  async function rejectTaskWatchdogConfigMutation(req: Request, res: Response) {
    if (req.actor.type !== "agent") return false;
    const scope = await resolveTaskWatchdogMutationScope(db, req.actor);
    if (scope.kind !== "watchdog") return false;
    res.status(403).json({
      error: "Task-watchdog runs cannot change watchdog configuration.",
      details: {
        watchedIssueId: scope.watchedIssueId,
        watchdogId: scope.watchdogId,
        securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
      },
    });
    return true;
  }

  async function assertTaskWatchdogIssueMutationAllowed(
    req: Request,
    res: Response,
    issue: {
      id: string;
      companyId: string;
      parentId?: string | null;
    },
    opts: { allowWatchdogIssue?: boolean } = {},
  ) {
    if (req.actor.type !== "agent") return true;
    const scope = await resolveTaskWatchdogMutationScope(db, req.actor);
    if (scope.kind === "none") return true;
    const result = await taskWatchdogScopeAllowsIssueMutation(db, scope, issue, opts);
    if (result.kind !== "invalid") return assertFreshTaskWatchdogSourceMutation(res, scope, issue);
    res.status(403).json({
      error: result.detail,
      details: {
        issueId: issue.id,
        securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
      },
    });
    return false;
  }

  function denyIssueThreadInteractionResolution(
    res: Response,
    input: {
      status: number;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    },
  ) {
    res.status(input.status).json({
      error: input.message,
      code: input.code,
      details: { code: input.code, ...(input.details ?? {}) },
    });
    return false as const;
  }

  async function assertAgentInteractionRunAttribution(
    req: Request,
    res: Response,
    issue: {
      id: string;
      companyId: string;
    },
  ) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (!req.actor.agentId || !runId) {
      return denyIssueThreadInteractionResolution(res, {
        status: 422,
        code: "interaction_run_attribution_required",
        message: "A valid authenticated agent run is required to resolve this issue-thread interaction",
      });
    }

    const run = await db
      .select({
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        responsibleUserId: heartbeatRuns.responsibleUserId,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, issue.companyId),
        eq(heartbeatRuns.agentId, req.actor.agentId),
      ))
      .then((rows) => rows[0] ?? null);
    const actorResponsibleUserId = req.actor.onBehalfOfUserId?.trim() || null;
    if (
      !run
      || run.companyId !== issue.companyId
      || run.agentId !== req.actor.agentId
      || (
        actorResponsibleUserId !== null
        && run.responsibleUserId !== undefined
        && run.responsibleUserId !== actorResponsibleUserId
      )
    ) {
      return denyIssueThreadInteractionResolution(res, {
        status: 422,
        code: "interaction_run_attribution_required",
        message: "The authenticated agent run is not valid for this issue-thread interaction",
      });
    }
    return runId;
  }

  async function assertIssueThreadInteractionContainmentAllowed(
    req: Request,
    res: Response,
    issue: Parameters<typeof assertAgentIssueMutationAllowed>[2],
  ) {
    if (req.actor.type !== "agent") return true;
    if (await actorIsLowTrustReview(req, issue.companyId, issue)) {
      return denyIssueThreadInteractionResolution(res, {
        status: 403,
        code: "interaction_scope_denied",
        message: "This issue-thread interaction is outside the actor's trusted control-plane scope",
      });
    }

    const watchdogScope = await resolveTaskWatchdogMutationScope(db, req.actor);
    if (watchdogScope.kind === "invalid") {
      return denyIssueThreadInteractionResolution(res, {
        status: 403,
        code: "interaction_scope_denied",
        message: watchdogScope.detail,
      });
    }
    if (watchdogScope.kind !== "none") {
      const scopeResult = await taskWatchdogScopeAllowsIssueMutation(db, watchdogScope, issue);
      if (scopeResult.kind === "invalid") {
        return denyIssueThreadInteractionResolution(res, {
          status: 403,
          code: "interaction_scope_denied",
          message: scopeResult.detail,
        });
      }
      const revalidated = await taskWatchdogsSvc.revalidateMutationScope(watchdogScope);
      if (!revalidated.allowed) {
        return denyIssueThreadInteractionResolution(res, {
          status: 403,
          code: "interaction_scope_denied",
          message: "This issue-thread interaction is outside the current watchdog scope",
        });
      }
      return true;
    }

    const boundaryDecision = await decideIssueAccess(req, issue, "issue:mutate");
    if (!boundaryDecision.allowed) {
      return denyIssueThreadInteractionResolution(res, {
        status: 403,
        code: "interaction_scope_denied",
        message: "This issue-thread interaction is outside the actor's authorized issue scope",
      });
    }
    return true;
  }

  async function assertIssueThreadInteractionResolutionAllowed(
    req: Request,
    res: Response,
    issue: Parameters<typeof assertAgentIssueMutationAllowed>[2],
    interaction: {
      id: string;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
      sourceRunId?: string | null;
      effectiveResolverPolicy: string;
      resolverPolicyProvenance?: string | null;
      addresseeAgentId?: string | null;
      addresseeUserId?: string | null;
      kind: string;
      status: string;
      payload?: unknown;
    },
    runId: string | null,
  ) {
    const reviewRestriction = await resolvePendingReviewInteractionRestriction(issue, interaction);
    const resolverPolicyRestriction = reviewRestriction?.restriction ?? null;
    if (reviewRestriction?.binding === "legacy") {
      await assertPendingReviewInteractionVerdictAllowed(req, issue, interaction);
    }
    const payload = interaction.payload && typeof interaction.payload === "object"
      ? interaction.payload as { toolAction?: unknown; secretProposal?: unknown }
      : null;
    const actor = getActorInfo(req);
    const decision: IssueThreadInteractionResolverAudienceDecision =
      evaluateIssueThreadInteractionResolverAudience({
        actor: actor.actorType === "agent"
          ? { type: "agent", agentId: actor.agentId, runId: runId || actor.runId }
          : { type: "user", userId: actor.actorId },
        interaction,
        additionalRestriction: resolverPolicyRestriction,
        governedAction:
          interaction.kind === "request_confirmation"
          && (payload?.toolAction !== undefined || payload?.secretProposal !== undefined),
      });
    if (!decision.allowed) {
      return denyIssueThreadInteractionResolution(res, {
        status: decision.status,
        code: decision.code,
        message: decision.message,
        details: {
          effectiveResolverPolicy: decision.effectiveResolverPolicy,
          ...(decision.details ?? {}),
        },
      });
    }
    // Resolving an interaction on another run's issue is a cross-issue mutation
    // like a comment or a PATCH, so it consumes the same per-run budget (§9.3,
    // §9.8.1). This runs last: company/resource access, run attribution,
    // containment, and the audience decision have all already passed, and the
    // terminal interaction mutation plus every child-task, continuation,
    // activity, tool, and wake side effect is still downstream. Same-issue
    // resolutions short-circuit inside the counter transaction and are not
    // charged, matching comment/update semantics.
    if (!(await assertCrossIssueInfluenceWithinRunCap(req, res, issue, "interaction_resolution"))) return false;
    return { decision, resolverPolicyRestriction } as const;
  }

  async function getIssueThreadInteractionResolutionAuthorization(
    req: Request,
    res: Response,
    issue: Parameters<typeof assertAgentIssueMutationAllowed>[2],
    interactionId: string,
  ) {
    // Actor-only gates deliberately precede the interaction lookup. An actor
    // outside the issue's trusted/watchdog scope must not learn whether an
    // interaction id exists on that issue.
    const runId = await assertAgentInteractionRunAttribution(req, res, issue);
    if (runId === false) return false;
    if (!(await assertIssueThreadInteractionContainmentAllowed(req, res, issue))) return false;
    if (req.actor.type !== "agent") assertBoard(req);

    const interactionSvc = issueThreadInteractionService(db);
    const current = await interactionSvc.getForIssue(issue, interactionId);
    const resolutionAuthorization = await assertIssueThreadInteractionResolutionAllowed(
      req,
      res,
      issue,
      current,
      runId,
    );
    if (!resolutionAuthorization) return false;
    return { interactionSvc, current, resolutionAuthorization } as const;
  }

  async function assertSuggestedTaskEffectsAllowed(
    req: Request,
    res: Response,
    issue: Parameters<typeof assertAgentIssueMutationAllowed>[2] & {
      projectId: string | null;
    },
    interaction: SuggestTasksInteraction,
    selectedClientKeys: string[] | undefined,
  ) {
    if (req.actor.type !== "agent") return true;
    const { selectedTasks } = resolveSelectedSuggestedTasks({ interaction, selectedClientKeys });
    for (const task of selectedTasks) {
      const explicitParentIssueId = task.parentId ?? interaction.payload.defaultParentId ?? issue.id;
      const parent = explicitParentIssueId === issue.id
        ? issue
        : await svc.getById(explicitParentIssueId);
      if (!parent || parent.companyId !== issue.companyId) {
        return denyIssueThreadInteractionResolution(res, {
          status: 403,
          code: "interaction_governed_action_denied",
          message: "Suggested-task creation is outside the resolver's authorized issue scope",
        });
      }
      try {
        const watchdogScope = await resolveTaskWatchdogMutationScope(db, req.actor);
        if (watchdogScope.kind === "invalid") {
          return denyIssueThreadInteractionResolution(res, {
            status: 403,
            code: "interaction_governed_action_denied",
            message: "Suggested-task creation is outside the current watchdog scope",
          });
        }
        if (watchdogScope.kind !== "none") {
          const scopeResult = await taskWatchdogScopeAllowsIssueMutation(
            db,
            watchdogScope,
            parent,
            { allowWatchdogIssue: false },
          );
          if (scopeResult.kind === "invalid") {
            return denyIssueThreadInteractionResolution(res, {
              status: 403,
              code: "interaction_governed_action_denied",
              message: "Suggested-task creation is outside the current watchdog scope",
            });
          }
          const revalidated = await taskWatchdogsSvc.revalidateMutationScope(watchdogScope);
          if (!revalidated.allowed) {
            return denyIssueThreadInteractionResolution(res, {
              status: 403,
              code: "interaction_governed_action_denied",
              message: "Suggested-task creation is outside the current watchdog scope",
            });
          }
        }
        await assertTaskBridgeCreateAllowed(req, issue.companyId, {
          projectId: task.projectId ?? issue.projectId,
          parentIssueId: parent.id,
          assigneeAgentId: task.assigneeAgentId ?? null,
          assigneeUserId: task.assigneeUserId ?? null,
        });
        if (task.assigneeAgentId || task.assigneeUserId) {
          await assertCanAssignTasks(req, issue.companyId, {
            projectId: task.projectId ?? issue.projectId,
            parentIssueId: parent.id,
            assigneeAgentId: task.assigneeAgentId ?? null,
            assigneeUserId: task.assigneeUserId ?? null,
          });
        }
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 403) throw error;
        return denyIssueThreadInteractionResolution(res, {
          status: 403,
          code: "interaction_governed_action_denied",
          message: "Suggested-task creation requires independent authorization for every selected task",
        });
      }
    }
    return true;
  }

  async function resolvePendingReviewInteractionRestriction(
    issue: {
      id: string;
      companyId: string;
      status: string;
      reviewPolicy?: IssueReviewPolicy | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    },
    interaction: {
      id: string;
      kind: string;
      status: string;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    },
  ): Promise<{
    restriction: IssueThreadInteractionCanonicalResolverPolicy | IssueThreadInteractionResolverRestriction;
    binding: "explicit" | "legacy";
  } | null> {
    if (
      issue.status !== "in_review"
      || interaction.status !== "pending"
      || (
        interaction.kind !== "request_confirmation"
        && interaction.kind !== "request_checkbox_confirmation"
      )
    ) return null;
    if (!(await isIssueReviewVerdictInteraction(db, { issue, interaction }))) return null;
    const requester = await resolveIssueReviewRequester(db, issue);
    const binding = requester?.reviewInteractionId === interaction.id ? "explicit" : "legacy";
    if (issue.reviewPolicy == null || issue.reviewPolicy === "anyone") {
      return { restriction: "anyone", binding };
    }
    if (issue.reviewPolicy === "human_only") {
      return { restriction: { policy: "human_only", source: "issue_review" }, binding };
    }
    return {
      restriction: {
        policy: "not_creator",
        source: "issue_review",
        excludedActor: requester ? { type: requester.type, id: requester.id } : null,
      },
      binding,
    };
  }

  async function assertPendingReviewInteractionVerdictAllowed(
    req: Request,
    issue: {
      id: string;
      companyId: string;
      status: string;
      reviewPolicy?: IssueReviewPolicy | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    },
    interaction: {
      id: string;
      kind: string;
      status: string;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    },
  ) {
    if (
      issue.status !== "in_review"
      || interaction.status !== "pending"
      || (
        interaction.kind !== "request_confirmation"
        && interaction.kind !== "request_checkbox_confirmation"
      )
      || issue.reviewPolicy == null
      || issue.reviewPolicy === "anyone"
    ) return;
    if (!(await isIssueReviewVerdictInteraction(db, { issue, interaction }))) return;
    const actor = getActorInfo(req);
    await assertIssueReviewVerdictActorAllowed(db, {
      issue,
      actor: { type: actor.actorType, id: actor.actorId },
    });
  }

  async function assertIssueThreadInteractionWithdrawalAllowed(
    req: Request,
    res: Response,
    issue: Parameters<typeof assertAgentIssueMutationAllowed>[2],
    interaction: { createdByAgentId?: string | null },
  ) {
    if (req.actor.type !== "agent") {
      assertBoard(req);
      return true;
    }
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId || await assertAgentInteractionRunAttribution(req, res, issue) === false) return false;
    if (!(await assertIssueThreadInteractionContainmentAllowed(req, res, issue))) return false;

    const isCreator = interaction.createdByAgentId === actorAgentId;
    const isAssignee = issue.assigneeAgentId === actorAgentId;
    if (!isCreator && !isAssignee) {
      res.status(403).json({ error: "Only the interaction creator, current issue assignee, or a board user may withdraw it" });
      return false;
    }
    if (isAssignee) return assertAgentIssueMutationAllowed(req, res, issue);
    return true;
  }

  async function assertTaskWatchdogCreateIssueAllowed(
    req: Request,
    res: Response,
    companyId: string,
    parent: {
      id: string;
      companyId: string;
      parentId?: string | null;
    } | null,
  ) {
    if (req.actor.type !== "agent") return true;
    const scope = await resolveTaskWatchdogMutationScope(db, req.actor);
    if (scope.kind === "none") return true;
    if (scope.kind === "invalid") {
      res.status(403).json({
        error: scope.detail,
        details: {
          securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
        },
      });
      return false;
    }
    if (!parent) {
      res.status(403).json({
        error: "Task-watchdog runs must create issues inside the watched issue subtree.",
        details: {
          companyId,
          watchedIssueId: scope.watchedIssueId,
          securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
        },
      });
      return false;
    }
    const result = await taskWatchdogScopeAllowsIssueMutation(db, scope, parent, { allowWatchdogIssue: false });
    if (result.kind !== "invalid") return assertFreshTaskWatchdogSourceMutation(res, scope, parent);
    res.status(403).json({
      error: result.detail,
      details: {
        parentIssueId: parent.id,
        securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
      },
    });
    return false;
  }

  async function resolveWatchdogFollowUpSerializationContext(
    req: Request,
    parent: {
      id: string;
      companyId: string;
      status?: string | null;
      originKind?: string | null;
    },
  ) {
    if (parent.originKind === TASK_WATCHDOG_ORIGIN_KIND) {
      return {
        enabled: true as const,
        watchdogParentIssueId: parent.id,
      };
    }
    if (req.actor.type !== "agent") return null;
    const scope = await resolveTaskWatchdogMutationScope(db, req.actor);
    if (scope.kind !== "watchdog") return null;
    return {
      enabled: true as const,
      watchdogParentIssueId: scope.watchdogIssueId,
    };
  }

  function mergeIssueBlockerIds(
    existing: unknown,
    blockerIssueId: string | null | undefined,
  ) {
    const current = Array.isArray(existing)
      ? existing.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    return blockerIssueId ? [...new Set([...current, blockerIssueId])] : [...new Set(current)];
  }

  async function findCurrentSerializedWatchdogChild(parent: { id: string; companyId: string }) {
    const children = await db
      .select({
        id: issueRows.id,
        status: issueRows.status,
      })
      .from(issueRows)
      .where(and(
        eq(issueRows.companyId, parent.companyId),
        eq(issueRows.parentId, parent.id),
        inArray(issueRows.status, ["todo", "in_progress", "in_review", "blocked"]),
        isNull(issueRows.hiddenAt),
      ))
      .orderBy(asc(issueRows.issueNumber), asc(issueRows.createdAt), asc(issueRows.id));
    return children[0] ?? null;
  }

  async function blockWatchdogParentOnCurrentChild(input: {
    actor: ReturnType<typeof getActorInfo>;
    watchdogParentIssueId: string | null | undefined;
    currentChildIssueId: string | null | undefined;
  }) {
    if (!input.watchdogParentIssueId || !input.currentChildIssueId) return;
    const watchdogParent = await svc.getById(input.watchdogParentIssueId);
    if (!watchdogParent || watchdogParent.originKind !== TASK_WATCHDOG_ORIGIN_KIND) return;
    if (watchdogParent.status !== "in_progress" && watchdogParent.status !== "blocked") return;

    const relations = await svc.getRelationSummaries(watchdogParent.id);
    const nextBlockedByIssueIds = mergeIssueBlockerIds(
      relations.blockedBy?.map((relation) => relation.id) ?? [],
      input.currentChildIssueId,
    );
    await svc.update(watchdogParent.id, {
      status: "blocked",
      blockedByIssueIds: nextBlockedByIssueIds,
      actorAgentId: input.actor.agentId,
      actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
    });
    await logActivity(db, {
      companyId: watchdogParent.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      agentApiKeyId: input.actor.agentApiKeyId,
      action: "issue.task_watchdog_followups_serialized",
      entityType: "issue",
      entityId: watchdogParent.id,
      details: {
        watchdogParentIssueId: watchdogParent.id,
        currentChildIssueId: input.currentChildIssueId,
        blockedByIssueIds: nextBlockedByIssueIds,
      },
    });
  }

  function normalizeWatchdogDiscovery(input: unknown): {
    kind: IssueWatchdogDiscoveryKind;
    evidenceMarkdown: string | null;
  } | null {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    const kind = typeof record.kind === "string" &&
      (ISSUE_WATCHDOG_DISCOVERY_KINDS as readonly string[]).includes(record.kind)
      ? record.kind as IssueWatchdogDiscoveryKind
      : null;
    if (!kind) return null;
    const evidenceMarkdown =
      typeof record.evidenceMarkdown === "string" && record.evidenceMarkdown.trim().length > 0
        ? record.evidenceMarkdown.trim()
        : null;
    return { kind, evidenceMarkdown };
  }

  function issueMarkdownLink(issue: { id: string; identifier?: string | null }) {
    const identifier = issue.identifier?.trim();
    if (!identifier) return `\`${issue.id}\``;
    const prefix = identifier.split("-")[0] || "PAP";
    return `[${identifier}](/${prefix}/issues/${identifier})`;
  }

  function appendWatchdogDiscoveryContext(input: {
    description: string | null | undefined;
    discovery: { kind: IssueWatchdogDiscoveryKind; evidenceMarkdown: string | null };
    sourceIssue: { id: string; identifier?: string | null };
    watchdogIssue: { id: string; identifier?: string | null } | null;
    stopFingerprint: string | null;
    runId: string | null;
  }) {
    const contextLines = [
      "## Watchdog Discovery",
      "",
      `Kind: \`${input.discovery.kind}\``,
      `Watched source issue: ${issueMarkdownLink(input.sourceIssue)}`,
      input.watchdogIssue ? `Watchdog issue: ${issueMarkdownLink(input.watchdogIssue)}` : null,
      input.stopFingerprint ? `Stopped fingerprint: \`${input.stopFingerprint}\`` : null,
      input.runId ? `Watchdog run: \`${input.runId}\`` : null,
      input.discovery.evidenceMarkdown ? "" : null,
      input.discovery.evidenceMarkdown ? "Evidence:" : null,
      input.discovery.evidenceMarkdown ?? null,
    ].filter((line): line is string => line != null);
    const existing = input.description?.trim();
    return existing ? `${existing}\n\n${contextLines.join("\n")}` : contextLines.join("\n");
  }

  async function resolveTaskWatchdogProductBugFollowUp(
    req: Request,
    res: Response,
    companyId: string,
    discovery: { kind: IssueWatchdogDiscoveryKind; evidenceMarkdown: string | null } | null,
  ) {
    if (!discovery) return null;
    if (req.actor.type !== "agent") {
      res.status(403).json({
        error: "Only task-watchdog agent runs can create watchdog-discovered product bug follow-ups",
      });
      return false;
    }
    const scope = await resolveTaskWatchdogMutationScope(db, req.actor);
    if (scope.kind === "none") {
      res.status(403).json({ error: "Only task-watchdog runs can create watchdog-discovered product bug follow-ups" });
      return false;
    }
    if (scope.kind === "invalid") {
      res.status(403).json({
        error: scope.detail,
        details: {
          securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
        },
      });
      return false;
    }
    if (scope.companyId !== companyId) {
      res.status(403).json({ error: "Task-watchdog product bug follow-up target is outside the watchdog company" });
      return false;
    }

    const sourceIssue = await svc.getById(scope.watchedIssueId);
    if (!sourceIssue || sourceIssue.companyId !== companyId) {
      res.status(404).json({ error: "Watched source issue not found" });
      return false;
    }
    const watchdogIssue = scope.watchdogIssueId ? await svc.getById(scope.watchdogIssueId) : null;
    if (watchdogIssue && watchdogIssue.companyId !== companyId) {
      res.status(403).json({ error: "Task-watchdog product bug evidence issue is outside the watchdog company" });
      return false;
    }

    return { scope, discovery, sourceIssue, watchdogIssue };
  }

  function isStatusOnlyRecoveryContext(contextSnapshot: unknown) {
    if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
    const context = contextSnapshot as Record<string, unknown>;
    return context.recoveryIntent === "status_only" &&
      context.allowDeliverableWork === false &&
      context.allowDocumentUpdates === false &&
      context.resumeRequiresNormalModel === true;
  }

  async function loadActorRunContext(req: Request, companyId: string) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (!runId) return null;
    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return null;
    return run;
  }

  function readObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  async function deriveRecoveryCommentPresentation(
    req: Request,
    companyId: string,
    body: string,
  ): Promise<IssueCommentPresentation | null> {
    const run = await loadActorRunContext(req, companyId);
    if (!run) return null;

    const context = readObject(run.contextSnapshot);
    const paperclipWake = readObject(context.paperclipWake);
    const recovery = readObject(paperclipWake.recovery);
    const wakeReason = typeof context.wakeReason === "string"
      ? context.wakeReason
      : typeof paperclipWake.reason === "string"
        ? paperclipWake.reason
        : null;
    if (wakeReason !== "source_scoped_recovery_action") return null;

    const recoveryCause = typeof context.recoveryCause === "string"
      ? context.recoveryCause
      : typeof recovery.cause === "string"
        ? recovery.cause
        : null;
    if (
      recoveryCause === "successful_run_missing_state" ||
      recoveryCause === "successful_run_missing_issue_disposition"
    ) {
      return null;
    }

    const firstLine = body.split(/\r?\n/, 1)[0]?.trim() || "Recovery update";
    const title = firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
    return {
      kind: "system_notice",
      tone: "info",
      title,
      detailsDefaultOpen: false,
      density: "compact",
    };
  }

  async function assertDeliverableMutationAllowedByRunContext(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string },
  ) {
    const run = await loadActorRunContext(req, issue.companyId);
    if (!run) return true;
    if (!isStatusOnlyRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Status-only recovery runs cannot update issue documents, plans, or deliverable artifacts",
      details: {
        issueId: issue.id,
        runId: run.id,
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
      },
    });
    return false;
  }

  async function assertApprovalMutationAllowedByRunContext(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string },
  ) {
    const run = await loadActorRunContext(req, issue.companyId);
    if (!run) return true;
    if (!isStatusOnlyRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Status-only recovery runs cannot create or modify approvals",
      details: {
        issueId: issue.id,
        runId: run.id,
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
      },
    });
    return false;
  }

  async function loadWorkProductRunAttribution(runId: string) {
    return await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        agentCompanyId: agents.companyId,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function resolveWorkProductCreatedByRunId(
    req: Request,
    res: Response,
    companyId: string,
    input: { createdByRunId?: string | null },
    mode: "create" | "update",
  ): Promise<string | null | undefined> {
    const hasCreatedByRunId = Object.prototype.hasOwnProperty.call(input, "createdByRunId");
    if (mode === "update" && !hasCreatedByRunId) return undefined;

    const requestedRunId = input.createdByRunId ?? null;
    if (req.actor.type === "agent") {
      const actorRunId = req.actor.runId?.trim() || null;
      if (requestedRunId && requestedRunId !== actorRunId) {
        res.status(403).json({ error: "createdByRunId must match the authenticated agent run" });
        return undefined;
      }
      if (!actorRunId) return requestedRunId;
      const run = await loadWorkProductRunAttribution(actorRunId);
      if (!run || run.companyId !== companyId || run.agentCompanyId !== companyId || run.agentId !== req.actor.agentId) {
        res.status(403).json({ error: "createdByRunId is not valid for this work product actor" });
        return undefined;
      }
      return actorRunId;
    }

    if (!requestedRunId) return null;
    const run = await loadWorkProductRunAttribution(requestedRunId);
    if (!run || run.companyId !== companyId || run.agentCompanyId !== companyId) {
      res.status(403).json({ error: "createdByRunId is not valid for this company" });
      return undefined;
    }
    return requestedRunId;
  }

  function assertStructuredCommentFieldsAllowed(
    req: Request,
    res: Response,
    input: { presentation?: unknown; metadata?: unknown },
  ) {
    const hasStructuredFields = input.presentation !== undefined || input.metadata !== undefined;
    if (!hasStructuredFields) return true;
    if (req.actor.type === "board") return true;
    res.status(403).json({
      error: "Only board users may set structured comment presentation or metadata",
      details: {
        securityPrinciples: ["Least Privilege", "Secure Defaults", "Complete Mediation"],
      },
    });
    return false;
  }

  async function assertExplicitResumeIntentAllowed(
    req: Request,
    res: Response,
    issue: Parameters<typeof decideIssueAccess>[1],
    options: { resumeIntent?: boolean } = {},
  ) {
    if (await assertLowTrustControlPlaneDenied(req, res, issue.companyId, issue)) return false;

    // Structured resume intent is the sole comment surface that may revive a
    // cancelled issue. Bare status transitions and `reopen` keep using the
    // dedicated restore-flow guard.
    if (issue.status === "cancelled" && options.resumeIntent !== true) {
      res.status(409).json({
        error: "Cancelled issues must be restored through the dedicated restore flow",
        details: {
          issueId: issue.id,
          status: issue.status,
        },
      });
      return false;
    }

    if (!isExplicitResumeCapableStatus(issue.status)) {
      res.status(409).json({
        error: "Issue is not resumable through comment follow-up intent",
        details: { issueId: issue.id, status: issue.status },
      });
      return false;
    }

    const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issue.companyId, issue.id);
    if (activePauseHold) {
      res.status(409).json({
        error: "Issue follow-up blocked by active subtree pause hold",
        details: {
          issueId: issue.id,
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
        },
      });
      return false;
    }

    if (issue.status === "blocked") {
      const readiness = await svc.getDependencyReadiness(issue.id);
      if (readiness.unresolvedBlockerCount > 0) {
        res.status(409).json({
          error: "Issue follow-up blocked by unresolved blockers",
          details: {
            issueId: issue.id,
            unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
          },
        });
        return false;
      }
    }

    if (req.actor.type !== "agent") return true;

    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (!issue.assigneeAgentId) {
      res.status(409).json({
        error: "Issue follow-up requires an assigned agent",
        details: { issueId: issue.id, actorAgentId },
      });
      return false;
    }
    if (issue.assigneeAgentId === actorAgentId) return true;
    if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)) {
      return true;
    }
    const boundaryDecision = await decideIssueAccess(req, issue, "issue:mutate");
    if (isDefaultOpenIssueWriteDecision(boundaryDecision)) return true;

    res.status(403).json({
      error: "Agent cannot request follow-up for another agent's issue",
      details: {
        issueId: issue.id,
        assigneeAgentId: issue.assigneeAgentId,
        actorAgentId,
      },
    });
    return false;
  }

  async function requireRecoveryActionAuthority(
    req: Request,
    issue: { id: string; companyId: string; assigneeAgentId: string | null },
    activeRecoveryAction: Awaited<ReturnType<typeof recoveryActionsSvc.getActiveForIssue>>,
    input: { source: "issue_update" | "recovery_action_resolution" },
  ) {
    if (req.actor.type !== "agent") return true;
    if (!activeRecoveryAction) return true;

    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      throw forbidden("Agent authentication required");
    }
    if (issue.assigneeAgentId === actorAgentId) return true;
    if (
      issue.assigneeAgentId &&
      await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)
    ) {
      return true;
    }
    if (activeRecoveryAction.ownerAgentId === actorAgentId) return true;
    if (
      activeRecoveryAction.ownerAgentId &&
      await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, activeRecoveryAction.ownerAgentId)
    ) {
      return true;
    }

    throw forbidden(
      "Agent cannot resolve another owner's recovery action",
      {
        issueId: issue.id,
        recoveryActionId: activeRecoveryAction.id,
        actorAgentId,
        assigneeAgentId: issue.assigneeAgentId,
        recoveryOwnerAgentId: activeRecoveryAction.ownerAgentId,
        source: input.source,
        securityPrinciples: ["Least Privilege", "Complete Mediation", "Secure Defaults"],
      },
    );
  }

  function activeExecutionParticipantAgentId(issue: { executionState?: unknown }) {
    const state = parseIssueExecutionState(issue.executionState);
    return state?.status === "pending" && state.currentParticipant?.type === "agent"
      ? state.currentParticipant.agentId
      : null;
  }

  async function requireRecoverySourceMutationAuthority(
    req: Request,
    issue: {
      id: string;
      companyId: string;
      status: string;
      assigneeAgentId: string | null;
      checkoutRunId?: string | null;
      executionRunId?: string | null;
      executionState?: unknown;
    },
  ) {
    if (req.actor.type !== "agent") return;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) throw forbidden("Agent authentication required");

    const isSourceOwner = issue.assigneeAgentId === actorAgentId;
    const isExecutionParticipant = activeExecutionParticipantAgentId(issue) === actorAgentId;
    const hasPolicyGrant = Boolean(
      issue.assigneeAgentId &&
      await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)
    );
    if (!isSourceOwner && !isExecutionParticipant && !hasPolicyGrant) {
      throw forbidden(
        "Recovery ownership does not authorize this source issue mutation",
        {
          code: "recovery_source_authority_required",
          issueId: issue.id,
          actorAgentId,
          assigneeAgentId: issue.assigneeAgentId,
          currentExecutionParticipantAgentId: activeExecutionParticipantAgentId(issue),
          remediation:
            "Have the source owner, current execution participant, board, or a policy-authorized agent perform the source mutation.",
          securityPrinciples: ["Least Privilege", "Complete Mediation", "Secure Defaults"],
        },
      );
    }

    const actorRunId = req.actor.runId?.trim() || null;
    const conflictingRunId = [issue.checkoutRunId, issue.executionRunId]
      .find((runId) => runId && runId !== actorRunId);
    if (conflictingRunId && !hasPolicyGrant) {
      throw conflict("Source issue mutation is locked by another active checkout or run", {
        code: "recovery_source_run_lock",
        issueId: issue.id,
        actorAgentId,
        actorRunId,
        checkoutRunId: issue.checkoutRunId ?? null,
        executionRunId: issue.executionRunId ?? null,
      });
    }
    if (isSourceOwner && issue.status === "in_progress" && !actorRunId && !hasPolicyGrant) {
      throw unauthorized("Agent run id required");
    }
  }

  async function assertSafeRecoveryHandBackGates(input: {
    req: Request;
    issue: {
      id: string;
      companyId: string;
      projectId: string | null;
      assigneeAgentId: string | null;
      checkoutRunId?: string | null;
      executionRunId?: string | null;
      executionState?: unknown;
    };
    recoveryAction: NonNullable<Awaited<ReturnType<typeof recoveryActionsSvc.getActiveForIssue>>>;
  }) {
    const returnOwnerAgentId = input.recoveryAction.returnOwnerAgentId;
    if (!returnOwnerAgentId || input.issue.assigneeAgentId !== returnOwnerAgentId) {
      throw forbidden(
        "Safe recovery hand-back requires the recorded original owner to remain assigned",
        {
          code: "recovery_safe_hand_back_owner_mismatch",
          issueId: input.issue.id,
          assigneeAgentId: input.issue.assigneeAgentId,
          returnOwnerAgentId,
        },
      );
    }
    const actorRunId = input.req.actor.type === "agent"
      ? input.req.actor.runId?.trim() || null
      : null;
    const conflictingRunId = [input.issue.checkoutRunId, input.issue.executionRunId]
      .find((runId) => runId && runId !== actorRunId);
    if (conflictingRunId) {
      throw conflict("Safe recovery hand-back is locked by another active checkout or run", {
        code: "recovery_source_run_lock",
        issueId: input.issue.id,
        actorRunId,
        checkoutRunId: input.issue.checkoutRunId ?? null,
        executionRunId: input.issue.executionRunId ?? null,
      });
    }
    if (parseIssueExecutionState(input.issue.executionState)?.status === "pending") {
      throw conflict("Safe recovery hand-back cannot bypass a pending execution review or approval stage", {
        code: "recovery_governed_stage_pending",
        issueId: input.issue.id,
      });
    }

    const activePauseHold = await treeControlSvc.getActivePauseHoldGate(input.issue.companyId, input.issue.id);
    if (activePauseHold) {
      throw conflict("Safe recovery hand-back blocked by active subtree pause hold", {
        issueId: input.issue.id,
        holdId: activePauseHold.holdId,
        rootIssueId: activePauseHold.rootIssueId,
        mode: activePauseHold.mode,
      });
    }
    if (input.issue.projectId) {
      const project = await projectsSvc.getById(input.issue.projectId);
      if (project?.pausedAt) {
        throw conflict(
          project.pauseReason === "budget"
            ? "Project is paused because its budget hard-stop was reached"
            : "Project is paused",
        );
      }
    }
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(input.issue.id);
    if (approvals.some((approval) => ACTIVE_REVIEW_APPROVAL_STATUSES.has(String(approval.status)))) {
      throw conflict("Safe recovery hand-back cannot bypass a pending governed approval", {
        code: "recovery_governed_approval_pending",
        issueId: input.issue.id,
      });
    }
    const budgetBlock = await budgetService(db).getInvocationBlock(
      input.issue.companyId,
      returnOwnerAgentId,
      { issueId: input.issue.id, projectId: input.issue.projectId },
    );
    if (budgetBlock) {
      throw conflict("Safe recovery hand-back is blocked by the source owner's budget or pause gate", {
        code: "recovery_safe_hand_back_budget_blocked",
        issueId: input.issue.id,
        returnOwnerAgentId,
        budgetBlock,
      });
    }
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

  type IssueQueueDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
  type IssueQueueTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
  type IssueQueueWake = typeof agentWakeupRequests.$inferSelect;
  type IssueQueueRun = typeof heartbeatRuns.$inferSelect;
  type IssueQueueState = {
    wake: IssueQueueWake;
    state: "deferred" | "queued";
    queueRun: IssueQueueRun | null;
  };

  function queueRevision(input: {
    wake: IssueQueueWake | null;
    comments: Array<{ id: string; updatedAt: Date }>;
  }): string {
    return createHash("sha256")
      .update(JSON.stringify({
        queueId: input.wake?.id ?? null,
        comments: input.comments.map((comment) => [comment.id, comment.updatedAt.toISOString()]),
      }))
      .digest("hex")
      .slice(0, 32);
  }

  async function findQueuedCommentWake(
    executor: IssueQueueDb,
    issue: { id: string; companyId: string; assigneeAgentId: string | null },
  ): Promise<IssueQueueState | null> {
    if (!issue.assigneeAgentId) return null;
    const rows = await executor
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, issue.companyId),
        eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
        inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued"]),
      ))
      .orderBy(asc(agentWakeupRequests.requestedAt));

    for (const wake of rows) {
      if (
        readObject(wake.payload).issueId !== issue.id
        || queuedCommentIdsFromWakePayload(wake.payload).length === 0
      ) continue;
      if (wake.status === "deferred_issue_execution") {
        return { wake, state: "deferred", queueRun: null };
      }
      if (!wake.runId) continue;
      const queueRun = await executor
        .select()
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.id, wake.runId),
          eq(heartbeatRuns.companyId, issue.companyId),
          eq(heartbeatRuns.agentId, issue.assigneeAgentId),
          eq(heartbeatRuns.wakeupRequestId, wake.id),
          eq(heartbeatRuns.status, "queued"),
        ))
        .limit(1)
        .then((runRows) => runRows[0] ?? null);
      if (queueRun) return { wake, state: "queued", queueRun };
    }
    return null;
  }

  async function queueCommentsForWake(executor: IssueQueueDb, issueId: string, wake: IssueQueueWake | null) {
    const ids = queuedCommentIdsFromWakePayload(wake?.payload);
    if (ids.length === 0) return [];
    const rows = await executor
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), inArray(issueComments.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row && !row.deletedAt ? [row] : [];
    });
  }

  async function buildQueuedCommentQueue(input: {
    executor: IssueQueueDb;
    issue: { id: string; companyId: string; assigneeAgentId: string | null };
    activeRun: Awaited<ReturnType<typeof resolveActiveIssueRun>>;
    actor: ReturnType<typeof getActorInfo>;
    queueState?: IssueQueueState | null;
    steeringDisposition?: IssueQueuedCommentQueue["steeringDisposition"];
  }): Promise<IssueQueuedCommentQueue> {
    const queueState = input.queueState === undefined
      ? await findQueuedCommentWake(input.executor, input.issue)
      : input.queueState;
    const wake = queueState?.wake ?? null;
    const comments = await queueCommentsForWake(input.executor, input.issue.id, wake);
    const assignedAgent = input.issue.assigneeAgentId
      ? await input.executor
        .select({ adapterType: agents.adapterType })
        .from(agents)
        .where(and(
          eq(agents.id, input.issue.assigneeAgentId),
          eq(agents.companyId, input.issue.companyId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      : null;
    const persistedRuntimeMode = queueState?.state === "queued" && queueState.queueRun
      ? queueState.queueRun.runtimeMode
      : queueState?.state === "deferred" && input.activeRun
        ? input.activeRun.runtimeMode
        : null;
    const protocol = persistedRuntimeMode === "native"
      || (persistedRuntimeMode === null && assignedAgent?.adapterType === "paperclip_runner")
      ? "paperclip_runner_v1" as const
      : "legacy" as const;
    const steeringRun = queueState?.state === "deferred" ? input.activeRun : null;
    let steeringDisposition = input.steeringDisposition
      ?? (protocol === "paperclip_runner_v1" && steeringRun
        ? await getNativeSessionSteeringState(steeringRun.id)
          .then((state) => state.disposition)
          .catch(() => "temporarily_unavailable" as const)
        : "unsupported" as const);
    if (protocol === "paperclip_runner_v1" && (!steeringRun || comments.length === 0)) {
      steeringDisposition = "temporarily_unavailable";
    }
    return {
      issueId: input.issue.id,
      queueId: wake?.id ?? null,
      state: queueState?.state ?? null,
      targetRunId: steeringRun?.id ?? null,
      revision: queueRevision({ wake, comments }),
      protocol,
      steeringDisposition,
      entries: comments.map((comment, position) => ({
        comment: comment as IssueQueuedCommentQueue["entries"][number]["comment"],
        position,
        canEdit: input.actor.actorType === "user" && comment.authorUserId === input.actor.actorId,
        canDiscard: input.actor.actorType === "user" && comment.authorUserId === input.actor.actorId,
      })),
    };
  }

  function assertQueueMutationTarget(input: {
    queue: IssueQueuedCommentQueue;
    queueId: string;
    revision: string;
  }) {
    if (input.queue.queueId !== input.queueId) {
      throw conflict("The queued message targets a stale queue", { code: "queued_comment_stale_queue" });
    }
    if (input.queue.revision !== input.revision) {
      throw conflict("The queued messages changed in another session", { code: "queued_comment_revision_conflict" });
    }
  }

  async function lockQueuedCommentState(input: {
    tx: IssueQueueTx;
    issue: {
      id: string;
      companyId: string;
      assigneeAgentId: string | null;
      executionRunId?: string | null;
    };
    actor: ReturnType<typeof getActorInfo>;
    queueId: string;
    targetRunId?: string;
  }) {
    await input.tx
      .select({ id: issueRows.id })
      .from(issueRows)
      .where(and(eq(issueRows.id, input.issue.id), eq(issueRows.companyId, input.issue.companyId)))
      .for("update");
    const wake = await input.tx
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.id, input.queueId),
        eq(agentWakeupRequests.companyId, input.issue.companyId),
        input.issue.assigneeAgentId
          ? eq(agentWakeupRequests.agentId, input.issue.assigneeAgentId)
          : undefined,
      ))
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !wake
      || readObject(wake.payload).issueId !== input.issue.id
      || queuedCommentIdsFromWakePayload(wake.payload).length === 0
    ) {
      throw conflict("The queued message is no longer pending", { code: "queued_comment_not_pending" });
    }

    let state: IssueQueueState["state"];
    let queueRun: IssueQueueRun | null = null;
    if (wake.status === "deferred_issue_execution") {
      state = "deferred";
    } else if (wake.status === "queued" && wake.runId) {
      queueRun = await input.tx
        .select()
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.id, wake.runId),
          eq(heartbeatRuns.companyId, input.issue.companyId),
          eq(heartbeatRuns.agentId, wake.agentId),
          eq(heartbeatRuns.wakeupRequestId, wake.id),
        ))
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!queueRun || queueRun.status !== "queued") {
        throw conflict("The queued message is already being dispatched", {
          code: "queued_comment_already_dispatching",
        });
      }
      state = "queued";
    } else if (
      wake.status === "claimed"
      || wake.status === "running"
      || (wake.runId && (wake.status === "succeeded" || wake.status === "failed"))
    ) {
      throw conflict("The queued message is already being dispatched", {
        code: "queued_comment_already_dispatching",
      });
    } else {
      throw conflict("The queued message is no longer pending", { code: "queued_comment_not_pending" });
    }

    const activeRunId = state === "deferred"
      ? input.targetRunId ?? input.issue.executionRunId ?? null
      : null;
    const activeRun = activeRunId
      ? await input.tx
        .select()
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.id, activeRunId),
          eq(heartbeatRuns.companyId, input.issue.companyId),
          eq(heartbeatRuns.status, "running"),
        ))
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null)
      : null;
    if (input.targetRunId) {
      const runContext = readObject(activeRun?.contextSnapshot);
      if (!activeRun || (runContext.issueId !== input.issue.id && runContext.taskId !== input.issue.id)) {
        throw conflict("The queued message targets a stale run", { code: "queued_comment_stale_target" });
      }
    }
    const queueState = { wake, state, queueRun } satisfies IssueQueueState;
    const queue = await buildQueuedCommentQueue({
      executor: input.tx,
      issue: input.issue,
      activeRun,
      actor: input.actor,
      queueState,
      steeringDisposition: activeRun?.runtimeMode === "native"
        ? "temporarily_unavailable"
        : "unsupported",
    });
    return { activeRun, wake, queueRun, state, queue, queueState };
  }

  async function updateQueuedRunCommentIds(
    tx: IssueQueueTx,
    queueRun: IssueQueueRun | null,
    ids: string[],
    updatedAt: Date,
  ) {
    if (!queueRun) return null;
    const updated = await tx
      .update(heartbeatRuns)
      .set({
        contextSnapshot: withQueuedCommentIdsInRunContext(queueRun.contextSnapshot, ids),
        updatedAt,
      })
      .where(and(eq(heartbeatRuns.id, queueRun.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) {
      throw conflict("The queued message is already being dispatched", {
        code: "queued_comment_already_dispatching",
      });
    }
    return updated;
  }

  async function discardQueuedComment(input: {
    issue: {
      id: string;
      companyId: string;
      assigneeAgentId: string | null;
      executionRunId?: string | null;
    };
    actor: ReturnType<typeof getActorInfo>;
    commentId: string;
    queueId: string;
    revision?: string;
  }) {
    return db.transaction(async (tx) => {
      const locked = await lockQueuedCommentState({
        tx,
        issue: input.issue,
        actor: input.actor,
        queueId: input.queueId,
      });
      if (input.revision) {
        assertQueueMutationTarget({
          queue: locked.queue,
          queueId: input.queueId,
          revision: input.revision,
        });
      }
      const entry = locked.queue.entries.find(
        (candidate) => candidate.comment.id === input.commentId,
      );
      if (!entry) {
        throw conflict("The queued message is no longer pending", {
          code: "queued_comment_not_pending",
        });
      }
      const actorOwnsEntry = input.actor.actorType === "agent"
        ? entry.comment.authorAgentId === input.actor.agentId
        : entry.comment.authorUserId === input.actor.actorId;
      if (!actorOwnsEntry) {
        throw forbidden("Only the queued message author can discard it");
      }

      const deleted = await tx
        .delete(issueComments)
        .where(and(
          eq(issueComments.id, input.commentId),
          eq(issueComments.issueId, input.issue.id),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!deleted) {
        throw conflict("The queued message is no longer pending", {
          code: "queued_comment_not_pending",
        });
      }
      await issueReferencesSvc.deleteCommentSource(input.commentId, tx);
      await externalObjectsSvc.syncCommentSafely(input.commentId, tx);

      const remainingIds = locked.queue.entries
        .map((candidate) => candidate.comment.id)
        .filter((candidateId) => candidateId !== input.commentId);
      const now = new Date();
      let nextQueueState: IssueQueueState | null = null;

      if (remainingIds.length === 0) {
        await tx
          .update(agentWakeupRequests)
          .set({
            status: "cancelled",
            finishedAt: now,
            error: "Queued message discarded before dispatch",
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, locked.wake.id));

        if (locked.queueRun) {
          const cancelledRun = await tx
            .update(heartbeatRuns)
            .set({
              status: "cancelled",
              finishedAt: now,
              error: "Queued message discarded before dispatch",
              errorCode: "queued_comment_discarded",
              updatedAt: now,
            })
            .where(and(
              eq(heartbeatRuns.id, locked.queueRun.id),
              eq(heartbeatRuns.status, "queued"),
            ))
            .returning({ id: heartbeatRuns.id })
            .then((rows) => rows[0] ?? null);
          if (!cancelledRun) {
            throw conflict("The queued message is already being dispatched", {
              code: "queued_comment_already_dispatching",
            });
          }
        }
      } else {
        const updatedWake = await tx
          .update(agentWakeupRequests)
          .set({
            payload: withQueuedCommentIdsInWakePayload(locked.wake.payload, remainingIds),
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, locked.wake.id))
          .returning()
          .then((rows) => rows[0] ?? locked.wake);
        const updatedQueueRun = await updateQueuedRunCommentIds(
          tx,
          locked.queueRun,
          remainingIds,
          now,
        );
        nextQueueState = {
          wake: updatedWake,
          state: locked.state,
          queueRun: updatedQueueRun ?? locked.queueRun,
        };
      }

      await tx
        .update(issueRows)
        .set({
          ...(locked.queueRun && remainingIds.length === 0
            ? {
                executionRunId: null,
                executionAgentNameKey: null,
                executionLockedAt: null,
              }
            : {}),
          updatedAt: now,
        })
        .where(and(
          eq(issueRows.id, input.issue.id),
          locked.queueRun && remainingIds.length === 0
            ? eq(issueRows.executionRunId, locked.queueRun.id)
            : undefined,
        ));

      return {
        deleted,
        queue: await buildQueuedCommentQueue({
          executor: tx,
          issue: input.issue,
          activeRun: locked.activeRun,
          actor: input.actor,
          queueState: nextQueueState,
        }),
      };
    });
  }

  function operatorInterruptCancelOptions(input: { issueId: string; actor: ReturnType<typeof getActorInfo> }) {
    return {
      errorCode: "operator_interrupted",
      resultJson: {
        operatorInterrupted: true,
        interruptionSource: "issue_comment_interrupt",
        interruptedIssueId: input.issueId,
        interruptedByActorType: input.actor.actorType,
        interruptedByActorId: input.actor.actorId,
      },
      eventMessage: "run interrupted by board comment",
      eventPayload: {
        issueId: input.issueId,
        source: "issue_comment_interrupt",
        interruptedByActorType: input.actor.actorType,
        interruptedByActorId: input.actor.actorId,
      },
    };
  }

  /**
   * Refuse an agent creating a child issue assigned to the agent that created
   * a still-open ancestor in the same chain. That shape is a delegation cycle
   * (A delegates to B, B delegates the same work back to A): each agent lacks
   * something the other assumed it had, the chain of blocked issues grows,
   * and no one tells the human. Humans are unaffected, and closed ancestors
   * do not count — re-engaging the creator of finished work is normal.
   */
  async function assertNoAgentDelegationCycle(input: {
    actorType: string;
    parentIssueId: string | null | undefined;
    assigneeAgentId: string | null | undefined;
  }) {
    if (input.actorType !== "agent") return;
    if (!input.parentIssueId || !input.assigneeAgentId) return;
    const ancestor = await svc.findOpenAncestorCreatedByAgent(input.parentIssueId, input.assigneeAgentId);
    if (!ancestor) return;
    throw conflict(
      `Delegation cycle: ${ancestor.identifier ?? "an ancestor issue"} in this chain was created by the agent this child would be assigned to. ` +
        "Complete the remaining work in your own issue, leave the child unassigned, or escalate to a board operator — do not delegate the work back to the agent that delegated it to you.",
      {
        code: "delegation_cycle",
        ancestorIssueId: ancestor.id,
        assigneeAgentId: input.assigneeAgentId,
      },
    );
  }

  async function normalizeIssueAssigneeAgentReference(
    companyId: string,
    rawAssigneeAgentId: string | null | undefined,
    options: { actorType?: string } = {},
  ) {
    if (rawAssigneeAgentId === undefined || rawAssigneeAgentId === null) {
      return rawAssigneeAgentId;
    }

    const raw = rawAssigneeAgentId.trim();
    if (raw.length === 0) {
      return rawAssigneeAgentId;
    }

    const resolved = await agentsSvc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    if (resolved.agent.status === "pending_approval") {
      throw conflict("Cannot assign work to pending approval agents");
    }
    if (resolved.agent.status === "terminated") {
      throw conflict("Cannot assign work to terminated agents");
    }
    // Agents must not route work to a paused peer/manager: the assignment is
    // accepted silently, nothing will ever run it, and the issue becomes an
    // invisible dead letter (e.g. escalation issues assigned to a paused
    // manager via the org chart). Humans may still assign to paused agents
    // deliberately — the pause state is visible in the UI and staging work
    // for a later unpause is a legitimate workflow.
    if (options.actorType === "agent" && resolved.agent.status === "paused") {
      throw conflict(
        "Cannot assign work to a paused agent. Assign an invokable agent, leave the issue unassigned, or escalate to a board operator instead.",
        { assigneeAgentId: resolved.agent.id, assigneeStatus: "paused" },
      );
    }
    if (resolved.agent.orgChainHealth?.status === "invalid_org_chain") {
      throw conflict(
        resolved.agent.orgChainHealth?.repairGuidance ??
          "Cannot assign work to agents with invalid org chains",
      );
    }
    return resolved.agent.id;
  }
  function toValidTimestamp(value: Date | string | null | undefined) {
    if (!value) return null;
    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function isQueuedIssueCommentForActiveRun(params: {
    comment: {
      authorAgentId?: string | null;
      createdAt?: Date | string | null;
    };
    activeRun: {
      agentId?: string | null;
      startedAt?: Date | string | null;
      createdAt?: Date | string | null;
    };
  }) {
    const activeRunStartedAtMs =
      toValidTimestamp(params.activeRun.startedAt) ?? toValidTimestamp(params.activeRun.createdAt);
    const commentCreatedAtMs = toValidTimestamp(params.comment.createdAt);

    if (activeRunStartedAtMs === null || commentCreatedAtMs === null) return false;
    if (params.comment.authorAgentId && params.comment.authorAgentId === params.activeRun.agentId) return false;
    return commentCreatedAtMs >= activeRunStartedAtMs;
  }
  async function getClosedIssueExecutionWorkspace(issue: { executionWorkspaceId?: string | null }) {
    if (!issue.executionWorkspaceId) return null;
    const workspace = await executionWorkspacesSvc.getById(issue.executionWorkspaceId);
    if (!workspace || !isClosedIsolatedExecutionWorkspace(workspace)) return null;
    return workspace;
  }

  // Reopen the closed isolated workspace that a guard found, so the request can
  // continue. The return value tells the caller what happened:
  //   "reopened"    - this request rebuilt the workspace and set the
  //                   reopen-pending flag. The caller must install the
  //                   consumption guard so the flag cannot leak.
  //   "already-open" - a concurrent request already reopened the workspace, so
  //                   this request did not set the flag. The caller continues but
  //                   must not install the guard, or it can clear the flag that
  //                   the other request still owns.
  //   null          - this function sent an error response, so the caller stops.
  // The reopen is scoped to the issue company and project inside the service, and
  // it runs only after the route already authorized the request on the issue.
  async function reopenClosedIssueExecutionWorkspaceOrRespond(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; projectId?: string | null },
    workspace: Pick<ExecutionWorkspace, "id">,
  ): Promise<{ outcome: "reopened" | "already-open"; generation: number } | null> {
    const actor = getActorInfo(req);
    const result = await executionWorkspacesSvc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId: workspace.id,
      issue: { id: issue.id, companyId: issue.companyId, projectId: issue.projectId ?? null },
      actor: { agentId: actor.agentId, actorType: actor.actorType },
    });
    if (result.ok) {
      return { outcome: result.reopened ? "reopened" : "already-open", generation: result.generation };
    }
    if (result.code === "not_reopenable") {
      res.status(409).json({ error: "This issue is linked to a closed workspace that cannot be reopened." });
    } else {
      res.status(503).json({ error: "Could not reopen the workspace for this issue. Please try again." });
    }
    return null;
  }

  // The keepalive re-stamps the reopen-pending flag on this interval while a
  // consuming request is in flight. The interval is one fifth of the stale grace
  // period, so several re-stamps land before the reaper could treat the flag as
  // stranded. This keeps a live but slow request's fence against the reaper.
  const REOPEN_PENDING_REFRESH_INTERVAL_MS = Math.floor(
    STALE_REOPEN_PENDING_CONSUMPTION_GRACE_MS / 5,
  );

  // Guard a reopen against a caller that never consumes it.
  // `reopenClosedIssueExecutionWorkspaceOrRespond` publishes the rebuilt worktree
  // as active and sets the reopen-pending flag while the source issue is still
  // terminal. The route then moves the issue out of the terminal state, and the
  // terminal reaper clears the flag once it sees the non-terminal issue. If the
  // route mutation returns null, throws, or leaves the issue terminal, the flag
  // stays set and both the reaper and the archive route skip the row forever, so
  // the rebuilt worktree leaks and no path can reclaim it.
  //
  // This guard runs when the response ends, so it covers every exit: a success, a
  // rejected mutation, and a thrown error. It reads the final issue status through
  // a getter. When the issue is null or still terminal, it clears the flag so the
  // reaper can reclaim the worktree. When the issue left the terminal state, it
  // does nothing and the reaper clears the flag. The guard never touches the
  // response, and the underlying clear is idempotent.
  function guardReopenedWorkspaceConsumption(input: {
    req: Request;
    res: Response;
    issue: { id: string; companyId: string };
    workspace: Pick<ExecutionWorkspace, "id"> | null;
    generation: number | null;
    finalIssueStatus: () => string | null | undefined;
  }): void {
    const { req, res, issue, workspace, generation, finalIssueStatus } = input;
    if (!workspace || generation === null) return;
    // Re-stamp the reopen-pending flag while this request is in flight. The
    // request that consumes the rebuilt worktree is an HTTP request, not a
    // heartbeat run, so the terminal reaper cannot see it through
    // `workspaceHasActiveRun`. A request that outruns the stale grace period
    // would let the reaper clear the live fence, and a later sweep would archive
    // and destroy the worktree under the request. The keepalive re-stamps the
    // timestamp on an interval below the grace, so the flag never looks stranded
    // while the request lives. The refresh runs only while the flag is still set
    // and the generation still matches, so it never revives a cleared flag and
    // never refreshes a newer reopen's fence.
    const keepAlive = setInterval(() => {
      void executionWorkspacesSvc
        .refreshReopenPendingConsumption({
          workspaceId: workspace.id,
          expectedGeneration: generation,
        })
        .then((result) => {
          // The fence is no longer ours: a clear removed the flag, or a newer
          // reopen or an archive raised the generation. Stop the keepalive so it
          // does not re-stamp another owner's row.
          if (!result.refreshed) clearInterval(keepAlive);
        })
        .catch((err) => {
          // A transient database error must not stop the keepalive. Keep the
          // interval so the next tick retries before the grace period elapses.
          logger.warn(
            { err, issueId: issue.id, executionWorkspaceId: workspace.id },
            "failed to refresh the reopen-pending flag for an in-flight request",
          );
        });
    }, REOPEN_PENDING_REFRESH_INTERVAL_MS);
    // Do not keep the event loop alive for the keepalive alone.
    keepAlive.unref?.();
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      const status = finalIssueStatus();
      if (typeof status === "string" && !isClosedIssueStatus(status)) return;
      const actor = getActorInfo(req);
      void clearReopenPendingConsumptionWithRetry({
        workspaceId: workspace.id,
        issue: { id: issue.id, companyId: issue.companyId },
        actor: { agentId: actor.agentId, actorType: actor.actorType },
        expectedGeneration: generation,
      });
    };
    res.once("finish", settle);
    res.once("close", settle);
  }

  // Clear the reopen-pending flag with a bounded retry. The response already
  // ended when this runs, so it is a background best-effort. A transient database
  // error must not strand the flag: while the flag stays set, the terminal reaper
  // skips the workspace and the archive route rejects it, so the rebuilt worktree
  // leaks. The clear is idempotent, so a retry after a partial failure is safe.
  // The method returns { cleared: false } without an error when the flag is
  // already clear, so that path does not retry.
  async function clearReopenPendingConsumptionWithRetry(input: {
    workspaceId: string;
    issue: { id: string; companyId: string };
    actor: { agentId: string | null; actorType: string };
    expectedGeneration: number;
  }): Promise<void> {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await executionWorkspacesSvc.clearReopenPendingConsumptionForUnconsumedReopen(input);
        return;
      } catch (err) {
        if (attempt >= maxAttempts) {
          logger.error(
            { err, issueId: input.issue.id, executionWorkspaceId: input.workspaceId, attempts: attempt },
            "failed to clear the reopen-pending flag after an unconsumed reopen; the rebuilt worktree may leak until the flag clears",
          );
          return;
        }
        logger.warn(
          { err, issueId: input.issue.id, executionWorkspaceId: input.workspaceId, attempt },
          "retry the clear of the reopen-pending flag after an unconsumed reopen",
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }

  async function destroyReusableSandboxLeasesForTerminalIssue(issue: {
    id: string;
    companyId: string;
    status: string;
    executionWorkspaceId?: string | null;
  }) {
    try {
      await environmentRuntime.destroyReusableSandboxLeases({
        companyId: issue.companyId,
        issueId: issue.id,
        executionWorkspaceId: issue.executionWorkspaceId ?? null,
        failureReason: `issue_terminal_${issue.status}`,
      });
    } catch (err) {
      logger.warn(
        { err, issueId: issue.id, executionWorkspaceId: issue.executionWorkspaceId ?? null },
        "failed to destroy reusable sandbox leases for terminal issue",
      );
    }
  }

  async function resolveIssueRouteId(rawId: string): Promise<string> {
    const identifier = normalizeIssueReferenceIdentifier(rawId);
    if (identifier) {
      const issue = await svc.getByIdentifier(identifier);
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

  function compactIssueProjectWorkspace(workspace: ProjectWorkspace | null | undefined) {
    if (!workspace) return null;
    return {
      id: workspace.id,
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      name: workspace.name,
      sourceType: workspace.sourceType,
      cwd: workspace.cwd,
      repoUrl: workspace.repoUrl,
      repoRef: workspace.repoRef,
      defaultRef: workspace.defaultRef,
      visibility: workspace.visibility,
      setupCommand: workspace.setupCommand,
      cleanupCommand: workspace.cleanupCommand,
      remoteProvider: workspace.remoteProvider,
      remoteWorkspaceRef: workspace.remoteWorkspaceRef,
      sharedWorkspaceKey: workspace.sharedWorkspaceKey,
      runtimeConfig: workspace.runtimeConfig,
      isPrimary: workspace.isPrimary,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }

  function compactIssueProject(project: Awaited<ReturnType<typeof resolveIssueProjectAndGoal>>["project"]) {
    if (!project) return null;
    return {
      id: project.id,
      companyId: project.companyId,
      urlKey: project.urlKey,
      goalId: project.goalId,
      goalIds: project.goalIds,
      goals: project.goals,
      name: project.name,
      description: project.description,
      status: project.status,
      leadAgentId: project.leadAgentId,
      targetDate: project.targetDate,
      color: project.color,
      icon: project.icon,
      env: null,
      pauseReason: project.pauseReason,
      pausedAt: project.pausedAt,
      executionWorkspacePolicy: project.executionWorkspacePolicy,
      codebase: project.codebase,
      workspaces: (project.workspaces ?? []).map(compactIssueProjectWorkspace),
      primaryWorkspace: compactIssueProjectWorkspace(project.primaryWorkspace),
      managedByPlugin: project.managedByPlugin ?? null,
      taskCount: project.taskCount,
      budget: project.budget,
      archivedAt: project.archivedAt,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  function compactIssueRuntimeService(service: WorkspaceRuntimeService) {
    return {
      id: service.id,
      companyId: service.companyId,
      projectId: service.projectId,
      projectWorkspaceId: service.projectWorkspaceId,
      executionWorkspaceId: service.executionWorkspaceId,
      issueId: service.issueId,
      scopeType: service.scopeType,
      scopeId: service.scopeId,
      serviceName: service.serviceName,
      status: service.status,
      lifecycle: service.lifecycle,
      reuseKey: service.reuseKey,
      command: service.command,
      cwd: service.cwd,
      port: service.port,
      url: service.url,
      provider: service.provider,
      providerRef: service.providerRef,
      ownerAgentId: service.ownerAgentId,
      startedByRunId: service.startedByRunId,
      lastUsedAt: service.lastUsedAt,
      startedAt: service.startedAt,
      stoppedAt: service.stoppedAt,
      healthStatus: service.healthStatus,
      exposure: service.exposure ?? null,
      configIndex: service.configIndex ?? null,
    };
  }

  function compactIssueExecutionWorkspace(workspace: ExecutionWorkspace | null) {
    if (!workspace) return null;
    return {
      id: workspace.id,
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      projectWorkspaceId: workspace.projectWorkspaceId,
      sourceIssueId: workspace.sourceIssueId,
      mode: workspace.mode,
      strategyType: workspace.strategyType,
      name: workspace.name,
      status: workspace.status,
      deliveryState: workspace.deliveryState,
      cwd: workspace.cwd,
      repoUrl: workspace.repoUrl,
      baseRef: workspace.baseRef,
      branchName: workspace.branchName,
      providerType: workspace.providerType,
      providerRef: workspace.providerRef,
      derivedFromExecutionWorkspaceId: workspace.derivedFromExecutionWorkspaceId,
      lastUsedAt: workspace.lastUsedAt,
      openedAt: workspace.openedAt,
      closedAt: workspace.closedAt,
      cleanupEligibleAt: workspace.cleanupEligibleAt,
      cleanupReason: workspace.cleanupReason,
      config: workspace.config
        ? {
            environmentId: workspace.config.environmentId,
            provisionCommand: workspace.config.provisionCommand,
            runtimeProvisionCommand: workspace.config.runtimeProvisionCommand,
            teardownCommand: workspace.config.teardownCommand,
            cleanupCommand: workspace.config.cleanupCommand,
            workspaceRuntime: workspace.config.workspaceRuntime,
            desiredState: workspace.config.desiredState,
            serviceStates: workspace.config.serviceStates,
          }
        : null,
      metadata: null,
      runtimeServices: (workspace.runtimeServices ?? [])
        .filter((service) =>
          service.status === "provisioning" || service.status === "starting" || service.status === "running"
        )
        .map(compactIssueRuntimeService),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await resolveIssueRouteId(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await resolveIssueRouteId(rawId);
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

  router.get("/companies/:companyId/search/extract", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const companyScopeDecision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!companyScopeDecision.allowed) {
      res.status(403).json({ error: "Company search is outside this actor's authorization boundary" });
      return;
    }
    const parsedQuery = companySearchExtractQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: parsedQuery.error.issues[0]?.message ?? "Invalid extract search query",
      });
      return;
    }
    const rateLimit = searchRateLimiter.consume(companySearchRateLimitActor(req, companyId));
    res.setHeader("X-RateLimit-Limit", String(rateLimit.limit));
    res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      res.status(429).json({
        error: "Search rate limit exceeded",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }
    const result = await getSearchService().extract(companyId, parsedQuery.data);
    res.json(result);
  });

  router.get("/companies/:companyId/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const companyScopeDecision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!companyScopeDecision.allowed) {
      res.status(403).json({ error: "Company search is outside this actor's authorization boundary" });
      return;
    }
    const parsedQuery = companySearchQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: parsedQuery.error.issues[0]?.message ?? "Invalid search query",
      });
      return;
    }
    let query = parsedQuery.data;
    if (query.assigneeUserId === "me") {
      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
        return;
      }
      query = { ...query, assigneeUserId: req.actor.userId };
    }
    const rateLimit = searchRateLimiter.consume(companySearchRateLimitActor(req, companyId));
    res.setHeader("X-RateLimit-Limit", String(rateLimit.limit));
    res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      res.status(429).json({
        error: "Search rate limit exceeded",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }
    const result = await getSearchService().search(companyId, query);
    res.json(result);
  });

  router.get("/companies/:companyId/issues", async (req, res) => {
    const startedAt = Date.now();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (isTaskBridgeKeyActor(req)) {
      res.status(403).json({ error: "Task bridge keys cannot use company-wide issue list APIs" });
      return;
    }
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
    const rawLimit = req.query.limit as string | undefined;
    const parsedLimit = rawLimit !== undefined && /^\d+$/.test(rawLimit)
      ? Number.parseInt(rawLimit, 10)
      : null;
    const limit = parsedLimit === null ? ISSUE_LIST_DEFAULT_LIMIT : clampIssueListLimit(parsedLimit);
    const rawOffset = req.query.offset as string | undefined;
    const parsedOffset = rawOffset !== undefined && /^\d+$/.test(rawOffset)
      ? Number.parseInt(rawOffset, 10)
      : null;
    const attention = req.query.attention as string | undefined;
    const sortField = req.query.sortField as string | undefined;
    const sortDir = req.query.sortDir as string | undefined;
    const view = req.query.view as string | undefined;
    const compactView = view === "compact";
    const hasPlanDocument = parseOptionalBooleanQuery(req.query.hasPlanDocument);
    const includeLiveDescendantSummary = parseOptionalBooleanQuery(req.query.includeLiveDescendantSummary);
    const assigneeAgentFilterRaw = req.query.assigneeAgentId;
    let assigneeAgentId: string | null | undefined;
    const rawUpdatedSince = req.query.updatedSince as string | undefined;

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
    if (attention !== undefined && attention !== "blocked") {
      res.status(400).json({ error: "attention must be 'blocked' when provided" });
      return;
    }
    if (view !== undefined && view !== "compact") {
      res.status(400).json({ error: "view must be 'compact' when provided" });
      return;
    }
    if (rawLimit !== undefined && (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      res.status(400).json({ error: `limit must be a positive integer up to ${ISSUE_LIST_MAX_LIMIT}` });
      return;
    }
    if (rawOffset !== undefined && (parsedOffset === null || !Number.isInteger(parsedOffset) || parsedOffset < 0)) {
      res.status(400).json({ error: "offset must be a non-negative integer" });
      return;
    }
    if (sortField !== undefined && sortField !== "updated") {
      res.status(400).json({ error: "sortField must be 'updated' when provided" });
      return;
    }
    if (sortDir !== undefined && sortDir !== "asc" && sortDir !== "desc") {
      res.status(400).json({ error: "sortDir must be 'asc' or 'desc' when provided" });
      return;
    }
    if (hasPlanDocument === null) {
      res.status(400).json({ error: "hasPlanDocument must be true or false when provided" });
      return;
    }
    if (includeLiveDescendantSummary === null) {
      res.status(400).json({ error: "includeLiveDescendantSummary must be true or false when provided" });
      return;
    }
    if (assigneeAgentFilterRaw !== undefined) {
      if (typeof assigneeAgentFilterRaw !== "string") {
        res.status(422).json({ error: "assigneeAgentId must be a UUID or 'null'" });
        return;
      }
      const normalizedAssigneeAgentFilter = assigneeAgentFilterRaw.trim();
      if (normalizedAssigneeAgentFilter.length === 0) {
        assigneeAgentId = undefined;
      } else if (normalizedAssigneeAgentFilter.toLowerCase() === "null") {
        assigneeAgentId = null;
      } else if (isUuidLike(normalizedAssigneeAgentFilter)) {
        assigneeAgentId = normalizedAssigneeAgentFilter;
      } else {
        res.status(422).json({ error: "assigneeAgentId must be a UUID or 'null'" });
        return;
      }
    }
    if (rawUpdatedSince !== undefined && !Number.isFinite(new Date(rawUpdatedSince).getTime())) {
      res.status(400).json({ error: "updatedSince must be a valid ISO 8601 timestamp when provided" });
      return;
    }
    const offset = parsedOffset ?? 0;

    const listFilters: IssueFilters = {
      attention: attention === "blocked" ? "blocked" : undefined,
      status: req.query.status as string | string[] | undefined,
      assigneeAgentId,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId: req.query.projectId as string | undefined,
      workspaceId: req.query.workspaceId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
      parentId: (req.query.parentId ?? req.query.parentIssueId) as string | undefined,
      descendantOf: req.query.descendantOf as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originKindPrefix: req.query.originKindPrefix as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      excludeRoutineExecutions:
        req.query.excludeRoutineExecutions === "true" || req.query.excludeRoutineExecutions === "1",
      includePluginOperations:
        req.query.includePluginOperations === "true" || req.query.includePluginOperations === "1",
      includeBlockedBy: req.query.includeBlockedBy === "true" || req.query.includeBlockedBy === "1",
      includeBlockedInboxAttention:
        req.query.includeBlockedInboxAttention === "true" || req.query.includeBlockedInboxAttention === "1",
      includeLiveDescendantSummary: includeLiveDescendantSummary === true,
      hasPlanDocument,
      q: req.query.q as string | undefined,
      limit,
      offset,
      sortField: sortField === "updated" ? "updated" : undefined,
      sortDir: sortDir === "asc" || sortDir === "desc" ? sortDir : undefined,
      updatedSince: rawUpdatedSince,
    };
    const requestKey = issueListRequestKey({
      req,
      companyId,
      normalizedQuery: {
        ...listFilters,
        view: compactView ? "compact" : undefined,
      },
    });
    const coordinated = await coordinateIssueListGet({
      req,
      companyId,
      requestKey,
      allowTtlCache: compactView,
      diagnostics: opts.issueListDiagnostics,
      compute: async () => {
        const rawResult = await svc.list(companyId, listFilters);
        const result = await actorCanReadCompanyScope(req, companyId)
          ? rawResult
          : await filterIssuesForActor(req, rawResult);
        const issueIds = result.map((issue) => issue.id);
        if (compactView) {
          const [handoffStates, recoveryActionByIssue] = await Promise.all([
            listSuccessfulRunHandoffStates(db, companyId, issueIds),
            recoveryActionsSvc.listActiveForIssues(companyId, issueIds),
          ]);
          const actor = getActorInfo(req);
          await Promise.all(result.map(async (issue) => {
            const activeRecoveryAction = recoveryActionByIssue.get(issue.id) ?? null;
            if (!activeRecoveryAction) return;
            const revalidated = await revalidateActiveSourceRecoveryForRead({
              issue,
              trigger: "read_projection",
              actor,
              activeRecoveryAction,
            });
            if (revalidated) recoveryActionByIssue.set(issue.id, revalidated);
            else recoveryActionByIssue.delete(issue.id);
          }));
          const compactResult = result.map((issue) =>
            toCompactIssue({
              ...issue,
              activeRecoveryAction: recoveryActionByIssue.get(issue.id) ?? null,
              successfulRunHandoff: handoffStates.get(issue.id) ?? null,
            }));
          return {
            kind: "compact",
            body: compactResult,
            etag: compactIssueListEtag(compactResult),
            cacheControl: "private, must-revalidate",
          };
        }
        const [handoffStates, recoveryActionByIssue] = await Promise.all([
          listSuccessfulRunHandoffStates(db, companyId, issueIds),
          recoveryActionsSvc.listActiveForIssues(companyId, issueIds),
        ]);
        const actor = getActorInfo(req);
        await Promise.all(result.map(async (issue) => {
          const activeRecoveryAction = recoveryActionByIssue.get(issue.id) ?? null;
          if (!activeRecoveryAction) return;
          const revalidated = await revalidateActiveSourceRecoveryForRead({
            issue,
            trigger: "read_projection",
            actor,
            activeRecoveryAction,
          });
          if (revalidated) recoveryActionByIssue.set(issue.id, revalidated);
          else recoveryActionByIssue.delete(issue.id);
        }));
        return {
          kind: "full",
          body: result.map((issue) => ({
            ...issue,
            successfulRunHandoff: handoffStates.get(issue.id) ?? null,
            activeRecoveryAction: recoveryActionByIssue.get(issue.id) ?? null,
          })),
        };
      },
    });

    res.setHeader("X-Paperclip-Request-Cache", coordinated.cacheStatus);
    if (!coordinated.response) {
      const body = {
        error: "Too many concurrent issue-list requests for this actor/client",
        retryAfterSeconds: coordinated.retryAfterSeconds ?? 1,
      };
      res.setHeader("Retry-After", String(body.retryAfterSeconds));
      logIssueListRequest({
        req,
        res,
        companyId,
        requestKey,
        startedAt,
        cacheStatus: "retry",
        bodyBytes: estimatedJsonBytes(body),
        etagOutcome: "none",
        identicalInFlightCount: coordinated.identicalInFlightCount,
      });
      res.status(429).json(body);
      return;
    }

    if (coordinated.response.kind === "compact") {
      res.setHeader("Cache-Control", coordinated.response.cacheControl);
      res.setHeader("ETag", coordinated.response.etag);
      const etagMatched = requestMatchesEtag(req.header("if-none-match"), coordinated.response.etag);
      logIssueListRequest({
        req,
        res,
        companyId,
        requestKey,
        startedAt,
        cacheStatus: coordinated.cacheStatus,
        bodyBytes: etagMatched ? 0 : estimatedJsonBytes(coordinated.response.body),
        etagOutcome: etagMatched ? "not_modified" : "fresh",
        identicalInFlightCount: coordinated.identicalInFlightCount,
      });
      if (etagMatched) {
        res.status(304).end();
        return;
      }
      res.json(coordinated.response.body);
      return;
    }

    logIssueListRequest({
      req,
      res,
      companyId,
      requestKey,
      startedAt,
      cacheStatus: coordinated.cacheStatus,
      bodyBytes: estimatedJsonBytes(coordinated.response.body),
      etagOutcome: "none",
      identicalInFlightCount: coordinated.identicalInFlightCount,
    });
    res.json(coordinated.response.body);
  });

  router.get("/companies/:companyId/issues/count", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (isTaskBridgeKeyActor(req)) {
      res.status(403).json({ error: "Task bridge keys cannot use company-wide issue count APIs" });
      return;
    }
    const attention = req.query.attention as string | undefined;
    const hasPlanDocument = parseOptionalBooleanQuery(req.query.hasPlanDocument);
    if (attention !== "blocked") {
      res.status(400).json({ error: "issues/count currently requires attention=blocked" });
      return;
    }
    if (req.query.limit !== undefined || req.query.offset !== undefined) {
      res.status(400).json({ error: "issues/count does not accept limit or offset" });
      return;
    }
    if (hasPlanDocument === null) {
      res.status(400).json({ error: "hasPlanDocument must be true or false when provided" });
      return;
    }

    const blockedCountFilters = {
      attention: "blocked",
      status: req.query.status as string | string[] | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId: req.query.assigneeUserId as string | undefined,
      projectId: req.query.projectId as string | undefined,
      workspaceId: req.query.workspaceId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
      parentId: (req.query.parentId ?? req.query.parentIssueId) as string | undefined,
      descendantOf: req.query.descendantOf as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originKindPrefix: req.query.originKindPrefix as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      excludeRoutineExecutions:
        req.query.excludeRoutineExecutions === "true" || req.query.excludeRoutineExecutions === "1",
      includePluginOperations:
        req.query.includePluginOperations === "true" || req.query.includePluginOperations === "1",
      includeBlockedBy: true,
      includeBlockedInboxAttention: true,
      hasPlanDocument,
      q: req.query.q as string | undefined,
    } as const;

    if (!(await actorCanReadCompanyScope(req, companyId))) {
      const trustResolution = req.actor.type === "agent"
        ? await resolveAgentTrustForIssue({
            agentId: req.actor.agentId,
            runId: req.actor.runId,
          }, companyId, null)
        : null;
      if (trustResolution?.kind === "denied") {
        throw forbidden(trustResolution.detail);
      }
      if (trustResolution?.kind === "low_trust_review") {
        const count = await svc.count(companyId, {
          ...blockedCountFilters,
          lowTrustBoundary: trustResolution.boundary,
        });
        res.json({ count });
        return;
      }

      let offset = 0;
      let visibleCount = 0;
      while (true) {
        const rows = await svc.list(companyId, {
          ...blockedCountFilters,
          limit: ISSUE_LIST_MAX_LIMIT,
          offset,
        });
        visibleCount += (await filterIssuesForActor(req, rows)).length;
        if (rows.length < ISSUE_LIST_MAX_LIMIT) break;
        offset += rows.length;
      }
      res.json({ count: visibleCount });
      return;
    }

    const count = await svc.count(companyId, blockedCountFilters);
    res.json({ count });
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
      agentApiKeyId: actor.agentApiKeyId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await getAccessibleResource(req, res, svc.getLabelById(labelId), "Label not found");
    if (!existing) return;
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
      agentApiKeyId: actor.agentApiKeyId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/issues/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;

    const wakeCommentId =
      typeof req.query.wakeCommentId === "string" && req.query.wakeCommentId.trim().length > 0
        ? req.query.wakeCommentId.trim()
        : null;

    const currentExecutionWorkspacePromise = issue.executionWorkspaceId
      ? executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : Promise.resolve(null);
    const [
      { project, goal },
      ancestors,
      commentCursor,
      wakeComment,
      relations,
      blockerAttention,
      reviewAttention,
      productivityReview,
      scheduledRetry,
      attachments,
      continuationSummary,
      currentExecutionWorkspace,
      activeRecoveryAction,
    ] =
      await Promise.all([
        resolveIssueProjectAndGoal(issue),
        svc.getAncestors(issue.id),
        svc.getCommentCursor(issue.id),
        wakeCommentId ? svc.getComment(wakeCommentId) : null,
        svc.getRelationSummaries(issue.id),
        svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
        svc.listReviewAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
        svc.listProductivityReviews(issue.companyId, [issue.id]).then((map) => map.get(issue.id) ?? null),
        svc.getCurrentScheduledRetry(issue.id),
        svc.listAttachments(issue.id),
        documentsSvc.getIssueDocumentByKey(issue.id, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY),
        currentExecutionWorkspacePromise,
        recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id),
      ]);
    const recoveryActionsByRelationIssue = await relationRecoveryActionMap(
      recoveryActionsSvc,
      issue.companyId,
      relations,
    );
    const relationsWithRecoveryActions = withRecoveryActionsOnRelationSummaries(
      relations,
      recoveryActionsByRelationIssue,
    );
    const revalidatedActiveRecoveryAction = await revalidateActiveSourceRecoveryForRead({
      issue,
      trigger: "read_projection",
      actor: getActorInfo(req),
      activeRecoveryAction,
    });
    const redactLowTrust = await shouldRedactLowTrustForHeartbeatContext(issue, getActorInfo(req));
    const safeWakeComment =
      wakeComment && wakeComment.issueId === issue.id
        ? redactLowTrust
          ? sanitizeQuarantinedCommentForHigherTrust(wakeComment)
          : wakeComment
        : null;
    const safeContinuationSummary =
      continuationSummary && redactLowTrust
        ? redactQuarantinedBodyForHigherTrust(continuationSummary)
        : continuationSummary;
    const planReviewContext = await buildPlanReviewContext({
      db,
      companyId: issue.companyId,
      issueId: issue.id,
      issueWorkMode: issue.workMode,
      includeForIssueComment: wakeCommentId !== null,
    });
    const documentReviewContext = await buildDocumentReviewContext({
      db,
      companyId: issue.companyId,
      issueId: issue.id,
      includeForIssueComment: wakeCommentId !== null,
    });

    const response = {
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        workMode: issue.workMode,
        ...(blockerAttention ? { blockerAttention } : {}),
        ...(reviewAttention ? { reviewAttention } : {}),
        productivityReview,
        scheduledRetry,
        activeRecoveryAction: revalidatedActiveRecoveryAction,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: goal?.id ?? issue.goalId,
        parentId: issue.parentId,
        blockedBy: relationsWithRecoveryActions.blockedBy,
        blocks: relationsWithRecoveryActions.blocks,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        originKind: issue.originKind,
        originId: issue.originId,
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
      wakeComment: safeWakeComment,
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.originalFilename,
        contentType: a.contentType,
        byteSize: a.byteSize,
        contentPath: withContentPath(a).contentPath,
        createdAt: a.createdAt,
      })),
      continuationSummary: safeContinuationSummary
        ? {
            key: safeContinuationSummary.key,
            title: safeContinuationSummary.title,
            body: safeContinuationSummary.body ?? "",
            latestRevisionId: safeContinuationSummary.latestRevisionId,
            latestRevisionNumber: safeContinuationSummary.latestRevisionNumber,
            updatedAt: safeContinuationSummary.updatedAt,
            sourceTrust: safeContinuationSummary.sourceTrust ?? null,
          }
        : null,
      planReviewContext,
      documentReviewContext,
      currentExecutionWorkspace: compactIssueExecutionWorkspace(currentExecutionWorkspace),
    };
    res.json(await runRedactions.redactForIssue(issue.companyId, issue.id, response));
  });

  router.get("/issues/:id/diagnostics/blockers", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;

    const diagnostic = await svc.getBlockerDiagnostics(issue.id);
    const visibleBlockers = await filterIssuesForActor(req, diagnostic.blockers);
    const response = buildIssueBlockerDiagnosticsResponse({
      issue,
      blockers: diagnostic.blockers,
      visibleBlockers,
      readiness: diagnostic.readiness,
      truncated: diagnostic.truncated,
    });

    logger.info(
      {
        companyId: issue.companyId,
        issueId: issue.id,
        actorType: req.actor.type,
        visibleBlockerCount: response.blockers.length,
        omittedUnauthorizedBlockerCount: response.omittedUnauthorizedBlockerCount,
        truncated: response.truncated,
      },
      "issue blocker diagnostics read",
    );

    res.json(response);
  });

  router.get("/issues/:id/diagnostics/wakes", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;

    const [wakeDiagnostic, blockerDiagnostic, includeInternalIds] = await Promise.all([
      svc.getWakeDiagnostics(issue.id),
      svc.getBlockerDiagnostics(issue.id),
      actorCanReadCompanyScope(req, issue.companyId),
    ]);
    const visibleBlockers = await filterIssuesForActor(req, blockerDiagnostic.blockers);
    const blockerResponse = buildIssueBlockerDiagnosticsResponse({
      issue,
      blockers: blockerDiagnostic.blockers,
      visibleBlockers,
      readiness: blockerDiagnostic.readiness,
      truncated: blockerDiagnostic.truncated,
    });
    const response = buildIssueWakeDiagnosticsResponse({
      issue,
      wakeRequests: wakeDiagnostic.wakeRequests,
      activityRecords: wakeDiagnostic.activityRecords,
      blockerDiagnostics: blockerResponse,
      truncatedWakeRequests: wakeDiagnostic.truncatedWakeRequests,
      truncatedActivityRecords: wakeDiagnostic.truncatedActivityRecords,
      includeInternalIds,
    });

    logger.info(
      {
        companyId: issue.companyId,
        issueId: issue.id,
        actorType: req.actor.type,
        wakeRequestCount: response.wakeRequestCount,
        activityRecordCount: response.activityRecordCount,
        internalIdsIncluded: includeInternalIds,
        truncated: response.truncated,
      },
      "issue wake diagnostics read",
    );

    res.json(response);
  });

  router.get("/issues/:id/diagnostics/subtree", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;

    const [diagnostic, includeInternalIds] = await Promise.all([
      svc.getSubtreeDiagnostics(issue.id),
      actorCanReadCompanyScope(req, issue.companyId),
    ]);
    const allBlockers = [...diagnostic.blockersByIssueId.values()].flat();
    const [visibleNodes, visibleBlockers] = await Promise.all([
      filterIssuesForActor(req, diagnostic.nodes),
      filterIssuesForActor(req, allBlockers),
    ]);
    const response = buildIssueSubtreeDiagnosticsResponse({
      issue,
      nodes: diagnostic.nodes,
      visibleNodes,
      blockersByIssueId: diagnostic.blockersByIssueId,
      visibleBlockers,
      readinessByIssueId: diagnostic.readinessByIssueId,
      wakeRequestsByIssueId: diagnostic.wakeRequestsByIssueId,
      activityRecordsByIssueId: diagnostic.activityRecordsByIssueId,
      truncatedNodes: diagnostic.truncatedNodes,
      truncatedDepth: diagnostic.truncatedDepth,
      truncatedBlockerIssueIds: diagnostic.truncatedBlockerIssueIds,
      truncatedWakeIssueIds: diagnostic.truncatedWakeIssueIds,
      truncatedActivityIssueIds: diagnostic.truncatedActivityIssueIds,
      includeInternalIds,
      caps: diagnostic.caps,
    });

    logger.info(
      {
        companyId: issue.companyId,
        issueId: issue.id,
        actorType: req.actor.type,
        nodeCount: response.nodeCount,
        omittedUnauthorizedNodeCount: response.omittedUnauthorizedNodeCount,
        edgeCount: response.edges.length,
        internalIdsIncluded: includeInternalIds,
        truncated: response.truncated,
      },
      "issue subtree diagnostics read",
    );

    res.json(response);
  });

  router.get("/issues/:id", async (req, res) => {
    const requestStartedAt = performance.now();
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const inboxArchiveFieldsPromise = req.actor.type === "board" && req.actor.userId
      ? svc.getActiveInboxArchiveFields(issue, req.actor.userId)
      : Promise.resolve({});
    const [
      { project, goal },
      ancestors,
      mentionedProjectIds,
      documentPayload,
      relations,
      blockerAttention,
      reviewAttention,
      productivityReview,
      referenceSummary,
      successfulRunHandoffStates,
      scheduledRetry,
      activeRecoveryAction,
      linkedCases,
      inboxArchiveFields,
    ] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id, { includeCommentBodies: false }),
      documentsSvc.getIssueDocumentPayload(issue),
      svc.getRelationSummaries(issue.id),
      svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
      svc.listReviewAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
      svc.listProductivityReviews(issue.companyId, [issue.id]).then((map) => map.get(issue.id) ?? null),
      issueReferencesSvc.listIssueReferenceSummary(issue.id),
      listSuccessfulRunHandoffStates(db, issue.companyId, [issue.id]),
      svc.getCurrentScheduledRetry(issue.id),
      recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id),
      listIssueLinkedCases(db, issue.companyId, issue.id),
      inboxArchiveFieldsPromise,
    ]);
    const recoveryActionsByRelationIssue = await relationRecoveryActionMap(
      recoveryActionsSvc,
      issue.companyId,
      relations,
    );
    const relationsWithRecoveryActions = withRecoveryActionsOnRelationSummaries(
      relations,
      recoveryActionsByRelationIssue,
    );
    const revalidatedActiveRecoveryAction = await revalidateActiveSourceRecoveryForRead({
      issue,
      trigger: "read_projection",
      actor: getActorInfo(req),
      activeRecoveryAction,
    });
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.setHeader("Server-Timing", `paperclip_issue;dur=${(performance.now() - requestStartedAt).toFixed(1)}`);
    res.json({
      ...issue,
      ...inboxArchiveFields,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      ...(blockerAttention ? { blockerAttention } : {}),
      ...(reviewAttention ? { reviewAttention } : {}),
      productivityReview,
      successfulRunHandoff: successfulRunHandoffStates.get(issue.id) ?? null,
      scheduledRetry,
      activeRecoveryAction: revalidatedActiveRecoveryAction,
      blockedBy: relationsWithRecoveryActions.blockedBy,
      blocks: relationsWithRecoveryActions.blocks,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
      ...documentPayload,
      project: compactIssueProject(project),
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace: compactIssueExecutionWorkspace(currentExecutionWorkspace),
      workProducts,
      linkedCases,
    });
  });

  router.get("/issues/:id/watchdog", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    res.json(await taskWatchdogsSvc.getActiveForIssue(issue.companyId, issue.id));
  });

  router.put("/issues/:id/watchdog", validate(upsertIssueWatchdogSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (await rejectTaskWatchdogConfigMutation(req, res)) return;
    if (await assertLowTrustControlPlaneDenied(req, res, issue.companyId, issue)) return;

    const actor = getActorInfo(req);
    const existingWatchdog = await taskWatchdogsSvc.getActiveForIssue(issue.companyId, issue.id);
    const { watchdog, created } = await taskWatchdogsSvc.upsertForIssue(issue.companyId, issue.id, {
      agentId: req.body.agentId,
      instructions: req.body.instructions,
      actor: {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      },
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: created ? "issue.watchdog_created" : "issue.watchdog_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        watchdogId: watchdog.id,
        watchdogAgentId: watchdog.watchdogAgentId,
        instructionsChanged: (existingWatchdog?.instructions ?? null) !== (watchdog.instructions ?? null),
      },
    });
    await queueTaskWatchdogEvaluation(issue, actor.runId);
    res.json(watchdog);
  });

  router.delete("/issues/:id/watchdog", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (await rejectTaskWatchdogConfigMutation(req, res)) return;
    if (await assertLowTrustControlPlaneDenied(req, res, issue.companyId, issue)) return;

    const actor = getActorInfo(req);
    const disabled = await taskWatchdogsSvc.disableForIssue(issue.companyId, issue.id, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId,
    });
    if (disabled) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.watchdog_removed",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          watchdogId: disabled.id,
          watchdogAgentId: disabled.watchdogAgentId,
        },
      });
    }
    await queueTaskWatchdogEvaluation(issue, actor.runId);
    res.json({ ok: true });
  });

  router.get("/issues/:id/recovery-actions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const active = await revalidateActiveSourceRecoveryForRead({
      issue,
      trigger: "read_projection",
      actor: getActorInfo(req),
    });
    res.json({
      active,
      actions: active ? [active] : [],
    });
  });

  router.post("/issues/:id/recovery-actions/resolve", validate(resolveIssueRecoveryActionSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!existing) return;
    if (!(await assertIssueReadAllowed(req, res, existing))) return;
    if (await assertLowTrustControlPlaneDenied(req, res, existing.companyId, existing)) return;
    if (req.actor.type === "agent") {
      const boundaryDecision = await decideIssueAccess(req, existing, "issue:mutate");
      if (!boundaryDecision.allowed) {
        await denyIssueWrite(req, res, existing, issueWriteDenialCodeForDecision(boundaryDecision));
        return;
      }
      if (!requireAgentRunId(req, res)) return;
      if (!(await assertCrossIssueInfluenceWithinRunCap(req, res, existing, "update"))) return;
    }

    const { actionId, outcome, sourceIssueStatus, resolutionNote } = req.body;
    if (outcome === "false_positive" || outcome === "cancelled") {
      assertBoard(req);
    }

    const actor = getActorInfo(req);
    const actionStatus = outcome === "cancelled" ? "cancelled" : "resolved";
    const postCommitActivityPublications: ActivityPublication[] = [];
    const postCommitIssueActions: IssuePostCommitAction[] = [];
    const result = await db.transaction(async (tx) => {
      const lockedIssue = await tx
        .select()
        .from(issueRows)
        .where(and(eq(issueRows.companyId, existing.companyId), eq(issueRows.id, existing.id)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!lockedIssue) throw notFound("Issue not found");

      const activeRecoveryAction = await recoveryActionsSvc.getActiveForIssue(
        lockedIssue.companyId,
        lockedIssue.id,
        tx,
      );
      if (!activeRecoveryAction || (actionId && activeRecoveryAction.id !== actionId)) {
        throw notFound("Active recovery action not found");
      }
      await requireRecoveryActionAuthority(
        req,
        lockedIssue,
        activeRecoveryAction,
        { source: "recovery_action_resolution" },
      );

      let issue = lockedIssue;
      const sourceStatusChanged = sourceIssueStatus !== lockedIssue.status;
      if (outcome === "blocked" && sourceStatusChanged) {
        const unresolvedBlockers = await tx
          .select({ id: issueRows.id })
          .from(issueRelations)
          .innerJoin(issueRows, eq(issueRelations.issueId, issueRows.id))
          .where(
            and(
              eq(issueRelations.companyId, existing.companyId),
              eq(issueRelations.relatedIssueId, existing.id),
              eq(issueRelations.type, "blocks"),
              notInArray(issueRows.status, ["done", "cancelled"]),
            ),
          )
          .limit(1);
        if (unresolvedBlockers.length === 0) {
          throw unprocessable("Blocked recovery resolution requires an unresolved first-class blocker on the source issue");
        }
      }

      if (sourceStatusChanged) {
        const safeHandBack =
          outcome === "restored" &&
          sourceIssueStatus === "todo" &&
          activeRecoveryAction.returnOwnerAgentId != null &&
          lockedIssue.assigneeAgentId === activeRecoveryAction.returnOwnerAgentId;
        if (safeHandBack) {
          await assertSafeRecoveryHandBackGates({
            req,
            issue: lockedIssue,
            recoveryAction: activeRecoveryAction,
          });
        } else {
          await requireRecoverySourceMutationAuthority(req, lockedIssue);
        }

        if (
          lockedIssue.status === "in_review" &&
          (sourceIssueStatus === "done" || sourceIssueStatus === "cancelled") &&
          lockedIssue.reviewPolicy != null &&
          lockedIssue.reviewPolicy !== "anyone"
        ) {
          await assertIssueReviewVerdictActorAllowed(tx as unknown as Db, {
            issue: lockedIssue,
            actor: { type: actor.actorType, id: actor.actorId },
          });
        }

        const updateFields: Record<string, unknown> = { status: sourceIssueStatus };
        if (!safeHandBack) {
          await assertInReviewReviewPath({
            existing: lockedIssue,
            updateFields,
            actorType: actor.actorType,
            actorId: actor.actorId,
            actorAgentId: actor.agentId,
            actorRunId: actor.runId,
          });
          const executionPolicy = normalizeIssueExecutionPolicy(lockedIssue.executionPolicy ?? null);
          const transition = applyIssueExecutionPolicyTransition({
            issue: lockedIssue,
            policy: executionPolicy,
            previousPolicy: executionPolicy,
            requestedStatus: sourceIssueStatus,
            requestedAssigneePatch: {},
            actor: {
              agentId: actor.agentId ?? null,
              userId: actor.actorType === "user" ? actor.actorId : null,
            },
            allowBoardOverride: req.actor.type === "board",
            commentBody: resolutionNote ?? null,
          });
          Object.assign(updateFields, transition.patch);
          if (transition.decision) {
            const decisionId = randomUUID();
            const nextExecutionState = updateFields.executionState;
            if (!nextExecutionState || typeof nextExecutionState !== "object") {
              throw new Error("Execution policy decision patch is missing executionState");
            }
            updateFields.executionState = { ...nextExecutionState, lastDecisionId: decisionId };
            await tx.insert(issueExecutionDecisions).values({
              id: decisionId,
              companyId: lockedIssue.companyId,
              issueId: lockedIssue.id,
              stageId: transition.decision.stageId,
              stageType: transition.decision.stageType,
              actorAgentId: actor.agentId ?? null,
              actorUserId: actor.actorType === "user" ? actor.actorId : null,
              outcome: transition.decision.outcome,
              body: transition.decision.body,
              createdByRunId: actor.runId ?? null,
            });
          }
        }

        const issueUpdate = {
          ...updateFields,
          actorAgentId: actor.agentId ?? null,
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
        };
        const updatedIssue = sourceIssueStatus === "done" || sourceIssueStatus === "cancelled"
          ? await svc.update(
              id,
              issueUpdate,
              tx,
              postCommitActivityPublications,
              postCommitIssueActions,
            )
          : await svc.update(id, issueUpdate, tx, postCommitActivityPublications);
        if (!updatedIssue) throw notFound("Issue not found");
        issue = updatedIssue;
      }

      const recordedOutcome =
        outcome === "restored" && issue.status === "todo" &&
          activeRecoveryAction.returnOwnerAgentId != null &&
          issue.assigneeAgentId === activeRecoveryAction.returnOwnerAgentId
          ? "handed_back"
          : outcome === "restored" && issue.status === "done"
            ? "owner_completed"
            : outcome;

      const recoveryAction = await recoveryActionsSvc.resolveActiveForIssue(
        {
          companyId: existing.companyId,
          sourceIssueId: existing.id,
          actionId: activeRecoveryAction.id,
          status: actionStatus,
          outcome: recordedOutcome,
          resolutionNote: resolutionNote ?? null,
        },
        tx,
      );
      if (!recoveryAction) throw notFound("Active recovery action not found");

      return { issue, recoveryAction };
    });
    for (const publication of postCommitActivityPublications) publishActivity(publication);
    await flushIssuePostCommitActions(postCommitIssueActions);

    await routinesSvc.syncRunStatusForIssue(result.issue.id);

    if (sourceIssueStatus && existing.status !== result.issue.status) {
      await logActivity(db, {
        companyId: result.issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.updated",
        entityType: "issue",
        entityId: result.issue.id,
        details: {
          identifier: result.issue.identifier,
          status: result.issue.status,
          source: "recovery_action_resolution",
          recoveryActionId: result.recoveryAction.id,
          _previous: {
            status: existing.status,
          },
        },
      });
    }

    await logActivity(db, {
      companyId: result.issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.recovery_action_resolved",
      entityType: "issue",
      entityId: result.issue.id,
      details: {
        identifier: result.issue.identifier,
        recoveryActionId: result.recoveryAction.id,
        recoveryActionStatus: result.recoveryAction.status,
        outcome: result.recoveryAction.outcome,
        sourceIssueStatus: sourceIssueStatus ?? null,
        resolutionNote: result.recoveryAction.resolutionNote,
      },
    });

    if (
      sourceIssueStatus === "todo" &&
      result.issue.assigneeAgentId &&
      (existing.status !== result.issue.status ||
        existing.assigneeAgentId !== result.issue.assigneeAgentId)
    ) {
      try {
        await enqueueRecoveryActionWakeup(result.issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_recovery_action_restored",
          payload: {
            issueId: result.issue.id,
            recoveryActionId: result.recoveryAction.id,
            mutation: "recovery_action_resolution",
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: result.issue.id,
            taskId: result.issue.id,
            wakeReason: "issue_recovery_action_restored",
            source: "issue.recovery_action_resolution",
            recoveryActionId: result.recoveryAction.id,
          },
        });
      } catch (err) {
        logger.warn(
          { err, issueId: result.issue.id, agentId: result.issue.assigneeAgentId },
          "failed to wake agent after recovery action restored issue",
        );
      }
    }

    res.json({
      issue: {
        ...result.issue,
        activeRecoveryAction: null,
      },
      recoveryAction: result.recoveryAction,
    });
  });

  router.get("/issues/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json(workProducts);
  });

  router.get("/issues/:id/external-objects", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const objects = await externalObjectsSvc.listForIssue(issue.id);
    res.json(objects);
  });

  router.get("/issues/:id/external-object-summary", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const summary = await externalObjectsSvc.getIssueSummary(issue.id);
    res.json(summary);
  });

  router.post("/companies/:companyId/issues/external-object-summaries", validate(externalObjectSummariesSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const requestedIssueIds = [...new Set(req.body.issueIds as string[])];
    const candidateIssues = requestedIssueIds.length > 0
      ? await db
        .select({
          id: issueRows.id,
          companyId: issueRows.companyId,
          projectId: issueRows.projectId,
          parentId: issueRows.parentId,
          assigneeAgentId: issueRows.assigneeAgentId,
          assigneeUserId: issueRows.assigneeUserId,
          status: issueRows.status,
        })
        .from(issueRows)
        .where(and(eq(issueRows.companyId, companyId), inArray(issueRows.id, requestedIssueIds)))
      : [];
    const readableIssueIds = (await filterIssuesForActor(req, candidateIssues)).map((issue) => issue.id);
    const summaries = await externalObjectsSvc.getIssueSummaries(companyId, readableIssueIds);
    res.json({ summaries: Object.fromEntries(summaries) });
  });

  router.post("/issues/:id/external-objects/refresh", validate(refreshExternalObjectsSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    const actor = getActorInfo(req);
    const results = await externalObjectsSvc.refreshIssueObjects(issue.id, {
      companyId: issue.companyId,
      objectIds: req.body.objectIds,
      actor,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "external_object.refresh_requested",
      entityType: "issue",
      entityId: issue.id,
      details: {
        issueId: issue.id,
        objectIds: results.map((result) => result.object.id),
      },
    });
    res.json({ refreshed: results });
  });

  router.get("/issues/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const docs = await documentsSvc.listIssueDocuments(issue.id, {
      includeSystem: req.query.includeSystem === "true",
    });
    res.json(docs);
  });

  router.get("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
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
    if (!shouldIncludeDocumentAnnotations(req)) {
      res.json(doc);
      return;
    }
    const annotations = await documentAnnotationsSvc.listThreadsForIssueDocument(issue.id, keyParsed.data, {
      status: "open",
      includeComments: shouldIncludeDocumentAnnotationComments(req),
    });
    res.json({ ...doc, annotations });
  });

  router.get("/issues/:id/documents/:key/annotations", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const status = req.query.status === "resolved" || req.query.status === "all" ? req.query.status : "open";
    const threads = await documentAnnotationsSvc.listThreadsForIssueDocument(issue.id, keyParsed.data, {
      status,
      includeComments: parseBooleanQuery(req.query.includeComments),
    });
    res.json(threads);
  });

  router.post(
    "/issues/:id/documents/:key/annotations",
    validate(createDocumentAnnotationThreadSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (!(await assertAgentIssueMutationAllowed(req, res, issue, { allowVisibleIssueWrite: true }))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      const { actor, annotationActor } = annotationActorInput(req);
      const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const thread = await documentAnnotationsSvc.createThread(issue.id, keyParsed.data, req.body, annotationActor);
      const firstComment = thread.comments[0];
      if (firstComment) await issueReferencesSvc.syncAnnotationComment(firstComment.id);
      const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.document_annotation_thread_created",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: thread.documentKey,
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          commentId: firstComment?.id ?? null,
          revisionNumber: thread.currentRevisionNumber,
          quote: thread.selectedText.slice(0, 240),
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      res.status(201).json(thread);
    },
  );

  router.get("/issues/:id/documents/:key/annotations/:threadId", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const thread = await documentAnnotationsSvc.getThreadForIssueDocument(
      issue.id,
      keyParsed.data,
      req.params.threadId as string,
    );
    if (!thread) {
      res.status(404).json({ error: "Annotation thread not found" });
      return;
    }
    res.json(thread);
  });

  router.post(
    "/issues/:id/documents/:key/annotations/:threadId/comments",
    validate(createDocumentAnnotationCommentSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      const { actor, annotationActor } = annotationActorInput(req);
      const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const comment = await documentAnnotationsSvc.addComment(
        issue.id,
        keyParsed.data,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await issueReferencesSvc.syncAnnotationComment(comment.id);
      const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.document_annotation_comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: keyParsed.data,
          documentKey: keyParsed.data,
          threadId: comment.threadId,
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      res.status(201).json(comment);
    },
  );

  router.patch(
    "/issues/:id/documents/:key/annotations/:threadId",
    validate(updateDocumentAnnotationThreadSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }
      const { actor, annotationActor } = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.updateThread(
        issue.id,
        keyParsed.data,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: thread.status === "resolved"
          ? "issue.document_annotation_thread_resolved"
          : "issue.document_annotation_thread_reopened",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: thread.documentKey,
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          status: thread.status,
        },
      });
      res.json(thread);
    },
  );

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const sourceTrust = await sourceTrustForActorWrite(issue, actor);
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
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
      sourceTrust,
      lockedDocumentStrategy: req.actor.type === "agent" ? "create_new_document" : "conflict",
    });
    const doc = result.document;
    const redirectedFromLockedDocument =
      "redirectedFromLockedDocument" in result ? result.redirectedFromLockedDocument : null;
    await issueReferencesSvc.syncDocument(doc.id);
    await externalObjectsSvc.syncDocumentSafely(doc.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    const remappedAnnotations = result.created
      ? []
      : await documentAnnotationsSvc.remapOpenThreadsForDocument({
        issueId: issue.id,
        key: doc.key,
        documentId: doc.id,
        nextRevisionId: doc.latestRevisionId,
        nextRevisionNumber: doc.latestRevisionNumber,
        nextBody: doc.body,
      });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
        redirectedFromLockedDocument,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    for (const remap of remappedAnnotations) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.document_annotation_remapped",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: doc.key,
          documentId: doc.id,
          threadId: remap.thread.id,
          revisionNumber: doc.latestRevisionNumber,
          anchorState: remap.thread.anchorState,
          anchorConfidence: remap.thread.anchorConfidence,
          snapshotId: remap.snapshot.id,
        },
      });
    }

    if (!result.created) {
      const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
        issue,
        {
          id: doc.id,
          key: doc.key,
          latestRevisionId: doc.latestRevisionId,
          latestRevisionNumber: doc.latestRevisionNumber,
        },
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        issue,
        interactions: expiredInteractions,
        actor,
        source: "issue.document_updated",
      });
      await queueExpiredInteractionReviewPathRecovery({
        issue,
        interactions: expiredInteractions,
        actor,
        source: "issue.document_updated",
      });
    }

    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "document",
      actor,
      documentChanged: true,
    });

    res.status(result.created ? 201 : 200).json(doc);
  });

  router.post("/issues/:id/documents/:key/lock", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const result = await documentsSvc.lockIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      lockedByAgentId: actor.agentId ?? null,
      lockedByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    if (result.changed) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.document_locked",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          lockedAt: result.document.lockedAt,
        },
      });
    }

    res.json(result.document);
  });

  router.post("/issues/:id/documents/:key/unlock", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const result = await documentsSvc.unlockIssueDocument(issue.id, keyParsed.data);

    if (result.changed) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.document_unlocked",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
        },
      });
    }

    res.json(result.document);
  });

  router.get("/issues/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
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
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
      if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      const actor = getActorInfo(req);
      const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const result = await documentsSvc.restoreIssueDocumentRevision({
        issueId: issue.id,
        key: keyParsed.data,
        revisionId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await issueReferencesSvc.syncDocument(result.document.id);
      const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      await externalObjectsSvc.syncDocumentSafely(result.document.id);
      const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
      const remappedAnnotations = await documentAnnotationsSvc.remapOpenThreadsForDocument({
        issueId: issue.id,
        key: result.document.key,
        documentId: result.document.id,
        nextRevisionId: result.document.latestRevisionId,
        nextRevisionNumber: result.document.latestRevisionNumber,
        nextBody: result.document.body,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
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
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      for (const remap of remappedAnnotations) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "issue.document_annotation_remapped",
          entityType: "issue",
          entityId: issue.id,
          details: {
            key: result.document.key,
            documentId: result.document.id,
            threadId: remap.thread.id,
            revisionNumber: result.document.latestRevisionNumber,
            anchorState: remap.thread.anchorState,
            anchorConfidence: remap.thread.anchorConfidence,
            snapshotId: remap.snapshot.id,
          },
        });
      }

      const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
        issue,
        {
          id: result.document.id,
          key: result.document.key,
          latestRevisionId: result.document.latestRevisionId,
          latestRevisionNumber: result.document.latestRevisionNumber,
        },
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        issue,
        interactions: expiredInteractions,
        actor,
        source: "issue.document_restored",
      });
      await queueExpiredInteractionReviewPathRecovery({
        issue,
        interactions: expiredInteractions,
        actor,
        source: "issue.document_restored",
      });

      await revalidateActiveSourceRecoveryAfterCommittedWrite({
        issue,
        trigger: "document",
        actor,
        documentChanged: true,
      });

      res.json(result.document);
    },
  );

  router.delete("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    await issueReferencesSvc.deleteDocumentSource(removed.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    if (removed) await externalObjectsSvc.syncDocumentSafely(removed.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });
    const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
      issue,
      {
        id: removed.id,
        key: removed.key,
        latestRevisionId: null,
        latestRevisionNumber: null,
      },
      {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    );
    await logExpiredRequestConfirmations({
      issue,
      interactions: expiredInteractions,
      actor,
      source: "issue.document_deleted",
    });
    await queueExpiredInteractionReviewPathRecovery({
      issue,
      interactions: expiredInteractions,
      actor,
      source: "issue.document_deleted",
    });
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "document",
      actor,
      documentChanged: true,
    });
    res.json({ ok: true });
  });

  router.post("/issues/:id/work-products", validate(createIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
    const actor = getActorInfo(req);
    const createInput = {
      ...req.body,
      projectId: req.body.projectId ?? issue.projectId ?? null,
      sourceTrust: await sourceTrustForActorWrite(issue, actor),
    };
    const createdByRunId = await resolveWorkProductCreatedByRunId(req, res, issue.companyId, req.body, "create");
    if (createdByRunId === undefined) return;
    createInput.createdByRunId = createdByRunId;
    if (requiresPaperclipAttachmentMetadata(createInput)) {
      createInput.metadata = await canonicalizePaperclipArtifactMetadata({
        issue,
        metadata: req.body.metadata ?? null,
      });
    }
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, createInput);
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.work_product_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "work_product",
      actor,
      workProductChanged: true,
    });
    await materializeArtifactReviewDocumentBestEffort({ issue, workProduct: product, actor });
    res.status(201).json(product);
  });

  async function ensureArtifactReviewDocumentForWorkProduct(input: {
    issue: NonNullable<Awaited<ReturnType<typeof svc.getById>>>;
    workProduct: NonNullable<Awaited<ReturnType<typeof workProductsSvc.getById>>>;
    actor: ReturnType<typeof getActorInfo>;
  }) {
    const { issue, workProduct, actor } = input;
    const result = await artifactReviewDocumentsSvc.ensureForWorkProduct({
      issue: { id: issue.id, companyId: issue.companyId },
      workProduct,
    });
    if (!result.revisionChanged) return result;
    const doc = result.document;
    await issueReferencesSvc.syncDocument(doc.id);
    await externalObjectsSvc.syncDocumentSafely(doc.id);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
        workProductId: workProduct.id,
        artifactReviewDocument: true,
      },
    });
    for (const remap of result.remappedAnnotations) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.document_annotation_remapped",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: doc.key,
          documentId: doc.id,
          threadId: remap.thread.id,
          revisionNumber: doc.latestRevisionNumber,
          anchorState: remap.thread.anchorState,
          anchorConfidence: remap.thread.anchorConfidence,
          snapshotId: remap.snapshot.id,
        },
      });
    }
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "document",
      actor,
      documentChanged: true,
    });
    return result;
  }

  async function materializeArtifactReviewDocumentBestEffort(input: {
    issue: NonNullable<Awaited<ReturnType<typeof svc.getById>>>;
    workProduct: NonNullable<Awaited<ReturnType<typeof workProductsSvc.getById>>>;
    actor: ReturnType<typeof getActorInfo>;
  }) {
    if (!isMarkdownArtifactWorkProduct(input.workProduct)) return;
    try {
      await ensureArtifactReviewDocumentForWorkProduct(input);
    } catch (error) {
      // Work-product writes stay fail-open: raw open and download remain
      // available, and the explicit review-document endpoint is the retry path.
      logger.warn(
        { err: error, issueId: input.issue.id, workProductId: input.workProduct.id },
        "markdown work product review-document materialization failed",
      );
    }
  }

  router.post("/issues/:id/work-products/:workProductId/review-document", async (req, res) => {
    const id = req.params.id as string;
    const workProductId = req.params.workProductId as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
    const workProduct = await workProductsSvc.getById(workProductId);
    if (!workProduct || workProduct.issueId !== issue.id || workProduct.companyId !== issue.companyId) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await ensureArtifactReviewDocumentForWorkProduct({ issue, workProduct, actor });
    res.status(result.created ? 201 : 200).json(result.document);
  });

  router.post("/issues/:id/low-trust/promotions", validate(promoteLowTrustOutputSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
    const actor = getActorInfo(req);
    if (await sourceTrustForActorWrite(issue, actor)) {
      res.status(403).json({ error: "Low-trust actors cannot promote quarantined output" });
      return;
    }
    const sourceTrust = await lookupLowTrustSourceArtifact({
      issueId: issue.id,
      artifactKind: req.body.sourceArtifactKind,
      artifactId: req.body.sourceArtifactId,
    });
    if (!sourceTrust) {
      res.status(404).json({ error: "Low-trust source artifact not found" });
      return;
    }
    if (!isLowTrustQuarantined(sourceTrust)) {
      res.status(422).json({ error: "Source artifact is not quarantined low-trust output" });
      return;
    }

    const promotedAt = new Date();
    const promotionTrust = buildPromotedSourceTrust({
      sourceIssueId: issue.id,
      sourceArtifactKind: req.body.sourceArtifactKind,
      sourceArtifactId: req.body.sourceArtifactId,
      promotedByActorType: actor.actorType,
      promotedByActorId: actor.actorId,
      promotedAt,
    });
    const product = await db.transaction(async (tx) => {
      const markPromoted = { sourceTrust: promotionTrust, updatedAt: promotedAt };
      const updatedSource = await (async () => {
        if (req.body.sourceArtifactKind === "issue") {
          return tx
            .update(issueRows)
            .set(markPromoted)
            .where(and(
              eq(issueRows.id, req.body.sourceArtifactId),
              eq(issueRows.sourceTrust, sourceTrust),
            ))
            .returning({ id: issueRows.id });
        }
        if (req.body.sourceArtifactKind === "comment") {
          return tx
            .update(issueComments)
            .set(markPromoted)
            .where(and(
              eq(issueComments.id, req.body.sourceArtifactId),
              eq(issueComments.issueId, issue.id),
              eq(issueComments.sourceTrust, sourceTrust),
            ))
            .returning({ id: issueComments.id });
        }
        if (req.body.sourceArtifactKind === "document") {
          return tx
            .update(documents)
            .set(markPromoted)
            .where(and(
              eq(documents.id, req.body.sourceArtifactId),
              eq(documents.sourceTrust, sourceTrust),
            ))
            .returning({ id: documents.id });
        }
        return tx
          .update(issueWorkProducts)
          .set(markPromoted)
          .where(and(
            eq(issueWorkProducts.id, req.body.sourceArtifactId),
            eq(issueWorkProducts.issueId, issue.id),
            eq(issueWorkProducts.sourceTrust, sourceTrust),
          ))
          .returning({ id: issueWorkProducts.id });
      })();
      if (!updatedSource[0]) return null;

      return tx
        .insert(issueWorkProducts)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          projectId: issue.projectId ?? null,
          type: "artifact",
          provider: "paperclip",
          externalId: req.body.sourceArtifactId,
          title: req.body.title,
          status: "approved",
          reviewState: "approved",
          isPrimary: false,
          healthStatus: "unknown",
          summary: req.body.summary,
          metadata: {
            promotion: {
              sourceArtifactKind: req.body.sourceArtifactKind,
              sourceArtifactId: req.body.sourceArtifactId,
            },
          },
          sourceTrust: promotionTrust,
          createdByRunId: actor.runId ?? null,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
    });
    if (!product) {
      res.status(422).json({ error: "Source artifact is not quarantined low-trust output" });
      return;
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.low_trust_output_promoted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        sourceArtifacts: [{
          artifactKind: req.body.sourceArtifactKind,
          artifactId: req.body.sourceArtifactId,
        }],
        reviewerPrincipal: {
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
        },
        targetIssueId: issue.id,
        promotedWorkProductId: product.id,
        decision: "promoted",
      },
    });

    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, workProductsSvc.getById(id), "Work product not found");
    if (!existing) return;
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
    const actor = getActorInfo(req);
    const patch = { ...req.body };
    const createdByRunId = await resolveWorkProductCreatedByRunId(req, res, existing.companyId, req.body, "update");
    if (createdByRunId === undefined && Object.prototype.hasOwnProperty.call(req.body, "createdByRunId")) return;
    if (createdByRunId !== undefined) patch.createdByRunId = createdByRunId;
    if (requiresPaperclipAttachmentMetadata(patch, existing)) {
      if (patch.metadata !== undefined) {
        patch.metadata = await canonicalizePaperclipArtifactMetadata({
          issue,
          metadata: patch.metadata ?? null,
        });
      } else if (!requiresPaperclipAttachmentMetadata(existing)) {
        res.status(422).json({ error: "Attachment-backed artifact metadata is required" });
        return;
      }
    }
    const sourceTrust = await sourceTrustForActorWrite(issue, actor);
    const product = await workProductsSvc.update(id, {
      ...patch,
      ...(sourceTrust ? { sourceTrust } : {}),
    });
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, changedKeys: Object.keys(req.body).sort() },
    });
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "work_product",
      actor,
      workProductChanged: true,
    });
    const reviewDocumentInputChanged = ["type", "provider", "metadata", "title", "createdByRunId"]
      .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
    if (reviewDocumentInputChanged || sourceTrust) {
      await materializeArtifactReviewDocumentBestEffort({ issue, workProduct: product, actor });
    }
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, workProductsSvc.getById(id), "Work product not found");
    if (!existing) return;
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
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
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.work_product_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: removed.id, type: removed.type },
    });
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "work_product",
      actor,
      workProductChanged: true,
    });
    res.json(removed);
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
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
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
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
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.read_unmarked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: issue.id, removed });
  });

  async function resolveInboxArchiveTarget(
    req: Request,
    issue: { id: string; companyId: string },
  ) {
    if (req.actor.type === "board") {
      if (!req.actor.userId) throw forbidden("Board user context required", { code: "inbox_target_user_unresolved" });
      return {
        userId: req.actor.userId,
        targetResolvedFrom: "responsible_user" as const,
        policyMode: null,
      };
    }
    if (req.actor.type !== "agent") throw unauthorized("Authentication required");

    const explicitUserId = typeof req.body?.userId === "string" ? req.body.userId.trim() || null : null;
    const responsibleUserId = req.actor.onBehalfOfUserId?.trim() || null;
    const userId = explicitUserId ?? responsibleUserId;
    if (!userId) {
      throw forbidden("Inbox target user could not be resolved", { code: "inbox_target_user_unresolved" });
    }

    const decision = await access.decide({
      actor: req.actor,
      action: "inbox:manage",
      resource: { type: "issue", companyId: issue.companyId, issueId: issue.id },
      scope: { userId },
    });
    if (!decision.allowed) {
      const code = decision.reason === "inbox_management_disabled"
        ? "inbox_management_disabled"
        : decision.reason === "inbox_agent_not_allowed" || decision.reason === "deny_low_trust_boundary"
          ? "inbox_agent_not_allowed"
          : decision.reason === "inbox_target_user_unresolved"
            ? "inbox_target_user_unresolved"
            : userId !== responsibleUserId
              ? "inbox_cross_user_grant_required"
              : "inbox_agent_not_allowed";
      throw forbidden(decision.explanation, { code, reason: decision.reason });
    }

    return {
      userId,
      targetResolvedFrom: explicitUserId ? "explicit" as const : "responsible_user" as const,
      policyMode: decision.inboxPolicyMode ?? "open",
    };
  }

  router.post("/issues/:id/inbox-archive", validate(inboxArchiveBodySchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    const target = await resolveInboxArchiveTarget(req, issue);
    const actor = getActorInfo(req);
    const archiveState = await svc.archiveInbox(issue.companyId, issue.id, target.userId, new Date(), {
      archivedByActorType: req.actor.type === "agent" ? "agent" : "user",
      archivedByAgentId: actor.agentId,
      archivedByRunId: actor.runId,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.inbox_archived",
      entityType: "issue",
      entityId: issue.id,
      details: {
        userId: target.userId,
        archivedAt: archiveState.archivedAt,
        targetResolvedFrom: target.targetResolvedFrom,
        ...(target.policyMode ? { policyMode: target.policyMode } : {}),
      },
    });
    res.json(archiveState);
  });

  router.delete("/issues/:id/inbox-archive", validate(inboxArchiveBodySchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    const target = await resolveInboxArchiveTarget(req, issue);
    const removed = await svc.unarchiveInbox(issue.companyId, issue.id, target.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.inbox_unarchived",
      entityType: "issue",
      entityId: issue.id,
      details: {
        userId: target.userId,
        targetResolvedFrom: target.targetResolvedFrom,
        ...(target.policyMode ? { policyMode: target.policyMode } : {}),
      },
    });
    res.json(removed ?? { ok: true, userId: target.userId });
  });

  router.get("/issues/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (await assertLowTrustControlPlaneDenied(req, res, issue.companyId, issue)) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.json(approvals);
  });

  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, issue))) return;
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
      agentApiKeyId: actor.agentApiKeyId,
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
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, issue))) return;
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    await issueApprovalsSvc.unlink(id, approvalId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/issues", applyCreateIssueStatusDefault, validateIssueMutationBody(createIssueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (isSkillTestScopedActor(req)) {
      res.status(403).json({
        error: "Skill-test run tokens cannot create issues.",
        details: {
          scopedIssueId: req.actor.keyScope?.kind === "skill_test" ? req.actor.keyScope.issueId : null,
          securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
        },
      });
      return;
    }
    if (await assertLowTrustControlPlaneDenied(req, res, companyId, null)) return;
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));
    const sanitizedBody = await sanitizeIssueCreateAttribution(db, req, res, companyId, req.body, {
      surface: "issues.create",
    });
    if (!sanitizedBody) return;
    const {
      watchdogDiscovery: rawWatchdogDiscovery,
      onboardingFirstTask: rawOnboardingFirstTask,
      ...rawCreateBody
    } = sanitizedBody;
    // The onboarding first-task marker grants privileged, server-owned behavior:
    // it stamps the onboarding origin (which suppresses the seeded description in
    // the UI) and seeds a comment authored *as the assigned agent*. Honor it only
    // when the request is genuinely the onboarding wizard creating a company's
    // very first task, verified server-side so a client marker alone cannot
    // trigger it:
    //   1. the caller is a human board/user session (the wizard never runs as an
    //      agent), and
    //   2. the company has no existing issues yet — i.e. this really is the first
    //      task. An established company creating an ordinary issue can never reach
    //      the greeting/description-suppression path, so no board caller can
    //      fabricate a statement attributed to an assigned agent on a normal task.
    // Fails closed: if it is not verifiably the first task, the flag is ignored
    // and an ordinary issue is created. The zero-count read below is only a
    // fast-path gate — overlapping requests could both observe zero — so the
    // partial unique index issues_onboarding_first_task_uq is what atomically
    // enforces at most one onboarding first task per company; the create call
    // handles losing that race by degrading to an ordinary issue.
    const onboardingFirstTaskRequested =
      rawOnboardingFirstTask === true && req.actor.type === "board";
    let isOnboardingFirstTask = onboardingFirstTaskRequested
      ? (await svc.count(companyId)) === 0
      : false;
    const watchdogDiscovery = normalizeWatchdogDiscovery(rawWatchdogDiscovery);
    const watchdogProductBugFollowUp = await resolveTaskWatchdogProductBugFollowUp(
      req,
      res,
      companyId,
      watchdogDiscovery,
    );
    if (watchdogProductBugFollowUp === false) return;
    const effectiveParentId = watchdogProductBugFollowUp ? null : rawCreateBody.parentId;
    let createParent: Awaited<ReturnType<typeof svc.getById>> | null = null;
    if (req.actor.type === "agent" && !effectiveParentId && !watchdogProductBugFollowUp && !isTaskBridgeKeyActor(req)) {
      const companyScopeDecision = await access.decide({
        actor: req.actor,
        action: "company_scope:read",
        resource: { type: "company", companyId },
      });
      if (!companyScopeDecision.allowed) {
        res.status(403).json({ error: "Low-trust agents must create child issues inside their assigned boundary" });
        return;
      }
    }
    if (req.actor.type === "agent" && effectiveParentId) {
      createParent = await svc.getById(effectiveParentId);
      if (!createParent || createParent.companyId !== companyId) {
        res.status(404).json({ error: "Parent issue not found" });
        return;
      }
      if (!isTaskBridgeKeyActor(req) && !(await assertIssueWriteInfluenceAllowed(req, res, createParent))) return;
    }
    if (
      !watchdogProductBugFollowUp &&
      !(await assertTaskWatchdogCreateIssueAllowed(req, res, companyId, createParent))
    ) return;
    const normalizedAssigneeAgentId = await normalizeIssueAssigneeAgentReference(
      companyId,
      rawCreateBody.assigneeAgentId as string | null | undefined,
      { actorType: req.actor.type },
    );
    await assertNoAgentDelegationCycle({
      actorType: req.actor.type,
      parentIssueId: typeof effectiveParentId === "string" ? effectiveParentId : null,
      assigneeAgentId: normalizedAssigneeAgentId ?? null,
    });
    const actor = getActorInfo(req);
    const runWorkspaceInheritanceSourceIssueId = hasExplicitIssueWorkspaceCreateSelection(rawCreateBody)
      ? null
      : await resolveRunIssueWorkspaceInheritanceSource(companyId, actor);
    const createBody = {
      ...rawCreateBody,
      parentId: effectiveParentId,
      ...(normalizedAssigneeAgentId !== undefined ? { assigneeAgentId: normalizedAssigneeAgentId } : {}),
      ...(runWorkspaceInheritanceSourceIssueId
        ? { inheritExecutionWorkspaceFromIssueId: runWorkspaceInheritanceSourceIssueId }
        : {}),
      ...(isOnboardingFirstTask && !watchdogProductBugFollowUp
        ? { originKind: ONBOARDING_FIRST_TASK_ORIGIN_KIND }
        : {}),
      ...(watchdogProductBugFollowUp
        ? {
          description: appendWatchdogDiscoveryContext({
            description: rawCreateBody.description,
            discovery: watchdogProductBugFollowUp.discovery,
            sourceIssue: watchdogProductBugFollowUp.sourceIssue,
            watchdogIssue: watchdogProductBugFollowUp.watchdogIssue,
            stopFingerprint: watchdogProductBugFollowUp.scope.stopFingerprint,
            runId: actor.runId,
          }),
          projectId: rawCreateBody.projectId ?? watchdogProductBugFollowUp.sourceIssue.projectId,
          goalId: rawCreateBody.goalId ?? watchdogProductBugFollowUp.sourceIssue.goalId,
          billingCode: rawCreateBody.billingCode ?? watchdogProductBugFollowUp.sourceIssue.billingCode,
          originKind: TASK_WATCHDOG_PRODUCT_BUG_ORIGIN_KIND,
          originId: watchdogProductBugFollowUp.sourceIssue.id,
          originRunId: actor.runId,
          originFingerprint: [
            TASK_WATCHDOG_PRODUCT_BUG_ORIGIN_KIND,
            watchdogProductBugFollowUp.sourceIssue.id,
            actor.runId ?? randomUUID(),
          ].join(":"),
        }
        : {}),
    };
    const createAssignmentScope = {
      projectId: await resolveAssignmentProjectId({
        companyId,
        projectId: createBody.projectId,
        parentIssueId: createBody.parentId,
      }),
      parentIssueId: createBody.parentId ?? null,
      assigneeAgentId: createBody.assigneeAgentId ?? null,
      assigneeUserId: rawCreateBody.assigneeUserId ?? null,
    };
    await assertTaskBridgeCreateAllowed(req, companyId, createAssignmentScope);
    if (rawCreateBody.assigneeAgentId || rawCreateBody.assigneeUserId) {
      await assertCanAssignTasks(req, companyId, createAssignmentScope);
    }
    await assertIssueEnvironmentSelection(companyId, createBody.executionWorkspaceSettings?.environmentId);

    const executionPolicy = applyActorMonitorScheduledBy(
      normalizeIssueExecutionPolicy(createBody.executionPolicy),
      actor.actorType,
    );
    await assertCanManageIssueMonitor(access, req, companyId, createBody.assigneeAgentId ?? null, Boolean(executionPolicy?.monitor));
    const issueId = randomUUID();
    const sourceTrust = await sourceTrustForActorWrite({
      id: issueId,
      companyId,
      projectId: createBody.projectId ?? null,
      executionPolicy,
    }, actor);
    let deduplicationReason: "idempotency_key" | "recent_open_title" | null = null;
    const createInput = {
      ...createBody,
      ...(taskBridgeOriginForActor(req) ?? {}),
      id: issueId,
      originRunId: createBody.originRunId ?? actor.runId,
      executionPolicy,
      ...(sourceTrust ? { sourceTrust } : {}),
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      actorRunId: actor.runId,
      actorResponsibleUserId: authenticatedActorResponsibleUserId(req),
      trustExplicitResponsibleUserId: actor.actorType === "user",
      watchdogActorRunId: actor.runId,
      onDeduplicated: (reason: "idempotency_key" | "recent_open_title") => {
        deduplicationReason = reason;
      },
    };
    let issue: Awaited<ReturnType<typeof svc.create>>;
    try {
      issue = await svc.create(companyId, createInput);
    } catch (error) {
      // Concurrent onboarding creates can both pass the zero-count fast path;
      // the issues_onboarding_first_task_uq index rejects the loser here. Fail
      // closed: drop the privileged origin (and with it the agent-attributed
      // greeting) and create an ordinary issue instead.
      if (!(isOnboardingFirstTask && isOnboardingFirstTaskConflict(error))) throw error;
      isOnboardingFirstTask = false;
      const { originKind: _onboardingOriginKind, ...ordinaryCreateInput } = createInput;
      issue = await svc.create(companyId, ordinaryCreateInput);
    }
    if (deduplicationReason) {
      const referenceSummary = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      res.status(200).json({
        ...issue,
        deduplicated: true,
        deduplicationReason,
        relatedWork: referenceSummary,
        referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
      });
      return;
    }
    await issueReferencesSvc.syncIssue(issue.id);
    await externalObjectsSvc.syncIssueSafely(issue.id);
    const referenceSummary = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
      issueReferencesSvc.emptySummary(),
      referenceSummary,
    );

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        title: issue.title,
        identifier: issue.identifier,
        ...(watchdogProductBugFollowUp
          ? {
            watchdogDiscovery: {
              kind: watchdogProductBugFollowUp.discovery.kind,
              sourceIssueId: watchdogProductBugFollowUp.sourceIssue.id,
              sourceIssueIdentifier: watchdogProductBugFollowUp.sourceIssue.identifier,
              watchdogIssueId: watchdogProductBugFollowUp.watchdogIssue?.id ?? null,
              watchdogIssueIdentifier: watchdogProductBugFollowUp.watchdogIssue?.identifier ?? null,
              stopFingerprint: watchdogProductBugFollowUp.scope.stopFingerprint,
            },
          }
          : {}),
        ...buildCreateIssueActivityStatusDetails(issue, res),
        ...(Array.isArray(req.body.blockedByIssueIds) ? { blockedByIssueIds: req.body.blockedByIssueIds } : {}),
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    if (executionPolicy?.monitor) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.monitor_scheduled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          nextCheckAt: executionPolicy.monitor.nextCheckAt,
          notes: executionPolicy.monitor.notes,
          scheduledBy: executionPolicy.monitor.scheduledBy,
          serviceName: executionPolicy.monitor.serviceName ?? null,
          timeoutAt: executionPolicy.monitor.timeoutAt ?? null,
          maxAttempts: executionPolicy.monitor.maxAttempts ?? null,
          recoveryPolicy: executionPolicy.monitor.recoveryPolicy ?? null,
        },
      });
    }

    if (issue.watchdog) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.watchdog_created",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          watchdogId: issue.watchdog.id,
          watchdogAgentId: issue.watchdog.watchdogAgentId,
          source: "issue.create",
        },
      });
    }

    // Seed the onboarding first-task greeting as an agent-authored comment so the
    // user lands on a waiting greeting (instead of a right-aligned "user" bubble
    // showing the seeded description). Deterministic template — no LLM call — and
    // best-effort: a greeting failure must not fail issue creation.
    if (isOnboardingFirstTask && issue.assigneeAgentId) {
      try {
        const [company, goal, assigneeAgent] = await Promise.all([
          companiesSvc.getById(companyId),
          createBody.goalId ? goalsSvc.getById(createBody.goalId) : Promise.resolve(null),
          agentsSvc.getById(issue.assigneeAgentId),
        ]);
        const greetingBody = buildOnboardingGreeting({
          agentName: assigneeAgent?.name ?? null,
          teamName: company?.name ?? null,
          goals: goal?.description ?? goal?.title ?? null,
        });
        await svc.addComment(
          issue.id,
          greetingBody,
          { agentId: issue.assigneeAgentId },
          {
            authorType: "agent",
            authorizationReason: ONBOARDING_GREETING_AUTHORIZATION_REASON,
          },
        );
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id, companyId },
          "failed to seed onboarding first-task greeting",
        );
      }
    }

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });
    await queueTaskWatchdogEvaluation(issue, actor.runId);

    res.status(201).json({
      ...issue,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
    });
  });

  router.post("/issues/:id/children", applyCreateIssueStatusDefault, validateIssueMutationBody(createChildIssueSchema), async (req, res) => {
    const parentId = req.params.id as string;
    const parent = await getAccessibleResource(req, res, svc.getById(parentId), "Parent issue not found");
    if (!parent) return;
    if (!isTaskBridgeKeyActor(req) && !(await assertIssueWriteInfluenceAllowed(req, res, parent))) return;
    if (!(await assertTaskWatchdogCreateIssueAllowed(req, res, parent.companyId, parent))) return;
    if (await assertLowTrustControlPlaneDenied(req, res, parent.companyId, parent)) return;
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));
    const sanitizedBody = await sanitizeIssueCreateAttribution(db, req, res, parent.companyId, req.body, {
      surface: "issues.children.create",
      entityId: parent.id,
    });
    if (!sanitizedBody) return;
    const normalizedAssigneeAgentId = await normalizeIssueAssigneeAgentReference(
      parent.companyId,
      sanitizedBody.assigneeAgentId as string | null | undefined,
      { actorType: req.actor.type },
    );
    await assertNoAgentDelegationCycle({
      actorType: req.actor.type,
      parentIssueId: parent.id,
      assigneeAgentId: normalizedAssigneeAgentId ?? null,
    });
    const createBody = {
      ...sanitizedBody,
      ...(normalizedAssigneeAgentId !== undefined ? { assigneeAgentId: normalizedAssigneeAgentId } : {}),
    };
    const childAssignmentScope = {
      projectId: createBody.projectId ?? parent.projectId ?? null,
      parentIssueId: parent.id,
      assigneeAgentId: createBody.assigneeAgentId ?? null,
      assigneeUserId: createBody.assigneeUserId ?? null,
    };
    await assertTaskBridgeCreateAllowed(req, parent.companyId, childAssignmentScope);
    if (sanitizedBody.assigneeAgentId || sanitizedBody.assigneeUserId) {
      await assertCanAssignTasks(req, parent.companyId, childAssignmentScope);
    }
    await assertIssueEnvironmentSelection(parent.companyId, createBody.executionWorkspaceSettings?.environmentId);

    const actor = getActorInfo(req);
    const serializationContext = await resolveWatchdogFollowUpSerializationContext(req, parent);
    const currentSerializedChild = serializationContext
      ? await findCurrentSerializedWatchdogChild(parent)
      : null;
    const executionPolicy = applyActorMonitorScheduledBy(
      normalizeIssueExecutionPolicy(createBody.executionPolicy),
      actor.actorType,
    );
    await assertCanManageIssueMonitor(access, req, parent.companyId, createBody.assigneeAgentId ?? null, Boolean(executionPolicy?.monitor));
    const issueId = randomUUID();
    const sourceTrust = await sourceTrustForActorWrite({
      id: issueId,
      companyId: parent.companyId,
      projectId: createBody.projectId ?? parent.projectId ?? null,
      executionPolicy,
    }, actor);
    const { issue, parentBlockerAdded } = await svc.createChild(parent.id, {
      ...createBody,
      ...(taskBridgeOriginForActor(req) ?? {}),
      id: issueId,
      executionPolicy,
      ...(currentSerializedChild
        ? {
          status: "blocked",
          blockedByIssueIds: mergeIssueBlockerIds(createBody.blockedByIssueIds, currentSerializedChild.id),
        }
        : {}),
      ...(sourceTrust ? { sourceTrust } : {}),
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      actorRunId: actor.runId,
      actorResponsibleUserId: authenticatedActorResponsibleUserId(req),
      trustExplicitResponsibleUserId: actor.actorType === "user",
      actorAgentId: actor.agentId,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
      watchdogActorRunId: actor.runId,
    });
    await externalObjectsSvc.syncIssueSafely(issue.id);

    await logActivity(db, {
      companyId: parent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.child_created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        parentId: parent.id,
        identifier: issue.identifier,
        title: issue.title,
        ...buildCreateIssueActivityStatusDetails(issue, res),
        inheritedExecutionWorkspaceFromIssueId: parent.id,
        ...(Array.isArray(req.body.blockedByIssueIds) ? { blockedByIssueIds: req.body.blockedByIssueIds } : {}),
        ...(parentBlockerAdded ? { parentBlockerAdded: true } : {}),
        ...(serializationContext
          ? {
            watchdogFollowUpsSerialized: true,
            serializedBehindIssueId: currentSerializedChild?.id ?? null,
          }
          : {}),
      },
    });

    if (executionPolicy?.monitor) {
      await logActivity(db, {
        companyId: parent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.monitor_scheduled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          parentId: parent.id,
          nextCheckAt: executionPolicy.monitor.nextCheckAt,
          notes: executionPolicy.monitor.notes,
          scheduledBy: executionPolicy.monitor.scheduledBy,
          serviceName: executionPolicy.monitor.serviceName ?? null,
          timeoutAt: executionPolicy.monitor.timeoutAt ?? null,
          maxAttempts: executionPolicy.monitor.maxAttempts ?? null,
          recoveryPolicy: executionPolicy.monitor.recoveryPolicy ?? null,
        },
      });
    }

    if (issue.watchdog) {
      await logActivity(db, {
        companyId: parent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.watchdog_created",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          watchdogId: issue.watchdog.id,
          watchdogAgentId: issue.watchdog.watchdogAgentId,
          source: "issue.child_create",
          parentId: parent.id,
        },
      });
    }

    if (!serializationContext || !currentSerializedChild) {
      void queueIssueAssignmentWakeup({
        heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.child_create",
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
    }
    await blockWatchdogParentOnCurrentChild({
      actor,
      watchdogParentIssueId: serializationContext?.watchdogParentIssueId,
      currentChildIssueId: currentSerializedChild?.id ?? issue.id,
    });
    await queueTaskWatchdogEvaluation(issue, actor.runId);

    res.status(201).json(issue);
  });

  router.get("/issues/:id/accepted-plan-decompositions", async (req, res) => {
    const sourceIssueId = req.params.id as string;
    const sourceIssue = await getAccessibleResource(req, res, getIssueById(req, sourceIssueId), "Issue not found");
    if (!sourceIssue) return;
    const decompositions = await svc.listAcceptedPlanDecompositions(sourceIssue.id);
    res.json(decompositions);
  });

  router.post("/issues/:id/accepted-plan-decompositions", validateIssueMutationBody(createAcceptedPlanDecompositionSchema), async (req, res) => {
    const sourceIssueId = req.params.id as string;
    const sourceIssue = await getAccessibleResource(req, res, svc.getById(sourceIssueId), "Issue not found");
    if (!sourceIssue) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, sourceIssue))) return;

    const requestedChildren = [];
    for (const child of req.body.children as Array<typeof req.body.children[number]>) {
      const sanitizedChild = await sanitizeIssueCreateAttribution(db, req, res, sourceIssue.companyId, child, {
        surface: "issues.accepted_plan_decomposition",
        entityId: sourceIssue.id,
      });
      if (!sanitizedChild) return;
      const normalizedAssigneeAgentId = await normalizeIssueAssigneeAgentReference(
        sourceIssue.companyId,
        sanitizedChild.assigneeAgentId as string | null | undefined,
        { actorType: req.actor.type },
      );
      const childBody = {
        ...sanitizedChild,
        ...(normalizedAssigneeAgentId !== undefined ? { assigneeAgentId: normalizedAssigneeAgentId } : {}),
      };
      requestedChildren.push(childBody);
      assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(childBody));
      if (childBody.assigneeAgentId || childBody.assigneeUserId) {
        await assertCanAssignTasks(req, sourceIssue.companyId, {
          projectId: childBody.projectId ?? sourceIssue.projectId ?? null,
          parentIssueId: sourceIssue.id,
          assigneeAgentId: childBody.assigneeAgentId ?? null,
          assigneeUserId: childBody.assigneeUserId ?? null,
        });
      }
      await assertIssueEnvironmentSelection(sourceIssue.companyId, childBody.executionWorkspaceSettings?.environmentId);
    }

    const actor = getActorInfo(req);
    const normalizedChildren = [];
    for (const child of requestedChildren) {
      const executionPolicy = applyActorMonitorScheduledBy(
        normalizeIssueExecutionPolicy(child.executionPolicy),
        actor.actorType,
      );
      await assertCanManageIssueMonitor(access, req, sourceIssue.companyId, child.assigneeAgentId ?? null, Boolean(executionPolicy?.monitor));
      const childIssueId = randomUUID();
      const sourceTrust = await sourceTrustForActorWrite({
        id: childIssueId,
        companyId: sourceIssue.companyId,
        projectId: child.projectId ?? sourceIssue.projectId ?? null,
        executionPolicy,
      }, actor);
      normalizedChildren.push({
        ...child,
        id: childIssueId,
        executionPolicy,
        ...(sourceTrust ? { sourceTrust } : {}),
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        actorRunId: actor.runId,
        actorResponsibleUserId: authenticatedActorResponsibleUserId(req),
        trustExplicitResponsibleUserId: actor.actorType === "user",
        actorAgentId: actor.agentId,
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
      });
    }
    const serializationContext = await resolveWatchdogFollowUpSerializationContext(req, sourceIssue);
    const existingSerializedChild = serializationContext
      ? await findCurrentSerializedWatchdogChild(sourceIssue)
      : null;
    const serializedBlockedChildIds = new Set<string>();
    if (serializationContext) {
      for (let index = 0; index < normalizedChildren.length; index += 1) {
        const blockerIssueId: string | null = index === 0
          ? existingSerializedChild?.id ?? null
          : normalizedChildren[index - 1]?.id ?? null;
        if (!blockerIssueId) continue;
        normalizedChildren[index] = {
          ...normalizedChildren[index],
          status: "blocked",
          blockedByIssueIds: mergeIssueBlockerIds(normalizedChildren[index].blockedByIssueIds, blockerIssueId),
        };
        serializedBlockedChildIds.add(normalizedChildren[index].id);
      }
    }

    const result = await svc.decomposeAcceptedPlan(sourceIssue.id, {
      acceptedPlanRevisionId: req.body.acceptedPlanRevisionId,
      children: normalizedChildren,
      actorAgentId: actor.agentId,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
      actorRunId: actor.runId ?? null,
    });

    await logActivity(db, {
      companyId: sourceIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.accepted_plan_decomposition_updated",
      entityType: "issue",
      entityId: sourceIssue.id,
      details: {
        identifier: sourceIssue.identifier,
        acceptedPlanRevisionId: req.body.acceptedPlanRevisionId,
        decompositionId: result.decomposition.id,
        status: result.decomposition.status,
        requestedChildCount: req.body.children.length,
        childIssueIds: result.childIssueIds,
        newlyCreatedChildIssueIds: result.newlyCreatedIssues.map((issue) => issue.id),
        ...(serializationContext
          ? {
            watchdogFollowUpsSerialized: true,
            currentSerializedChildIssueId: existingSerializedChild?.id ?? result.newlyCreatedIssues[0]?.id ?? null,
            serializedBlockedChildIssueIds: [...serializedBlockedChildIds],
          }
          : {}),
      },
    });

    for (const issue of result.newlyCreatedIssues) {
      await logActivity(db, {
        companyId: sourceIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.child_created",
        entityType: "issue",
        entityId: issue.id,
        details: {
          parentId: sourceIssue.id,
          identifier: issue.identifier,
          title: issue.title,
          inheritedExecutionWorkspaceFromIssueId: sourceIssue.id,
          acceptedPlanRevisionId: req.body.acceptedPlanRevisionId,
          ...buildCreateIssueActivityStatusDetails(issue, res),
          ...(serializationContext
            ? {
              watchdogFollowUpsSerialized: true,
              serializedBlocked: serializedBlockedChildIds.has(issue.id),
            }
            : {}),
        },
      });

      const executionPolicy = normalizeIssueExecutionPolicy(issue.executionPolicy);
      if (executionPolicy?.monitor) {
        await logActivity(db, {
          companyId: sourceIssue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "issue.monitor_scheduled",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            parentId: sourceIssue.id,
            acceptedPlanRevisionId: req.body.acceptedPlanRevisionId,
            nextCheckAt: executionPolicy.monitor.nextCheckAt,
            notes: executionPolicy.monitor.notes,
            scheduledBy: executionPolicy.monitor.scheduledBy,
            serviceName: executionPolicy.monitor.serviceName ?? null,
            timeoutAt: executionPolicy.monitor.timeoutAt ?? null,
            maxAttempts: executionPolicy.monitor.maxAttempts ?? null,
            recoveryPolicy: executionPolicy.monitor.recoveryPolicy ?? null,
          },
        });
      }

      if (!serializedBlockedChildIds.has(issue.id)) {
        void queueIssueAssignmentWakeup({
          heartbeat,
          issue,
          reason: "issue_assigned",
          mutation: "accepted_plan_decomposition",
          contextSource: "issue.accepted_plan_decomposition",
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
        });
      }
      await queueTaskWatchdogEvaluation(issue, actor.runId);
    }
    await blockWatchdogParentOnCurrentChild({
      actor,
      watchdogParentIssueId: serializationContext?.watchdogParentIssueId,
      currentChildIssueId: existingSerializedChild?.id ?? result.newlyCreatedIssues[0]?.id,
    });

    res.json({
      decomposition: result.decomposition,
      childIssueIds: result.childIssueIds,
      newlyCreatedChildIssueIds: result.newlyCreatedIssues.map((issue) => issue.id),
    });
  });

  router.post("/issues/:id/monitor/check-now", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    await assertCanManageIssueMonitor(access, req, issue.companyId, issue.assigneeAgentId, true);

    const actor = getActorInfo(req);
    await heartbeat.triggerIssueMonitor(issue.id, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
    });

    res.json({ ok: true });
  });

  router.post("/issues/:id/scheduled-retry/retry-now", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;

    const actor = getActorInfo(req);
    const result = await heartbeat.retryScheduledRetryNow({
      issueId: issue.id,
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "issue.scheduled_retry_retry_now",
      entityType: "issue",
      entityId: issue.id,
      agentId: result.scheduledRetry?.agentId ?? issue.assigneeAgentId ?? null,
      runId: result.scheduledRetry?.runId ?? null,
      details: {
        outcome: result.outcome,
        message: result.message,
        scheduledRetry: result.scheduledRetry,
      },
    });

    res.json(result);
  });

  router.post(
    "/issues/:id/stalled-review-decision",
    validate(stalledReviewDecisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      assertBoard(req);

      if (req.actor.source !== "local_implicit") {
        const userId = req.actor.userId?.trim();
        const membership = userId
          ? await db
              .select({ membershipRole: companyMemberships.membershipRole })
              .from(companyMemberships)
              .where(and(
                eq(companyMemberships.companyId, issue.companyId),
                eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.principalId, userId),
                eq(companyMemberships.status, "active"),
              ))
              .then((rows) => rows[0] ?? null)
          : null;
        if (!membership?.membershipRole || membership.membershipRole === "viewer") {
          throw forbidden("Active non-viewer company membership required");
        }
      }

      const actor = getActorInfo(req);
      const result = await stalledReviewDecisionService(db).decide({
        issueId: issue.id,
        companyId: issue.companyId,
        action: req.body.action,
        note: req.body.note,
        actor: {
          userId: actor.actorId,
          runId: actor.runId,
        },
      });

      // The decision transaction has already committed the status change. The
      // remaining side effects (comment sync, resume wake) are best-effort: a
      // transient failure must not fail the request, because the decision
      // cannot be retried once the issue has left `in_review`, which would
      // permanently strand the resume signal. This mirrors the issue-update
      // wake dispatch, and the issue lands durably in `todo`/`done` regardless.
      //
      // Reviewed and accepted as best-effort rather than transactional (PAP-16101):
      // `enqueueWakeup` writes a durable `agent_wakeup_requests` row, so the wake
      // is scheduler-driven the moment that insert lands, and the catch below only
      // covers a transient insert failure. In that narrow window the issue is in
      // `todo` *still assigned* — an active status the normal liveness sweep picks
      // up — so the worst case is a delayed resume, not the invisible
      // `in_review`-with-zero-paths zombie this contract exists to kill. Making
      // only this path transactional would also diverge from every other route's
      // post-commit dispatch. `wakeQueued` is returned so callers can see the
      // difference.
      if (result.comment) {
        try {
          await issueReferencesSvc.syncComment(result.comment.id);
          await externalObjectsSvc.syncCommentSafely(result.comment.id);
        } catch (err) {
          logger.warn(
            { err, issueId: result.issue.id, commentId: result.comment.id },
            "failed to sync stalled-review decision comment",
          );
        }
      }

      let wakeQueued = false;
      if (req.body.action !== "approve" && result.issue.assigneeAgentId) {
        const userAuthoredNote = result.comment
          ? { commentId: result.comment.id, authorUserId: actor.actorId }
          : undefined;
        try {
          const wake = await enqueueStalledReviewDecisionWakeup(result.issue.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_status_changed",
            idempotencyKey: `stalled-review-decision:${result.issue.id}:${req.body.action}`,
            requestedByActorType: "user",
            requestedByActorId: actor.actorId,
            payload: {
              issueId: result.issue.id,
              mutation: "stalled_review_decision",
              reviewDecision: req.body.action,
              resumeIntent: true,
              ...(userAuthoredNote ? { userAuthoredNote } : {}),
            },
            contextSnapshot: {
              issueId: result.issue.id,
              taskId: result.issue.id,
              source: "issue.stalled_review_decision",
              wakeReason: "issue_status_changed",
              reviewDecision: req.body.action,
              resumeIntent: true,
              ...(userAuthoredNote ? { userAuthoredNote } : {}),
            },
          });
          wakeQueued = wake !== null;
        } catch (err) {
          logger.warn(
            { err, issueId: result.issue.id, agentId: result.issue.assigneeAgentId },
            "failed to enqueue stalled-review decision resume wake",
          );
        }
      }

      res.json({
        issue: result.issue,
        action: req.body.action,
        comment: result.comment,
        wakeQueued,
      });
    },
  );

  router.patch("/issues/:id", validateIssueMutationBody(updateIssueRouteSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!existing) return;
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));
    if (req.actor.type === "agent" && req.body.onBehalfOfUserId != null) {
      await auditAgentIssueCommentAttributionSpoof({
        db,
        req,
        issue: existing,
        surface: "issue.patch.comment",
        requestedValue: readNonEmptyString(req.body.onBehalfOfUserId),
      });
      await denyIssueWrite(req, res, existing, "issue_write_attribution_spoof_rejected");
      return;
    }
    const issueMutationAccess = await assertAgentIssueMutationAllowed(
      req,
      res,
      existing,
      { allowVisibleIssueWrite: true },
    );
    if (!issueMutationAccess) return;
    const issueMutationAuthorizationReason = req.actor.type === "agent"
      ? issueWriteAuthorizationReason(req, await decideIssueAccess(req, existing, "issue:mutate"))
      : issueWriteAuthorizationReason(req, true);

    const actor = getActorInfo(req);
    const isClosed = isClosedIssueStatus(existing.status);
    const isBlocked = existing.status === "blocked";
    const normalizedAssigneeAgentId = await normalizeIssueAssigneeAgentReference(
      existing.companyId,
      req.body.assigneeAgentId as string | null | undefined,
      { actorType: req.actor.type },
    );
    const titleOrDescriptionChanged = req.body.title !== undefined || req.body.description !== undefined;
    const existingRelations =
      Array.isArray(req.body.blockedByIssueIds)
        ? await svc.getRelationSummaries(existing.id)
        : null;
    const {
      comment: commentBody,
      reviewInteractionId: requestedReviewInteractionId,
      reviewRequest,
      reopen: reopenRequested,
      resume: resumeRequested,
      interrupt: interruptRequested,
      hiddenAt: hiddenAtRaw,
      onBehalfOfUserId: _requestedOnBehalfOfUserId,
      ...updateFields
    } = req.body;
    const reviewPolicyChangeRequested =
      req.body.reviewPolicy !== undefined
      && req.body.reviewPolicy !== existing.reviewPolicy;
    const reviewVerdictRequested =
      existing.status === "in_review"
      && (updateFields.status === "done" || updateFields.status === "cancelled");
    const reviewPolicySensitiveMutationRequested =
      req.body.reviewPolicy !== undefined
      || updateFields.status === "done"
      || updateFields.status === "cancelled";
    if (
      (reviewVerdictRequested || reviewPolicyChangeRequested)
      && existing.reviewPolicy != null
      && existing.reviewPolicy !== "anyone"
    ) {
      await assertIssueReviewVerdictActorAllowed(db, {
        issue: existing,
        actor: { type: actor.actorType, id: actor.actorId },
        reviewPolicy: existing.reviewPolicy,
      });
    }
    const shouldCancelActiveRunForCancelledStatus =
      existing.status !== "cancelled" && updateFields.status === "cancelled";
    if (resumeRequested === true && !commentBody) {
      res.status(400).json({ error: "Follow-up intent requires a comment" });
      return;
    }
    if (
      (reopenRequested === true ||
        resumeRequested === true ||
        Array.isArray(req.body.blockedByIssueIds)) &&
      await assertLowTrustControlPlaneDenied(req, res, existing.companyId, existing)
    ) {
      return;
    }
    if (
      resumeRequested === true &&
      !(await assertExplicitResumeIntentAllowed(req, res, existing, { resumeIntent: true }))
    ) return;
    const agentStatusTransitionRequiresResumeAuthority =
      req.actor.type === "agent" &&
      typeof updateFields.status === "string" &&
      updateFields.status !== existing.status &&
      (isBlocked || (isClosed && !isClosedIssueStatus(updateFields.status)));
    if (resumeRequested !== true && req.actor.type === "agent" && reopenRequested === true) {
      if (!(await assertExplicitResumeIntentAllowed(req, res, existing))) return;
    }
    await assertIssueEnvironmentSelection(existing.companyId, updateFields.executionWorkspaceSettings?.environmentId);
    const requestedAssigneeAgentId =
      normalizedAssigneeAgentId === undefined ? existing.assigneeAgentId : normalizedAssigneeAgentId;
    const explicitMoveToTodoRequested = reopenRequested || resumeRequested === true;
    const recoveryRelevantSourceMutationRequested =
      req.body.status !== undefined ||
      normalizedAssigneeAgentId !== undefined ||
      req.body.assigneeUserId !== undefined ||
      Array.isArray(req.body.blockedByIssueIds) ||
      req.body.executionPolicy !== undefined ||
      explicitMoveToTodoRequested;
    const activeRecoveryActionBeforeUpdate = recoveryRelevantSourceMutationRequested
      ? await recoveryActionsSvc.getActiveForIssue(existing.companyId, existing.id)
      : null;
    if (recoveryRelevantSourceMutationRequested) {
      await requireRecoveryActionAuthority(
        req,
        existing,
        activeRecoveryActionBeforeUpdate,
        { source: "issue_update" },
      );
      const recoveryRestrictedSourceMutationRequested =
        activeRecoveryActionBeforeUpdate != null &&
        (
          updateFields.status === "done" ||
          updateFields.status === "cancelled" ||
          normalizedAssigneeAgentId !== undefined ||
          req.body.assigneeUserId !== undefined ||
          (
            activeExecutionParticipantAgentId(existing) != null &&
            typeof updateFields.status === "string" &&
            updateFields.status !== existing.status
          )
        );
      if (recoveryRestrictedSourceMutationRequested) {
        await requireRecoverySourceMutationAuthority(req, existing);
      }
    }
    if (
      resumeRequested !== true &&
      agentStatusTransitionRequiresResumeAuthority &&
      !(await assertExplicitResumeIntentAllowed(req, res, existing))
    ) {
      return;
    }
    const scheduledRetryForHumanComment =
      shouldHumanCommentResumeInProgressScheduledRetry({
        hasComment: !!commentBody,
        issueStatus: existing.status,
        assigneeAgentId: requestedAssigneeAgentId,
        actorType: actor.actorType,
      })
        ? await svc.getCurrentScheduledRetry(existing.id)
        : null;
    const shouldResumeInProgressScheduledRetry =
      !!scheduledRetryForHumanComment &&
      scheduledRetryForHumanComment.agentId === requestedAssigneeAgentId;
    const assigneeSelfCommentOnTerminal = isAssigneeSelfCommentOnTerminalIssue({
      hasCommentBody: !!commentBody,
      resumeRequested: resumeRequested === true,
      issueStatus: existing.status,
      assigneeAgentId: existing.assigneeAgentId,
      actorType: actor.actorType,
      actorId: actor.actorId,
    });
    const effectiveMoveToTodoRequested =
      !assigneeSelfCommentOnTerminal &&
      (explicitMoveToTodoRequested ||
        (!!commentBody &&
          shouldImplicitlyMoveCommentedIssueToTodo({
            issueStatus: existing.status,
            assigneeAgentId: requestedAssigneeAgentId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            actorRunId: actor.runId,
            checkoutRunId: existing.checkoutRunId,
            executionRunId: existing.executionRunId,
            requestAddsExplicitBlockers:
              Array.isArray(req.body.blockedByIssueIds) && req.body.blockedByIssueIds.length > 0,
          })) ||
        shouldResumeInProgressScheduledRetry);
    const updateReferenceSummaryBefore = titleOrDescriptionChanged
      ? await issueReferencesSvc.listIssueReferenceSummary(existing.id)
      : null;
    const hasUnresolvedFirstClassBlockers =
      isBlocked && effectiveMoveToTodoRequested
        ? (await svc.getDependencyReadiness(existing.id)).unresolvedBlockerCount > 0
        : false;
    if (resumeRequested === true && isBlocked && hasUnresolvedFirstClassBlockers) {
      res.status(409).json({ error: "Issue follow-up blocked by unresolved blockers" });
      return;
    }
    let interruptedRunId: string | null = null;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(existing);
    const isAgentWorkUpdate =
      req.actor.type === "agent" &&
      (Object.keys(updateFields).length > 0 || reviewRequest !== undefined || hiddenAtRaw !== undefined);

    if (
      isAgentWorkUpdate &&
      !(await assertCrossIssueInfluenceWithinRunCap(req, res, existing, "update"))
    ) return;
    if (
      commentBody &&
      !(await assertCrossIssueInfluenceWithinRunCap(req, res, existing, "comment"))
    ) return;

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
        const cancelled = await heartbeat.cancelRun(
          runToInterrupt.id,
          "Interrupted by board comment",
          operatorInterruptCancelOptions({ issueId: existing.id, actor }),
        );
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            issueId: existing.id,
            details: {
              agentId: cancelled.agentId,
              source: "issue_comment_interrupt",
              issueId: existing.id,
              cancellationKind: "operator_interrupted",
              operatorInterrupted: true,
            },
          });
        }
      }
    }

    const runToCancelForCancelledStatus = shouldCancelActiveRunForCancelledStatus
      ? await resolveActiveIssueRun(existing)
      : null;

    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
    }
    if (
      commentBody &&
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers) || shouldResumeInProgressScheduledRetry) &&
      updateFields.status === undefined
    ) {
      updateFields.status = "todo";
    }
    let cancelledScheduledRetryRunId: string | null = null;
    if (
      commentBody &&
      shouldResumeInProgressScheduledRetry &&
      updateFields.status === "todo"
    ) {
      cancelledScheduledRetryRunId = await cancelScheduledRetrySupersededByComment({
        scheduledRetryRunId: scheduledRetryForHumanComment?.runId,
        issue: existing,
        actor,
      });
    }
    if (req.body.executionPolicy !== undefined) {
      updateFields.executionPolicy = applyActorMonitorScheduledBy(
        normalizeIssueExecutionPolicy(req.body.executionPolicy),
        actor.actorType,
      );
    }
    const previousExecutionPolicy = normalizeIssueExecutionPolicy(existing.executionPolicy ?? null);
    const nextExecutionPolicy =
      updateFields.executionPolicy !== undefined
        ? (updateFields.executionPolicy as NormalizedExecutionPolicy | null)
        : previousExecutionPolicy;
    if (normalizedAssigneeAgentId !== undefined) {
      updateFields.assigneeAgentId = normalizedAssigneeAgentId;
    }
    const monitorChanged = monitorPoliciesEqual(previousExecutionPolicy, nextExecutionPolicy) === false;
    await assertCanManageIssueMonitor(
      access,
      req,
      existing.companyId,
      existing.assigneeAgentId,
      req.body.executionPolicy !== undefined && monitorChanged,
    );

    const transition = applyIssueExecutionPolicyTransition({
      issue: existing,
      policy: nextExecutionPolicy,
      previousPolicy: previousExecutionPolicy,
      requestedStatus: typeof updateFields.status === "string" ? updateFields.status : undefined,
      requestedAssigneePatch: {
        assigneeAgentId: normalizedAssigneeAgentId,
        assigneeUserId:
          req.body.assigneeUserId === undefined ? undefined : (req.body.assigneeUserId as string | null),
      },
      actor: {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
      allowBoardOverride: req.actor.type === "board",
      commentBody,
      reviewRequest: reviewRequest === undefined ? undefined : reviewRequest,
      monitorExplicitlyUpdated: req.body.executionPolicy !== undefined && monitorChanged,
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

    const nextStatus = updateFields.status ?? existing.status;
    if (updateFields.unblockDescriptor && nextStatus !== "blocked") {
      throw unprocessable("unblockDescriptor requires blocked status");
    }
    const descriptor = updateFields.unblockDescriptor ?? null;
    if (descriptor && typeof descriptor === "object") {
      const owner = descriptor.owner;
      if (req.actor.type === "agent" && (owner === "board" || "userId" in owner)) {
        throw forbidden("Agents may only name themselves as an unblock owner");
      }
      if (owner !== "board" && "agentId" in owner) {
        const target = await db.select({ id: agents.id }).from(agents).where(and(
          eq(agents.id, owner.agentId),
          eq(agents.companyId, existing.companyId),
        )).limit(1).then((rows) => rows[0] ?? null);
        if (!target) throw unprocessable("Unblock owner agent must belong to the issue company");
        if (req.actor.type === "agent" && req.actor.agentId !== owner.agentId) {
          throw forbidden("Agents may only name themselves as an unblock owner");
        }
      } else if (owner !== "board" && "userId" in owner) {
        const member = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
          eq(companyMemberships.companyId, existing.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, owner.userId),
          eq(companyMemberships.status, "active"),
        )).limit(1).then((rows) => rows[0] ?? null);
        if (!member) throw unprocessable("Unblock owner user must be an active company member");
      }
    }
    const enteringBlocked = existing.status !== "blocked" && updateFields.status === "blocked";
    if (enteringBlocked) {
      const requestedBlockerIds = Array.isArray(req.body.blockedByIssueIds)
        ? [...new Set(req.body.blockedByIssueIds as string[])]
        : null;
      const hasUnresolvedBlocker = requestedBlockerIds
        ? requestedBlockerIds.length > 0 && await db.select({ id: issueRows.id }).from(issueRows).where(and(
          eq(issueRows.companyId, existing.companyId),
          inArray(issueRows.id, requestedBlockerIds),
          notInArray(issueRows.status, ["done", "cancelled"]),
        )).limit(1).then((rows) => rows.length > 0)
        : (await svc.getDependencyReadiness(existing.id)).unresolvedBlockerCount > 0;
      const [pendingInteraction, pendingApproval] = await Promise.all([
        db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.companyId, existing.companyId),
          eq(issueThreadInteractions.issueId, existing.id),
          eq(issueThreadInteractions.status, "pending"),
        )).limit(1).then((rows) => rows[0] ?? null),
        db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id)).where(and(
          eq(issueApprovals.companyId, existing.companyId),
          eq(issueApprovals.issueId, existing.id),
          eq(approvals.status, "pending"),
        )).limit(1).then((rows) => rows[0] ?? null),
      ]);
      if (!hasUnresolvedBlocker && !pendingInteraction && !pendingApproval && !descriptor) {
        res.status(422).json({ error: "Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor" });
        return;
      }
    }
    if (reviewRequest !== undefined && transition.patch.executionState === undefined) {
      const existingExecutionState = parseIssueExecutionState(existing.executionState);
      if (!existingExecutionState || existingExecutionState.status !== "pending") {
        if (reviewRequest !== null) {
          res.status(422).json({ error: "reviewRequest requires an active review or approval stage" });
          return;
        }
      } else {
        updateFields.executionState = {
          ...existingExecutionState,
          reviewRequest,
        };
      }
    }

    const reviewInteractionId = await assertInReviewReviewPath({
      existing,
      updateFields,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorAgentId: actor.agentId,
      actorRunId: actor.runId,
      reviewInteractionId: requestedReviewInteractionId,
    });
    const enteringReviewRequested =
      existing.status !== "in_review" && updateFields.status === "in_review";
    const persistReviewActivityTransactionally =
      enteringReviewRequested || Boolean(reviewInteractionId);

    const nextAssigneeAgentId =
      updateFields.assigneeAgentId === undefined ? existing.assigneeAgentId : (updateFields.assigneeAgentId as string | null);
    const nextAssigneeUserId =
      updateFields.assigneeUserId === undefined ? existing.assigneeUserId : (updateFields.assigneeUserId as string | null);
    const assigneeWillChange =
      nextAssigneeAgentId !== existing.assigneeAgentId || nextAssigneeUserId !== existing.assigneeUserId;
    const isAgentReturningIssueToCreator =
      req.actor.type === "agent" &&
      !!req.actor.agentId &&
      existing.assigneeAgentId === req.actor.agentId &&
      nextAssigneeAgentId === null &&
      typeof nextAssigneeUserId === "string" &&
      !!existing.createdByUserId &&
      nextAssigneeUserId === existing.createdByUserId;

    if (assigneeWillChange && !transition.workflowControlledAssignment) {
      if (!isAgentReturningIssueToCreator) {
        await assertCanAssignTasks(req, existing.companyId, {
          issueId: existing.id,
          projectId: await resolveAssignmentProjectId({
            companyId: existing.companyId,
            projectId: updateFields.projectId === undefined
              ? existing.projectId
              : updateFields.projectId as string | null | undefined,
            parentIssueId: (updateFields.parentId === undefined
              ? existing.parentId
              : updateFields.parentId) as string | null | undefined,
          }),
          parentIssueId: (updateFields.parentId === undefined
            ? existing.parentId
            : updateFields.parentId) as string | null | undefined,
          assigneeAgentId: nextAssigneeAgentId,
          assigneeUserId: nextAssigneeUserId,
        });
      }
    }

    const nextParentId = updateFields.parentId === undefined
      ? existing.parentId
      : updateFields.parentId as string | null;
    const shouldRelayStop =
      Boolean(nextParentId) &&
      existing.status !== updateFields.status &&
      (updateFields.status === "blocked" || updateFields.status === "cancelled") &&
      await directParentReportDisabledForIssue({
        companyId: existing.companyId,
        projectId: updateFields.projectId === undefined
          ? existing.projectId
          : updateFields.projectId as string | null,
        executionPolicy: updateFields.executionPolicy === undefined
          ? existing.executionPolicy
          : updateFields.executionPolicy,
        assigneeAgentId: nextAssigneeAgentId,
        checkoutRunId: existing.checkoutRunId,
        executionRunId: existing.executionRunId,
      });
    const stopRelayResult: {
      value: Awaited<ReturnType<typeof svc.addStopRelayCommentIfNeeded>>;
    } = { value: null };
    const postCommitActivityPublications: ActivityPublication[] = [];
    const postCommitIssueActions: IssuePostCommitAction[] = [];
    const issueUpdateData = {
      ...updateFields,
      actorAgentId: actor.agentId ?? null,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
    };
    const shouldCollectCompletionPublication =
      actor.actorType === "user" && existing.status !== "done" && updateFields.status === "done";
    const shouldCollectTerminalIssueActions =
      updateFields.status === "done" || updateFields.status === "cancelled";
    const updateIssue = (tx?: Parameters<typeof svc.update>[2]) => {
      if (tx) {
        if (shouldCollectCompletionPublication) {
          return svc.update(id, issueUpdateData, tx, postCommitActivityPublications, postCommitIssueActions);
        }
        return shouldCollectTerminalIssueActions
          ? svc.update(id, issueUpdateData, tx, undefined, postCommitIssueActions)
          : svc.update(id, issueUpdateData, tx);
      }
      return shouldCollectCompletionPublication
        ? svc.update(id, issueUpdateData, db, postCommitActivityPublications)
        : svc.update(id, issueUpdateData);
    };
    const assertLockedReviewPolicyAllowsMutation = async (
      tx: Parameters<typeof svc.update>[2],
    ) => {
      const lockedExisting = await svc.getByIdForUpdate(id, tx);
      if (!lockedExisting) return false;
      const lockedPolicyChangeRequested =
        req.body.reviewPolicy !== undefined
        && req.body.reviewPolicy !== lockedExisting.reviewPolicy;
      const lockedReviewVerdictRequested =
        lockedExisting.status === "in_review"
        && (updateFields.status === "done" || updateFields.status === "cancelled");
      if (
        (lockedReviewVerdictRequested || lockedPolicyChangeRequested)
        && lockedExisting.reviewPolicy != null
        && lockedExisting.reviewPolicy !== "anyone"
      ) {
        await assertIssueReviewVerdictActorAllowed(tx as unknown as Db, {
          issue: lockedExisting,
          actor: { type: actor.actorType, id: actor.actorId },
          reviewPolicy: lockedExisting.reviewPolicy,
        });
      }
      return true;
    };
    const persistReviewTransitionActivity = async (
      tx: Parameters<typeof svc.update>[2],
      updated: NonNullable<Awaited<ReturnType<typeof svc.update>>>,
    ) => {
      if (!persistReviewActivityTransactionally) return;
      const changes = updated.changes ?? {};
      const previous = Object.fromEntries(
        Object.entries(changes).map(([key, change]) => [key, change.from]),
      );
      await logActivity(tx as unknown as Db, {
        companyId: updated.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        responsibleUserIdOverride: authenticatedActorResponsibleUserId(req),
        action: "issue.updated",
        entityType: "issue",
        entityId: updated.id,
        details: {
          ...updateFields,
          identifier: updated.identifier,
          authorizationReason: issueMutationAuthorizationReason,
          changes,
          ...(reviewInteractionId ? { reviewInteractionId } : {}),
          ...(commentBody ? { source: "comment" } : {}),
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          _previous: Object.keys(changes).length > 0 ? previous : undefined,
        },
      }, postCommitActivityPublications);
    };
    // Reopen the closed isolated workspace only after every access, validation,
    // and policy gate passes, and just before the update persists. A rejected
    // update must not rebuild and republish the workspace as active, because the
    // issue stays terminal and the reaper then skips the leaked workspace.
    let reopenedWorkspace: Pick<ExecutionWorkspace, "id"> | null = null;
    let reopenedGeneration: number | null = null;
    if (closedExecutionWorkspace && (commentBody || isAgentWorkUpdate)) {
      const reopenOutcome = await reopenClosedIssueExecutionWorkspaceOrRespond(
        req,
        res,
        existing,
        closedExecutionWorkspace,
      );
      if (reopenOutcome === null) {
        return;
      }
      // Install the guard only when this request set the reopen-pending flag. A
      // concurrent request that found the workspace already open must not clear
      // the flag that the actual reopener still owns.
      if (reopenOutcome.outcome === "reopened") {
        reopenedWorkspace = closedExecutionWorkspace;
        reopenedGeneration = reopenOutcome.generation;
      }
    }
    let issue: Awaited<ReturnType<typeof svc.update>>;
    // Clear the reopen-pending flag if this update leaves the issue terminal, so
    // the rebuilt worktree does not leak. The guard reads `issue` when the
    // response ends, so it also covers a null return and a thrown error. It clears
    // only the fence this request installed, keyed by its generation.
    guardReopenedWorkspaceConsumption({
      req,
      res,
      issue: existing,
      workspace: reopenedWorkspace,
      generation: reopenedGeneration,
      finalIssueStatus: () => issue?.status,
    });
    const decision = transition.decision && decisionId ? transition.decision : null;
    const shouldUseTransactionalIssueUpdate =
      Boolean(decision)
      || shouldRelayStop
      || persistReviewActivityTransactionally
      || reviewPolicySensitiveMutationRequested;
    try {
      if (shouldUseTransactionalIssueUpdate) {
        issue = await db.transaction(async (tx) => {
          if (
            reviewPolicySensitiveMutationRequested
            && !(await assertLockedReviewPolicyAllowsMutation(tx))
          ) return null;
          const updated = await updateIssue(tx);
          if (!updated) return null;

          if (decision && decisionId) {
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
          }

          if (shouldRelayStop) {
            stopRelayResult.value = await svc.addStopRelayCommentIfNeeded(updated, tx);
          }

          await persistReviewTransitionActivity(tx, updated);

          return updated;
        });
      } else {
        issue = await updateIssue();
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            issueId: id,
            companyId: existing.companyId,
            assigneePatch: {
              assigneeAgentId: normalizedAssigneeAgentId === undefined ? "__omitted__" : normalizedAssigneeAgentId,
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
    for (const publication of postCommitActivityPublications) publishActivity(publication);
    await flushIssuePostCommitActions(postCommitIssueActions);

    if (enteringBlocked) {
      const blockedIssue = issue;
      let ownerNotifiedAt: Date | null = null;
      await deliverAgentUnblockNotification({
        issue: blockedIssue,
        wakeup: heartbeat.wakeup,
        markNotified: async (blockedOwnerNotifiedAt) => {
          ownerNotifiedAt = blockedOwnerNotifiedAt;
        },
      });
      if (ownerNotifiedAt) {
        await db.update(issueRows).set({ blockedOwnerNotifiedAt: ownerNotifiedAt }).where(and(
          eq(issueRows.id, blockedIssue.id),
          eq(issueRows.companyId, blockedIssue.companyId),
        ));
        issue = { ...blockedIssue, blockedOwnerNotifiedAt: ownerNotifiedAt };
      }
    }

    let cancelledStatusRunId: string | null = null;
    if (runToCancelForCancelledStatus) {
      try {
        const cancelled = await heartbeat.cancelRun(runToCancelForCancelledStatus.id);
        if (cancelled) {
          cancelledStatusRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            issueId: existing.id,
            details: { agentId: cancelled.agentId, source: "issue_status_cancelled", issueId: existing.id },
          });
        }
      } catch (err) {
        logger.warn({ err, issueId: existing.id, runId: runToCancelForCancelledStatus.id }, "failed to cancel run for cancelled issue");
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "heartbeat.cancel_failed",
          entityType: "heartbeat_run",
          entityId: runToCancelForCancelledStatus.id,
          issueId: existing.id,
          details: { source: "issue_status_cancelled", issueId: existing.id },
        });
      }
    }

    if (titleOrDescriptionChanged) {
      await issueReferencesSvc.syncIssue(issue.id);
      await externalObjectsSvc.syncIssueSafely(issue.id);
    }
    const updateReferenceSummaryAfter = titleOrDescriptionChanged
      ? await issueReferencesSvc.listIssueReferenceSummary(issue.id)
      : null;
    const updateReferenceDiff = updateReferenceSummaryBefore && updateReferenceSummaryAfter
      ? issueReferencesSvc.diffIssueReferenceSummary(updateReferenceSummaryBefore, updateReferenceSummaryAfter)
      : null;
    let issueResponse: typeof issue & {
      blockedBy?: unknown;
      blocks?: unknown;
      activeRecoveryAction?: unknown;
      relatedWork?: Awaited<ReturnType<typeof issueReferencesSvc.listIssueReferenceSummary>>;
      referencedIssueIdentifiers?: string[];
    } = issue;
    let updatedRelations: Awaited<ReturnType<typeof svc.getRelationSummaries>> | null = null;
    if (issue && Array.isArray(req.body.blockedByIssueIds)) {
      updatedRelations = await svc.getRelationSummaries(issue.id);
      issueResponse = {
        ...issue,
        blockedByIssueIds:
          issue.blockedByIssueIds ?? [...new Set(req.body.blockedByIssueIds as string[])].sort(),
        blockedBy: updatedRelations.blockedBy,
        blocks: updatedRelations.blocks,
      };
    }
    await routinesSvc.syncRunStatusForIssue(issue.id);

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue activity"));
    }

    // Use the service's row-lock-backed receipt as the activity source of truth.
    // Requested fields alone miss server-side effects such as cleared run locks,
    // status timestamps, goal fallback, and normalized relation arrays.
    const issueChanges = issue.changes ?? {};
    const previous: Record<string, unknown> = Object.fromEntries(
      Object.entries(issueChanges).map(([key, change]) => [key, change.from]),
    );
    const hasFieldChanges = Object.keys(issueChanges).length > 0;
    let workspaceChange = null;
    if (hasIssueWorkspaceAuditChange(previous)) {
      try {
        workspaceChange = await buildIssueWorkspaceChangeActivityDetails(db, issue.companyId, existing, issue);
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "failed to enrich issue workspace change activity details");
        const fallbackNames = emptyWorkspaceNameMaps();
        workspaceChange = {
          from: summarizeIssueWorkspaceForActivity(existing, fallbackNames),
          to: summarizeIssueWorkspaceForActivity(issue, fallbackNames),
        };
      }
    }
    const reopened =
      commentBody &&
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers)) &&
      previous.status !== undefined &&
      issue.status === "todo";
    const reopenFromStatus = reopened ? existing.status : null;
    const scheduledRetrySupersededByComment =
      shouldResumeInProgressScheduledRetry &&
      previous.status !== undefined &&
      existing.status === "in_progress" &&
      issue.status === "todo";
    const statusChangedFromBlockedToTodo =
      existing.status === "blocked" &&
      issue.status === "todo" &&
      (req.body.status !== undefined || reopened);
    const revalidatedRecoveryAction = await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "issue_update",
      actor,
      activeRecoveryAction: activeRecoveryActionBeforeUpdate ?? undefined,
      statusChanged: existing.status !== issue.status,
      assigneeChanged:
        existing.assigneeAgentId !== issue.assigneeAgentId ||
        existing.assigneeUserId !== issue.assigneeUserId,
      blockersChanged: Array.isArray(req.body.blockedByIssueIds),
      executionPolicyChanged: req.body.executionPolicy !== undefined,
      monitorChanged,
      resumeRequested: resumeRequested === true,
      reopened,
      blockedToTodoRecovery: statusChangedFromBlockedToTodo,
    });
    if (activeRecoveryActionBeforeUpdate && !revalidatedRecoveryAction) {
      issueResponse = {
        ...issueResponse,
        activeRecoveryAction: null,
      };
    }
    if (!persistReviewActivityTransactionally) await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      responsibleUserIdOverride: authenticatedActorResponsibleUserId(req),
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        ...updateFields,
        identifier: issue.identifier,
        authorizationReason: issueMutationAuthorizationReason,
        changes: issueChanges,
        ...(reviewInteractionId ? { reviewInteractionId } : {}),
        ...(commentBody ? { source: "comment" } : {}),
        ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
        ...(scheduledRetrySupersededByComment
          ? {
              scheduledRetrySupersededByComment: true,
              scheduledRetryRunId: scheduledRetryForHumanComment?.runId ?? null,
              ...(cancelledScheduledRetryRunId ? { cancelledScheduledRetryRunId } : {}),
            }
          : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        ...(cancelledStatusRunId ? { cancelledStatusRunId } : {}),
        ...(workspaceChange ? { workspaceChange } : {}),
        _previous: hasFieldChanges ? previous : undefined,
        ...summarizeIssueReferenceActivityDetails(
          updateReferenceDiff
            ? {
                addedReferencedIssues: updateReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
                removedReferencedIssues: updateReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
                currentReferencedIssues: updateReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
              }
            : null,
        ),
      },
    });

    if (existing.status === "in_progress" && issue.status !== existing.status && issue.status !== "in_progress") {
      await listSuccessfulRunHandoffStates(db, issue.companyId, [issue.id], { hydrateLiveness: false })
        .then(async (handoffStates) => {
          const handoff = handoffStates.get(issue.id);
          if (handoff?.state !== "required") return;
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "issue.successful_run_handoff_resolved",
            entityType: "issue",
            entityId: issue.id,
            details: {
              identifier: issue.identifier,
              sourceRunId: handoff.sourceRunId,
              correctiveRunId: handoff.correctiveRunId,
              resolvedByStatus: issue.status,
            },
          });
        })
        .catch((err) => {
          logger.warn({ err, issueId: issue.id }, "failed to log successful run handoff resolution");
        });
    }

    if (Array.isArray(req.body.blockedByIssueIds)) {
      const previousBlockedByIds = new Set((existingRelations?.blockedBy ?? []).map((relation) => relation.id));
      const nextBlockedByIds = new Set(req.body.blockedByIssueIds as string[]);
      const addedBlockedByIssueIds = [...nextBlockedByIds].filter((candidate) => !previousBlockedByIds.has(candidate));
      const removedBlockedByIssueIds = [...previousBlockedByIds].filter((candidate) => !nextBlockedByIds.has(candidate));
      const nextBlockedByRelations = updatedRelations?.blockedBy ?? [];
      const previousBlockedByRelations = existingRelations?.blockedBy ?? [];
      if (addedBlockedByIssueIds.length > 0 || removedBlockedByIssueIds.length > 0) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "issue.blockers_updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            blockedByIssueIds: req.body.blockedByIssueIds,
            addedBlockedByIssueIds,
            removedBlockedByIssueIds,
            blockedByIssues: nextBlockedByRelations.map(summarizeIssueRelationForActivity),
            addedBlockedByIssues: nextBlockedByRelations
              .filter((relation) => addedBlockedByIssueIds.includes(relation.id))
              .map(summarizeIssueRelationForActivity),
            removedBlockedByIssues: previousBlockedByRelations
              .filter((relation) => removedBlockedByIssueIds.includes(relation.id))
              .map(summarizeIssueRelationForActivity),
          },
        });
      }
    }

    const reviewerChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "review");
    if (reviewerChanges.addedParticipants.length > 0 || reviewerChanges.removedParticipants.length > 0) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.reviewers_updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          participants: reviewerChanges.participants,
          addedParticipants: reviewerChanges.addedParticipants,
          removedParticipants: reviewerChanges.removedParticipants,
        },
      });
    }

    const approverChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "approval");
    if (approverChanges.addedParticipants.length > 0 || approverChanges.removedParticipants.length > 0) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.approvers_updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          participants: approverChanges.participants,
          addedParticipants: approverChanges.addedParticipants,
          removedParticipants: approverChanges.removedParticipants,
        },
      });
    }

    const nextStoredExecutionPolicy = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
    const previousMonitor = summarizeIssueMonitor(existing, previousExecutionPolicy);
    const nextMonitor = summarizeIssueMonitor(issue, nextStoredExecutionPolicy);
    const monitorScheduledChanged = previousMonitor.nextCheckAt !== nextMonitor.nextCheckAt;
    if (nextMonitor.nextCheckAt && (monitorScheduledChanged || previousMonitor.notes !== nextMonitor.notes)) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.monitor_scheduled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          nextCheckAt: nextMonitor.nextCheckAt,
          previousNextCheckAt: previousMonitor.nextCheckAt,
          notes: nextMonitor.notes,
          scheduledBy: nextMonitor.scheduledBy,
          serviceName: nextMonitor.serviceName,
          timeoutAt: nextMonitor.timeoutAt,
          maxAttempts: nextMonitor.maxAttempts,
          recoveryPolicy: nextMonitor.recoveryPolicy,
        },
      });
    } else if (!nextMonitor.nextCheckAt && previousMonitor.nextCheckAt) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.monitor_cleared",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          previousNextCheckAt: previousMonitor.nextCheckAt,
          reason: nextMonitor.clearReason ?? "manual",
          notes: previousMonitor.notes,
        },
      });
    }

    if (issue.status === "done" && existing.status !== "done") {
      const tc = getTelemetryClient();
      if (tc && actor.agentId) {
        const actorAgent = await agentsSvc.getById(actor.agentId);
        if (actorAgent) {
          const model = typeof actorAgent.adapterConfig?.model === "string" ? actorAgent.adapterConfig.model : undefined;
          trackAgentTaskCompleted(tc, {
            agentRole: actorAgent.role,
            agentId: actorAgent.id,
            adapterType: actorAgent.adapterType,
            model,
          });
        }
      }
    }

    if (
      issue.harnessKind === "skill_test" &&
      existing.status !== issue.status &&
      (issue.status === "done" || issue.status === "cancelled")
    ) {
      const completedRun = await companySkillsSvc.completeTestRunForIssue({
        companyId: issue.companyId,
        issueId: issue.id,
        outcome: issue.status === "done" ? "succeeded" : "cancelled",
        error: issue.status === "cancelled" ? "Harness issue was cancelled" : null,
      });
      if (completedRun) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "company.skill_test_run_completed",
          entityType: "company_skill_test_run",
          entityId: completedRun.id,
          issueId: issue.id,
          details: {
            issueId: issue.id,
            status: completedRun.status,
            outputDocumentKey: completedRun.outputDocumentKey,
          },
        });
      }
    }

    let comment = null;
    let lostReviewPathRef: string | null = null;
    if (commentBody) {
      const commentReferenceSummaryBefore = updateReferenceSummaryAfter
        ?? await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      comment = await svc.addComment(id, commentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
        onBehalfOfUserId: authenticatedActorResponsibleUserId(req),
      }, {
        authorizationReason: issueMutationAuthorizationReason,
        sourceTrust: await sourceTrustForActorWrite(issue, actor),
      });
      await issueReferencesSvc.syncComment(comment.id);
      await externalObjectsSvc.syncCommentSafely(comment.id);
      const commentReferenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const commentReferenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
        commentReferenceSummaryBefore,
        commentReferenceSummaryAfter,
      );
      issueResponse = {
        ...issueResponse,
        relatedWork: commentReferenceSummaryAfter,
        referencedIssueIdentifiers: commentReferenceSummaryAfter.outbound.map(
          (item) => item.issue.identifier ?? item.issue.id,
        ),
      };

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        responsibleUserIdOverride: authenticatedActorResponsibleUserId(req),
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          authorizationReason: issueMutationAuthorizationReason,
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
          ...(scheduledRetrySupersededByComment
            ? {
                scheduledRetrySupersededByComment: true,
                scheduledRetryRunId: scheduledRetryForHumanComment?.runId ?? null,
                ...(cancelledScheduledRetryRunId ? { cancelledScheduledRetryRunId } : {}),
              }
            : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          ...(hasFieldChanges ? { updated: true } : {}),
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: commentReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: commentReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: commentReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      const expiredInteractions = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
        issue,
        comment,
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        issue,
        interactions: expiredInteractions,
        actor,
        source: "issue.comment",
      });
      if (issue.status === "in_review" && expiredInteractions.length > 0) {
        const reviewAttention = await svc
          .listReviewAttention(issue.companyId, [issue])
          .then((map) => map.get(issue.id));
        if (reviewAttention?.state === "stalled") {
          const expiredInteractionIds = expiredInteractions.map((interaction) => interaction.id).sort();
          lostReviewPathRef = expiredInteractionIds.length === 1
            ? expiredInteractionIds[0]!
            : `interactions:${expiredInteractionIds.join(",")}`;
        }
      }

    } else if (updateReferenceSummaryAfter) {
      issueResponse = {
        ...issueResponse,
        relatedWork: updateReferenceSummaryAfter,
        referencedIssueIdentifiers: updateReferenceSummaryAfter.outbound.map(
          (item) => item.issue.identifier ?? item.issue.id,
        ),
      };
    }

    const commentIsFromAssigneeRun = comment
      ? await commentWasCreatedByAssigneeRun(comment, issue.assigneeAgentId)
      : false;

    const assigneeChanged =
      issue.assigneeAgentId !== existing.assigneeAgentId || issue.assigneeUserId !== existing.assigneeUserId;
    const statusChangedFromBacklog =
      existing.status === "backlog" &&
      issue.status !== "backlog" &&
      req.body.status !== undefined;
    const statusChangedFromClosedToTodo =
      isClosedIssueStatus(existing.status) &&
      issue.status === "todo" &&
      req.body.status !== undefined;
    const userResumedFromReviewToTodo =
      actor.actorType === "user" &&
      existing.status === "in_review" &&
      issue.status === "todo" &&
      req.body.status !== undefined;
    const previousExecutionState = parseIssueExecutionState(existing.executionState);
    const nextExecutionState = parseIssueExecutionState(issue.executionState);
    const executionStageWakeup = buildExecutionStageWakeup({
      issueId: issue.id,
      previousState: previousExecutionState,
      nextState: nextExecutionState,
      interruptedRunId,
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      type WakeupRequest = NonNullable<Parameters<typeof heartbeat.wakeup>[1]>;
      type DependencyReadinessProvider = {
        getDependencyReadiness?: typeof svc.getDependencyReadiness;
      };
      const dependencyReadinessSvc = svc as DependencyReadinessProvider;
      const wakeups = new Map<string, { agentId: string; wakeup: WakeupRequest }>();
      const addWakeup = (agentId: string, wakeup: WakeupRequest) => {
        const wakeIssueId =
          wakeup.payload && typeof wakeup.payload === "object" && typeof wakeup.payload.issueId === "string"
            ? wakeup.payload.issueId
            : issue.id;
        wakeups.set(`${agentId}:${wakeIssueId}`, { agentId, wakeup });
      };
      const addDependencyResolvedWakeup = async (input: {
        agentId: string;
        dependentIssueId: string;
        resolvedBlockerIssueId: string;
        blockerIssueIds: string[];
        blockedTransitionAt?: Date | string | null;
        source: string;
        mutation: string;
      }) => {
        const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: input.dependentIssueId,
          blockerIssueIds: input.blockerIssueIds,
          blockedTransitionAt: input.blockedTransitionAt,
        });
        try {
          const existingWake = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
            companyId: issue.companyId,
            dependentIssueId: input.dependentIssueId,
            blockerIssueIds: input.blockerIssueIds,
            blockedTransitionAt: input.blockedTransitionAt,
          });
          if (existingWake) return;
        } catch (err) {
          logger.warn(
            { err, issueId: input.dependentIssueId, idempotencyKey },
            "failed to check existing dependency wake before issue update wake",
          );
        }
        addWakeup(input.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
          payload: {
            issueId: input.dependentIssueId,
            resolvedBlockerIssueId: input.resolvedBlockerIssueId,
            blockerIssueIds: input.blockerIssueIds,
            mutation: input.mutation,
          },
          idempotencyKey,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: input.dependentIssueId,
            taskId: input.dependentIssueId,
            wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
            source: input.source,
            resolvedBlockerIssueId: input.resolvedBlockerIssueId,
            blockerIssueIds: input.blockerIssueIds,
          },
        });
      };

      if (executionStageWakeup) {
        addWakeup(executionStageWakeup.agentId, executionStageWakeup.wakeup);
      } else if (assigneeChanged && issue.assigneeAgentId && issue.status !== "backlog") {
        addWakeup(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: {
            issueId: issue.id,
            ...(comment ? { commentId: comment.id } : {}),
            mutation: "update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            ...(comment
              ? {
                  taskId: issue.id,
                  commentId: comment.id,
                  wakeCommentId: comment.id,
                }
              : {}),
            source: "issue.update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (
        !assigneeChanged &&
        (
          statusChangedFromBacklog ||
          statusChangedFromBlockedToTodo ||
          statusChangedFromClosedToTodo ||
          userResumedFromReviewToTodo
        ) &&
        issue.assigneeAgentId
      ) {
        addWakeup(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_status_changed",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.status_change",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (commentBody && comment) {
        const assigneeId = issue.assigneeAgentId;
        const actorIsAgent = actor.actorType === "agent";
        const selfComment =
          (actorIsAgent && actor.actorId === assigneeId) ||
          commentIsFromAssigneeRun;
        // Re-derive closed-ness from the post-update issue so a status change
        // like in_progress -> done with a closure comment does not enqueue a
        // stale issue_commented wake for an already-completed issue.
        const shouldWakeAssigneeForComment =
          !(selfComment && resumeRequested !== true) &&
          (reopened || !isClosedIssueStatus(issue.status));

        if (assigneeId && !assigneeChanged && shouldWakeAssigneeForComment) {
          addWakeup(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: reopened ? "issue_reopened_via_comment" : "issue_commented",
            payload: {
              issueId: id,
              commentId: comment.id,
              mutation: "comment",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
              ...(lostReviewPathRef
                ? {
                    reviewPathLost: true,
                    reviewPathConsumedRef: lostReviewPathRef,
                    reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
                  }
                : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: reopened ? "issue.comment.reopen" : "issue.comment",
              wakeReason: reopened ? "issue_reopened_via_comment" : "issue_commented",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
              ...(lostReviewPathRef
                ? {
                    reviewPathLost: true,
                    reviewPathConsumedRef: lostReviewPathRef,
                    reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
                  }
                : {}),
            },
          });
        }

        let mentionedIds: string[] = [];
        try {
          mentionedIds = await svc.findMentionedAgents(issue.companyId, commentBody);
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }

        for (const mentionedId of mentionedIds) {
          if (
            (actor.actorType === "agent" && actor.actorId === mentionedId) ||
            (commentIsFromAssigneeRun && mentionedId === assigneeId)
          ) continue;
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

      const becameDone = existing.status !== "done" && issue.status === "done";
      if (becameDone) {
        const dependents = await svc.listWakeableBlockedDependents(issue.id);
        for (const dependent of dependents) {
          await addDependencyResolvedWakeup({
            agentId: dependent.assigneeAgentId,
            dependentIssueId: dependent.id,
            resolvedBlockerIssueId: issue.id,
            blockerIssueIds: dependent.blockerIssueIds,
            blockedTransitionAt: dependent.blockedTransitionAt,
            source: "issue.blockers_resolved",
            mutation: "blocker_done",
          });
        }
      }

      const restoredBlockedReadyDependency =
        issue.status === "blocked" &&
        issue.assigneeAgentId &&
        (
          existing.status !== "blocked" ||
          Array.isArray(req.body.blockedByIssueIds) ||
          existing.assigneeAgentId !== issue.assigneeAgentId
        );
      if (restoredBlockedReadyDependency && typeof dependencyReadinessSvc.getDependencyReadiness === "function") {
        const readiness = await dependencyReadinessSvc.getDependencyReadiness(issue.id);
        const resolvedBlockerIssueId = readiness.blockerIssueIds[0] ?? null;
        if (
          resolvedBlockerIssueId &&
          readiness.isDependencyReady &&
          readiness.blockerIssueIds.length > 0
        ) {
          await addDependencyResolvedWakeup({
            agentId: issue.assigneeAgentId!,
            dependentIssueId: issue.id,
            resolvedBlockerIssueId,
            blockerIssueIds: readiness.blockerIssueIds,
            blockedTransitionAt: issue.blockedTransitionAt,
            source: "issue.blockers_restored",
            mutation: "blocked_dependency_restored",
          });
        }
      }

      const stopRelay = stopRelayResult.value;
      if (stopRelay) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "issue_stop_relay",
          agentId: null,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: stopRelay.parent.id,
          details: {
            commentId: stopRelay.comment.id,
            source: "child_stop_relay",
            childIssueId: issue.id,
            childIdentifier: issue.identifier,
            childStatus: issue.status,
          },
        });
        if (stopRelay.parent.assigneeAgentId && !isClosedIssueStatus(stopRelay.parent.status)) {
          addWakeup(stopRelay.parent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: stopRelay.parent.id,
              commentId: stopRelay.comment.id,
              mutation: "comment",
            },
            requestedByActorType: "system",
            requestedByActorId: "issue_stop_relay",
            contextSnapshot: {
              issueId: stopRelay.parent.id,
              taskId: stopRelay.parent.id,
              commentId: stopRelay.comment.id,
              wakeCommentId: stopRelay.comment.id,
              source: "issue.stop_relay",
              wakeReason: "issue_commented",
              childIssueId: issue.id,
              childStatus: issue.status,
            },
          });
        }
      }

      const becameTerminal =
        !["done", "cancelled"].includes(existing.status) && ["done", "cancelled"].includes(issue.status);
      if (becameTerminal) {
        const expiredInteractions = await issueThreadInteractionService(db).expirePendingInteractionsForTerminalIssue(issue, {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
        await logExpiredRequestConfirmations({
          issue,
          interactions: expiredInteractions,
          actor,
          source: "issue.status_transition.issue_closed",
        });
        await destroyReusableSandboxLeasesForTerminalIssue(issue);
      }
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
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
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
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
          });
        }
      }

      for (const { agentId, wakeup } of wakeups.values()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .then((wakeRun) => {
            if (wakeup.reason !== ISSUE_BLOCKERS_RESOLVED_WAKE_REASON) return;
            const payload = wakeup.payload && typeof wakeup.payload === "object" ? wakeup.payload : {};
            const dependentIssueId = typeof payload.issueId === "string" ? payload.issueId : issue.id;
            return logActivity(db, {
              companyId: issue.companyId,
              actorType: "system",
              actorId: "issue_update",
              agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: "issue.blockers_resolved_wake_emitted",
              entityType: "issue",
              entityId: dependentIssueId,
              details: {
                source: wakeup.contextSnapshot?.source ?? "issue.update",
                wakeupRunId: wakeRun?.id ?? null,
                idempotencyKey: wakeup.idempotencyKey ?? null,
                resolvedBlockerIssueId: typeof payload.resolvedBlockerIssueId === "string"
                  ? payload.resolvedBlockerIssueId
                  : null,
                blockerIssueIds: Array.isArray(payload.blockerIssueIds) ? payload.blockerIssueIds : [],
              },
            });
          })
          .catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();

    await queueTaskWatchdogEvaluation(issue, actor.runId);
    const changes = issueResponse.changes ?? {};
    if (prefersMinimalIssueUpdateResponse(req)) {
      res.setHeader("Preference-Applied", "return=minimal");
      res.json({
        id: issueResponse.id,
        identifier: issueResponse.identifier,
        updatedAt: issueResponse.updatedAt,
        changes,
        comment,
      });
      return;
    }
    res.json({ ...issueResponse, changes, comment });
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!existing) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
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
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    await queueTaskWatchdogEvaluation(existing, actor.runId);
    res.json(issue);
  });

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;

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

    if (issue.assigneeAgentId !== req.body.agentId) {
      await assertCanAssignTasks(req, issue.companyId, {
        issueId: issue.id,
        projectId: issue.projectId ?? null,
        parentIssueId: issue.parentId ?? null,
        assigneeAgentId: req.body.agentId,
        assigneeUserId: null,
      });
    }

    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;

    // Reopen the closed isolated workspace only after the run-id gate passes. A
    // rejected checkout must not rebuild and republish the workspace as active.
    let reopenedWorkspace: Pick<ExecutionWorkspace, "id"> | null = null;
    let reopenedGeneration: number | null = null;
    if (closedExecutionWorkspace) {
      const reopenOutcome = await reopenClosedIssueExecutionWorkspaceOrRespond(
        req,
        res,
        issue,
        closedExecutionWorkspace,
      );
      if (reopenOutcome === null) {
        return;
      }
      // Install the guard only when this request set the reopen-pending flag. A
      // concurrent request that found the workspace already open must not clear
      // the flag that the actual reopener still owns.
      if (reopenOutcome.outcome === "reopened") {
        reopenedWorkspace = closedExecutionWorkspace;
        reopenedGeneration = reopenOutcome.generation;
      }
    }
    let updated: Awaited<ReturnType<typeof svc.checkout>> | undefined;
    // Clear the reopen-pending flag if the checkout leaves the issue terminal, so
    // the rebuilt worktree does not leak. The guard reads `updated` when the
    // response ends, so it covers a null return and a thrown error. It clears only
    // the fence this request installed, keyed by its generation.
    guardReopenedWorkspaceConsumption({
      req,
      res,
      issue,
      workspace: reopenedWorkspace,
      generation: reopenedGeneration,
      finalIssueStatus: () => updated?.status,
    });
    try {
      updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    } catch (error) {
      if (isUniqueViolation(error, "issues_open_routine_execution_uq")) {
        res.status(409).json({
          error: "Another execution for this routine is already in progress",
        });
        return;
      }
      throw error;
    }
    const actor = getActorInfo(req);
    if (updated?.harnessKind === "skill_test") {
      await companySkillsSvc.markTestRunRunning(updated.companyId, updated.id);
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
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
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!existing) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
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
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    res.json(released);
  });

  router.post("/issues/:id/admin/force-release", async (req, res) => {
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board access required" });
      return;
    }
    if (!req.actor.userId) {
      throw forbidden("Board user context required");
    }

    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!existing) return;

    const clearAssignee = req.query.clearAssignee === "true";
    const result = await svc.adminForceRelease(id, { clearAssignee });
    if (!result) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.admin_force_release",
      entityType: "issue",
      entityId: result.issue.id,
      details: {
        issueId: result.issue.id,
        actorUserId: req.actor.userId,
        prevCheckoutRunId: result.previous.checkoutRunId,
        prevExecutionRunId: result.previous.executionRunId,
        clearAssignee,
      },
    });

    res.json(result);
  });

  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
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
    res.json(await runRedactions.redactForIssue(issue.companyId, issue.id, comments));
  });

  router.get("/issues/:id/queued-comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const queue = await buildQueuedCommentQueue({
      executor: db,
      issue,
      activeRun: await resolveActiveIssueRun(issue),
      actor: getActorInfo(req),
    });
    res.json(await runRedactions.redactForIssue(issue.companyId, issue.id, queue));
  });

  router.patch(
    "/issues/:id/queued-comments/:commentId",
    validate(editQueuedCommentSchema),
    async (req, res) => {
      assertBoard(req);
      if (!req.actor.userId) throw forbidden("Board user context required");
      const id = req.params.id as string;
      const commentId = req.params.commentId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      const actor = getActorInfo(req);
      const queue = await db.transaction(async (tx) => {
        const locked = await lockQueuedCommentState({
          tx,
          issue,
          actor,
          queueId: req.body.queueId,
        });
        assertQueueMutationTarget({
          queue: locked.queue,
          queueId: req.body.queueId,
          revision: req.body.revision,
        });
        const entry = locked.queue.entries.find((candidate) => candidate.comment.id === commentId);
        if (!entry) throw conflict("The queued message is no longer pending", { code: "queued_comment_not_pending" });
        if (!entry.canEdit) throw forbidden("Only the queued message author can edit it");
        const updatedAt = new Date();
        const updated = await tx
          .update(issueComments)
          .set({ body: req.body.body, updatedAt })
          .where(and(eq(issueComments.id, commentId), eq(issueComments.issueId, issue.id)))
          .returning({ id: issueComments.id })
          .then((rows) => rows[0] ?? null);
        if (!updated) throw conflict("The queued message is no longer pending", { code: "queued_comment_not_pending" });
        await tx.update(issueRows).set({ updatedAt }).where(eq(issueRows.id, issue.id));
        await issueReferencesSvc.syncComment(commentId, tx);
        await externalObjectsSvc.syncCommentSafely(commentId, tx);
        const updatedQueueRun = await updateQueuedRunCommentIds(
          tx,
          locked.queueRun,
          locked.queue.entries.map((candidate) => candidate.comment.id),
          updatedAt,
        );
        return buildQueuedCommentQueue({
          executor: tx,
          issue,
          activeRun: locked.activeRun,
          actor,
          queueState: {
            wake: locked.wake,
            state: locked.state,
            queueRun: updatedQueueRun ?? locked.queueRun,
          },
        });
      });
      res.json(await runRedactions.redactForIssue(issue.companyId, issue.id, queue));
    },
  );

  router.put(
    "/issues/:id/queued-comments/order",
    validate(reorderQueuedCommentsSchema),
    async (req, res) => {
      assertBoard(req);
      if (!req.actor.userId) throw forbidden("Board user context required");
      const id = req.params.id as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      const actor = getActorInfo(req);
      const queue = await db.transaction(async (tx) => {
        const locked = await lockQueuedCommentState({
          tx,
          issue,
          actor,
          queueId: req.body.queueId,
        });
        assertQueueMutationTarget({
          queue: locked.queue,
          queueId: req.body.queueId,
          revision: req.body.revision,
        });
        const currentIds = locked.queue.entries.map((entry) => entry.comment.id);
        const orderedIds = req.body.orderedCommentIds as string[];
        const orderedSet = new Set(orderedIds);
        if (
          orderedSet.size !== orderedIds.length
          || orderedIds.length !== currentIds.length
          || currentIds.some((commentId) => !orderedSet.has(commentId))
        ) {
          throw conflict("The queued message order does not match the current queue", {
            code: "queued_comment_order_mismatch",
          });
        }
        const now = new Date();
        const updatedWake = await tx
          .update(agentWakeupRequests)
          .set({
            payload: withQueuedCommentIdsInWakePayload(locked.wake.payload, orderedIds),
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, locked.wake.id))
          .returning()
          .then((rows) => rows[0] ?? locked.wake);
        const updatedQueueRun = await updateQueuedRunCommentIds(
          tx,
          locked.queueRun,
          orderedIds,
          now,
        );
        return buildQueuedCommentQueue({
          executor: tx,
          issue,
          activeRun: locked.activeRun,
          actor,
          queueState: {
            wake: updatedWake,
            state: locked.state,
            queueRun: updatedQueueRun ?? locked.queueRun,
          },
        });
      });
      res.json(await runRedactions.redactForIssue(issue.companyId, issue.id, queue));
    },
  );

  router.post(
    "/issues/:id/queued-comments/:commentId/steer",
    validate(queuedCommentSteeringTargetSchema),
    async (req, res) => {
      assertBoard(req);
      if (!req.actor.userId) throw forbidden("Board user context required");
      const id = req.params.id as string;
      const commentId = req.params.commentId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      const actor = getActorInfo(req);
      let acknowledgedTurnId: string | null = null;
      let duplicate = false;
      let queue: IssueQueuedCommentQueue;
      try {
        queue = await db.transaction(async (tx) => {
          // A client can lose the successful response after the final queued
          // message cancels its wake. Lock the original queue and target run
          // first so that the persisted acknowledgement remains a durable
          // idempotency record even when no pending queue remains.
          await tx
            .select({ id: issueRows.id })
            .from(issueRows)
            .where(and(eq(issueRows.id, issue.id), eq(issueRows.companyId, issue.companyId)))
            .for("update");
          const retryWake = await tx
            .select()
            .from(agentWakeupRequests)
            .where(and(
              eq(agentWakeupRequests.id, req.body.queueId),
              eq(agentWakeupRequests.companyId, issue.companyId),
              issue.assigneeAgentId
                ? eq(agentWakeupRequests.agentId, issue.assigneeAgentId)
                : undefined,
            ))
            .for("update")
            .limit(1)
            .then((rows) => rows[0] ?? null);
          const retryRun = retryWake && readObject(retryWake.payload).issueId === issue.id
            ? await tx
              .select()
              .from(heartbeatRuns)
              .where(and(
                eq(heartbeatRuns.id, req.body.targetRunId),
                eq(heartbeatRuns.companyId, issue.companyId),
                eq(heartbeatRuns.agentId, retryWake.agentId),
              ))
              .for("update")
              .limit(1)
              .then((rows) => rows[0] ?? null)
            : null;
          const retryRunContext = readObject(retryRun?.contextSnapshot);
          const retryRunResult = readObject(retryRun?.resultJson);
          const retryAcknowledgements = readObject(
            retryRunResult.queuedSteeringAcknowledgements,
          );
          const retryAcknowledgement = readObject(retryAcknowledgements[commentId]);
          if (
            retryRun
            && (retryRunContext.issueId === issue.id || retryRunContext.taskId === issue.id)
            && retryAcknowledgement.status === "acknowledged"
            && retryAcknowledgement.queueId === req.body.queueId
          ) {
            duplicate = true;
            acknowledgedTurnId = typeof retryAcknowledgement.turnId === "string"
              ? retryAcknowledgement.turnId
              : null;
            return buildQueuedCommentQueue({
              executor: tx,
              issue,
              activeRun: retryRun.status === "running" ? retryRun : null,
              actor,
            });
          }

          const locked = await lockQueuedCommentState({
            tx,
            issue,
            actor,
            queueId: req.body.queueId,
            targetRunId: req.body.targetRunId,
          });
          if (!locked.activeRun) {
            throw conflict("The queued message targets a stale run", {
              code: "queued_comment_stale_target",
            });
          }
          const runResult = readObject(locked.activeRun.resultJson);
          const acknowledgements = readObject(runResult.queuedSteeringAcknowledgements);
          const priorAcknowledgement = readObject(acknowledgements[commentId]);
          if (
            priorAcknowledgement.status === "acknowledged"
            && priorAcknowledgement.queueId === req.body.queueId
          ) {
            duplicate = true;
            acknowledgedTurnId = typeof priorAcknowledgement.turnId === "string"
              ? priorAcknowledgement.turnId
              : null;
            return buildQueuedCommentQueue({
              executor: tx,
              issue,
              activeRun: locked.activeRun,
              actor,
              queueState: locked.queueState,
            });
          }
          assertQueueMutationTarget({
            queue: locked.queue,
            queueId: req.body.queueId,
            revision: req.body.revision,
          });
          if (locked.queue.protocol !== "paperclip_runner_v1") {
            throw conflict("This runner does not support same-turn steering", {
              code: "steering_unsupported",
            });
          }
          const entry = locked.queue.entries.find((candidate) => candidate.comment.id === commentId);
          if (!entry) {
            throw conflict("The queued message is no longer pending", {
              code: "queued_comment_not_pending",
            });
          }

          const acknowledgement = await steerNativeSession({
            runId: locked.activeRun.id,
            message: entry.comment.body,
            correlationId: commentId,
          });
          acknowledgedTurnId = acknowledgement.turnId;
          const remainingIds = locked.queue.entries
            .map((candidate) => candidate.comment.id)
            .filter((candidateId) => candidateId !== commentId);
          const now = new Date();
          const nextWake = remainingIds.length === 0
            ? await tx
              .update(agentWakeupRequests)
              .set({ status: "cancelled", finishedAt: now, updatedAt: now })
              .where(eq(agentWakeupRequests.id, locked.wake.id))
              .returning()
              .then(() => null)
            : await tx
              .update(agentWakeupRequests)
              .set({
                payload: withQueuedCommentIdsInWakePayload(locked.wake.payload, remainingIds),
                updatedAt: now,
              })
              .where(eq(agentWakeupRequests.id, locked.wake.id))
              .returning()
              .then((rows) => rows[0] ?? locked.wake);
          await tx
            .update(heartbeatRuns)
            .set({
              resultJson: {
                ...runResult,
                queuedSteeringAcknowledgements: {
                  ...acknowledgements,
                  [commentId]: {
                    status: "acknowledged",
                    queueId: req.body.queueId,
                    turnId: acknowledgement.turnId,
                    acknowledgedAt: now.toISOString(),
                  },
                },
              },
              updatedAt: now,
            })
            .where(eq(heartbeatRuns.id, locked.activeRun.id));
          return buildQueuedCommentQueue({
            executor: tx,
            issue,
            activeRun: locked.activeRun,
            actor,
            queueState: nextWake
              ? { wake: nextWake, state: "deferred", queueRun: null }
              : null,
          });
        });
      } catch (error) {
        if (error instanceof NativeSessionSteeringError) {
          throw conflict(error.message, { code: error.code, retryable: true });
        }
        throw error;
      }
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.queued_comment_steered",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId,
          targetRunId: req.body.targetRunId,
          turnId: acknowledgedTurnId,
          duplicate,
        },
      });
      res.json(await runRedactions.redactForIssue(issue.companyId, issue.id, queue));
    },
  );


  router.delete(
    "/issues/:id/queued-comments/:commentId",
    validate(queuedCommentMutationTargetSchema),
    async (req, res) => {
      assertBoard(req);
      if (!req.actor.userId) throw forbidden("Board user context required");
      const id = req.params.id as string;
      const commentId = req.params.commentId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      const actor = getActorInfo(req);
      const { queue } = await discardQueuedComment({
        issue,
        actor,
        commentId,
        queueId: req.body.queueId,
        revision: req.body.revision,
      });
      res.json(await runRedactions.redactForIssue(issue.companyId, issue.id, queue));
    },
  );

  router.get("/issues/:id/interactions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const interactions = await issueThreadInteractionService(db).listForIssue(id);
    res.json(interactions);
  });

  router.post("/issues/:id/interactions", validate(createIssueThreadInteractionSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type === "agent") {
      if (!(await assertAgentIssueMutationAllowed(req, res, issue, { allowVisibleIssueWrite: true }))) return;
      if (await assertLowTrustControlPlaneDenied(req, res, issue.companyId, issue)) return;
    } else {
      assertBoard(req);
    }

    const actor = getActorInfo(req);
    const agentSourceRunId = req.actor.type === "agent" ? requireAgentRunId(req, res) : null;
    if (req.actor.type === "agent" && !agentSourceRunId) return;
    if (
      req.body.kind === "request_confirmation"
      && req.body.addresseeAgentId
      && req.body.payload?.toolAction !== undefined
    ) {
      throw badRequest("Tool-action confirmations cannot be addressed to agents");
    }
    if (req.body.kind === "request_confirmation" && req.body.payload?.toolAction !== undefined) {
      throw unprocessable("payload.toolAction is server-owned metadata and cannot be supplied when creating an interaction");
    }
    if (req.body.kind === "request_confirmation" && req.body.payload?.secretProposal !== undefined) {
      throw unprocessable("payload.secretProposal is server-owned metadata and cannot be supplied when creating an interaction");
    }

    // Plan-document confirmation targets are validated authoritatively inside
    // issueThreadInteractionService.create, which re-reads the plan document's
    // latest revision and rejects a stale/missing target under the same insert
    // transaction (see assertRequestConfirmationTargetIsCurrent). We deliberately
    // do not pre-check the revision here: a separate route-level read would be
    // non-atomic with the insert and only duplicate the service gate.
    const interaction = await issueThreadInteractionService(db).create(issue, {
      ...req.body,
      sourceRunId: req.actor.type === "agent" ? agentSourceRunId : req.body.sourceRunId ?? null,
    }, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        continuationPolicy: interaction.continuationPolicy,
        addresseeAgentId: interaction.addresseeAgentId ?? null,
        addresseeUserId: interaction.addresseeUserId ?? null,
        requestedResolverPolicy: interaction.requestedResolverPolicy,
        effectiveResolverPolicy: interaction.effectiveResolverPolicy,
        resolverPolicyProvenance: interaction.resolverPolicyProvenance,
        effectiveResolverPolicySource: interaction.effectiveResolverPolicySource,
      },
    });

    if (
      interaction.addresseeAgentId
      && issueThreadInteractionAttentionAgentAllowed({
        agentId: interaction.addresseeAgentId,
        interaction,
        governedAction: interaction.kind === "request_confirmation"
          && typeof interaction.payload === "object"
          && interaction.payload !== null
          && "toolAction" in interaction.payload
          && interaction.payload.toolAction !== undefined,
      })
    ) {
      void heartbeat.wakeup(interaction.addresseeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "interaction_pending",
        payload: {
          issueId: issue.id,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          sourceCommentId: interaction.sourceCommentId ?? null,
          sourceRunId: interaction.sourceRunId ?? null,
          mutation: "interaction",
        },
        idempotencyKey: `interaction-pending:${interaction.id}`,
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          sourceCommentId: interaction.sourceCommentId ?? null,
          sourceRunId: interaction.sourceRunId ?? null,
          wakeReason: "interaction_pending",
          source: "issue.interaction.created",
        },
      }).catch((err) => logger.warn({
        err,
        issueId: issue.id,
        interactionId: interaction.id,
        agentId: interaction.addresseeAgentId,
      }, "failed to wake addressee on issue interaction creation"));
    }

    res.status(201).json(interaction);
  });

  router.post(
    "/issues/:id/interactions/:interactionId/accept",
    validate(acceptIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      const authorizedResolution = await getIssueThreadInteractionResolutionAuthorization(
        req,
        res,
        issue,
        interactionId,
      );
      if (!authorizedResolution) return;
      const { interactionSvc, current, resolutionAuthorization } = authorizedResolution;
      if (current.kind === "connection_intent") {
        throw unprocessable("Connection intents must be resolved through the connection intent endpoints");
      }
      const suggestedTaskEffectsAuthorized = current.kind === "suggest_tasks"
        ? await assertSuggestedTaskEffectsAllowed(
            req,
            res,
            issue,
            current,
            req.body.selectedClientKeys,
          )
        : true;
      if (!suggestedTaskEffectsAuthorized) return;

      const actor = getActorInfo(req);
      const { interaction, createdIssues, continuationIssue } = await interactionSvc.acceptInteraction(issue, interactionId, req.body, {
        agentId: actor.agentId,
        runId: actor.runId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        resolverPolicyRestriction: resolutionAuthorization.resolverPolicyRestriction,
        suggestedTaskEffectsAuthorized,
      });
      const toolAction = interaction.payload && typeof interaction.payload === "object"
        ? (interaction.payload as { toolAction?: { actionRequestId?: unknown } }).toolAction
        : null;
      const secretProposal = interaction.payload && typeof interaction.payload === "object"
        ? (interaction.payload as { secretProposal?: { proposalId?: unknown; configPath?: unknown } }).secretProposal
        : null;
      let continuationInteraction = interaction;
      if (
        interaction.kind === "request_confirmation"
        && interaction.status === "accepted"
        && typeof toolAction?.actionRequestId === "string"
        && opts.approveToolActionRequest
      ) {
        const approvalResult = await opts.approveToolActionRequest({
          companyId: issue.companyId,
          issueId: issue.id,
          interactionId: interaction.id,
          actionRequestId: toolAction.actionRequestId,
          actor: {
            agentId: actor.agentId,
            userId: actor.actorType === "user" ? actor.actorId : null,
          },
        });
        const approval = readObject(approvalResult);
        const executionStatus = readToolActionExecutionStatus(approval.status);
        if (executionStatus) {
          const currentResult = readObject(interaction.result);
          continuationInteraction = {
            ...interaction,
            result: {
              ...currentResult,
              toolAction: {
                version: 1,
                status: executionStatus,
                errorMessage: readNonEmptyString(approval.error),
                resultSummary: readNonEmptyString(approval.resultSummary),
                updatedAt: new Date().toISOString(),
              },
            } as typeof interaction.result,
          };
        }
      }
      if (
        interaction.kind === "request_confirmation"
        && interaction.status === "accepted"
        && typeof secretProposal?.proposalId === "string"
      ) {
        const resolvedByUserId = actor.actorType === "user" ? actor.actorId : "board";
        try {
          if (opts.approveSecretProposal) {
            await opts.approveSecretProposal({
              companyId: issue.companyId,
              issueId: issue.id,
              interactionId: interaction.id,
              proposalId: secretProposal.proposalId,
              actor: { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null },
            });
          } else {
            const proposal = await secretProposals.getById(issue.companyId, secretProposal.proposalId);
            if (
              !proposal
              || proposal.kind !== "binding"
              || proposal.originIssueId !== issue.id
              || proposal.interactionId !== interaction.id
            ) {
              throw notFound("Secret proposal not found");
            }
            await secretProposals.approve(issue.companyId, proposal.id, {
              resolvedByUserId,
              assertCanResolve: (lockedProposal, txDb) => assertCanResolveProposal({
                db: txDb,
                actor: req.actor,
                companyId: issue.companyId,
                proposal: lockedProposal,
              }),
            });
            await notifySecretProposalResolution({
              proposal,
              status: "approved",
              userId: resolvedByUserId,
              issues: svc,
              heartbeat,
            });
          }
          continuationInteraction = await interactionSvc.recordSecretProposalExecutionResult(
            issue,
            interaction.id,
            secretProposal.proposalId,
            { status: "executed" },
          );
        } catch (error) {
          const errorCode = secretProposalExecutionErrorCode(error);
          continuationInteraction = await interactionSvc.recordSecretProposalExecutionResult(
            issue,
            interaction.id,
            secretProposal.proposalId,
            { status: "failed", errorCode },
          );
          const recordedResult = readObject(continuationInteraction.result);
          const recordedSecretProposal = readObject(recordedResult.secretProposal);
          if (recordedSecretProposal.status !== "executed") {
            const configPath = typeof secretProposal.configPath === "string" ? secretProposal.configPath : "unknown";
            try {
              await svc.addComment(
                issue.id,
                `Secret binding execution failed\n\n- Config path: \`${configPath}\`\n- Error code: \`${errorCode}\`\n- Binding created: **no**`,
                { userId: resolvedByUserId },
              );
            } catch (commentError) {
              logger.warn(
                { err: commentError, issueId: issue.id, interactionId: interaction.id, errorCode },
                "failed to post secret proposal execution failure comment",
              );
            }
          }
        }
      }
      const continuationWakeIssue = continuationIssue ?? issue;

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_accepted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          resolutionActorKind: actor.actorType,
          requestedResolverPolicy: interaction.requestedResolverPolicy,
          effectiveResolverPolicy: interaction.effectiveResolverPolicy,
          resolverPolicyProvenance: interaction.resolverPolicyProvenance,
          effectiveResolverPolicySource: interaction.effectiveResolverPolicySource,
          resolverAuthorizationReason: resolutionAuthorization.decision.reason,
          createdTaskCount:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.createdTasks?.length ?? 0)
              : 0,
          skippedTaskCount:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.skippedClientKeys?.length ?? 0)
              : 0,
        },
      });

      if (continuationIssue) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "issue.updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            status: continuationIssue.status,
            ...(continuationIssue.workMode ? { workMode: continuationIssue.workMode } : {}),
            assigneeAgentId: continuationIssue.assigneeAgentId ?? null,
            assigneeUserId: continuationIssue.assigneeUserId ?? null,
            source: "request_confirmation_accept",
            interactionId: interaction.id,
            _previous: {
              status: issue.status,
              workMode: issue.workMode,
              assigneeAgentId: issue.assigneeAgentId ?? null,
              assigneeUserId: issue.assigneeUserId ?? null,
            },
          },
        });
      }

      for (const createdIssue of createdIssues) {
        void queueIssueAssignmentWakeup({
          heartbeat,
          issue: createdIssue,
          reason: "issue_assigned",
          mutation: "interaction_accept",
          contextSource: "issue.interaction.accept",
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
        });
      }

      const acceptedPlanTarget = interaction.kind === "request_confirmation"
        ? readAcceptedPlanConfirmationTarget(interaction.payload, issue.id)
        : null;
      const acceptedPlanConfirmation =
        interaction.kind === "request_confirmation" &&
        interaction.status === "accepted" &&
        acceptedPlanTarget?.issueId === issue.id &&
        acceptedPlanTarget.key === "plan";
      await queueResolvedInteractionContinuationWakeup({
        db,
        heartbeat,
        issue: { ...continuationWakeIssue, companyId: issue.companyId },
        interaction: continuationInteraction,
        actor,
        source: "issue.interaction.accept",
        forceFreshSession: acceptedPlanConfirmation,
        workspaceRefreshReason: acceptedPlanConfirmation ? "accepted_plan_confirmation" : null,
      });

      res.json(continuationInteraction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/reject",
    validate(rejectIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      const authorizedResolution = await getIssueThreadInteractionResolutionAuthorization(
        req,
        res,
        issue,
        interactionId,
      );
      if (!authorizedResolution) return;
      const { interactionSvc, current, resolutionAuthorization } = authorizedResolution;
      if (current.kind === "connection_intent") {
        throw unprocessable("Connection intents must be resolved through the connection intent endpoints");
      }

      const actor = getActorInfo(req);
      const interaction = await interactionSvc.rejectInteraction(issue, interactionId, req.body, {
        agentId: actor.agentId,
        runId: actor.runId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        resolverPolicyRestriction: resolutionAuthorization.resolverPolicyRestriction,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_rejected",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          resolutionActorKind: actor.actorType,
          requestedResolverPolicy: interaction.requestedResolverPolicy,
          effectiveResolverPolicy: interaction.effectiveResolverPolicy,
          resolverPolicyProvenance: interaction.resolverPolicyProvenance,
          effectiveResolverPolicySource: interaction.effectiveResolverPolicySource,
          resolverAuthorizationReason: resolutionAuthorization.decision.reason,
          rejectionReason:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.rejectionReason ?? null)
              : interaction.kind === "request_confirmation" || interaction.kind === "request_checkbox_confirmation"
                ? (interaction.result?.reason ?? null)
              : null,
        },
      });

      await queueResolvedInteractionContinuationWakeup({
        db,
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.reject",
      });

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/respond",
    validate(respondIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      const authorizedResolution = await getIssueThreadInteractionResolutionAuthorization(
        req,
        res,
        issue,
        interactionId,
      );
      if (!authorizedResolution) return;
      const { interactionSvc, current, resolutionAuthorization } = authorizedResolution;

      const actor = getActorInfo(req);
      if (current.kind === "ask_user_questions") {
        validateNativeQuestionResponseInput(current, req.body);
      }
      const interaction = await interactionSvc.answerQuestions(issue, interactionId, req.body, {
        agentId: actor.agentId,
        runId: actor.runId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        resolverPolicyRestriction: resolutionAuthorization.resolverPolicyRestriction,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.thread_interaction_answered",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          resolutionActorKind: actor.actorType,
          requestedResolverPolicy: interaction.requestedResolverPolicy,
          effectiveResolverPolicy: interaction.effectiveResolverPolicy,
          resolverPolicyProvenance: interaction.resolverPolicyProvenance,
          effectiveResolverPolicySource: interaction.effectiveResolverPolicySource,
          resolverAuthorizationReason: resolutionAuthorization.decision.reason,
          answeredQuestionCount:
            interaction.kind === "ask_user_questions"
              ? (interaction.result?.answers?.length ?? 0)
              : 0,
        },
      });

      await questionResponseDeliveries.deliver(interaction.id).catch((err) => {
        logger.warn({
          err,
          companyId: issue.companyId,
          issueId: issue.id,
          interactionId: interaction.id,
        }, "synchronous question response delivery failed; durable outbox will retry");
      });

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/verdicts",
    validate(submitIssueThreadInteractionVerdictsSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      const authorizedResolution = await getIssueThreadInteractionResolutionAuthorization(
        req,
        res,
        issue,
        interactionId,
      );
      if (!authorizedResolution) return;
      const { interactionSvc, resolutionAuthorization } = authorizedResolution;

      const actor = getActorInfo(req);
      const { interaction, newlyResolvedItemIds } = await interactionSvc.submitItemVerdicts(
        issue,
        interactionId,
        req.body,
        {
          agentId: actor.agentId,
          runId: actor.runId,
          userId: actor.actorType === "user" ? actor.actorId : null,
          resolverPolicyRestriction: resolutionAuthorization.resolverPolicyRestriction,
        },
      );

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_item_verdicts_submitted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          resolutionActorKind: actor.actorType,
          requestedResolverPolicy: interaction.requestedResolverPolicy,
          effectiveResolverPolicy: interaction.effectiveResolverPolicy,
          resolverPolicyProvenance: interaction.resolverPolicyProvenance,
          effectiveResolverPolicySource: interaction.effectiveResolverPolicySource,
          resolverAuthorizationReason: resolutionAuthorization.decision.reason,
          submittedVerdictCount: Array.isArray(req.body?.verdicts) ? req.body.verdicts.length : 0,
          newlyResolvedItemCount: newlyResolvedItemIds.length,
          newlyResolvedItemIds,
          complete:
            interaction.kind === "request_item_verdicts"
              ? (interaction.result?.complete ?? false)
              : false,
        },
      });

      if (newlyResolvedItemIds.length > 0) {
        await queueResolvedInteractionContinuationWakeup({
          db,
          heartbeat,
          issue,
          interaction,
          actor,
          source: "issue.interaction.verdicts",
          newlyResolvedItemIds,
          idempotencyKey: buildRequestItemVerdictsWakeIdempotencyKey({
            issueId: issue.id,
            interactionId: interaction.id,
          }),
        });
      }

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/withdraw",
    validate(withdrawIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;

      const interactionSvc = issueThreadInteractionService(db);
      const current = await interactionSvc.getForIssue(issue, interactionId);
      if (!(await assertIssueThreadInteractionWithdrawalAllowed(req, res, issue, current))) return;
      await assertPendingReviewInteractionVerdictAllowed(req, issue, current);

      const actor = getActorInfo(req);
      let nativeRunId: string | null = null;
      const interaction = await interactionSvc.withdrawInteraction(
        issue,
        interactionId,
        req.body,
        {
          agentId: actor.agentId,
          runId: actor.runId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
        {
          afterResolveInTransaction: async (tx, resolved) => {
            if (resolved.kind !== "ask_user_questions") return;
            nativeRunId = await requestNativeQuestionRunCancellation(tx, resolved, {
              kind: "interaction_withdrawn",
              interactionId: resolved.id,
            });
          },
        },
      );
      if (nativeRunId) {
        try {
          await heartbeat.cancelRun(nativeRunId, "Question withdrawn while waiting for operator input", {
            resultJson: {
              withdrawnInteractionId: interaction.id,
              withdrawnByActorType: actor.actorType,
              withdrawnByActorId: actor.actorId,
            },
          });
        } catch (err) {
          logger.warn(
            { err, runId: nativeRunId, interactionId: interaction.id },
            "native question withdrawal cancellation deferred to recovery sweep",
          );
        }
      }
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.thread_interaction_withdrawn",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          reason: interaction.result && "reason" in interaction.result ? interaction.result.reason ?? null : null,
        },
      });

      if (actor.agentId !== issue.assigneeAgentId) {
        await queueResolvedInteractionContinuationWakeup({
          db,
          heartbeat,
          issue,
          interaction,
          actor,
          source: "issue.interaction.withdraw",
        });
      }
      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/skip",
    validate(skipIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (req.actor.type === "agent") {
        res.status(403).json({ error: "Agent actors cannot skip issue-thread interactions through this board-only route" });
        return;
      }
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await issueThreadInteractionService(db).skipInteraction(issue, interactionId, req.body, {
        agentId: actor.agentId,
        runId: actor.runId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.thread_interaction_skipped",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          reason: interaction.result && "reason" in interaction.result
            ? interaction.result.reason ?? null
            : null,
        },
      });

      // Skip intentionally does not enqueue an interaction continuation. A
      // subsequent ordinary message uses the existing comment steering path.
      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/cancel",
    validate(cancelIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (req.actor.type === "agent") {
        res.status(403).json({ error: "Agent actors cannot cancel issue-thread interactions through this board-only route" });
        return;
      }
      assertBoard(req);

      const actor = getActorInfo(req);
      let nativeRunId: string | null = null;
      const interaction = await issueThreadInteractionService(db).cancelQuestions(
        issue,
        interactionId,
        req.body,
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
        {
          afterResolveInTransaction: async (tx, resolved) => {
            if (resolved.kind !== "ask_user_questions") return;
            nativeRunId = await requestNativeQuestionRunCancellation(tx, resolved, {
              kind: "interaction_cancelled",
              interactionId: resolved.id,
            });
          },
        },
      );

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.thread_interaction_cancelled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          cancellationReason:
            interaction.kind === "ask_user_questions"
              ? (interaction.result?.cancellationReason ?? null)
              : null,
        },
      });

      if (nativeRunId) {
        try {
          await heartbeat.cancelRun(nativeRunId, "Cancelled while waiting for operator input", {
            resultJson: {
              cancelledByActorType: "user",
              cancelledByUserId: req.actor.userId ?? null,
              cancelledInteractionId: interaction.id,
            },
          });
        } catch (err) {
          logger.warn(
            { err, runId: nativeRunId, interactionId: interaction.id },
            "native question board cancellation deferred to recovery sweep",
          );
        }
      }

      await queueResolvedInteractionContinuationWakeup({
        db,
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.cancel",
      });

      res.json(interaction);
    },
  );

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(await runRedactions.redactForIssue(issue.companyId, issue.id, comment));
  });

  router.delete("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;

    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    const actor = getActorInfo(req);
    const actorOwnsComment =
      actor.actorType === "agent"
        ? comment.authorAgentId === actor.agentId
        : comment.authorUserId === actor.actorId;
    const deleteMode = req.query.mode === "cancel" ? "cancel" : "delete";

    const authoritativeQueueWake = issue.assigneeAgentId
      ? await db
        .select()
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, issue.companyId),
          eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
          inArray(agentWakeupRequests.status, [
            "deferred_issue_execution",
            "queued",
            "claimed",
            "succeeded",
            "failed",
          ]),
        ))
        .orderBy(desc(agentWakeupRequests.requestedAt))
        .then((rows) => rows.find((wake) => (
          readObject(wake.payload).issueId === issue.id
          && queuedCommentIdsFromWakePayload(wake.payload).includes(commentId)
        )) ?? null)
      : null;
    const activeRun = await resolveActiveIssueRun(issue);
    const pendingQueueWake = authoritativeQueueWake
      && ["deferred_issue_execution", "queued"].includes(authoritativeQueueWake.status)
      ? authoritativeQueueWake
      : null;
    const isLegacyQueuedComment = activeRun
      ? isQueuedIssueCommentForActiveRun({ comment, activeRun })
      : false;
    if (deleteMode === "cancel" || pendingQueueWake || isLegacyQueuedComment) {
      if (!actorOwnsComment) {
        res.status(403).json({ error: "Only the comment author can cancel queued comments" });
        return;
      }

      const queueWakeForCancellation = deleteMode === "cancel"
        ? authoritativeQueueWake
        : pendingQueueWake;
      const removed = queueWakeForCancellation
        ? (await discardQueuedComment({
          issue,
          actor,
          commentId,
          queueId: queueWakeForCancellation.id,
        })).deleted
        : activeRun && isLegacyQueuedComment
          ? await svc.removeComment(commentId)
          : null;
      if (!removed) {
        res.status(409).json({
          error: activeRun
            ? "Only queued comments can be canceled"
            : "Queued comment can no longer be canceled",
        });
        return;
      }

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.comment_cancelled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: removed.id,
          bodySnippet: removed.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          source: "queue_cancel",
          queueId: queueWakeForCancellation?.id ?? null,
          queueTargetRunId: activeRun?.id ?? queueWakeForCancellation?.runId ?? null,
        },
      });

      res.json(removed);
      return;
    }

    if (!actorOwnsComment) {
      res.status(403).json({ error: "Only the comment author can delete comments" });
      return;
    }

    if (comment.deletedAt) {
      res.json(comment);
      return;
    }

    let annotationCleanup = { deletedCommentIds: [] as string[], resolvedThreadIds: [] as string[] };
    const deleted = await svc.tombstoneComment(
      commentId,
      {
        actorType: actor.actorType,
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      },
      {
        afterTombstone: async (deletedComment, tx) => {
          await issueReferencesSvc.syncComment(deletedComment.id, tx);
          await externalObjectsSvc.syncCommentSafely(deletedComment.id, tx);
          annotationCleanup = await documentAnnotationsSvc.cleanupForIssueCommentDeletion(issue.id, deletedComment.id, {
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            userId: actor.actorType === "user" ? actor.actorId : null,
            runId: actor.runId,
          }, tx);
          await Promise.all(
            annotationCleanup.deletedCommentIds.map((annotationCommentId) =>
              Promise.all([
                issueReferencesSvc.deleteCommentSource(annotationCommentId, tx),
                externalObjectsSvc.syncCommentSafely(annotationCommentId, tx),
              ])
            ),
          );
          await decisionTrainingSvc.scrubDeletedComments({
            companyId: issue.companyId,
            issueId: issue.id,
            commentIds: [deletedComment.id, ...annotationCleanup.deletedCommentIds],
            deletedAt: deletedComment.deletedAt ?? new Date(),
          }, tx);
        },
      },
    );
    if (!deleted) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.comment_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId: deleted.id,
        identifier: issue.identifier,
        issueTitle: issue.title,
        source: "author_delete",
        deletedByType: actor.actorType,
        deletedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
        deletedByUserId: actor.actorType === "user" ? actor.actorId : null,
        deletedByRunId: actor.runId,
        deletedAt: deleted.deletedAt,
        deletedAnnotationCommentIds: annotationCleanup.deletedCommentIds,
        resolvedAnnotationThreadIds: annotationCleanup.resolvedThreadIds,
      },
    });

    res.json(deleted);
  });

  router.get("/issues/:id/feedback-votes", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback votes" });
      return;
    }

    const votes = await feedback.listIssueVotesForUser(id, req.actor.userId ?? "local-board");
    res.json(votes);
  });

  router.get("/issues/:id/feedback-traces", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, getIssueById(req, id), "Issue not found");
    if (!issue) return;
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
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type === "agent" && req.body.onBehalfOfUserId != null) {
      await auditAgentIssueCommentAttributionSpoof({
        db,
        req,
        issue,
        surface: "issue.comment.create",
        requestedValue: readNonEmptyString(req.body.onBehalfOfUserId),
      });
      await denyIssueWrite(req, res, issue, "issue_write_attribution_spoof_rejected");
      return;
    }
    const commentAccessDecision = await assertAgentIssueCommentAllowed(req, res, issue);
    if (!commentAccessDecision) return;
    const commentAuthorizationReason = issueWriteAuthorizationReason(req, commentAccessDecision);
    if (!assertStructuredCommentFieldsAllowed(req, res, {
      presentation: req.body.presentation,
      metadata: req.body.metadata,
    })) return;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);

    const actor = getActorInfo(req);
    const commentPresentation = req.body.presentation ??
      await deriveRecoveryCommentPresentation(req, issue.companyId, req.body.body);
    const reopenRequested = req.body.reopen === true;
    const resumeRequested = req.body.resume === true;
    const interruptRequested = req.body.interrupt === true;
    const isClosed = isClosedIssueStatus(issue.status);
    const isBlocked = issue.status === "blocked";
    const crossIssueCommentOnlyGrant =
      isClosed &&
      (isDirectParentReportDecision(commentAccessDecision) ||
        (req.actor.type === "agent" &&
          issue.assigneeAgentId !== null &&
          issue.assigneeAgentId !== req.actor.agentId &&
          !reopenRequested &&
          !resumeRequested &&
          (isIssueMentionGrantDecision(commentAccessDecision) ||
            isDefaultOpenIssueWriteDecision(commentAccessDecision))));
    const effectiveReopenRequested = crossIssueCommentOnlyGrant ? false : reopenRequested;
    const effectiveResumeRequested = crossIssueCommentOnlyGrant ? false : resumeRequested;
    if (
      isClosed &&
      req.actor.type === "agent" &&
      issue.assigneeAgentId !== null &&
      issue.assigneeAgentId !== req.actor.agentId &&
      !crossIssueCommentOnlyGrant
    ) {
      if (!(await assertAgentIssueMutationAllowed(req, res, issue, { allowVisibleIssueWrite: true }))) return;
    }
    if (
      effectiveResumeRequested === true &&
      !(await assertExplicitResumeIntentAllowed(req, res, issue, { resumeIntent: true }))
    ) return;
    if (effectiveResumeRequested !== true && effectiveReopenRequested === true && req.actor.type === "agent") {
      if (!(await assertExplicitResumeIntentAllowed(req, res, issue))) return;
    }
    const explicitMoveToTodoRequested = effectiveReopenRequested || effectiveResumeRequested === true;
    const scheduledRetryForHumanComment =
      shouldHumanCommentResumeInProgressScheduledRetry({
        hasComment: true,
        issueStatus: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        actorType: actor.actorType,
      })
        ? await svc.getCurrentScheduledRetry(issue.id)
        : null;
    const shouldResumeInProgressScheduledRetry =
      !!scheduledRetryForHumanComment &&
      scheduledRetryForHumanComment.agentId === issue.assigneeAgentId;
    const assigneeSelfCommentOnTerminal = isAssigneeSelfCommentOnTerminalIssue({
      hasCommentBody: true,
      resumeRequested: resumeRequested === true,
      issueStatus: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      actorType: actor.actorType,
      actorId: actor.actorId,
    });
    const effectiveMoveToTodoRequested =
      !assigneeSelfCommentOnTerminal &&
      (explicitMoveToTodoRequested ||
        shouldImplicitlyMoveCommentedIssueToTodo({
          issueStatus: issue.status,
          assigneeAgentId: issue.assigneeAgentId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          actorRunId: actor.runId,
          checkoutRunId: issue.checkoutRunId,
          executionRunId: issue.executionRunId,
        }) ||
        shouldResumeInProgressScheduledRetry);
    const hasUnresolvedFirstClassBlockers =
      isBlocked && effectiveMoveToTodoRequested
        ? (await svc.getDependencyReadiness(issue.id)).unresolvedBlockerCount > 0
        : false;
    if (resumeRequested === true && isBlocked && hasUnresolvedFirstClassBlockers) {
      res.status(409).json({ error: "Issue follow-up blocked by unresolved blockers" });
      return;
    }
    if (!(await assertCrossIssueInfluenceWithinRunCap(req, res, issue, "comment"))) return;
    // Reopen the closed isolated workspace only after every access, resume-intent,
    // blocker, and run-cap gate passes. A rejected comment must not rebuild and
    // republish the workspace as active, because the issue stays terminal and the
    // reaper then skips the leaked workspace.
    let reopenedWorkspace: Pick<ExecutionWorkspace, "id"> | null = null;
    let reopenedGeneration: number | null = null;
    if (closedExecutionWorkspace) {
      const reopenOutcome = await reopenClosedIssueExecutionWorkspaceOrRespond(
        req,
        res,
        issue,
        closedExecutionWorkspace,
      );
      if (reopenOutcome === null) {
        return;
      }
      // Install the guard only when this request set the reopen-pending flag. A
      // concurrent request that found the workspace already open must not clear
      // the flag that the actual reopener still owns.
      if (reopenOutcome.outcome === "reopened") {
        reopenedWorkspace = closedExecutionWorkspace;
        reopenedGeneration = reopenOutcome.generation;
      }
    }
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;
    // Clear the reopen-pending flag if this comment leaves the issue terminal, so
    // the rebuilt worktree does not leak. A comment reopens the workspace but only
    // moves the issue out of the terminal state when it resumes the work. The
    // guard reads `currentIssue` when the response ends, so it covers a rejected
    // move, a thrown error, and a comment that keeps the issue terminal. It clears
    // only the fence this request installed, keyed by its generation.
    guardReopenedWorkspaceConsumption({
      req,
      res,
      issue,
      workspace: reopenedWorkspace,
      generation: reopenedGeneration,
      finalIssueStatus: () => currentIssue.status,
    });
    let issueBeforeCommentDecision = issue;
    let commentDecisionStageWakeup: ReturnType<typeof buildExecutionStageWakeup> | null = null;
    const commentReferenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);

    let scheduledRetrySupersededByComment = false;
    let cancelledScheduledRetryRunId: string | null = null;
    if (
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers) || shouldResumeInProgressScheduledRetry)
    ) {
      scheduledRetrySupersededByComment = shouldResumeInProgressScheduledRetry && issue.status === "in_progress";
      cancelledScheduledRetryRunId = scheduledRetrySupersededByComment
        ? await cancelScheduledRetrySupersededByComment({
            scheduledRetryRunId: scheduledRetryForHumanComment?.runId,
            issue,
            actor,
          })
        : null;
      const reopenedIssue = await svc.update(id, { status: "todo" });
      if (!reopenedIssue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      reopened = isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers);
      reopenFromStatus = reopened ? issue.status : null;
      currentIssue = reopenedIssue;

      await logActivity(db, {
        companyId: currentIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.updated",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          status: "todo",
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
          ...(scheduledRetrySupersededByComment
            ? {
                scheduledRetrySupersededByComment: true,
                scheduledRetryRunId: scheduledRetryForHumanComment?.runId ?? null,
                ...(cancelledScheduledRetryRunId ? { cancelledScheduledRetryRunId } : {}),
              }
            : {}),
          source: "comment",
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
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
        const cancelled = await heartbeat.cancelRun(
          runToInterrupt.id,
          "Interrupted by board comment",
          operatorInterruptCancelOptions({ issueId: currentIssue.id, actor }),
        );
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            issueId: currentIssue.id,
            details: {
              agentId: cancelled.agentId,
              source: "issue_comment_interrupt",
              issueId: currentIssue.id,
              cancellationKind: "operator_interrupted",
              operatorInterrupted: true,
            },
          });
        }
      }
    }

    const currentExecutionState = parseIssueExecutionState(currentIssue.executionState);
    const currentExecutionPolicy = normalizeIssueExecutionPolicy(currentIssue.executionPolicy ?? null);
    const shouldAutoApproveReviewComment =
      currentIssue.status === "in_review" &&
      currentExecutionState?.status === "pending" &&
      actorMatchesExecutionParticipant(actor, currentExecutionState.currentParticipant ?? null) &&
      isApprovalReviewComment(req.body.body);

    // Persist the comment and the auto-approval state transition atomically when both apply.
    // Without a single transaction, a 422 (or any error) thrown by the status update after the
    // comment is inserted would leave an orphan comment without the corresponding state change.
    let comment: Awaited<ReturnType<typeof svc.addComment>>;
    if (shouldAutoApproveReviewComment) {
      const transition = applyIssueExecutionPolicyTransition({
        issue: currentIssue,
        policy: currentExecutionPolicy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: {
          agentId: actor.agentId ?? null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
        commentBody: req.body.body,
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

      issueBeforeCommentDecision = currentIssue;
      const updatePatch = {
        ...transition.patch,
        status: typeof transition.patch.status === "string" ? transition.patch.status : "done",
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
      };

      const sourceTrust = await sourceTrustForActorWrite(currentIssue, actor);
      const commentOptions = {
        authorType: req.body.authorType ?? (actor.actorType === "agent" ? "agent" : "user"),
        presentation: commentPresentation,
        metadata: req.body.metadata ?? null,
        sourceTrust,
      };
      let txResult: { comment: Awaited<ReturnType<typeof svc.addComment>>; issue: NonNullable<Awaited<ReturnType<typeof svc.update>>> };
      const postCommitActivityPublications: ActivityPublication[] = [];
      const postCommitIssueActions: IssuePostCommitAction[] = [];
      try {
        txResult = await db.transaction(async (tx) => {
          const insertedComment = await svc.addComment(
            id,
            req.body.body,
            {
              agentId: actor.agentId ?? undefined,
              userId: actor.actorType === "user" ? actor.actorId : undefined,
              runId: actor.runId,
              onBehalfOfUserId: authenticatedActorResponsibleUserId(req),
            },
            { ...commentOptions, authorizationReason: commentAuthorizationReason },
            tx,
          );
          const updated = actor.actorType === "user" && currentIssue.status !== "done"
            ? await svc.update(id, updatePatch, tx, postCommitActivityPublications, postCommitIssueActions)
            : await svc.update(id, updatePatch, tx, undefined, postCommitIssueActions);
          // Throw (not return null) so drizzle rolls back the inserted comment when the issue
          // has been concurrently deleted between the initial fetch and the in-transaction update.
          if (!updated) throw new AutoApprovalIssueMissingError();

          if (transition.decision && decisionId) {
            await tx.insert(issueExecutionDecisions).values({
              id: decisionId,
              companyId: updated.companyId,
              issueId: updated.id,
              stageId: transition.decision.stageId,
              stageType: transition.decision.stageType,
              actorAgentId: actor.agentId ?? null,
              actorUserId: actor.actorType === "user" ? actor.actorId : null,
              outcome: transition.decision.outcome,
              body: transition.decision.body,
              createdByRunId: actor.runId ?? null,
            });
          }

          return { comment: insertedComment, issue: updated };
        });
      } catch (err) {
        if (err instanceof AutoApprovalIssueMissingError) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        throw err;
      }
      for (const publication of postCommitActivityPublications) publishActivity(publication);
      await flushIssuePostCommitActions(postCommitIssueActions);
      comment = txResult.comment;
      currentIssue = txResult.issue;
      // Mirror the normal status-change audit trail: every other in_review -> done path
      // emits an `issue.updated` activity, so emit one here too for the auto-approval path.
      if (issueBeforeCommentDecision.status !== currentIssue.status) {
        await logActivity(db, {
          companyId: currentIssue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "issue.updated",
          entityType: "issue",
          entityId: currentIssue.id,
          details: {
            status: currentIssue.status,
            identifier: currentIssue.identifier,
            source: "auto_approval_comment",
            _previous: { status: issueBeforeCommentDecision.status },
          },
        });
      }
      commentDecisionStageWakeup = buildExecutionStageWakeup({
        issueId: currentIssue.id,
        previousState: currentExecutionState,
        nextState: parseIssueExecutionState(currentIssue.executionState),
        interruptedRunId,
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
    } else {
      comment = await svc.addComment(id, req.body.body, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
        onBehalfOfUserId: authenticatedActorResponsibleUserId(req),
      }, {
        authorType: req.body.authorType ?? (actor.actorType === "agent" ? "agent" : "user"),
        presentation: commentPresentation,
        metadata: req.body.metadata ?? null,
        authorizationReason: commentAuthorizationReason,
        sourceTrust: await sourceTrustForActorWrite(currentIssue, actor),
      });
    }

    await issueReferencesSvc.syncComment(comment.id);
    await externalObjectsSvc.syncCommentSafely(comment.id);
    const commentReferenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(currentIssue.id);
    const commentReferenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
      commentReferenceSummaryBefore,
      commentReferenceSummaryAfter,
    );

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
      agentApiKeyId: actor.agentApiKeyId,
      responsibleUserIdOverride: authenticatedActorResponsibleUserId(req),
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        authorizationReason: commentAuthorizationReason,
        ...(isDirectParentReportDecision(commentAccessDecision)
          ? { directParentReportGrant: true }
          : {}),
        ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(scheduledRetrySupersededByComment
          ? {
              scheduledRetrySupersededByComment: true,
              scheduledRetryRunId: scheduledRetryForHumanComment?.runId ?? null,
              ...(cancelledScheduledRetryRunId ? { cancelledScheduledRetryRunId } : {}),
            }
          : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: commentReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: commentReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: commentReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    const expiredInteractions = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
      currentIssue,
      comment,
      {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    );
    await logExpiredRequestConfirmations({
      issue: currentIssue,
      interactions: expiredInteractions,
      actor,
      source: "issue.comment",
    });
    let lostReviewPathRef: string | null = null;
    if (currentIssue.status === "in_review" && expiredInteractions.length > 0) {
      const reviewAttention = await svc
        .listReviewAttention(currentIssue.companyId, [currentIssue])
        .then((map) => map.get(currentIssue.id));
      if (reviewAttention?.state === "stalled") {
        const expiredInteractionIds = expiredInteractions.map((interaction) => interaction.id).sort();
        lostReviewPathRef = expiredInteractionIds.length === 1
          ? expiredInteractionIds[0]!
          : `interactions:${expiredInteractionIds.join(",")}`;
      }
    }

    const commentIsFromAssigneeRun = await commentWasCreatedByAssigneeRun(
      comment,
      currentIssue.assigneeAgentId,
    );

    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue: currentIssue,
      trigger: "comment",
      actor,
      statusChanged: reopened || scheduledRetrySupersededByComment,
      resumeRequested: resumeRequested === true,
      reopened,
      blockedToTodoRecovery: reopened && reopenFromStatus === "blocked" && currentIssue.status === "todo",
    });

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      type WakeupRequest = NonNullable<Parameters<typeof heartbeat.wakeup>[1]>;
      const wakeups = new Map<string, { agentId: string; wakeup: WakeupRequest }>();
      const addWakeup = (agentId: string, wakeup: WakeupRequest) => {
        const wakeIssueId =
          wakeup.payload && typeof wakeup.payload === "object" && typeof wakeup.payload.issueId === "string"
            ? wakeup.payload.issueId
            : currentIssue.id;
        const key = `${agentId}:${wakeIssueId}`;
        if (wakeups.has(key)) return;
        wakeups.set(key, { agentId, wakeup });
      };
      const addDependencyResolvedWakeup = async (input: {
        agentId: string;
        dependentIssueId: string;
        resolvedBlockerIssueId: string;
        blockerIssueIds: string[];
        blockedTransitionAt?: Date | string | null;
      }) => {
        const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: input.dependentIssueId,
          blockerIssueIds: input.blockerIssueIds,
          blockedTransitionAt: input.blockedTransitionAt,
        });
        try {
          const existingWake = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
            companyId: currentIssue.companyId,
            dependentIssueId: input.dependentIssueId,
            blockerIssueIds: input.blockerIssueIds,
            blockedTransitionAt: input.blockedTransitionAt,
          });
          if (existingWake) return;
        } catch (err) {
          logger.warn(
            { err, issueId: input.dependentIssueId, idempotencyKey },
            "failed to check existing dependency wake before issue comment wake",
          );
        }
        addWakeup(input.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
          payload: {
            issueId: input.dependentIssueId,
            resolvedBlockerIssueId: input.resolvedBlockerIssueId,
            blockerIssueIds: input.blockerIssueIds,
            mutation: "comment",
          },
          idempotencyKey,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: input.dependentIssueId,
            taskId: input.dependentIssueId,
            wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
            source: "issue.blockers_resolved",
            resolvedBlockerIssueId: input.resolvedBlockerIssueId,
            blockerIssueIds: input.blockerIssueIds,
          },
        });
      };

      if (commentDecisionStageWakeup) {
        addWakeup(commentDecisionStageWakeup.agentId, commentDecisionStageWakeup.wakeup);
      }

      // Re-fetch immediately before deciding whether to wake anyone: outside
      // the reopen/auto-approval branches above, `currentIssue` is still the
      // snapshot read before the comment was inserted, so a concurrent
      // close/unassign/reassign landing in that window would otherwise wake
      // the wrong (or no-longer-relevant) agent off stale state. The comment
      // is already committed, so a failed re-fetch is logged and falls back to
      // the in-hand snapshot rather than aborting this best-effort wake block.
      const wakeIssueSnapshot = (await svc.getById(currentIssue.id).catch((err) => {
        logger.warn(
          { err, issueId: currentIssue.id },
          "failed to re-fetch issue for comment wake decision; falling back to in-hand snapshot",
        );
        return null;
      })) ?? currentIssue;
      const assigneeId = wakeIssueSnapshot.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment =
        (actorIsAgent && actor.actorId === assigneeId) ||
        commentIsFromAssigneeRun;
      // Re-derive closed-ness from the post-mutation issue so the auto-approval
      // transition (in_review -> done) suppresses a stale `issue_commented` wake
      // to the returnAssignee for an already-completed issue.
      const shouldWakeAssigneeForComment =
        !(selfComment && resumeRequested !== true) &&
        (reopened || !isClosedIssueStatus(wakeIssueSnapshot.status));
      if (assigneeId && shouldWakeAssigneeForComment) {
        if (reopened) {
          addWakeup(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_reopened_via_comment",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment.reopen",
              wakeReason: "issue_reopened_via_comment",
              reopenedFrom: reopenFromStatus,
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          addWakeup(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              mutation: "comment",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
              ...(lostReviewPathRef
                ? {
                    reviewPathLost: true,
                    reviewPathConsumedRef: lostReviewPathRef,
                    reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
                  }
                : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment",
              wakeReason: "issue_commented",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
              ...(lostReviewPathRef
                ? {
                    reviewPathLost: true,
                    reviewPathConsumedRef: lostReviewPathRef,
                    reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
                  }
                : {}),
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
        if (
          (actorIsAgent && actor.actorId === mentionedId) ||
          (commentIsFromAssigneeRun && mentionedId === assigneeId)
        ) continue;
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

      const becameDone = issueBeforeCommentDecision.status !== "done" && currentIssue.status === "done";
      if (becameDone) {
        const dependents = await svc.listWakeableBlockedDependents(currentIssue.id);
        for (const dependent of dependents) {
          await addDependencyResolvedWakeup({
            agentId: dependent.assigneeAgentId,
            dependentIssueId: dependent.id,
            resolvedBlockerIssueId: currentIssue.id,
            blockerIssueIds: dependent.blockerIssueIds,
            blockedTransitionAt: dependent.blockedTransitionAt,
          });
        }
      }

      const becameTerminal =
        !["done", "cancelled"].includes(issueBeforeCommentDecision.status) &&
        ["done", "cancelled"].includes(currentIssue.status);
      if (becameTerminal) {
        const expiredInteractions = await issueThreadInteractionService(db).expirePendingInteractionsForTerminalIssue(currentIssue, {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
        await logExpiredRequestConfirmations({
          issue: currentIssue,
          interactions: expiredInteractions,
          actor,
          source: "issue.status_transition.issue_closed",
        });
        await destroyReusableSandboxLeasesForTerminalIssue(currentIssue);
      }
      if (becameTerminal && currentIssue.parentId) {
        const parent = await svc.getWakeableParentAfterChildCompletion(currentIssue.parentId);
        if (parent) {
          addWakeup(parent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_children_completed",
            payload: {
              issueId: parent.id,
              completedChildIssueId: currentIssue.id,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: parent.id,
              taskId: parent.id,
              wakeReason: "issue_children_completed",
              source: "issue.children_completed",
              completedChildIssueId: currentIssue.id,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
          });
        }
      }

      for (const { agentId, wakeup } of wakeups.values()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .then((wakeRun) => {
            if (wakeup.reason !== ISSUE_BLOCKERS_RESOLVED_WAKE_REASON) return;
            const payload = wakeup.payload && typeof wakeup.payload === "object" ? wakeup.payload : {};
            const dependentIssueId = typeof payload.issueId === "string" ? payload.issueId : currentIssue.id;
            return logActivity(db, {
              companyId: currentIssue.companyId,
              actorType: "system",
              actorId: "issue_comment",
              agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: "issue.blockers_resolved_wake_emitted",
              entityType: "issue",
              entityId: dependentIssueId,
              details: {
                source: wakeup.contextSnapshot?.source ?? "issue.comment",
                wakeupRunId: wakeRun?.id ?? null,
                idempotencyKey: wakeup.idempotencyKey ?? null,
                resolvedBlockerIssueId: typeof payload.resolvedBlockerIssueId === "string"
                  ? payload.resolvedBlockerIssueId
                  : null,
                blockerIssueIds: Array.isArray(payload.blockerIssueIds) ? payload.blockerIssueIds : [],
              },
            });
          })
          .catch((err) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    await queueTaskWatchdogEvaluation(currentIssue, actor.runId);
    res.status(201).json(comment);
  });

  router.post("/issues/:id/feedback-votes", validate(upsertIssueFeedbackVoteSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
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
      agentApiKeyId: actor.agentApiKeyId,
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
        agentApiKeyId: actor.agentApiKeyId,
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
            agentApiKeyId: actor.agentApiKeyId,
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
    const issue = await getAccessibleResource(req, res, getIssueById(req, issueId), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
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
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;

    try {
      await runSingleFileUpload(req, res, MAX_ATTACHMENT_BYTES);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({
            error: `Attachment is larger than the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} limit`,
          });
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
    const contentType = normalizeUploadAttachmentContentType({
      contentType: file.mimetype,
      originalFilename: file.originalname,
    });
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
      agentApiKeyId: actor.agentApiKeyId,
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
    const attachment = await getAccessibleResource(req, res, svc.getAttachmentById(attachmentId), "Attachment not found");
    if (!attachment) return;
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertIssueReadAllowed(req, res, issue))) return;

    const contentLength = attachment.byteSize;
    const range = parseAttachmentRangeHeader(
      typeof req.headers.range === "string" ? req.headers.range : undefined,
      contentLength,
    );
    res.setHeader("Accept-Ranges", "bytes");
    if (range.kind === "invalid") {
      res.setHeader("Content-Range", `bytes */${contentLength}`);
      res.status(416).end();
      return;
    }

    const object = await storage.getObject(
      attachment.companyId,
      attachment.objectKey,
      range.kind === "range" ? { range: { start: range.start, end: range.end } } : undefined,
    );
    const responseContentType = resolveAttachmentResponseContentType({
      storedContentType: attachment.contentType,
      objectContentType: object.contentType,
      originalFilename: attachment.originalFilename,
    });
    // Markdown bodies are stored as UTF-8; declare the charset so inline
    // (raw) views do not mojibake. SVG/inline checks below stay on the bare type.
    const isMarkdownResponse = isMarkdownAttachmentContent({
      contentType: responseContentType,
      originalFilename: attachment.originalFilename,
    });
    res.setHeader(
      "Content-Type",
      isMarkdownResponse ? `${responseContentType}; charset=utf-8` : responseContentType,
    );
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === SVG_CONTENT_TYPE) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = attachment.originalFilename ?? "attachment";
    const disposition = parseBooleanQuery(req.query.download)
      ? "attachment"
      : isInlineAttachmentContentType(responseContentType) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    if (range.kind === "range") {
      const rangeLength = range.end - range.start + 1;
      res.status(206);
      res.setHeader("Content-Length", String(rangeLength));
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${contentLength}`);
      object.stream.pipe(res);
      return;
    }

    res.setHeader("Content-Length", String(contentLength || object.contentLength || 0));
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await getAccessibleResource(req, res, svc.getAttachmentById(attachmentId), "Attachment not found");
    if (!attachment) return;
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;

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
      agentApiKeyId: actor.agentApiKeyId,
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
