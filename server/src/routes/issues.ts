import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueRelations,
  issues as issueRows,
  issueWorkProducts,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  addIssueCommentSchema,
  acceptIssueThreadInteractionSchema,
  attachmentArtifactWorkProductMetadataSchema,
  cancelIssueThreadInteractionSchema,
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
  rejectIssueThreadInteractionSchema,
  restoreIssueDocumentRevisionSchema,
  respondIssueThreadInteractionSchema,
  updateIssueWorkProductSchema,
  updateDocumentAnnotationThreadSchema,
  upsertIssueDocumentSchema,
  updateIssueSchema,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  isUuidLike,
  normalizeIssueIdentifier as normalizeIssueReferenceIdentifier,
  type CompanySearchQuery,
  type CompanySearchResponse,
  type ExecutionWorkspace,
  type IssueRelationIssueSummary,
  type IssueWatchdogDiscoveryKind,
  type SourceTrustMetadata,
  type SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import * as serviceIndex from "../services/index.js";
import {
  accessService,
  agentService,
  companyService,
  companySearchService,
  executionWorkspaceService,
  goalService,
  heartbeatService,
  issueApprovalService,
  issueRecoveryActionService,
  issueThreadInteractionService,
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_MAX_LIMIT,
  issueReferenceService,
  issueService,
  clampIssueListLimit,
  documentService,
  documentAnnotationService,
  logActivity,
  projectService,
  routineService,
  workProductService,
} from "../services/index.js";
import {
  TASK_WATCHDOG_ORIGIN_KIND,
  resolveTaskWatchdogMutationScope,
  taskWatchdogScopeAllowsIssueMutation,
} from "../services/task-watchdog-scope.js";
import type { TaskWatchdogServiceDeps, taskWatchdogService } from "../services/task-watchdogs.js";
import { logger } from "../middleware/logger.js";
import { conflict, forbidden, HttpError, notFound, unauthorized, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectIssueWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import {
  isInlineAttachmentContentType,
  isAllowedContentType,
  normalizeIssueAttachmentMaxBytes,
  normalizeContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { executionWorkspaceService as executionWorkspaceServiceDirect } from "../services/execution-workspaces.js";
import { feedbackService } from "../services/feedback.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { readAcceptedPlanConfirmationTarget } from "../services/issues.js";
import { environmentService } from "../services/environments.js";
import { redactSensitiveText } from "../redaction.js";
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

const MAX_ISSUE_COMMENT_LIMIT = 500;
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
});

const promoteLowTrustOutputSchema = z.object({
  sourceArtifactKind: z.enum(["comment", "document", "work_product", "issue"]),
  sourceArtifactId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(8_000),
});

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
      },
    }),
  };
}

function buildAttachmentContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

const GENERIC_ATTACHMENT_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-binary",
]);

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
  if (!GENERIC_ATTACHMENT_CONTENT_TYPES.has(storedContentType)) return storedContentType;
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
  attachmentId: z.string().uuid(),
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
  const settings = parseIssueExecutionWorkspaceSettings(issue.executionWorkspaceSettings);
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
  return states;
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
    throw forbidden(runtimeDecision.explanation);
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
}) {
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
  return status === "done" || status === "blocked" || status === "todo" || status === "in_progress";
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

function queueResolvedInteractionContinuationWakeup(input: {
  heartbeat: ReturnType<typeof heartbeatService>;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  interaction: {
    id: string;
    kind: string;
    status: string;
    continuationPolicy: string;
    sourceCommentId?: string | null;
    sourceRunId?: string | null;
  };
  actor: { actorType: "user" | "agent"; actorId: string };
  source: string;
  forceFreshSession?: boolean;
  workspaceRefreshReason?: string | null;
}) {
  if (
    input.interaction.continuationPolicy !== "wake_assignee"
    && input.interaction.continuationPolicy !== "wake_assignee_on_accept"
  ) return;
  if (
    input.interaction.continuationPolicy === "wake_assignee_on_accept"
    && input.interaction.status !== "accepted"
  ) return;
  if (input.interaction.status === "expired") return;
  if (!input.issue.assigneeAgentId || isClosedIssueStatus(input.issue.status)) return;

  const forceFreshSession = input.forceFreshSession === true;
  const workspaceRefreshReason = readNonEmptyString(input.workspaceRefreshReason);
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
      mutation: "interaction",
    },
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
  } = {},
) {
  const router = Router();
  const svc = issueService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
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
  const documentAnnotationsSvc = documentAnnotationService(db);
  const issueReferencesSvc = issueReferenceService(db);
  const issueThreadInteractionsSvc = issueThreadInteractionService(db);
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
  const routinesSvc = routineService(db, {
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
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: cancelledRunId,
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

  async function assertAgentInReviewReviewPath(input: {
    existing: {
      id: string;
      companyId: string;
      status: string;
      assigneeUserId?: string | null;
      executionState?: unknown;
      monitorNextCheckAt?: Date | null;
    };
    updateFields: Record<string, unknown>;
    actorType: string;
  }) {
    const nextStatus = typeof input.updateFields.status === "string"
      ? input.updateFields.status
      : input.existing.status;
    if (input.actorType !== "agent" || input.existing.status === "in_review" || nextStatus !== "in_review") return;

    const nextAssigneeUserId = input.updateFields.assigneeUserId === undefined
      ? input.existing.assigneeUserId
      : input.updateFields.assigneeUserId;
    if (typeof nextAssigneeUserId === "string" && nextAssigneeUserId.trim().length > 0) return;

    const nextExecutionState = input.updateFields.executionState === undefined
      ? input.existing.executionState
      : input.updateFields.executionState;
    if (hasExecutionParticipant(nextExecutionState)) return;

    const nextExecutionPolicy = input.updateFields.executionPolicy;
    if (hasScheduledMonitor({
      existingMonitorNextCheckAt: input.existing.monitorNextCheckAt ?? null,
      patchMonitorNextCheckAt: input.updateFields.monitorNextCheckAt,
      executionPolicy: nextExecutionPolicy,
    })) return;

    const interactions = await issueThreadInteractionService(db).listForIssue(input.existing.id);
    if (interactions.some((interaction) => interaction.status === "pending")) return;

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(input.existing.id);
    if (approvals.some((approval) => ACTIVE_REVIEW_APPROVAL_STATUSES.has(String(approval.status)))) return;

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
    throw forbidden(decision.explanation);
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

  async function assertIssueReadAllowed(req: Request, res: Response, issue: Parameters<typeof decideIssueAccess>[1]) {
    const decision = await decideIssueAccess(req, issue, "issue:read");
    if (decision.allowed) return true;
    res.status(403).json({ error: "Issue is outside this actor's authorization boundary" });
    return false;
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
      res.status(403).json({ error: "Issue is outside this actor's authorization boundary" });
      return false;
    }
    return boundaryDecision;
  }

  function isIssueMentionGrantDecision(decision: true | Awaited<ReturnType<typeof decideIssueAccess>>) {
    return decision !== true && decision.reason === "allow_issue_mention_grant";
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
    },
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
      res.status(403).json({ error: "Issue is outside this actor's authorization boundary" });
      return false;
    }
    if (issue.assigneeAgentId === null) {
      return true;
    }
    if (issue.assigneeAgentId !== actorAgentId) {
      if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)) {
        return true;
      }
      if (issue.status === "in_progress") {
        res.status(409).json({
          error: "Issue is checked out by another agent",
          details: {
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            actorAgentId,
          },
        });
      } else {
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
      }
      return false;
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

  async function rejectAgentIssueThreadInteractionResolution(
    req: Request,
    res: Response,
    issue: {
      id: string;
      companyId: string;
      parentId?: string | null;
    },
  ) {
    if (req.actor.type !== "agent") return false;
    if (
      req.actor.runId &&
      !(await assertTaskWatchdogIssueMutationAllowed(req, res, issue, { allowWatchdogIssue: false }))
    ) {
      return true;
    }
    res.status(403).json({ error: "Agent actors cannot resolve issue-thread interactions through this board-only route" });
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

  function isStatusOnlyCheapRecoveryContext(contextSnapshot: unknown) {
    if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
    const context = contextSnapshot as Record<string, unknown>;
    return context.modelProfile === "cheap" &&
      context.recoveryIntent === "status_only" &&
      context.allowDeliverableWork === false &&
      context.allowDocumentUpdates === false &&
      context.resumeRequiresNormalModel === true;
  }

  function requestsCheapIssueAssigneeModelProfile(input: { assigneeAdapterOverrides?: unknown }) {
    const overrides = input.assigneeAdapterOverrides;
    return !!overrides &&
      typeof overrides === "object" &&
      !Array.isArray(overrides) &&
      (overrides as Record<string, unknown>).modelProfile === "cheap";
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

  async function assertCheapRecoveryIssueAssigneeProfileAllowed(
    req: Request,
    res: Response,
    issue: { id?: string; companyId: string },
    input: { assigneeAdapterOverrides?: unknown },
  ) {
    if (!requestsCheapIssueAssigneeModelProfile(input)) return true;
    const run = await loadActorRunContext(req, issue.companyId);
    if (!run || !isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Cheap status-only recovery runs cannot assign downstream issue work to the cheap model profile",
      details: {
        issueId: issue.id ?? null,
        runId: run.id,
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
      },
    });
    return false;
  }

  async function assertDeliverableMutationAllowedByRunContext(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string },
  ) {
    const run = await loadActorRunContext(req, issue.companyId);
    if (!run) return true;
    if (!isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Cheap status-only recovery runs cannot update issue documents, plans, or deliverable artifacts",
      details: {
        issueId: issue.id,
        runId: run.id,
        modelProfile: "cheap",
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
    if (!isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Cheap status-only recovery runs cannot create or modify approvals",
      details: {
        issueId: issue.id,
        runId: run.id,
        modelProfile: "cheap",
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
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (await assertLowTrustControlPlaneDenied(req, res, issue.companyId, issue)) return false;

    if (issue.status === "cancelled") {
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

  async function assertRecoveryActionAuthority(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; assigneeAgentId: string | null },
    activeRecoveryAction: Awaited<ReturnType<typeof recoveryActionsSvc.getActiveForIssue>>,
    input: { source: "issue_update" | "recovery_action_resolution" },
  ) {
    if (req.actor.type !== "agent") return true;
    if (!activeRecoveryAction) return true;

    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
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

    res.status(403).json({
      error: "Agent cannot resolve another owner's recovery action",
      details: {
        issueId: issue.id,
        recoveryActionId: activeRecoveryAction.id,
        actorAgentId,
        assigneeAgentId: issue.assigneeAgentId,
        recoveryOwnerAgentId: activeRecoveryAction.ownerAgentId,
        source: input.source,
        securityPrinciples: ["Least Privilege", "Complete Mediation", "Secure Defaults"],
      },
    });
    return false;
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

  async function normalizeIssueAssigneeAgentReference(
    companyId: string,
    rawAssigneeAgentId: string | null | undefined,
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

  function respondClosedIssueExecutionWorkspace(
    res: Response,
    workspace: Pick<ExecutionWorkspace, "closedAt" | "id" | "mode" | "name" | "status">,
  ) {
    res.status(409).json({
      error: getClosedIsolatedExecutionWorkspaceMessage(workspace),
      executionWorkspace: workspace,
    });
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
    const query = companySearchQuerySchema.parse(req.query);
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
    const hasPlanDocument = parseOptionalBooleanQuery(req.query.hasPlanDocument);
    const assigneeAgentFilterRaw = req.query.assigneeAgentId;
    let assigneeAgentId: string | null | undefined;

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
    const offset = parsedOffset ?? 0;

    const rawResult = await svc.list(companyId, {
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
      parentId: req.query.parentId as string | undefined,
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
      hasPlanDocument,
      q: req.query.q as string | undefined,
      limit,
      offset,
      sortField: sortField === "updated" ? "updated" : undefined,
      sortDir: sortDir === "asc" || sortDir === "desc" ? sortDir : undefined,
    });
    const result = await actorCanReadCompanyScope(req, companyId)
      ? rawResult
      : await filterIssuesForActor(req, rawResult);
    const issueIds = result.map((issue) => issue.id);
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
    res.json(result.map((issue) => ({
      ...issue,
      successfulRunHandoff: handoffStates.get(issue.id) ?? null,
      activeRecoveryAction: recoveryActionByIssue.get(issue.id) ?? null,
    })));
  });

  router.get("/companies/:companyId/issues/count", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
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
      parentId: req.query.parentId as string | undefined,
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

  router.get("/issues/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
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

    res.json({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        workMode: issue.workMode,
        ...(blockerAttention ? { blockerAttention } : {}),
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
      currentExecutionWorkspace,
    });
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const [
      { project, goal },
      ancestors,
      mentionedProjectIds,
      documentPayload,
      relations,
      blockerAttention,
      productivityReview,
      referenceSummary,
      successfulRunHandoffStates,
      scheduledRetry,
      activeRecoveryAction,
    ] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id, { includeCommentBodies: false }),
      documentsSvc.getIssueDocumentPayload(issue),
      svc.getRelationSummaries(issue.id),
      svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
      svc.listProductivityReviews(issue.companyId, [issue.id]).then((map) => map.get(issue.id) ?? null),
      issueReferencesSvc.listIssueReferenceSummary(issue.id),
      listSuccessfulRunHandoffStates(db, issue.companyId, [issue.id]),
      svc.getCurrentScheduledRetry(issue.id),
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
      ...(blockerAttention ? { blockerAttention } : {}),
      productivityReview,
      successfulRunHandoff: successfulRunHandoffStates.get(issue.id) ?? null,
      scheduledRetry,
      activeRecoveryAction: revalidatedActiveRecoveryAction,
      blockedBy: relationsWithRecoveryActions.blockedBy,
      blocks: relationsWithRecoveryActions.blocks,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
      ...documentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace,
      workProducts,
    });
  });

  router.get("/issues/:id/watchdog", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    res.json(await taskWatchdogsSvc.getActiveForIssue(issue.companyId, issue.id));
  });

  router.put("/issues/:id/watchdog", validate(upsertIssueWatchdogSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
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
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
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
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
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
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    const activeRecoveryAction = await recoveryActionsSvc.getActiveForIssue(existing.companyId, existing.id);
    if (
      !(await assertRecoveryActionAuthority(
        req,
        res,
        existing,
        activeRecoveryAction,
        { source: "recovery_action_resolution" },
      ))
    ) {
      return;
    }

    const { actionId, outcome, sourceIssueStatus, resolutionNote } = req.body;
    if (outcome === "false_positive" || outcome === "cancelled") {
      assertBoard(req);
    }

    const actor = getActorInfo(req);
    const updateFields = sourceIssueStatus ? { status: sourceIssueStatus } : {};
    await assertAgentInReviewReviewPath({
      existing,
      updateFields,
      actorType: req.actor.type,
    });

    const actionStatus = outcome === "cancelled" ? "cancelled" : "resolved";
    const result = await db.transaction(async (tx) => {
      let issue = existing;
      if (outcome === "blocked") {
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

      if (sourceIssueStatus) {
        const updatedIssue = await svc.update(
          id,
          {
            status: sourceIssueStatus,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
          },
          tx,
        );
        if (!updatedIssue) throw notFound("Issue not found");
        issue = updatedIssue;
      }

      const recoveryAction = await recoveryActionsSvc.resolveActiveForIssue(
        {
          companyId: existing.companyId,
          sourceIssueId: existing.id,
          actionId: actionId ?? null,
          status: actionStatus,
          outcome,
          resolutionNote: resolutionNote ?? null,
        },
        tx,
      );
      if (!recoveryAction) throw notFound("Active recovery action not found");

      return { issue, recoveryAction };
    });

    await routinesSvc.syncRunStatusForIssue(result.issue.id);

    if (sourceIssueStatus && existing.status !== result.issue.status) {
      await logActivity(db, {
        companyId: result.issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
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
      existing.status !== result.issue.status &&
      result.issue.assigneeAgentId
    ) {
      void heartbeat.wakeup(result.issue.assigneeAgentId, {
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
      }).catch((err) =>
        logger.warn(
          { err, issueId: result.issue.id, agentId: result.issue.assigneeAgentId },
          "failed to wake agent after recovery action restored issue",
        ));
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
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
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
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const docs = await documentsSvc.listIssueDocuments(issue.id, {
      includeSystem: req.query.includeSystem === "true",
    });
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
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
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
        action: "issue.document_annotation_thread_created",
        entityType: "issue",
        entityId: issue.id,
        details: {
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
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
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
        action: "issue.document_annotation_comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
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
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
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
        action: thread.status === "resolved"
          ? "issue.document_annotation_thread_resolved"
          : "issue.document_annotation_thread_reopened",
        entityType: "issue",
        entityId: issue.id,
        details: {
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
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
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

    const actor = getActorInfo(req);
    const result = await documentsSvc.unlockIssueDocument(issue.id, keyParsed.data);

    if (result.changed) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
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
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    await issueReferencesSvc.deleteDocumentSource(removed.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
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
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
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
    res.status(201).json(product);
  });

  router.post("/issues/:id/low-trust/promotions", validate(promoteLowTrustOutputSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
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
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
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
    if (await assertLowTrustControlPlaneDenied(req, res, issue.companyId, issue)) return;
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
    assertCompanyAccess(req, issue.companyId);
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
    assertCompanyAccess(req, issue.companyId);
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
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/issues", applyCreateIssueStatusDefault, validate(createIssueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (await assertLowTrustControlPlaneDenied(req, res, companyId, null)) return;
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));
    const { watchdogDiscovery: rawWatchdogDiscovery, ...rawCreateBody } = req.body;
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
    if (req.actor.type === "agent" && !effectiveParentId && !watchdogProductBugFollowUp) {
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
      if (!(await assertIssueReadAllowed(req, res, createParent))) return;
    }
    if (
      !watchdogProductBugFollowUp &&
      !(await assertTaskWatchdogCreateIssueAllowed(req, res, companyId, createParent))
    ) return;
    const normalizedAssigneeAgentId = await normalizeIssueAssigneeAgentReference(
      companyId,
      rawCreateBody.assigneeAgentId as string | null | undefined,
    );
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
    if (!(await assertCheapRecoveryIssueAssigneeProfileAllowed(req, res, { companyId }, createBody))) return;
    if (rawCreateBody.assigneeAgentId || rawCreateBody.assigneeUserId) {
      await assertCanAssignTasks(req, companyId, {
        projectId: await resolveAssignmentProjectId({
          companyId,
          projectId: createBody.projectId,
          parentIssueId: createBody.parentId,
        }),
        parentIssueId: createBody.parentId ?? null,
        assigneeAgentId: createBody.assigneeAgentId ?? null,
        assigneeUserId: rawCreateBody.assigneeUserId ?? null,
      });
    }
    await assertIssueEnvironmentSelection(companyId, createBody.executionWorkspaceSettings?.environmentId);

    const executionPolicy = applyActorMonitorScheduledBy(
      normalizeIssueExecutionPolicy(createBody.executionPolicy),
      actor.actorType,
    );
    await assertCanManageIssueMonitor(access, req, companyId, createBody.assigneeAgentId ?? null, Boolean(executionPolicy?.monitor));

    // Idempotency: if the same idempotencyKey is sent twice, return the existing issue.
    if (rawCreateBody.idempotencyKey) {
      const [existing] = await db
        .select({ id: issueRows.id })
        .from(issueRows)
        .where(
          and(
            eq(issueRows.companyId, companyId),
            eq(issueRows.idempotencyKey, rawCreateBody.idempotencyKey),
            notInArray(issueRows.status, ["cancelled"]),
          ),
        )
        .limit(1);
      if (existing) {
        const full = await svc.getById(existing.id);
        res.json(full);
        return;
      }
    }

    const issueId = randomUUID();
    const sourceTrust = await sourceTrustForActorWrite({
      id: issueId,
      companyId,
      projectId: createBody.projectId ?? null,
      executionPolicy,
    }, actor);
    const issue = await svc.create(companyId, {
      ...createBody,
      id: issueId,
      executionPolicy,
      ...(sourceTrust ? { sourceTrust } : {}),
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      watchdogActorRunId: actor.runId,
    });
    await issueReferencesSvc.syncIssue(issue.id);
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

  router.post("/issues/:id/children", applyCreateIssueStatusDefault, validate(createChildIssueSchema), async (req, res) => {
    const parentId = req.params.id as string;
    const parent = await svc.getById(parentId);
    if (!parent) {
      res.status(404).json({ error: "Parent issue not found" });
      return;
    }
    assertCompanyAccess(req, parent.companyId);
    if (!(await assertIssueReadAllowed(req, res, parent))) return;
    if (!(await assertTaskWatchdogCreateIssueAllowed(req, res, parent.companyId, parent))) return;
    if (await assertLowTrustControlPlaneDenied(req, res, parent.companyId, parent)) return;
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));
    const normalizedAssigneeAgentId = await normalizeIssueAssigneeAgentReference(
      parent.companyId,
      req.body.assigneeAgentId as string | null | undefined,
    );
    const createBody = {
      ...req.body,
      ...(normalizedAssigneeAgentId !== undefined ? { assigneeAgentId: normalizedAssigneeAgentId } : {}),
    };
    if (!(await assertCheapRecoveryIssueAssigneeProfileAllowed(req, res, parent, createBody))) return;
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, parent.companyId, {
        projectId: createBody.projectId ?? parent.projectId ?? null,
        parentIssueId: parent.id,
        assigneeAgentId: createBody.assigneeAgentId ?? null,
        assigneeUserId: createBody.assigneeUserId ?? null,
      });
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
      actorAgentId: actor.agentId,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
      watchdogActorRunId: actor.runId,
    });

    await logActivity(db, {
      companyId: parent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
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
    const sourceIssue = await svc.getById(sourceIssueId);
    if (!sourceIssue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, sourceIssue.companyId);
    const decompositions = await svc.listAcceptedPlanDecompositions(sourceIssue.id);
    res.json(decompositions);
  });

  router.post("/issues/:id/accepted-plan-decompositions", validate(createAcceptedPlanDecompositionSchema), async (req, res) => {
    const sourceIssueId = req.params.id as string;
    const sourceIssue = await svc.getById(sourceIssueId);
    if (!sourceIssue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, sourceIssue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, sourceIssue))) return;

    const requestedChildren = [];
    for (const child of req.body.children as Array<typeof req.body.children[number]>) {
      const normalizedAssigneeAgentId = await normalizeIssueAssigneeAgentReference(
        sourceIssue.companyId,
        child.assigneeAgentId as string | null | undefined,
      );
      const childBody = {
        ...child,
        ...(normalizedAssigneeAgentId !== undefined ? { assigneeAgentId: normalizedAssigneeAgentId } : {}),
      };
      requestedChildren.push(childBody);
      assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(childBody));
      if (!(await assertCheapRecoveryIssueAssigneeProfileAllowed(req, res, sourceIssue, childBody))) return;
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
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
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
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

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

  router.patch("/issues/:id", validate(updateIssueRouteSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    if (!(await assertCheapRecoveryIssueAssigneeProfileAllowed(req, res, existing, req.body))) return;

    const actor = getActorInfo(req);
    const isClosed = isClosedIssueStatus(existing.status);
    const isBlocked = existing.status === "blocked";
    const normalizedAssigneeAgentId = await normalizeIssueAssigneeAgentReference(
      existing.companyId,
      req.body.assigneeAgentId as string | null | undefined,
    );
    const titleOrDescriptionChanged = req.body.title !== undefined || req.body.description !== undefined;
    const existingRelations =
      Array.isArray(req.body.blockedByIssueIds)
        ? await svc.getRelationSummaries(existing.id)
        : null;
    const {
      comment: commentBody,
      reviewRequest,
      reopen: reopenRequested,
      resume: resumeRequested,
      interrupt: interruptRequested,
      hiddenAt: hiddenAtRaw,
      ...updateFields
    } = req.body;
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
    if (resumeRequested === true && !(await assertExplicitResumeIntentAllowed(req, res, existing))) return;
    if (resumeRequested !== true && reopenRequested === true && req.actor.type === "agent") {
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
    if (
      recoveryRelevantSourceMutationRequested &&
      !(await assertRecoveryActionAuthority(
        req,
        res,
        existing,
        activeRecoveryActionBeforeUpdate,
        { source: "issue_update" },
      ))
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
      req.actor.type === "agent" && (Object.keys(updateFields).length > 0 || reviewRequest !== undefined);

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
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
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

    await assertAgentInReviewReviewPath({
      existing,
      updateFields,
      actorType: req.actor.type,
    });

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
        });
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
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
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
          action: "heartbeat.cancel_failed",
          entityType: "heartbeat_run",
          entityId: runToCancelForCancelledStatus.id,
          details: { source: "issue_status_cancelled", issueId: existing.id },
        });
      }
    }

    if (titleOrDescriptionChanged) {
      await issueReferencesSvc.syncIssue(issue.id);
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
        blockedBy: updatedRelations.blockedBy,
        blocks: updatedRelations.blocks,
      };
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
    if (Array.isArray(req.body.blockedByIssueIds)) {
      previous.blockedByIssueIds = existingRelations?.blockedBy.map((relation) => relation.id) ?? [];
    }

    const hasFieldChanges = Object.keys(previous).length > 0;
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
      await listSuccessfulRunHandoffStates(db, issue.companyId, [issue.id])
        .then(async (handoffStates) => {
          const handoff = handoffStates.get(issue.id);
          if (handoff?.state !== "required") return;
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
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

    let comment = null;
    if (commentBody) {
      const commentReferenceSummaryBefore = updateReferenceSummaryAfter
        ?? await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      comment = await svc.addComment(id, commentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
      }, {
        sourceTrust: await sourceTrustForActorWrite(issue, actor),
      });
      await issueReferencesSvc.syncComment(comment.id);
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
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
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

    } else if (updateReferenceSummaryAfter) {
      issueResponse = {
        ...issueResponse,
        relatedWork: updateReferenceSummaryAfter,
        referencedIssueIdentifiers: updateReferenceSummaryAfter.outbound.map(
          (item) => item.issue.identifier ?? item.issue.id,
        ),
      };
    }

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
      const wakeups = new Map<string, { agentId: string; wakeup: WakeupRequest }>();
      const addWakeup = (agentId: string, wakeup: WakeupRequest) => {
        const wakeIssueId =
          wakeup.payload && typeof wakeup.payload === "object" && typeof wakeup.payload.issueId === "string"
            ? wakeup.payload.issueId
            : issue.id;
        wakeups.set(`${agentId}:${wakeIssueId}`, { agentId, wakeup });
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
        (statusChangedFromBacklog || statusChangedFromBlockedToTodo || statusChangedFromClosedToTodo) &&
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
        const selfComment = actorIsAgent && actor.actorId === assigneeId;
        const skipAssigneeCommentWake = selfComment || isClosed;

        if (assigneeId && !assigneeChanged && (reopened || !skipAssigneeCommentWake)) {
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

      const becameDone = existing.status !== "done" && issue.status === "done";
      if (becameDone) {
        const dependents = await svc.listWakeableBlockedDependents(issue.id);
        for (const dependent of dependents) {
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
          .catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();

    await queueTaskWatchdogEvaluation(issue, actor.runId);
    res.json({ ...issueResponse, comment });
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
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
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    await queueTaskWatchdogEvaluation(existing, actor.runId);
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
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

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
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
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
    res.json(comments);
  });

  router.get("/issues/:id/interactions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const actor = getActorInfo(req);
    const interactionSvc = issueThreadInteractionService(db);
    const expiredInteractions = await interactionSvc.expireRequestConfirmationsSupersededByHistoricalComments(issue);
    await logExpiredRequestConfirmations({
      issue,
      interactions: expiredInteractions,
      actor,
      source: "issue.interactions.catchup_superseded_by_comment",
    });

    const interactions = await interactionSvc.listForIssue(id);
    res.json(interactions);
  });

  router.post("/issues/:id/interactions", validate(createIssueThreadInteractionSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type === "agent") {
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
      if (await assertLowTrustControlPlaneDenied(req, res, issue.companyId, issue)) return;
    } else {
      assertBoard(req);
    }

    const actor = getActorInfo(req);
    const agentSourceRunId = req.actor.type === "agent" ? requireAgentRunId(req, res) : null;
    if (req.actor.type === "agent" && !agentSourceRunId) return;

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
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        continuationPolicy: interaction.continuationPolicy,
      },
    });

    res.status(201).json(interaction);
  });

  router.post(
    "/issues/:id/interactions/:interactionId/accept",
    validate(acceptIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      if (await rejectAgentIssueThreadInteractionResolution(req, res, issue)) return;
      assertBoard(req);

      const actor = getActorInfo(req);
      const { interaction, createdIssues, continuationIssue } = await issueThreadInteractionService(db).acceptInteraction(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
      const continuationWakeIssue = continuationIssue ?? issue;

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_accepted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
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
          action: "issue.updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            status: continuationIssue.status,
            assigneeAgentId: continuationIssue.assigneeAgentId ?? null,
            assigneeUserId: continuationIssue.assigneeUserId ?? null,
            source: "request_confirmation_accept",
            interactionId: interaction.id,
            _previous: {
              status: issue.status,
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
        ? readAcceptedPlanConfirmationTarget(interaction.payload)
        : null;
      const acceptedPlanConfirmation =
        interaction.kind === "request_confirmation" &&
        interaction.status === "accepted" &&
        acceptedPlanTarget?.issueId === issue.id &&
        acceptedPlanTarget.key === "plan";
      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue: continuationWakeIssue,
        interaction,
        actor,
        source: "issue.interaction.accept",
        forceFreshSession: acceptedPlanConfirmation,
        workspaceRefreshReason: acceptedPlanConfirmation ? "accepted_plan_confirmation" : null,
      });

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/reject",
    validate(rejectIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      if (await rejectAgentIssueThreadInteractionResolution(req, res, issue)) return;
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await issueThreadInteractionService(db).rejectInteraction(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_rejected",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          rejectionReason:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.rejectionReason ?? null)
              : interaction.kind === "request_confirmation" || interaction.kind === "request_checkbox_confirmation"
                ? (interaction.result?.reason ?? null)
              : null,
        },
      });

      queueResolvedInteractionContinuationWakeup({
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
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      if (await rejectAgentIssueThreadInteractionResolution(req, res, issue)) return;
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await issueThreadInteractionService(db).answerQuestions(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.thread_interaction_answered",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          answeredQuestionCount:
            interaction.kind === "ask_user_questions"
              ? (interaction.result?.answers?.length ?? 0)
              : 0,
        },
      });

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.respond",
      });

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/cancel",
    validate(cancelIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      if (await rejectAgentIssueThreadInteractionResolution(req, res, issue)) return;
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await issueThreadInteractionService(db).cancelQuestions(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
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

      queueResolvedInteractionContinuationWakeup({
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
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.delete("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
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

    const activeRun = await resolveActiveIssueRun(issue);
    const isQueuedComment = activeRun ? isQueuedIssueCommentForActiveRun({ comment, activeRun }) : false;
    if (deleteMode === "cancel" || isQueuedComment) {
      if (!actorOwnsComment) {
        res.status(403).json({ error: "Only the comment author can cancel queued comments" });
        return;
      }

      if (!activeRun) {
        res.status(409).json({ error: "Queued comment can no longer be canceled" });
        return;
      }

      if (!isQueuedComment) {
        res.status(409).json({ error: "Only queued comments can be canceled" });
        return;
      }

      const removed = await svc.removeComment(commentId);
      if (!removed) {
        res.status(404).json({ error: "Comment not found" });
        return;
      }

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_cancelled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: removed.id,
          bodySnippet: removed.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          source: "queue_cancel",
          queueTargetRunId: activeRun.id,
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
          annotationCleanup = await documentAnnotationsSvc.cleanupForIssueCommentDeletion(issue.id, deletedComment.id, {
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            userId: actor.actorType === "user" ? actor.actorId : null,
            runId: actor.runId,
          }, tx);
          await Promise.all(
            annotationCleanup.deletedCommentIds.map((annotationCommentId) =>
              issueReferencesSvc.deleteCommentSource(annotationCommentId, tx)
            ),
          );
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
    const commentAccessDecision = await assertAgentIssueCommentAllowed(req, res, issue);
    if (!commentAccessDecision) return;
    if (!assertStructuredCommentFieldsAllowed(req, res, {
      presentation: req.body.presentation,
      metadata: req.body.metadata,
    })) return;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const actor = getActorInfo(req);
    const reopenRequested = req.body.reopen === true;
    const resumeRequested = req.body.resume === true;
    const interruptRequested = req.body.interrupt === true;
    const isClosed = isClosedIssueStatus(issue.status);
    const isBlocked = issue.status === "blocked";
    const mentionGrantedPeerAgentCommentOnly =
      isClosed &&
      req.actor.type === "agent" &&
      issue.assigneeAgentId !== null &&
      issue.assigneeAgentId !== req.actor.agentId &&
      !reopenRequested &&
      !resumeRequested &&
      isIssueMentionGrantDecision(commentAccessDecision);
    const effectiveReopenRequested = mentionGrantedPeerAgentCommentOnly ? false : reopenRequested;
    const effectiveResumeRequested = mentionGrantedPeerAgentCommentOnly ? false : resumeRequested;
    if (
      isClosed &&
      req.actor.type === "agent" &&
      issue.assigneeAgentId !== null &&
      issue.assigneeAgentId !== req.actor.agentId &&
      !mentionGrantedPeerAgentCommentOnly
    ) {
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    }
    if (effectiveResumeRequested === true && !(await assertExplicitResumeIntentAllowed(req, res, issue))) return;
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
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;
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
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
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
        presentation: req.body.presentation ?? null,
        metadata: req.body.metadata ?? null,
        sourceTrust,
      };
      let txResult: { comment: Awaited<ReturnType<typeof svc.addComment>>; issue: NonNullable<Awaited<ReturnType<typeof svc.update>>> };
      try {
        txResult = await db.transaction(async (tx) => {
          const insertedComment = await svc.addComment(
            id,
            req.body.body,
            {
              agentId: actor.agentId ?? undefined,
              userId: actor.actorType === "user" ? actor.actorId : undefined,
              runId: actor.runId,
            },
            commentOptions,
            tx,
          );
          const updated = await svc.update(id, updatePatch, tx);
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
      }, {
        authorType: req.body.authorType ?? (actor.actorType === "agent" ? "agent" : "user"),
        presentation: req.body.presentation ?? null,
        metadata: req.body.metadata ?? null,
        sourceTrust: await sourceTrustForActorWrite(currentIssue, actor),
      });
    }

    await issueReferencesSvc.syncComment(comment.id);
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
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
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

      if (commentDecisionStageWakeup) {
        addWakeup(commentDecisionStageWakeup.agentId, commentDecisionStageWakeup.wakeup);
      }

      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      // Re-derive closed-ness from the post-mutation issue so the auto-approval
      // transition (in_review -> done) suppresses a stale `issue_commented` wake
      // to the returnAssignee for an already-completed issue.
      const skipWake = selfComment || isClosedIssueStatus(currentIssue.status);
      if (assigneeId && (reopened || !skipWake)) {
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
        if (actorIsAgent && actor.actorId === mentionedId) continue;
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
          addWakeup(dependent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_blockers_resolved",
            payload: {
              issueId: dependent.id,
              resolvedBlockerIssueId: currentIssue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: dependent.id,
              taskId: dependent.id,
              wakeReason: "issue_blockers_resolved",
              source: "issue.blockers_resolved",
              resolvedBlockerIssueId: currentIssue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
          });
        }
      }

      const becameTerminal =
        !["done", "cancelled"].includes(issueBeforeCommentDecision.status) &&
        ["done", "cancelled"].includes(currentIssue.status);
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
          .catch((err) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    await queueTaskWatchdogEvaluation(currentIssue, actor.runId);
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
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;

    const company = await companiesSvc.getById(companyId);
    const attachmentMaxBytes = normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes);

    try {
      await runSingleFileUpload(req, res, attachmentMaxBytes);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${attachmentMaxBytes} bytes` });
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
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported attachment content type: ${contentType}` });
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
    res.setHeader("Content-Type", responseContentType);
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
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);
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
