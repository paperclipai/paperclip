import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNull, like, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  assets,
  companies,
  companyMemberships,
  documents,
  goals,
  heartbeatRuns,
  executionWorkspaces,
  externalOperations,
  issueApprovals,
  issueAttachments,
  issueInboxArchives,
  issueLabels,
  issueRecoveryActions,
  issueRelations,
  issueComments,
  issueDocuments,
  issueReadStates,
  issueThreadInteractions,
  issues,
  labels,
  projectWorkspaces,
  projects,
  workCycles,
} from "@paperclipai/db";
import type {
  IssueCommentAuthorType,
  IssueAttachment,
  IssueCommentMetadata,
  IssueCommentPresentation,
  IssueBlockerAttention,
  IssueProductivityReview,
  IssueProductivityReviewTrigger,
  IssueRelationIssueSummary,
} from "@paperclipai/shared";
import {
  ISSUE_WORK_ITEM_TYPES,
} from "@paperclipai/shared/constants";
import {
  clampIssueRequestDepth,
  extractAgentMentionIds,
  extractProjectMentionIds,
  issueCommentAuthorTypeSchema,
  issueCommentMetadataSchema,
  issueCommentPresentationSchema,
  issueExecutionContractSchema,
  isUuidLike,
  normalizeIssueIdentifier as normalizeIssueReferenceIdentifier,
  requestConfirmationPayloadSchema,
  requestConfirmationResultSchema,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import {
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
} from "./execution-workspace-policy.js";
import { mergeExecutionWorkspaceConfig } from "./execution-workspaces.js";
import {
  assertIssueCompletionEvidence,
  assertIssueCompletionEvidenceOnCreate,
} from "./issue-completion-evidence.js";
import {
  buildInitialIssueMonitorFields,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  stripMonitorFromExecutionPolicy,
} from "./issue-execution-policy.js";
import {
  acquireIssueDeliveryLock,
  buildFactoryDeliveryEvidenceExpectations,
  candidateShasMatch,
  deliveryService,
  evaluateDeliveryEvidenceGates,
} from "./delivery.js";
import { assertFactoryExecutionPolicySnapshotConsistent } from "./ai-factory-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { resolveIssueGoalId, resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { getRunLogStore } from "./run-log-store.js";
import { getDefaultCompanyGoal } from "./goals.js";
import {
  isVerifiedIssueTreeControlInteractionWake,
  issueTreeControlService,
  type ActiveIssueTreePauseHoldGate,
} from "./issue-tree-control.js";
import { parseIssueGraphLivenessIncidentKey } from "./recovery/origins.js";

const ALL_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const MAX_ISSUE_COMMENT_PAGE_LIMIT = 500;
export const ISSUE_LIST_DEFAULT_LIMIT = 500;
export const ISSUE_LIST_MAX_LIMIT = 1000;
const ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE = 500;
export const MAX_DIRECT_CHILD_ISSUES_PER_PARENT = 10;
const MAX_CHILD_COMPLETION_SUMMARIES = 20;
const CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS = 500;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_LOG_BYTES = 2_000_000;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_CHUNK_BYTES = 256_000;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_END_SLACK_MS = 60_000;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_PARALLEL_READS = 8;
const ISSUE_ATTACHMENT_CONTENT_PATH_RE = /\/api\/attachments\/([^/\s)"'`]+)\/content\b/g;

function issueAttachmentContentPath(id: string) {
  return `/api/attachments/${id}/content`;
}

function extractIssueAttachmentIdsFromText(text: string) {
  const ids = new Set<string>();
  for (const match of text.matchAll(ISSUE_ATTACHMENT_CONTENT_PATH_RE)) {
    const id = match[1]?.trim();
    if (id && isUuidLike(id)) ids.add(id);
  }
  return [...ids];
}

function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!ALL_ISSUE_STATUSES.includes(to)) {
    throw conflict(`Unknown issue status: ${to}`);
  }
}

function applyStatusSideEffects(
  status: string | undefined,
  patch: Partial<typeof issues.$inferInsert>,
): Partial<typeof issues.$inferInsert> {
  if (!status) return patch;

  if (status === "in_progress" && !patch.startedAt) {
    patch.startedAt = new Date();
  }
  if (status === "done") {
    patch.completedAt = new Date();
  }
  if (status === "cancelled") {
    patch.cancelledAt = new Date();
  }
  return patch;
}

function readStringFromRecord(record: unknown, key: string) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildReusedExecutionWorkspaceConfigPatchFromIssueSettings(
  settings: ReturnType<typeof parseIssueExecutionWorkspaceSettings>,
) {
  return {
    environmentId: settings?.environmentId ?? null,
    provisionCommand: settings?.workspaceStrategy?.provisionCommand ?? null,
    teardownCommand: settings?.workspaceStrategy?.teardownCommand ?? null,
    workspaceRuntime: settings?.workspaceRuntime ?? null,
  };
}

function toTimestampMs(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

type IssueCommentRunLogAttributionCandidate = {
  id: string;
  createdAt: Date | string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdByRunId?: string | null;
};

type IssueCommentRunLogAttributionRun = {
  runId: string;
  agentId: string;
  createdAt: Date | string;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  logContent: string;
};

export function deriveIssueCommentRunLogAttribution(
  comments: readonly IssueCommentRunLogAttributionCandidate[],
  runs: readonly IssueCommentRunLogAttributionRun[],
) {
  const derivedByCommentId = new Map<string, {
    derivedAuthorAgentId: string;
    derivedCreatedByRunId: string;
    derivedAuthorSource: "run_log_comment_post";
  }>();

  for (const comment of comments) {
    if (comment.authorAgentId || !comment.authorUserId || comment.createdByRunId) continue;
    const commentCreatedAtMs = toTimestampMs(comment.createdAt);
    if (commentCreatedAtMs === null) continue;

    let bestMatch:
      | {
        runId: string;
        agentId: string;
        distanceMs: number;
      }
      | null = null;

    for (const run of runs) {
      const runStartMs = toTimestampMs(run.startedAt ?? run.createdAt);
      const runEndMs = toTimestampMs(run.finishedAt ?? run.createdAt);
      if (runStartMs === null || runEndMs === null) continue;
      if (
        commentCreatedAtMs < runStartMs
        || commentCreatedAtMs > runEndMs + ISSUE_COMMENT_RUN_LOG_DERIVATION_END_SLACK_MS
      ) {
        continue;
      }
      if (!run.logContent.includes(`comment id: ${comment.id}`)) continue;

      const distanceMs = Math.abs(runEndMs - commentCreatedAtMs);
      if (!bestMatch || distanceMs < bestMatch.distanceMs) {
        bestMatch = {
          runId: run.runId,
          agentId: run.agentId,
          distanceMs,
        };
      }
    }

    if (!bestMatch) continue;
    derivedByCommentId.set(comment.id, {
      derivedAuthorAgentId: bestMatch.agentId,
      derivedCreatedByRunId: bestMatch.runId,
      derivedAuthorSource: "run_log_comment_post",
    });
  }

  return derivedByCommentId;
}

export interface IssueFilters {
  status?: string | readonly string[];
  assigneeAgentId?: string;
  recoveryOwnerAgentId?: string;
  participantAgentId?: string;
  assigneeUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  awaitingDecisionForUserId?: string;
  projectId?: string;
  cycleId?: string;
  projectScopeRestrictedTo?: string[];
  workspaceId?: string;
  executionWorkspaceId?: string;
  parentId?: string;
  descendantOf?: string;
  labelId?: string;
  originKind?: string;
  originKindPrefix?: string;
  originId?: string;
  workItemType?: string;
  includeRoutineExecutions?: boolean;
  excludeRoutineExecutions?: boolean;
  includePluginOperations?: boolean;
  includeBlockedBy?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export function parseStatusFilter(input: string | readonly string[] | undefined): string[] {
  if (input == null) return [];
  const entries = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  return entries
    .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
    .map((status) => status.trim())
    .filter(Boolean);
}

const ISSUE_WORK_ITEM_TYPE_SET = new Set<string>(ISSUE_WORK_ITEM_TYPES);
const HUMAN_CONTROL_WORK_ITEM_TYPES = new Set(["initiative", "human_task"]);

export function parseWorkItemTypeFilter(input: string | readonly string[] | undefined): string[] {
  if (input == null) return [];
  const entries = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  return entries
    .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
    .map((workItemType) => workItemType.trim())
    .filter((workItemType) => ISSUE_WORK_ITEM_TYPE_SET.has(workItemType));
}

function isHumanControlWorkItemType(value: unknown) {
  return typeof value === "string" && HUMAN_CONTROL_WORK_ITEM_TYPES.has(value);
}

function assertAgentAssignmentAllowedForWorkItem(workItemType: unknown, assigneeAgentId: string | null | undefined) {
  if (!assigneeAgentId || !isHumanControlWorkItemType(workItemType)) return;
  throw unprocessable("Initiatives and human tasks cannot be assigned to AI agents. Create a linked AI execution issue instead.");
}

export type IssueChildTopologyPolicy = {
  mode: "same_issue_only" | "single_execution_lane" | "direct_execution_lanes";
  maxExecutionLanes: number;
  source: "execution_contract" | "execution_policy" | "legacy_contract_constraint" | "default";
};

function readFactoryExtension(executionContract: unknown) {
  if (!isRecord(executionContract) || !isRecord(executionContract.extensions)) return null;
  const extension = executionContract.extensions.aiFactory ?? executionContract.extensions.ai_factory;
  return isRecord(extension) ? extension : null;
}

function readFactoryTopologyMode(value: unknown): IssueChildTopologyPolicy["mode"] | null {
  return value === "same_issue_only" || value === "single_execution_lane" || value === "direct_execution_lanes"
    ? value
    : null;
}

function boundedExecutionLaneCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? Math.min(value, MAX_DIRECT_CHILD_ISSUES_PER_PARENT)
    : MAX_DIRECT_CHILD_ISSUES_PER_PARENT;
}

function collectContractConstraintText(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectContractConstraintText(entry, depth + 1));
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((entry) => collectContractConstraintText(entry, depth + 1));
}

function legacyContractForbidsChildren(executionContract: unknown) {
  if (!isRecord(executionContract) || !isRecord(executionContract.core)) return false;
  const constraintText = collectContractConstraintText(executionContract.core.constraints).join("\n").toLowerCase();
  return [
    /\bsame[- ]issue[- ]only\b/,
    /\b(?:create|spawn|open|make)\s+(?:no|zero)\s+(?:child(?:ren)?|child issues?|sub[- ]?issues?)\b/,
    /\bno\s+(?:child(?:ren)?|child issues?|sub[- ]?issues?)\s+(?:are\s+)?(?:allowed|permitted|required)\b/,
    /\bmust\s+not\s+(?:create|spawn|open|make)\s+(?:child(?:ren)?|child issues?|sub[- ]?issues?)\b/,
  ].some((pattern) => pattern.test(constraintText));
}

/**
 * Resolves the immutable topology contract used by every child-creation path.
 * A frozen factory control snapshot is an upper bound: an issue contract may
 * make its topology stricter, but can never loosen the snapshotted lane cap.
 * Legacy prose is recognized only for unambiguous no-child phrases.
 */
export function resolveIssueChildTopologyPolicy(input: {
  executionContract: unknown;
  executionPolicy: unknown;
}): IssueChildTopologyPolicy {
  const executionPolicy = normalizeIssueExecutionPolicy(input.executionPolicy);
  const frozenControlTopology: IssueChildTopologyPolicy | null =
    executionPolicy?.factory?.laneKind === "control"
      ? {
          mode: executionPolicy.factory.topologyMode,
          maxExecutionLanes: executionPolicy.factory.topologyMode === "same_issue_only"
            ? 0
            : executionPolicy.factory.topologyMode === "single_execution_lane"
              ? 1
              : boundedExecutionLaneCount(executionPolicy.factory.maxExecutionLanes),
          source: "execution_policy",
        }
      : null;
  const extension = readFactoryExtension(input.executionContract);
  const extensionMode = readFactoryTopologyMode(extension?.topologyMode ?? extension?.topology_mode);
  const extensionForbidsChildren = extension?.childrenAllowed === false || extension?.children_allowed === false;
  if (extensionMode || extensionForbidsChildren) {
    const mode = extensionForbidsChildren ? "same_issue_only" : extensionMode!;
    const contractTopology: IssueChildTopologyPolicy = {
      mode,
      maxExecutionLanes: mode === "same_issue_only"
        ? 0
        : mode === "single_execution_lane"
          ? 1
          : boundedExecutionLaneCount(extension?.maxExecutionLanes ?? extension?.max_execution_lanes),
      source: "execution_contract",
    };
    if (
      frozenControlTopology
      && frozenControlTopology.maxExecutionLanes <= contractTopology.maxExecutionLanes
    ) {
      return frozenControlTopology;
    }
    return contractTopology;
  }

  if (executionPolicy?.factory) {
    const mode = executionPolicy.factory.topologyMode;
    return {
      mode,
      maxExecutionLanes: mode === "same_issue_only"
        ? 0
        : mode === "single_execution_lane"
          ? 1
          : boundedExecutionLaneCount(executionPolicy.factory.maxExecutionLanes),
      source: "execution_policy",
    };
  }

  if (legacyContractForbidsChildren(input.executionContract)) {
    return {
      mode: "same_issue_only",
      maxExecutionLanes: 0,
      source: "legacy_contract_constraint",
    };
  }

  return {
    mode: "direct_execution_lanes",
    maxExecutionLanes: MAX_DIRECT_CHILD_ISSUES_PER_PARENT,
    source: "default",
  };
}

export function assertFactoryExecutionPolicySnapshotPreserved(input: {
  previous: unknown;
  next: unknown;
}) {
  const previous = normalizeIssueExecutionPolicy(input.previous);
  if (!previous?.factory) return;
  const next = normalizeIssueExecutionPolicy(input.next);
  if (
    next?.factory
    && isDeepStrictEqual(
      stripMonitorFromExecutionPolicy(previous),
      stripMonitorFromExecutionPolicy(next),
    )
  ) {
    return;
  }
  throw conflict(
    "The AI Factory execution snapshot is immutable after it is attached to an issue.",
    {
      code: "factory_policy_frozen",
      policyKey: previous.factory.policyKey,
      policyVersion: previous.factory.policyVersion,
      policyHash: previous.factory.policyHash,
    },
  );
}

/**
 * A factory snapshot is compiled against one issue access and project
 * context. Once that snapshot exists (including the transaction that first
 * pins it), moving the control/lane or changing its visibility would detach
 * execution and provider evidence from the boundary that was authorized.
 */
export function assertFactoryIssueAccessBoundaryPreserved(input: {
  existing: {
    projectId: string | null;
    visibility: string;
    executionPolicy: unknown;
  };
  patch: {
    projectId?: string | null;
    visibility?: string;
    executionPolicy?: unknown;
  };
}) {
  const existingPolicy = normalizeIssueExecutionPolicy(input.existing.executionPolicy);
  const proposedPolicy = Object.prototype.hasOwnProperty.call(input.patch, "executionPolicy")
    ? normalizeIssueExecutionPolicy(input.patch.executionPolicy)
    : existingPolicy;
  const factory = existingPolicy?.factory ?? proposedPolicy?.factory;
  if (!factory) return;

  const changedFields: Array<"projectId" | "visibility"> = [];
  if (
    Object.prototype.hasOwnProperty.call(input.patch, "projectId")
    && input.patch.projectId !== input.existing.projectId
  ) {
    changedFields.push("projectId");
  }
  if (
    Object.prototype.hasOwnProperty.call(input.patch, "visibility")
    && input.patch.visibility !== input.existing.visibility
  ) {
    changedFields.push("visibility");
  }
  if (changedFields.length === 0) return;

  throw conflict(
    "The AI Factory project and visibility boundary is immutable after its policy is pinned.",
    {
      code: "factory_access_boundary_frozen",
      fields: changedFields,
      laneKind: factory.laneKind,
      controlIssueId: factory.controlIssueId ?? null,
      policyKey: factory.policyKey,
      policyVersion: factory.policyVersion,
      policyHash: factory.policyHash,
      projectId: input.existing.projectId,
      visibility: input.existing.visibility,
    },
  );
}

async function assertChildIssueCreationAllowed(
  dbOrTx: DbReader,
  companyId: string,
  parentIssueId: string,
  options: { lockParent?: boolean } = {},
) {
  const parentSelection = dbOrTx
    .select({
      id: issues.id,
      companyId: issues.companyId,
      parentId: issues.parentId,
      executionContract: issues.executionContract,
      executionPolicy: issues.executionPolicy,
    })
    .from(issues)
    .where(and(eq(issues.id, parentIssueId), eq(issues.companyId, companyId)));
  const parent = options.lockParent
    ? await parentSelection.for("update").then((rows) => rows[0] ?? null)
    : await parentSelection.then((rows) => rows[0] ?? null);
  if (!parent) throw notFound("Parent issue not found");
  const activeCancelHold = await issueTreeControlService(dbOrTx as unknown as Db).getActiveCancelHoldGate(
    companyId,
    parent.id,
  );
  if (activeCancelHold) {
    throw conflict("Issue creation is blocked by an active subtree cancel hold", {
      code: "issue_tree_cancelled",
      holdId: activeCancelHold.holdId,
      rootIssueId: activeCancelHold.rootIssueId,
      issueId: parent.id,
    });
  }
  if (parent.parentId) {
    throw unprocessable(
      "Execution lanes cannot create sub-issues. Paperclip supports only one child level under a main parent issue.",
    );
  }

  const topology = resolveIssueChildTopologyPolicy(parent);
  if (topology.mode === "same_issue_only") {
    throw unprocessable(
      "This issue's execution contract requires work to stay on the same issue; execution lanes are not allowed.",
      {
        code: "factory_policy_conflict",
        rule: "issue_topology",
        topologyMode: topology.mode,
        policySource: topology.source,
        parentIssueId: parent.id,
      },
    );
  }

  const [{ childCount }] = await dbOrTx
    .select({ childCount: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.parentId, parent.id)));
  if (childCount >= topology.maxExecutionLanes) {
    throw unprocessable(
      `Parent issue already has the maximum ${topology.maxExecutionLanes} direct execution lane${topology.maxExecutionLanes === 1 ? "" : "s"}.`,
      {
        code: "factory_policy_conflict",
        rule: "max_execution_lanes",
        topologyMode: topology.mode,
        maxExecutionLanes: topology.maxExecutionLanes,
        policySource: topology.source,
        parentIssueId: parent.id,
      },
    );
  }

  return parent;
}

async function assertIssueParentUpdateAllowed(
  dbOrTx: DbReader,
  existing: IssueRow,
  nextParentId: string,
  options: { lockRows?: boolean } = {},
) {
  if (nextParentId === existing.id) {
    throw unprocessable("An issue cannot be its own parent");
  }
  const parent = await assertChildIssueCreationAllowed(dbOrTx, existing.companyId, nextParentId, {
    lockParent: options.lockRows,
  });
  const existingPolicy = normalizeIssueExecutionPolicy(existing.executionPolicy);
  const parentPolicy = normalizeIssueExecutionPolicy(parent.executionPolicy);
  if (existingPolicy?.factory || parentPolicy?.factory?.laneKind === "control") {
    throw unprocessable(
      "AI Factory execution-lane topology is server-managed. Use the typed execution-lane route.",
      {
        code: "factory_managed_route_required",
        managedRoute: `POST /api/issues/${nextParentId}/execution-lanes`,
      },
    );
  }

  const childSelection = dbOrTx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, existing.companyId), eq(issues.parentId, existing.id)));
  const children = options.lockRows
    ? await childSelection.for("update")
    : await childSelection;
  if (children.length > 0) {
    throw unprocessable(
      "Main issues with execution lanes cannot become child issues. Paperclip supports only one child level.",
    );
  }
}

type IssueRow = typeof issues.$inferSelect;
type IssueLabelRow = typeof labels.$inferSelect;
type IssueActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
type IssueScheduledRetryRow = {
  runId: string;
  status: "scheduled_retry" | "queued" | "running" | "cancelled";
  agentId: string;
  agentName: string | null;
  retryOfRunId: string | null;
  scheduledRetryAt: Date | null;
  scheduledRetryAttempt: number;
  scheduledRetryReason: string | null;
  retryExhaustedReason?: string | null;
  error?: string | null;
  errorCode?: string | null;
};
type IssueWithLabels = IssueRow & { labels: IssueLabelRow[]; labelIds: string[] };
type IssueWithLabelsAndRun = IssueWithLabels & { activeRun: IssueActiveRunRow | null };
type IssueUserCommentStats = {
  issueId: string;
  myLastCommentAt: Date | null;
  lastExternalCommentAt: Date | null;
};
type IssueReadStat = {
  issueId: string;
  myLastReadAt: Date | null;
};
type IssueLastActivityStat = {
  issueId: string;
  latestCommentAt: Date | null;
  latestLogAt: Date | null;
};
type IssueUserContextInput = {
  createdByUserId: string | null;
  assigneeUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type ProjectGoalReader = Pick<Db, "select">;
type DbReader = Pick<Db, "select">;
const FACTORY_ORCHESTRATION_AUTHORITY = Symbol("paperclip.factory-orchestration-authority");
export const FACTORY_IRREVERSIBLE_ACTION_APPROVAL_TARGET_KEY =
  "ai-factory-production-deployment" as const;

async function assertFactoryIrreversibleActionApproval(input: {
  executor: Db;
  companyId: string;
  issueId: string;
  candidateSha: string | null;
}) {
  if (!input.candidateSha) {
    throw unprocessable(
      "Production deployment approval requires an implementation candidate SHA.",
      {
        code: "factory_irreversible_action_approval_required",
        reason: "missing_candidate",
        targetKey: FACTORY_IRREVERSIBLE_ACTION_APPROVAL_TARGET_KEY,
      },
    );
  }
  const candidates = await input.executor
    .select({
      payload: issueThreadInteractions.payload,
      result: issueThreadInteractions.result,
      resolvedByUserId: issueThreadInteractions.resolvedByUserId,
    })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.kind, "request_confirmation"),
      eq(issueThreadInteractions.status, "accepted"),
    ));
  const accepted = candidates.some((row) => {
    if (!row.resolvedByUserId) return false;
    const payload = requestConfirmationPayloadSchema.safeParse(row.payload);
    const result = requestConfirmationResultSchema.safeParse(row.result);
    if (!payload.success || !result.success || result.data.outcome !== "accepted") return false;
    const target = payload.data.target;
    const reasonKind = payload.data.capabilityPreflight?.reasonKind;
    return target?.type === "custom"
      && target.key === FACTORY_IRREVERSIBLE_ACTION_APPROVAL_TARGET_KEY
      && candidateShasMatch(target.revisionId, input.candidateSha)
      && (reasonKind === "irreversible_action" || reasonKind === "policy_approval");
  });
  if (accepted) return;
  throw unprocessable(
    "A board user must approve this exact production candidate before the deployment stage can start.",
    {
      code: "factory_irreversible_action_approval_required",
      reason: "accepted_board_confirmation_missing",
      targetKey: FACTORY_IRREVERSIBLE_ACTION_APPROVAL_TARGET_KEY,
      candidateSha: input.candidateSha,
      requiredReasonKinds: ["irreversible_action", "policy_approval"],
    },
  );
}

export function authorizeFactoryManagedCreate(policyHash: string, controlIssueId: string) {
  return { token: FACTORY_ORCHESTRATION_AUTHORITY, policyHash, controlIssueId };
}

export function authorizeFactoryManagedPolicyPin(policyHash: string) {
  return { token: FACTORY_ORCHESTRATION_AUTHORITY, policyHash };
}

export function authorizeFactoryManagedTransition(
  expectedStageRevision: number,
  decisionId?: string | null,
) {
  return { token: FACTORY_ORCHESTRATION_AUTHORITY, expectedStageRevision, decisionId };
}

type IssueCreateInput = Omit<typeof issues.$inferInsert, "companyId"> & {
  labelIds?: string[];
  blockedByIssueIds?: string[];
  inheritExecutionWorkspaceFromIssueId?: string | null;
  budgetLimits?: unknown;
  /** Server-internal authorization issued by the typed factory lane route. */
  factoryManagedCreate?: ReturnType<typeof authorizeFactoryManagedCreate>;
};
type IssueChildCreateInput = IssueCreateInput & {
  acceptanceCriteria?: string[];
  blockParentUntilDone?: boolean;
  actorAgentId?: string | null;
  actorUserId?: string | null;
};

type FactoryManagedTransitionAuthorization = {
  token: symbol;
  expectedStageRevision: number;
  decisionId?: string | null;
};

function stageStateWithoutMonitor(input: unknown) {
  const state = parseIssueExecutionState(input);
  if (!state) return null;
  const { monitor: _monitor, ...stageState } = state;
  return stageState;
}

function factoryExecutionStageMutation(input: {
  existing: typeof issues.$inferSelect;
  patch: Partial<typeof issues.$inferInsert>;
}) {
  const statusChanged = input.patch.status !== undefined && input.patch.status !== input.existing.status;
  const agentChanged = input.patch.assigneeAgentId !== undefined
    && input.patch.assigneeAgentId !== input.existing.assigneeAgentId;
  const userChanged = input.patch.assigneeUserId !== undefined
    && input.patch.assigneeUserId !== input.existing.assigneeUserId;
  const stateChanged = input.patch.executionState !== undefined
    && !isDeepStrictEqual(
      stageStateWithoutMonitor(input.patch.executionState),
      stageStateWithoutMonitor(input.existing.executionState),
    );
  return statusChanged || agentChanged || userChanged || stateChanged;
}

function assertFactoryCompletionState(input: {
  policy: NonNullable<ReturnType<typeof normalizeIssueExecutionPolicy>>;
  state: ReturnType<typeof parseIssueExecutionState>;
}) {
  if (input.policy.factory?.laneKind !== "execution") return;
  const state = input.state;
  const requiredStageIds = input.policy.stages.map((stage) => stage.id);
  const completed = new Set(state?.completedStageIds ?? []);
  if (
    !state
    || state.status !== "completed"
    || state.currentStageId !== null
    || requiredStageIds.some((stageId) => !completed.has(stageId))
  ) {
    throw unprocessable(
      "AI Factory execution lanes can only finish through the typed stage transition engine.",
      {
        code: "factory_transition_required",
        missingStageIds: requiredStageIds.filter((stageId) => !completed.has(stageId)),
      },
    );
  }
}

async function assertFactoryControlBlockerEdgesPreserved(input: {
  executor: Db;
  controlIssue: typeof issues.$inferSelect;
  proposedBlockerIssueIds: string[];
}) {
  const controlPolicy = normalizeIssueExecutionPolicy(input.controlIssue.executionPolicy);
  if (controlPolicy?.factory?.laneKind !== "control") return;
  const currentBlockerIds = await input.executor
    .select({ issueId: issueRelations.issueId })
    .from(issueRelations)
    .where(and(
      eq(issueRelations.companyId, input.controlIssue.companyId),
      eq(issueRelations.relatedIssueId, input.controlIssue.id),
      eq(issueRelations.type, "blocks"),
    ))
    .then((rows) => rows.map((row) => row.issueId));
  if (currentBlockerIds.length === 0) return;
  const blockerIssues = await input.executor
    .select({ id: issues.id, parentId: issues.parentId, executionPolicy: issues.executionPolicy })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.controlIssue.companyId),
      inArray(issues.id, currentBlockerIds),
    ));
  const immutableLaneBlockerIds = blockerIssues
    .filter((candidate) => {
      const policy = normalizeIssueExecutionPolicy(candidate.executionPolicy);
      return candidate.parentId === input.controlIssue.id
        && policy?.factory?.laneKind === "execution"
        && policy.factory.controlIssueId === input.controlIssue.id;
    })
    .map((candidate) => candidate.id);
  const proposed = new Set(input.proposedBlockerIssueIds);
  const removed = immutableLaneBlockerIds.filter((issueId) => !proposed.has(issueId));
  if (removed.length > 0) {
    throw conflict("AI Factory lane blocker relations cannot be removed through generic issue mutation.", {
      code: "factory_lane_blocker_frozen",
      controlIssueId: input.controlIssue.id,
      laneIssueIds: removed,
    });
  }
}

async function assertFactoryControlCompletion(input: {
  executor: Db;
  controlIssue: typeof issues.$inferSelect;
}) {
  const controlPolicy = normalizeIssueExecutionPolicy(input.controlIssue.executionPolicy);
  if (controlPolicy?.factory?.laneKind !== "control") return;
  const children = await input.executor
    .select({
      id: issues.id,
      status: issues.status,
      executionPolicy: issues.executionPolicy,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.controlIssue.companyId),
      eq(issues.parentId, input.controlIssue.id),
    ))
    .orderBy(asc(issues.id))
    .for("update");
  const lanes = children.filter((candidate) => {
    const policy = normalizeIssueExecutionPolicy(candidate.executionPolicy);
    return policy?.factory?.laneKind === "execution"
      && policy.factory.controlIssueId === input.controlIssue.id;
  });
  const expectedLaneCount = controlPolicy.factory.policySnapshot?.topology.defaultExecutionLanes ?? 1;
  const unfinishedLaneIds = lanes
    .filter((lane) => lane.status !== "done")
    .map((lane) => lane.id);
  if (lanes.length < expectedLaneCount || unfinishedLaneIds.length > 0) {
    throw unprocessable(
      "AI Factory control issues can only finish after every required execution lane is done.",
      {
        code: "factory_control_incomplete",
        controlIssueId: input.controlIssue.id,
        expectedLaneCount,
        actualLaneCount: lanes.length,
        unfinishedLaneIds,
      },
    );
  }
  const readiness = await listIssueDependencyReadinessMap(
    input.executor,
    input.controlIssue.companyId,
    [input.controlIssue.id],
  ).then((rows) => rows.get(input.controlIssue.id));
  if (readiness && readiness.unresolvedBlockerIssueIds.length > 0) {
    throw unprocessable("AI Factory control issue still has unresolved blockers.", {
      code: "factory_control_incomplete",
      controlIssueId: input.controlIssue.id,
      unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
    });
  }
  if (lanes.length === 0) return;
  for (const lane of [...lanes].sort((left, right) => left.id.localeCompare(right.id))) {
    const lanePolicy = normalizeIssueExecutionPolicy(lane.executionPolicy);
    const laneState = parseIssueExecutionState(lane.executionState);
    if (!lanePolicy || lanePolicy.factory?.laneKind !== "execution" || !laneState) {
      throw unprocessable("AI Factory control issue has a lane without a valid execution snapshot.", {
        code: "factory_control_incomplete",
        controlIssueId: input.controlIssue.id,
        laneIssueId: lane.id,
      });
    }
    await acquireIssueDeliveryLock(input.executor, input.controlIssue.companyId, lane.id);
    const snapshot = await deliveryService(input.executor).getSnapshot(
      input.controlIssue.companyId,
      lane.id,
    );
    const gates = [...new Set(lanePolicy.stages.flatMap((stage) => stage.evidenceGates ?? []))];
    const expectations = buildFactoryDeliveryEvidenceExpectations({
      policy: lanePolicy,
      state: laneState,
      candidateSha: snapshot.candidateSha,
    });
    const missing = evaluateDeliveryEvidenceGates(snapshot, gates, expectations)
      .filter((result) => !result.satisfied);
    if (missing.length > 0) {
      throw unprocessable("AI Factory control issue cannot finish with stale or missing lane delivery evidence.", {
        code: "factory_control_incomplete",
        controlIssueId: input.controlIssue.id,
        laneIssueId: lane.id,
        snapshotRevision: snapshot.revision,
        missing,
      });
    }
  }
  const activeOperationIssueIds = await input.executor
    .select({ issueId: externalOperations.issueId })
    .from(externalOperations)
    .where(and(
      eq(externalOperations.companyId, input.controlIssue.companyId),
      inArray(externalOperations.issueId, lanes.map((lane) => lane.id)),
      isNull(externalOperations.terminalAt),
      notInArray(externalOperations.state, ["succeeded", "failed", "cancelled", "timed_out"]),
    ))
    .then((rows) => [...new Set(rows.map((row) => row.issueId))]);
  if (activeOperationIssueIds.length > 0) {
    throw unprocessable("AI Factory control issue still has active external operations.", {
      code: "factory_control_incomplete",
      controlIssueId: input.controlIssue.id,
      activeOperationIssueIds,
    });
  }
}
type IssueRelationSummaryMap = {
  blockedBy: IssueRelationIssueSummary[];
  blocks: IssueRelationIssueSummary[];
};
export type IssueDependencyReadiness = {
  issueId: string;
  blockerIssueIds: string[];
  unresolvedBlockerIssueIds: string[];
  unresolvedBlockerCount: number;
  allBlockersDone: boolean;
  isDependencyReady: boolean;
};
export type ChildIssueCompletionSummary = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  summary: string | null;
};

function sameRunLock(checkoutRunId: string | null, actorRunId: string | null) {
  if (actorRunId) return checkoutRunId === actorRunId;
  return checkoutRunId == null;
}

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const ISSUE_LIST_DESCRIPTION_MAX_CHARS = 1200;
const ISSUE_LIST_DESCRIPTION_MAX_BYTES = ISSUE_LIST_DESCRIPTION_MAX_CHARS * 4;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function clampIssueListLimit(limit: number): number {
  return Math.min(ISSUE_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function chunkList<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function truncateInlineSummary(value: string | null | undefined, maxChars = CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS) {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]` : normalized;
}

function truncateByCodePoint(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return Array.from(value).slice(0, maxChars).join("");
}

function decodeDatabaseTextPreview(value: string | null | undefined, maxChars: number): string | null {
  if (value == null) return null;
  return truncateByCodePoint(Buffer.from(value, "base64").toString("utf8"), maxChars);
}

function appendAcceptanceCriteriaToDescription(description: string | null | undefined, acceptanceCriteria: string[] | undefined) {
  const criteria = (acceptanceCriteria ?? []).map((item) => item.trim()).filter(Boolean);
  if (criteria.length === 0) return description ?? null;
  const base = description?.trim() ?? "";
  const criteriaMarkdown = ["## Acceptance Criteria", "", ...criteria.map((item) => `- ${item}`)].join("\n");
  return base ? `${base}\n\n${criteriaMarkdown}` : criteriaMarkdown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeExecutionContractValue(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  return isRecord(value) ? value : null;
}

function canonicalizeExecutionContractAlias(
  value: Record<string, unknown>,
  canonical: string,
  legacy: string,
) {
  if (value[canonical] === undefined && value[legacy] !== undefined) {
    value[canonical] = value[legacy];
  }
  delete value[legacy];
}

function canonicalizeExecutionContractAliases(value: Record<string, unknown>) {
  const canonical = { ...value };
  canonicalizeExecutionContractAlias(canonical, "schemaVersion", "schema_version");
  canonicalizeExecutionContractAlias(canonical, "supersedesRevision", "supersedes_revision");
  canonicalizeExecutionContractAlias(canonical, "contractType", "contract_type");
  canonicalizeExecutionContractAlias(canonical, "taskType", "task_type");

  if (isRecord(canonical.core)) {
    const core = { ...canonical.core };
    canonicalizeExecutionContractAlias(core, "sourceOfTruth", "source_of_truth");
    canonicalizeExecutionContractAlias(core, "acceptanceChecks", "acceptance_checks");
    canonicalizeExecutionContractAlias(core, "evidenceRequired", "evidence_required");
    canonicalizeExecutionContractAlias(core, "requiredOutputs", "required_outputs");
    canonicalizeExecutionContractAlias(core, "handoffNotes", "handoff_notes");
    if (isRecord(core.handoffNotes)) {
      const handoffNotes = { ...core.handoffNotes };
      canonicalizeExecutionContractAlias(handoffNotes, "managerReasoning", "manager_reasoning");
      canonicalizeExecutionContractAlias(handoffNotes, "currentBlocker", "current_blocker");
      canonicalizeExecutionContractAlias(handoffNotes, "nextAction", "next_action");
      core.handoffNotes = handoffNotes;
    }
    canonical.core = core;
  }
  return canonical;
}

function executionContractsAreSemanticallyEqual(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
) {
  if (!previous || !next) return previous === next;
  const previousSemantic = canonicalizeExecutionContractAliases(previous);
  const nextSemantic = canonicalizeExecutionContractAliases(next);
  delete previousSemantic.revision;
  delete previousSemantic.supersedesRevision;
  delete nextSemantic.revision;
  delete nextSemantic.supersedesRevision;
  return isDeepStrictEqual(previousSemantic, nextSemantic);
}

function parseExecutionContractValue(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  const parsed = issueExecutionContractSchema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable("Invalid executionContract", {
      code: "invalid_execution_contract_schema",
      issues: parsed.error.issues,
    });
  }
  return canonicalizeExecutionContractAliases(parsed.data);
}

function executionContractRevision(value: Record<string, unknown> | null | undefined) {
  const revision = value?.revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : null;
}

function executionContractSupersedesRevision(value: Record<string, unknown>) {
  const revision = value.supersedesRevision ?? value.supersedes_revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : null;
}

function prepareInitialExecutionContract(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  const requestedRevision = executionContractRevision(value);
  if (requestedRevision !== null && requestedRevision !== 1) {
    throw unprocessable("A new executionContract must start at revision 1", {
      code: "invalid_execution_contract_revision",
      expectedRevision: 1,
      receivedRevision: requestedRevision,
    });
  }
  if (executionContractSupersedesRevision(value) !== null) {
    throw unprocessable("A new executionContract cannot supersede an earlier revision", {
      code: "invalid_execution_contract_revision",
      expectedSupersedesRevision: null,
    });
  }
  const canonical = canonicalizeExecutionContractAliases(value);
  return {
    ...canonical,
    revision: 1,
  };
}

function issueExecutionContractIsFrozen(issue: IssueRow) {
  return Boolean(
    issue.startedAt ||
    issue.checkoutRunId ||
    issue.executionRunId ||
    !["backlog", "todo"].includes(issue.status),
  );
}

function prepareUpdatedExecutionContract(input: {
  existing: IssueRow;
  next: Record<string, unknown> | null;
}): { changed: boolean; value: Record<string, unknown> | null } {
  const previous = normalizeExecutionContractValue(input.existing.executionContract);
  if (executionContractsAreSemanticallyEqual(previous, input.next)) {
    return { changed: false, value: previous };
  }
  if (issueExecutionContractIsFrozen(input.existing)) {
    throw conflict(
      "executionContract is frozen once issue execution begins; create a replacement issue for a superseding contract",
      {
        code: "execution_contract_frozen",
        currentRevision: executionContractRevision(previous) ?? 1,
      },
    );
  }
  if (!input.next) return { changed: true, value: null };
  if (!previous) return { changed: true, value: prepareInitialExecutionContract(input.next) };

  const currentRevision = executionContractRevision(previous) ?? 1;
  const expectedRevision = currentRevision + 1;
  const requestedRevision = executionContractRevision(input.next);
  const requestedSupersedesRevision = executionContractSupersedesRevision(input.next);
  const echoedCurrentRevision = requestedRevision === currentRevision;
  if (
    requestedRevision !== null &&
    requestedRevision !== currentRevision &&
    requestedRevision !== expectedRevision
  ) {
    throw unprocessable("executionContract revision must identify the current or next revision", {
      code: "invalid_execution_contract_revision",
      expectedRevision,
      currentRevision,
      receivedRevision: requestedRevision,
    });
  }
  const previousSupersedesRevision = executionContractSupersedesRevision(previous);
  const expectedRequestedSupersedesRevision = echoedCurrentRevision
    ? previousSupersedesRevision
    : currentRevision;
  if (
    requestedSupersedesRevision !== null &&
    requestedSupersedesRevision !== expectedRequestedSupersedesRevision
  ) {
    throw unprocessable("executionContract supersedesRevision must reference the current revision", {
      code: "invalid_execution_contract_revision",
      expectedSupersedesRevision: expectedRequestedSupersedesRevision,
      receivedSupersedesRevision: requestedSupersedesRevision,
    });
  }
  const next = canonicalizeExecutionContractAliases(input.next);
  delete next.supersedes_revision;
  return {
    changed: true,
    value: {
      ...next,
      revision: expectedRevision,
      supersedesRevision: currentRevision,
    },
  };
}

function extractJsonObjectFromMarkdown(value: string): Record<string, unknown> | null {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? (() => {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    return start >= 0 && end > start ? value.slice(start, end + 1).trim() : "";
  })();
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return normalizeExecutionContractValue(parsed);
  } catch {
    return null;
  }
}

function extractExecutionContractFromDescription(description: string | null | undefined): {
  description: string | null;
  executionContract: Record<string, unknown> | null;
} | null {
  if (typeof description !== "string" || !description.trim()) return null;
  const headingPattern = /^##\s+Execution Contract\s*$/gim;
  const match = headingPattern.exec(description);
  if (!match) return null;

  const sectionStart = (() => {
    const lineEnd = description.indexOf("\n", match.index + match[0].length);
    return lineEnd === -1 ? description.length : lineEnd + 1;
  })();
  const nextHeadingPattern = /^##\s+\S.*$/gm;
  nextHeadingPattern.lastIndex = sectionStart;
  const nextHeading = nextHeadingPattern.exec(description);
  const sectionEnd = nextHeading?.index ?? description.length;
  const sectionBody = description.slice(sectionStart, sectionEnd);
  const executionContract = extractJsonObjectFromMarkdown(sectionBody);
  if (!executionContract) return null;

  return {
    description,
    executionContract,
  };
}

function resolveExecutionContractFields(input: {
  description?: string | null;
  executionContract?: Record<string, unknown> | null;
}): {
  description?: string | null;
  executionContract?: Record<string, unknown> | null;
} {
  const hasDescription = Object.prototype.hasOwnProperty.call(input, "description");
  const extracted = hasDescription ? extractExecutionContractFromDescription(input.description) : null;
  const description = extracted ? extracted.description : input.description;
  if (input.executionContract !== undefined) {
    return {
      ...(hasDescription ? { description } : {}),
      executionContract: parseExecutionContractValue(input.executionContract),
    };
  }
  if (extracted) {
    return {
      description,
      executionContract: parseExecutionContractValue(extracted.executionContract),
    };
  }
  return hasDescription ? { description } : {};
}

export type DelegatedIssueExecutionContractValidation = {
  valid: boolean;
  warnings: string[];
};

function readContractField(record: Record<string, unknown> | null | undefined, ...keys: string[]) {
  if (!record) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function readContractString(record: Record<string, unknown> | null | undefined, ...keys: string[]) {
  const value = readContractField(record, ...keys);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasContractContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasContractContent);
  if (isRecord(value)) return Object.values(value).some(hasContractContent);
  return false;
}

export function validateDelegatedIssueExecutionContract(
  executionContract: Record<string, unknown> | null | undefined,
): DelegatedIssueExecutionContractValidation {
  const warnings: string[] = [];
  if (!executionContract) {
    return {
      valid: false,
      warnings: ["executionContract is required for agent-created child issues"],
    };
  }

  const schemaVersion = readContractField(executionContract, "schemaVersion", "schema_version");
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    warnings.push("executionContract.schemaVersion must be a positive integer");
  }

  if (!readContractString(executionContract, "contractType", "contract_type")) {
    warnings.push("executionContract.contractType is required");
  }
  if (!readContractString(executionContract, "taskType", "task_type")) {
    warnings.push("executionContract.taskType is required");
  }

  const coreValue = readContractField(executionContract, "core");
  if (!isRecord(coreValue)) {
    warnings.push("executionContract.core is required");
    return { valid: false, warnings };
  }

  if (!readContractString(coreValue, "objective")) {
    warnings.push("executionContract.core.objective is required");
  }
  if (!readContractString(coreValue, "why")) {
    warnings.push("executionContract.core.why is required");
  }

  const sourceOfTruth = readContractField(coreValue, "sourceOfTruth", "source_of_truth");
  if (!hasContractContent(sourceOfTruth)) {
    warnings.push("executionContract.core.sourceOfTruth must contain at least one source");
  }

  const acceptanceChecks = readContractField(coreValue, "acceptanceChecks", "acceptance_checks");
  if (!hasContractContent(acceptanceChecks)) {
    warnings.push("executionContract.core.acceptanceChecks must contain at least one check");
  }

  const handoffNotesValue = readContractField(coreValue, "handoffNotes", "handoff_notes");
  const handoffNotes = isRecord(handoffNotesValue) ? handoffNotesValue : null;
  if (!readContractString(handoffNotes, "managerReasoning", "manager_reasoning")) {
    warnings.push("executionContract.core.handoffNotes.managerReasoning is required");
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}

export function assertDelegatedIssueExecutionContract(
  executionContract: Record<string, unknown> | null | undefined,
  input: {
    parentId: string;
    mode?: "enforce";
  },
) {
  const validation = validateDelegatedIssueExecutionContract(executionContract);
  if (validation.valid) return;

  throw unprocessable("Agent-created child issues require a valid executionContract", {
    code: "invalid_execution_contract",
    mode: input.mode ?? "enforce",
    parentId: input.parentId,
    missingExecutionContract: executionContract == null,
    warnings: validation.warnings,
  });
}

function createIssueDependencyReadiness(issueId: string): IssueDependencyReadiness {
  return {
    issueId,
    blockerIssueIds: [],
    unresolvedBlockerIssueIds: [],
    unresolvedBlockerCount: 0,
    allBlockersDone: true,
    isDependencyReady: true,
  };
}

async function listIssueDependencyReadinessMap(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueIds: string[],
) {
  const uniqueIssueIds = [...new Set(issueIds.filter(Boolean))];
  const readinessMap = new Map<string, IssueDependencyReadiness>();
  for (const issueId of uniqueIssueIds) {
    readinessMap.set(issueId, createIssueDependencyReadiness(issueId));
  }
  if (uniqueIssueIds.length === 0) return readinessMap;

  const blockerRows = await dbOrTx
    .select({
      issueId: issueRelations.relatedIssueId,
      blockerIssueId: issueRelations.issueId,
      blockerStatus: issues.status,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, uniqueIssueIds),
      ),
    );

  for (const row of blockerRows) {
    const current = readinessMap.get(row.issueId) ?? createIssueDependencyReadiness(row.issueId);
    current.blockerIssueIds.push(row.blockerIssueId);
    // A blocker resolves its dependents once it reaches a TERMINAL state — done
    // OR cancelled. Previously only "done" cleared a dependent, so cancelling a
    // blocker (a normal way to say "this is no longer needed") left the dependent
    // stranded in `blocked` forever with no obvious recourse — every run,
    // including credential-failover retries, got cancelled by the dependency
    // gate. A cancelled blocker is not coming back, so it should not keep a
    // ready issue (e.g. one that's "Ready to QA") blocked.
    if (row.blockerStatus !== "done" && row.blockerStatus !== "cancelled") {
      current.unresolvedBlockerIssueIds.push(row.blockerIssueId);
      current.unresolvedBlockerCount += 1;
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    }
    readinessMap.set(row.issueId, current);
  }

  return readinessMap;
}

async function listUnresolvedBlockerIssueIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerIssueIds: string[],
) {
  const uniqueBlockerIssueIds = [...new Set(blockerIssueIds.filter(Boolean))];
  if (uniqueBlockerIssueIds.length === 0) return [];
  return dbOrTx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.id, uniqueBlockerIssueIds),
        // Cancelled blockers intentionally remain unresolved until the relation changes.
        ne(issues.status, "done"),
      ),
    )
    .then((rows) => rows.map((row) => row.id));
}
async function getProjectDefaultGoalId(
  db: ProjectGoalReader,
  companyId: string,
  projectId: string | null | undefined,
) {
  if (!projectId) return null;
  const row = await db
    .select({ goalId: projects.goalId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return row?.goalId ?? null;
}

async function getWorkspaceInheritanceIssue(
  db: DbReader,
  companyId: string,
  issueId: string,
) {
  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId,
      executionWorkspaceSettings: issues.executionWorkspaceSettings,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) {
    throw notFound("Workspace inheritance issue not found");
  }
  return issue;
}

function touchedByUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    (
      ${issues.createdByUserId} = ${userId}
      OR ${issues.assigneeUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${issueReadStates}
        WHERE ${issueReadStates.issueId} = ${issues.id}
          AND ${issueReadStates.companyId} = ${companyId}
          AND ${issueReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorUserId} = ${userId}
      )
    )
  `;
}

function participatedByAgentCondition(companyId: string, agentId: string) {
  return sql<boolean>`
    (
      ${issues.createdByAgentId} = ${agentId}
      OR ${issues.assigneeAgentId} = ${agentId}
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorAgentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${activityLog}
        WHERE ${activityLog.companyId} = ${companyId}
          AND ${activityLog.entityType} = 'issue'
          AND ${activityLog.entityId} = ${issues.id}::text
          AND ${activityLog.agentId} = ${agentId}
      )
    )
  `;
}

function myLastCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND ${issueComments.authorUserId} = ${userId}
    )
  `;
}

function myLastReadAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueReadStates.lastReadAt})
      FROM ${issueReadStates}
      WHERE ${issueReadStates.issueId} = ${issues.id}
        AND ${issueReadStates.companyId} = ${companyId}
        AND ${issueReadStates.userId} = ${userId}
    )
  `;
}

function myLastTouchAtExpr(companyId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(companyId, userId);
  const myLastReadAt = myLastReadAtExpr(companyId, userId);
  return sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.createdByUserId} = ${userId} THEN ${issues.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.assigneeUserId} = ${userId} THEN ${issues.updatedAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

function lastExternalCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND (
          ${issueComments.authorUserId} IS NULL
          OR ${issueComments.authorUserId} <> ${userId}
        )
    )
  `;
}

function issueLastActivityAtExpr(companyId: string, userId: string) {
  const lastExternalCommentAt = lastExternalCommentAtExpr(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<Date>`
    GREATEST(
      COALESCE(${lastExternalCommentAt}, to_timestamp(0)),
      CASE
        WHEN ${issues.updatedAt} > COALESCE(${myLastTouchAt}, to_timestamp(0))
        THEN ${issues.updatedAt}
        ELSE to_timestamp(0)
      END
    )
  `;
}

const ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS = [
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
] as const;

function issueLatestCommentAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
    )
  `;
}

function issueLatestLogAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${activityLog.createdAt})
      FROM ${activityLog}
      WHERE ${activityLog.companyId} = ${companyId}
        AND ${activityLog.entityType} = 'issue'
        AND ${activityLog.entityId} = ${issues.id}::text
        AND ${activityLog.action} NOT IN (${sql.join(
          ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
          sql`, `,
        )})
    )
  `;
}

function issueCanonicalLastActivityAtExpr(companyId: string) {
  const latestCommentAt = issueLatestCommentAtExpr(companyId);
  const latestLogAt = issueLatestLogAtExpr(companyId);
  return sql<Date>`
    GREATEST(
      ${issues.updatedAt},
      COALESCE(${latestCommentAt}, to_timestamp(0)),
      COALESCE(${latestLogAt}, to_timestamp(0))
    )
  `;
}

function unreadForUserCondition(companyId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND (
            ${issueComments.authorUserId} IS NULL
            OR ${issueComments.authorUserId} <> ${userId}
          )
          AND ${issueComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

function inboxVisibleForUserCondition(companyId: string, userId: string) {
  const issueLastActivityAt = issueLastActivityAtExpr(companyId, userId);
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM ${issueInboxArchives}
      WHERE ${issueInboxArchives.issueId} = ${issues.id}
        AND ${issueInboxArchives.companyId} = ${companyId}
        AND ${issueInboxArchives.userId} = ${userId}
        AND ${issueInboxArchives.archivedAt} >= ${issueLastActivityAt}
    )
  `;
}

function nonPluginOperationIssueCondition() {
  return sql<boolean>`NOT (${issues.originKind} LIKE 'plugin:%:operation' OR ${issues.originKind} LIKE 'plugin:%:operation:%')`;
}

function shouldIncludePluginOperationIssues(filters: IssueFilters | undefined) {
  return Boolean(
    filters?.includePluginOperations ||
    filters?.originKind ||
    filters?.originId ||
    filters?.projectId,
  );
}

/** Named entities commonly emitted in saved issue bodies; unknown `&name;` sequences are left unchanged. */
const WELL_KNOWN_NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  copy: "\u00A9",
  gt: ">",
  lt: "<",
  nbsp: "\u00A0",
  quot: '"',
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
};

function decodeNumericHtmlEntity(digits: string, radix: 16 | 10): string | null {
  const n = Number.parseInt(digits, radix);
  if (Number.isNaN(n) || n < 0 || n > 0x10ffff) return null;
  try {
    return String.fromCodePoint(n);
  } catch {
    return null;
  }
}

/** Decodes HTML character references in a raw @mention capture so UI-encoded bodies match agent names. */
export function normalizeAgentMentionToken(raw: string): string {
  let s = raw.replace(/&#x([0-9a-fA-F]+);/gi, (full, hex: string) => decodeNumericHtmlEntity(hex, 16) ?? full);
  s = s.replace(/&#([0-9]+);/g, (full, dec: string) => decodeNumericHtmlEntity(dec, 10) ?? full);
  s = s.replace(/&([a-z][a-z0-9]*);/gi, (full, name: string) => {
    const decoded = WELL_KNOWN_NAMED_HTML_ENTITIES[name.toLowerCase()];
    return decoded !== undefined ? decoded : full;
  });
  return s.trim();
}

export function deriveIssueUserContext(
  issue: IssueUserContextInput,
  userId: string,
  stats:
    | {
      myLastCommentAt: Date | string | null;
      myLastReadAt: Date | string | null;
      lastExternalCommentAt: Date | string | null;
    }
    | null
    | undefined,
) {
  const normalizeDate = (value: Date | string | null | undefined) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const myLastCommentAt = normalizeDate(stats?.myLastCommentAt);
  const myLastReadAt = normalizeDate(stats?.myLastReadAt);
  const createdTouchAt = issue.createdByUserId === userId ? normalizeDate(issue.createdAt) : null;
  const assignedTouchAt = issue.assigneeUserId === userId ? normalizeDate(issue.updatedAt) : null;
  const myLastTouchAt = [myLastCommentAt, myLastReadAt, createdTouchAt, assignedTouchAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastExternalCommentAt = normalizeDate(stats?.lastExternalCommentAt);
  const isUnreadForMe = Boolean(
    myLastTouchAt &&
    lastExternalCommentAt &&
    lastExternalCommentAt.getTime() > myLastTouchAt.getTime(),
  );

  return {
    myLastTouchAt,
    lastExternalCommentAt,
    isUnreadForMe,
  };
}

function latestIssueActivityAt(...values: Array<Date | string | null | undefined>): Date | null {
  const normalized = values
    .map((value) => {
      if (!value) return null;
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime());
  return normalized[0] ?? null;
}

function rowsFromDbExecuteResult<T>(result: unknown): T[] {
  if (!result) return [];
  if (Array.isArray(result)) return result as T[];

  if (typeof result === "object" && "rows" in result) {
    const rowsValue = (result as { rows?: unknown }).rows;
    if (Array.isArray(rowsValue)) return rowsValue as T[];
  }

  if (
    typeof result === "object" &&
    typeof (result as Iterable<T>)[Symbol.iterator] === "function"
  ) {
    return Array.from(result as Iterable<T>);
  }
  return [];
}

async function labelMapForIssues(dbOrTx: any, issueIds: string[]): Promise<Map<string, IssueLabelRow[]>> {
  const map = new Map<string, IssueLabelRow[]>();
  if (issueIds.length === 0) return map;
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueLabels.issueId,
        label: labels,
      })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(inArray(issueLabels.issueId, issueIdChunk))
      .orderBy(asc(labels.name), asc(labels.id));

    for (const row of rows) {
      const existing = map.get(row.issueId);
      if (existing) existing.push(row.label);
      else map.set(row.issueId, [row.label]);
    }
  }
  return map;
}

async function withIssueLabels(dbOrTx: any, rows: IssueRow[]): Promise<IssueWithLabels[]> {
  if (rows.length === 0) return [];
  const labelsByIssueId = await labelMapForIssues(dbOrTx, rows.map((row) => row.id));
  return rows.map((row) => {
    const issueLabels = labelsByIssueId.get(row.id) ?? [];
    return {
      ...row,
      labels: issueLabels,
      labelIds: issueLabels.map((label) => label.id),
    };
  });
}

const ACTIVE_RUN_STATUSES = ["queued", "running"];
const BLOCKER_ATTENTION_ACTIVE_RUN_STATUSES = ["queued", "running"];
const BLOCKER_ATTENTION_ACTIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution"];
const BLOCKER_ATTENTION_PENDING_INTERACTION_STATUSES = ["pending"];
const BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"];
const BLOCKER_ATTENTION_OPEN_RECOVERY_ORIGIN_KIND = "harness_liveness_escalation";
const PRODUCTIVITY_REVIEW_ORIGIN_KIND = "issue_productivity_review";
const PRODUCTIVITY_REVIEW_TERMINAL_STATUSES = ["done", "cancelled"];
const PRODUCTIVITY_REVIEW_ACTIVITY_ACTIONS = [
  "issue.productivity_review_created",
  "issue.productivity_review_updated",
];
const PRODUCTIVITY_REVIEW_TRIGGERS: readonly IssueProductivityReviewTrigger[] = [
  "no_comment_streak",
  "long_active_duration",
  "high_churn",
];
const BLOCKER_ATTENTION_OPEN_RECOVERY_TERMINAL_STATUSES = ["done", "cancelled"];
const BLOCKER_ATTENTION_MAX_DEPTH = 8;
const BLOCKER_ATTENTION_MAX_NODES = 2000;
const BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);

type IssueBlockerAttentionNode = {
  id: string;
  companyId: string;
  parentId: string | null;
  identifier: string | null;
  title: string;
  status: string;
  executionRunId?: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};
type IssueBlockerAttentionInputNode =
  Pick<
    IssueBlockerAttentionNode,
    "id" | "companyId" | "parentId" | "identifier" | "title" | "status" | "assigneeAgentId" | "assigneeUserId"
  >
  & { executionRunId?: string | null };

type IssueBlockerAttentionEdge = {
  issueId: string;
  blockerIssueId: string;
};
type IssueBlockerAttentionQueryRow = IssueBlockerAttentionNode & {
  issueId: string | null;
  blockerIssueId: string;
};
type IssueBlockerAttentionActivePathRow = {
  issueId: string | null;
};
type IssueBlockerAttentionAgentRow = {
  id: string;
  companyId: string;
  status: string;
};

async function activeRunMapForIssues(
  dbOrTx: any,
  issueRows: IssueWithLabels[],
): Promise<Map<string, IssueActiveRunRow>> {
  const map = new Map<string, IssueActiveRunRow>();
  const runIds = issueRows
    .map((row) => row.executionRunId)
    .filter((id): id is string => id != null);
  if (runIds.length === 0) return map;

  for (const runIdChunk of chunkList([...new Set(runIds)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.id, runIdChunk),
          inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );

    for (const row of rows) {
      map.set(row.id, row);
    }
  }
  return map;
}

async function actualAiSecondsMapForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const uniqueIssueIds = [...new Set(issueIds.filter(Boolean))];
  if (uniqueIssueIds.length === 0) return map;

  const issueIdExpr = sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
  const runSecondsExpr = sql<number>`
    CASE
      WHEN COALESCE(${heartbeatRuns.startedAt}, ${heartbeatRuns.processStartedAt}) IS NULL THEN 0
      ELSE GREATEST(
        0,
        EXTRACT(EPOCH FROM (
          COALESCE(
            ${heartbeatRuns.finishedAt},
            CASE
              WHEN ${heartbeatRuns.status} IN ('queued', 'running') THEN now()
              ELSE ${heartbeatRuns.updatedAt}
            END,
            ${heartbeatRuns.updatedAt},
            ${heartbeatRuns.createdAt}
          )
          - COALESCE(${heartbeatRuns.startedAt}, ${heartbeatRuns.processStartedAt})
        ))
      )
    END
  `;

  for (const issueIdChunk of chunkList(uniqueIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueIdExpr,
        seconds: sql<number>`COALESCE(SUM(${runSecondsExpr}), 0)::int`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(issueIdExpr, issueIdChunk),
        ),
      )
      .groupBy(issueIdExpr);

    for (const row of rows) {
      if (!row.issueId) continue;
      map.set(row.issueId, Number(row.seconds ?? 0));
    }
  }

  return map;
}

async function actualHumanSecondsMapForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const uniqueIssueIds = [...new Set(issueIds.filter(Boolean))];
  if (uniqueIssueIds.length === 0) return map;

  const stopAtExpr = sql<Date>`
    CASE
      WHEN ${issues.status} IN ('done', 'cancelled') THEN COALESCE(
        (
          SELECT MIN(${activityLog.createdAt})
          FROM ${activityLog}
          WHERE ${activityLog.companyId} = ${companyId}
            AND ${activityLog.entityType} = 'issue'
            AND ${activityLog.entityId} = ${issues.id}::text
            AND ${activityLog.action} = 'issue.updated'
            AND ${activityLog.details}->>'status' IN ('done', 'cancelled')
            AND ${activityLog.createdAt} >= COALESCE(
              (
                SELECT MAX(open_activity.created_at)
                FROM activity_log AS open_activity
                WHERE open_activity.company_id = ${companyId}
                  AND open_activity.entity_type = 'issue'
                  AND open_activity.entity_id = ${issues.id}::text
                  AND open_activity.action = 'issue.updated'
                  AND open_activity.details->>'status' NOT IN ('done', 'cancelled')
                  AND open_activity.created_at >= ${issues.createdAt}
              ),
              ${issues.createdAt}
            )
        ),
        ${issues.completedAt},
        ${issues.cancelledAt},
        ${issues.updatedAt},
        now()
      )
      ELSE now()
    END
  `;

  const lifecycleSecondsExpr = sql<number>`
    GREATEST(
      0,
      EXTRACT(EPOCH FROM (
        ${stopAtExpr} - ${issues.createdAt}
      ))
    )
  `;

  for (const issueIdChunk of chunkList(uniqueIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issues.id,
        seconds: sql<number>`COALESCE(${lifecycleSecondsExpr}, 0)::int`,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.id, issueIdChunk),
        ),
      );

    for (const row of rows) {
      map.set(row.issueId, Number(row.seconds ?? 0));
    }
  }

  return map;
}

function createIssueBlockerAttention(input: Partial<IssueBlockerAttention> = {}): IssueBlockerAttention {
  return {
    state: input.state ?? "none",
    reason: input.reason ?? null,
    unresolvedBlockerCount: input.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: input.coveredBlockerCount ?? 0,
    stalledBlockerCount: input.stalledBlockerCount ?? 0,
    attentionBlockerCount: input.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: input.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier: input.sampleStalledBlockerIdentifier ?? null,
  };
}

function blockerSampleIdentifier(node: IssueBlockerAttentionNode | null | undefined) {
  return node?.identifier ?? node?.id ?? null;
}

function appendBlockerAttentionEdges(
  edgesByIssueId: Map<string, IssueBlockerAttentionEdge[]>,
  rows: IssueBlockerAttentionEdge[],
) {
  for (const row of rows) {
    const existing = edgesByIssueId.get(row.issueId) ?? [];
    if (!existing.some((edge) => edge.blockerIssueId === row.blockerIssueId)) {
      existing.push(row);
      edgesByIssueId.set(row.issueId, existing);
    }
  }
}

type IssueRelationSummaryRow = {
  relatedId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

function summarizeIssueRelationRow(row: IssueRelationSummaryRow): IssueRelationIssueSummary {
  return {
    id: row.relatedId,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueRelationIssueSummary["status"],
    priority: row.priority as IssueRelationIssueSummary["priority"],
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
  };
}

async function terminalExplicitBlockersByRoot(
  companyId: string,
  roots: IssueRelationIssueSummary[],
  dbOrTx: DbReader,
): Promise<Map<string, IssueRelationIssueSummary[]>> {
  const rootIds = [...new Set(roots.map((root) => root.id))];
  const terminalByRoot = new Map<string, IssueRelationIssueSummary[]>();
  if (rootIds.length === 0) return terminalByRoot;

  const nodesById = new Map<string, IssueRelationIssueSummary>();
  const edgesByIssueId = new Map<string, string[]>();
  for (const root of roots) nodesById.set(root.id, root);

  let frontier = rootIds;
  for (let depth = 0; frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextFrontier = new Set<string>();
    for (const chunk of chunkList([...new Set(frontier)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const rows = await dbOrTx
        .select({
          currentIssueId: issueRelations.relatedIssueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, chunk),
            eq(issues.companyId, companyId),
            ne(issues.status, "done"),
          ),
        );

      for (const row of rows) {
        const existingEdges = edgesByIssueId.get(row.currentIssueId) ?? [];
        if (!existingEdges.includes(row.relatedId)) {
          existingEdges.push(row.relatedId);
          edgesByIssueId.set(row.currentIssueId, existingEdges);
        }
        if (!nodesById.has(row.relatedId)) {
          nodesById.set(row.relatedId, summarizeIssueRelationRow(row));
          nextFrontier.add(row.relatedId);
        }
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) break;
    frontier = [...nextFrontier];
  }

  const collectTerminal = (issueId: string, seen: Set<string>): IssueRelationIssueSummary[] => {
    if (seen.has(issueId)) return [];
    const node = nodesById.get(issueId);
    if (!node || node.status === "done") return [];
    const nextSeen = new Set(seen);
    nextSeen.add(issueId);
    const downstreamIds = edgesByIssueId.get(issueId) ?? [];
    if (downstreamIds.length === 0) return [node];
    return downstreamIds.flatMap((downstreamId) => collectTerminal(downstreamId, nextSeen));
  };

  for (const rootId of rootIds) {
    const deduped = new Map<string, IssueRelationIssueSummary>();
    for (const blocker of collectTerminal(rootId, new Set())) {
      if (blocker.id !== rootId) deduped.set(blocker.id, blocker);
    }
    if (deduped.size > 0) {
      terminalByRoot.set(rootId, [...deduped.values()].sort((a, b) => a.title.localeCompare(b.title)));
    }
  }

  return terminalByRoot;
}

function readProductivityReviewTrigger(value: unknown): IssueProductivityReviewTrigger | null {
  if (typeof value !== "string") return null;
  return PRODUCTIVITY_REVIEW_TRIGGERS.includes(value as IssueProductivityReviewTrigger)
    ? (value as IssueProductivityReviewTrigger)
    : null;
}

function readProductivityReviewStreak(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

async function listIssueProductivityReviewMap(
  dbOrTx: any,
  companyId: string,
  sourceIssueIds: string[],
): Promise<Map<string, IssueProductivityReview>> {
  const map = new Map<string, IssueProductivityReview>();
  if (sourceIssueIds.length === 0) return map;

  const reviewRows: Array<{
    sourceIssueId: string | null;
    reviewIssueId: string;
    reviewIdentifier: string | null;
    status: string;
    priority: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  for (const chunk of chunkList([...new Set(sourceIssueIds)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        sourceIssueId: issues.originId,
        reviewIssueId: issues.id,
        reviewIdentifier: issues.identifier,
        status: issues.status,
        priority: issues.priority,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          inArray(issues.originId, chunk),
          isNull(issues.hiddenAt),
          notInArray(issues.status, PRODUCTIVITY_REVIEW_TERMINAL_STATUSES),
        ),
      )
      .orderBy(desc(issues.createdAt), desc(issues.id));
    reviewRows.push(...rows);
  }

  if (reviewRows.length === 0) return map;

  const reviewIssueIds = reviewRows.map((row) => row.reviewIssueId);
  const triggerByReviewIssueId = new Map<
    string,
    { trigger: IssueProductivityReviewTrigger | null; noCommentStreak: number | null }
  >();
  for (const chunk of chunkList(reviewIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const detailRows = await dbOrTx
      .select({
        entityId: activityLog.entityId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          inArray(activityLog.entityId, chunk),
          inArray(activityLog.action, PRODUCTIVITY_REVIEW_ACTIVITY_ACTIONS),
        ),
      )
      .orderBy(desc(activityLog.createdAt));
    for (const row of detailRows as Array<{
      entityId: string;
      details: Record<string, unknown> | null;
      createdAt: Date;
    }>) {
      if (triggerByReviewIssueId.has(row.entityId)) continue;
      triggerByReviewIssueId.set(row.entityId, {
        trigger: readProductivityReviewTrigger(row.details?.trigger),
        noCommentStreak: readProductivityReviewStreak(row.details?.noCommentStreak),
      });
    }
  }

  for (const row of reviewRows) {
    if (!row.sourceIssueId) continue;
    if (map.has(row.sourceIssueId)) continue;
    const detail = triggerByReviewIssueId.get(row.reviewIssueId);
    map.set(row.sourceIssueId, {
      reviewIssueId: row.reviewIssueId,
      reviewIdentifier: row.reviewIdentifier,
      status: row.status as IssueProductivityReview["status"],
      priority: row.priority as IssueProductivityReview["priority"],
      trigger: detail?.trigger ?? null,
      noCommentStreak: detail?.noCommentStreak ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  return map;
}

async function listIssueBlockerAttentionMap(
  dbOrTx: any,
  companyId: string,
  issueRows: IssueBlockerAttentionInputNode[],
): Promise<Map<string, IssueBlockerAttention>> {
  const roots = issueRows.filter((row) => row.companyId === companyId && row.status === "blocked");
  const attentionMap = new Map<string, IssueBlockerAttention>();
  for (const row of issueRows) {
    if (row.status !== "blocked") {
      attentionMap.set(row.id, createIssueBlockerAttention());
    }
  }
  if (roots.length === 0) return attentionMap;

  const nodesById = new Map<string, IssueBlockerAttentionNode>();
  const edgesByIssueId = new Map<string, IssueBlockerAttentionEdge[]>();
  for (const root of roots) nodesById.set(root.id, { ...root });

  let frontier = roots.map((root) => root.id);
  let truncated = false;
  for (let depth = 0; frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextFrontier = new Set<string>();

    for (const chunk of chunkList([...new Set(frontier)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const explicitBlockerRowsPromise: Promise<IssueBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          issueId: issueRelations.relatedIssueId,
          blockerIssueId: issues.id,
          id: issues.id,
          companyId: issues.companyId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          executionRunId: issues.executionRunId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, chunk),
            eq(issues.companyId, companyId),
            ne(issues.status, "done"),
          ),
        );
      const childRowsPromise: Promise<IssueBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          issueId: issues.parentId,
          blockerIssueId: issues.id,
          id: issues.id,
          companyId: issues.companyId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          executionRunId: issues.executionRunId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.parentId, chunk),
            ne(issues.status, "done"),
          ),
        );
      const [explicitBlockerRows, childRows] = await Promise.all([
        explicitBlockerRowsPromise,
        childRowsPromise,
      ]);

      appendBlockerAttentionEdges(edgesByIssueId, [
        ...explicitBlockerRows
          .filter((row): row is IssueBlockerAttentionQueryRow & { issueId: string } => row.issueId !== null)
          .map((row) => ({ issueId: row.issueId, blockerIssueId: row.blockerIssueId })),
        ...childRows
          .filter((row): row is IssueBlockerAttentionQueryRow & { issueId: string } => row.issueId !== null)
          .map((row) => ({ issueId: row.issueId, blockerIssueId: row.blockerIssueId })),
      ]);

      for (const row of [...explicitBlockerRows, ...childRows]) {
        if (!row.issueId || nodesById.has(row.blockerIssueId)) continue;
        nodesById.set(row.blockerIssueId, {
          id: row.blockerIssueId,
          companyId: row.companyId,
          parentId: row.parentId,
          identifier: row.identifier,
          title: row.title,
          status: row.status,
          executionRunId: row.executionRunId,
          assigneeAgentId: row.assigneeAgentId,
          assigneeUserId: row.assigneeUserId,
        });
        nextFrontier.add(row.blockerIssueId);
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) {
      truncated = true;
      break;
    }
    frontier = [...nextFrontier];
  }
  if (frontier.length > 0) truncated = true;

  const nodeIds = [...nodesById.keys()];
  const activeIssueIds = new Set<string>();
  const agentIds = new Set<string>();
  const issueIdByExecutionRunId = new Map<string, string>();
  for (const node of nodesById.values()) {
    if (node.assigneeAgentId) agentIds.add(node.assigneeAgentId);
    if (node.executionRunId) issueIdByExecutionRunId.set(node.executionRunId, node.id);
  }

  for (const chunk of chunkList([...issueIdByExecutionRunId.keys()], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const runRows: Array<{ id: string }> = await dbOrTx
      .select({
        id: heartbeatRuns.id,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, BLOCKER_ATTENTION_ACTIVE_RUN_STATUSES),
          inArray(heartbeatRuns.id, chunk),
        ),
      );

    for (const row of runRows) {
      const issueId = issueIdByExecutionRunId.get(row.id);
      if (issueId) activeIssueIds.add(issueId);
    }
  }

  for (const chunk of chunkList(nodeIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const wakeRowsPromise: Promise<IssueBlockerAttentionActivePathRow[]> = dbOrTx
      .select({
        issueId: sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, BLOCKER_ATTENTION_ACTIVE_WAKE_STATUSES),
          sql`${agentWakeupRequests.runId} is null`,
          inArray(sql<string>`${agentWakeupRequests.payload} ->> 'issueId'`, chunk),
        ),
      );
    const wakeRows = await wakeRowsPromise;
    for (const row of wakeRows) {
      if (row.issueId) activeIssueIds.add(row.issueId);
    }
  }

  const explicitWaitCandidateIds = [...nodesById.values()]
    .filter((node) => node.status !== "done")
    .map((node) => node.id);
  const explicitWaitingIssueIds = new Set<string>();
  if (explicitWaitCandidateIds.length > 0) {
    for (const chunk of chunkList(explicitWaitCandidateIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const interactionRows: Array<{ issueId: string }> = await dbOrTx
        .select({ issueId: issueThreadInteractions.issueId })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.status, BLOCKER_ATTENTION_PENDING_INTERACTION_STATUSES),
            inArray(issueThreadInteractions.issueId, chunk),
          ),
        );
      for (const row of interactionRows) explicitWaitingIssueIds.add(row.issueId);

      const approvalRows: Array<{ issueId: string }> = await dbOrTx
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(issueApprovals.companyId, companyId),
            inArray(approvals.status, BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES),
            inArray(issueApprovals.issueId, chunk),
          ),
        );
      for (const row of approvalRows) explicitWaitingIssueIds.add(row.issueId);
    }

    // Recovery rows are intentionally company-wide: a liveness escalation for
    // the same leaf blocker represents an active waiting path even when that
    // blocker is reached through another blocked graph.
    const recoveryRows: Array<{ id: string; originId: string | null }> = await dbOrTx
      .select({ id: issues.id, originId: issues.originId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, BLOCKER_ATTENTION_OPEN_RECOVERY_ORIGIN_KIND),
          isNull(issues.hiddenAt),
          notInArray(issues.status, BLOCKER_ATTENTION_OPEN_RECOVERY_TERMINAL_STATUSES),
        ),
      );
    for (const row of recoveryRows) {
      const parsed = parseIssueGraphLivenessIncidentKey(row.originId);
      if (!parsed || parsed.companyId !== companyId) continue;
      explicitWaitingIssueIds.add(row.id);
      explicitWaitingIssueIds.add(parsed.issueId);
      explicitWaitingIssueIds.add(parsed.leafIssueId);
    }

    const recoveryActionRows: Array<{ sourceIssueId: string }> = await dbOrTx
      .select({ sourceIssueId: issueRecoveryActions.sourceIssueId })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          inArray(issueRecoveryActions.sourceIssueId, explicitWaitCandidateIds),
        ),
      );
    for (const row of recoveryActionRows) explicitWaitingIssueIds.add(row.sourceIssueId);
  }

  const agentRows: IssueBlockerAttentionAgentRow[] = agentIds.size > 0
    ? await dbOrTx
        .select({
          id: agents.id,
          companyId: agents.companyId,
          status: agents.status,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...agentIds])))
    : [];
  const agentsById = new Map(agentRows.map((agent) => [agent.id, agent]));

  type PathClassification = {
    covered: boolean;
    stalled: boolean;
    sampleBlockerIdentifier: string | null;
    sampleStalledBlockerIdentifier: string | null;
  };
  const classifyPath = (
    nodeId: string,
    seen: Set<string>,
  ): PathClassification => {
    const sample = blockerSampleIdentifier(nodesById.get(nodeId));
    if (truncated || seen.has(nodeId)) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: sample, sampleStalledBlockerIdentifier: null };
    }
    const node = nodesById.get(nodeId);
    if (!node || node.companyId !== companyId) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeId, sampleStalledBlockerIdentifier: null };
    }
    const nodeSample = blockerSampleIdentifier(node);
    if (node.status === "done") {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (explicitWaitingIssueIds.has(node.id)) {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.assigneeUserId && node.status !== "cancelled") {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.status === "in_review") {
      const hasWaitingPath = activeIssueIds.has(node.id) || Boolean(node.assigneeUserId);
      if (hasWaitingPath) {
        return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
      }
      return { covered: false, stalled: true, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: nodeSample };
    }
    if (activeIssueIds.has(node.id)) {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.status === "cancelled") {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.status === "backlog" && node.assigneeAgentId) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }

    const downstream = (edgesByIssueId.get(node.id) ?? []).filter((edge) => nodesById.get(edge.blockerIssueId)?.status !== "done");
    if (downstream.length > 0) {
      const nextSeen = new Set(seen);
      nextSeen.add(nodeId);
      const classified = downstream.map((edge) => classifyPath(edge.blockerIssueId, nextSeen));
      const stalledChild = classified.find((result) => result.stalled || result.sampleStalledBlockerIdentifier);
      const sampleStalled = stalledChild?.sampleStalledBlockerIdentifier ?? null;
      const hardAttention = classified.find((result) => !result.covered && !result.stalled);
      if (hardAttention) {
        return {
          covered: false,
          stalled: false,
          sampleBlockerIdentifier: hardAttention.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      const stalledEntry = classified.find((result) => result.stalled);
      if (stalledEntry) {
        return {
          covered: false,
          stalled: true,
          sampleBlockerIdentifier: stalledEntry.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: classified[0]?.sampleBlockerIdentifier ?? nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }

    if (node.assigneeAgentId) {
      const assignee = agentsById.get(node.assigneeAgentId);
      if (!assignee || assignee.companyId !== companyId || !BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES.has(assignee.status)) {
        return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
      }
    }

    return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
  };

  for (const root of roots) {
    const topLevelEdges = (edgesByIssueId.get(root.id) ?? []).filter((edge) => nodesById.get(edge.blockerIssueId)?.status !== "done");
    if (topLevelEdges.length === 0) {
      attentionMap.set(root.id, createIssueBlockerAttention({
        state: "needs_attention",
        reason: "attention_required",
      }));
      continue;
    }

    const classified = topLevelEdges.map((edge) => ({
      edge,
      result: classifyPath(edge.blockerIssueId, new Set([root.id])),
    }));
    const coveredBlockerCount = classified.filter((entry) => entry.result.covered).length;
    const stalledBlockerCount = classified.filter((entry) => entry.result.stalled).length;
    const attentionBlockerCount = classified.length - coveredBlockerCount - stalledBlockerCount;
    const hardAttentionEntry = classified.find((entry) => !entry.result.covered && !entry.result.stalled);
    const stalledEntry = classified.find((entry) => entry.result.stalled);
    const sampleEntry = hardAttentionEntry ?? stalledEntry ?? classified[0] ?? null;
    const sampleNode = sampleEntry ? nodesById.get(sampleEntry.edge.blockerIssueId) : null;
    const sampleStalledFromChain = classified
      .map((entry) => entry.result.sampleStalledBlockerIdentifier)
      .find((value) => value);

    let state: IssueBlockerAttention["state"];
    let reason: IssueBlockerAttention["reason"];
    if (attentionBlockerCount > 0) {
      state = "needs_attention";
      reason = "attention_required";
    } else if (stalledBlockerCount > 0) {
      state = "stalled";
      reason = "stalled_review";
    } else {
      state = "covered";
      reason = topLevelEdges.every((edge) => nodesById.get(edge.blockerIssueId)?.parentId === root.id)
        ? "active_child"
        : "active_dependency";
    }

    attentionMap.set(root.id, createIssueBlockerAttention({
      state,
      reason,
      unresolvedBlockerCount: topLevelEdges.length,
      coveredBlockerCount,
      stalledBlockerCount,
      attentionBlockerCount,
      sampleBlockerIdentifier: sampleEntry?.result.sampleBlockerIdentifier ?? blockerSampleIdentifier(sampleNode),
      sampleStalledBlockerIdentifier:
        stalledEntry?.result.sampleStalledBlockerIdentifier ?? sampleStalledFromChain ?? null,
    }));
  }

  return attentionMap;
}

const issueListSelect = {
  id: issues.id,
  companyId: issues.companyId,
  projectId: issues.projectId,
  cycleId: issues.cycleId,
  projectWorkspaceId: issues.projectWorkspaceId,
  goalId: issues.goalId,
  parentId: issues.parentId,
  title: issues.title,
  description: sql<string | null>`
    CASE
      WHEN ${issues.description} IS NULL THEN NULL
      ELSE encode(
        substring(
          convert_to(${issues.description}, current_setting('server_encoding'))
          FROM 1 FOR ${ISSUE_LIST_DESCRIPTION_MAX_BYTES}
        ),
        'base64'
      )
    END
  `,
  status: issues.status,
  workMode: issues.workMode,
  workItemType: issues.workItemType,
  priority: issues.priority,
  assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId,
  checkoutRunId: issues.checkoutRunId,
  executionRunId: issues.executionRunId,
  executionAgentNameKey: issues.executionAgentNameKey,
  executionLockedAt: issues.executionLockedAt,
  createdByAgentId: issues.createdByAgentId,
  createdByUserId: issues.createdByUserId,
  issueNumber: issues.issueNumber,
  identifier: issues.identifier,
  originKind: issues.originKind,
  originId: issues.originId,
  originRunId: issues.originRunId,
  originFingerprint: issues.originFingerprint,
  requestDepth: issues.requestDepth,
  billingCode: issues.billingCode,
  assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
  executionContract: sql<null>`null`,
  executionPolicy: sql<null>`null`,
  executionState: sql<null>`null`,
  monitorNextCheckAt: issues.monitorNextCheckAt,
  monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
  monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
  monitorAttemptCount: issues.monitorAttemptCount,
  monitorNotes: issues.monitorNotes,
  monitorScheduledBy: issues.monitorScheduledBy,
  executionWorkspaceId: issues.executionWorkspaceId,
  executionWorkspacePreference: issues.executionWorkspacePreference,
  executionWorkspaceSettings: sql<null>`null`,
  visibility: issues.visibility,
  dueDate: issues.dueDate,
  workLeadDays: issues.workLeadDays,
  storyPoints: issues.storyPoints,
  estimateHours: issues.estimateHours,
  actualHumanSeconds: issues.actualHumanSeconds,
  startedAt: issues.startedAt,
  completedAt: issues.completedAt,
  cancelledAt: issues.cancelledAt,
  hiddenAt: issues.hiddenAt,
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
};
const { workItemType: _workItemType, ...issueListSelectWithoutWorkItemType } = issueListSelect;

function withActiveRuns(
  issueRows: IssueWithLabels[],
  runMap: Map<string, IssueActiveRunRow>,
): IssueWithLabelsAndRun[] {
  return issueRows.map((row) => ({
    ...row,
    activeRun: row.executionRunId ? (runMap.get(row.executionRunId) ?? null) : null,
  }));
}

async function userCommentStatsForIssues(
  dbOrTx: any,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<IssueUserCommentStats[]> {
  const stats: IssueUserCommentStats[] = [];
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueComments.issueId,
        myLastCommentAt: sql<Date | null>`
          MAX(CASE WHEN ${issueComments.authorUserId} = ${userId} THEN ${issueComments.createdAt} END)
        `,
        lastExternalCommentAt: sql<Date | null>`
          MAX(
            CASE
              WHEN ${issueComments.authorUserId} IS NULL OR ${issueComments.authorUserId} <> ${userId}
              THEN ${issueComments.createdAt}
            END
          )
        `,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, issueIdChunk),
        ),
      )
      .groupBy(issueComments.issueId);
    stats.push(...rows);
  }
  return stats;
}

async function userReadStatsForIssues(
  dbOrTx: any,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<IssueReadStat[]> {
  const stats: IssueReadStat[] = [];
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueReadStates.issueId,
        myLastReadAt: issueReadStates.lastReadAt,
      })
      .from(issueReadStates)
      .where(
        and(
          eq(issueReadStates.companyId, companyId),
          eq(issueReadStates.userId, userId),
          inArray(issueReadStates.issueId, issueIdChunk),
        ),
      );
    stats.push(...rows);
  }
  return stats;
}

async function lastActivityStatsForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<IssueLastActivityStat[]> {
  const byIssueId = new Map<string, IssueLastActivityStat>();
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const [commentRows, logRows] = await Promise.all([
      dbOrTx
        .select({
          issueId: issueComments.issueId,
          latestCommentAt: sql<Date | null>`MAX(${issueComments.createdAt})`,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, issueIdChunk),
          ),
        )
        .groupBy(issueComments.issueId),
      dbOrTx
        .select({
          issueId: activityLog.entityId,
          latestLogAt: sql<Date | null>`MAX(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, issueIdChunk),
            sql`${activityLog.action} NOT IN (${sql.join(
              ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
              sql`, `,
            )})`,
          ),
        )
        .groupBy(activityLog.entityId),
    ]);

    for (const row of commentRows) {
      byIssueId.set(row.issueId, {
        issueId: row.issueId,
        latestCommentAt: row.latestCommentAt,
        latestLogAt: null,
      });
    }
    for (const row of logRows) {
      const existing = byIssueId.get(row.issueId);
      if (existing) existing.latestLogAt = row.latestLogAt;
      else {
        byIssueId.set(row.issueId, {
          issueId: row.issueId,
          latestCommentAt: null,
          latestLogAt: row.latestLogAt,
        });
      }
    }
  }
  return [...byIssueId.values()];
}

async function blockedByMapForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, IssueRelationIssueSummary[]>> {
  const map = new Map<string, IssueRelationIssueSummary[]>();
  const uniqueIssueIds = [...new Set(issueIds)];
  if (uniqueIssueIds.length === 0) return map;

  for (const issueId of uniqueIssueIds) {
    map.set(issueId, []);
  }

  for (const issueIdChunk of chunkList(uniqueIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        currentIssueId: issueRelations.relatedIssueId,
        relatedId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, issueIdChunk),
        ),
      );

    for (const row of rows) {
      const blockedBy = map.get(row.currentIssueId);
      if (!blockedBy) continue;
      blockedBy.push({
        id: row.relatedId,
        identifier: row.identifier,
        title: row.title,
        status: row.status as IssueRelationIssueSummary["status"],
        priority: row.priority as IssueRelationIssueSummary["priority"],
        assigneeAgentId: row.assigneeAgentId,
        assigneeUserId: row.assigneeUserId,
      });
    }
  }

  for (const blockedBy of map.values()) {
    blockedBy.sort((a, b) => a.title.localeCompare(b.title));
  }

  return map;
}

export function issueService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const treeControlSvc = issueTreeControlService(db);

  async function getIssueByUuid(id: string) {
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withIssueLabels(db, [row]);
    return enriched;
  }

  async function getIssueByIdentifier(identifier: string) {
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.identifier, identifier.toUpperCase()))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withIssueLabels(db, [row]);
    return enriched;
  }

  async function getCurrentScheduledRetryForIssue(issueId: string, companyId: string): Promise<IssueScheduledRetryRow | null> {
    const row = await db
      .select({
        runId: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        agentName: agents.name,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "scheduled_retry"),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(asc(heartbeatRuns.scheduledRetryAt), asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    return row ? { ...row, status: "scheduled_retry" } : null;
  }

  function deriveIssueCommentAuthorType(comment: {
    authorType?: string | null;
    authorAgentId?: string | null;
    authorUserId?: string | null;
  }): IssueCommentAuthorType {
    const explicit = issueCommentAuthorTypeSchema.safeParse(comment.authorType);
    if (explicit.success) return explicit.data;
    if (comment.authorAgentId) return "agent";
    if (comment.authorUserId) return "user";
    return "system";
  }

  function assertIssueCommentAuthorTypeAllowed(
    actor: { agentId?: string | null; userId?: string | null },
    authorType: IssueCommentAuthorType,
  ) {
    if (actor.agentId && authorType !== "agent") {
      throw unprocessable("Comment authorType must match authenticated actor");
    }
    if (actor.userId && authorType !== "user") {
      throw unprocessable("Comment authorType must match authenticated actor");
    }
    if (!actor.agentId && !actor.userId && authorType !== "system") {
      throw unprocessable("System comments cannot use user or agent authorType without an author id");
    }
  }

  function redactIssueComment<T extends { body: string; authorType?: string | null; authorAgentId?: string | null; authorUserId?: string | null; presentation?: unknown; metadata?: unknown }>(
    comment: T,
    censorUsernameInLogs: boolean,
  ): T & {
    authorType: IssueCommentAuthorType;
    presentation: IssueCommentPresentation | null;
    metadata: IssueCommentMetadata | null;
  } {
    return {
      ...comment,
      authorType: deriveIssueCommentAuthorType(comment),
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
      presentation: issueCommentPresentationSchema.nullable().catch(null).parse(comment.presentation ?? null),
      metadata: issueCommentMetadataSchema.nullable().catch(null).parse(comment.metadata ?? null),
    };
  }

  async function attachIssueAttachmentsToComments<T extends { id: string; issueId: string; body: string }>(
    comments: readonly T[],
  ): Promise<Array<T & { attachments: IssueAttachment[] }>> {
    if (comments.length === 0) return [];

    const issueIds = [...new Set(comments.map((comment) => comment.issueId))];
    const commentIds = comments.map((comment) => comment.id);
    const referencedIdsByCommentId = new Map<string, string[]>();
    const referencedAttachmentIds = new Set<string>();

    for (const comment of comments) {
      const ids = extractIssueAttachmentIdsFromText(comment.body);
      referencedIdsByCommentId.set(comment.id, ids);
      for (const id of ids) referencedAttachmentIds.add(id);
    }

    const directCommentCondition = commentIds.length > 0
      ? inArray(issueAttachments.issueCommentId, commentIds)
      : null;
    const referencedAttachmentCondition = referencedAttachmentIds.size > 0
      ? inArray(issueAttachments.id, [...referencedAttachmentIds])
      : null;
    const attachmentScopeCondition = directCommentCondition && referencedAttachmentCondition
      ? or(directCommentCondition, referencedAttachmentCondition)!
      : directCommentCondition ?? referencedAttachmentCondition;

    if (!attachmentScopeCondition) {
      return comments.map((comment) => ({ ...comment, attachments: [] }));
    }

    const issueCondition = issueIds.length === 1
      ? eq(issueAttachments.issueId, issueIds[0])
      : inArray(issueAttachments.issueId, issueIds);

    const attachmentRows = await db
      .select({
        id: issueAttachments.id,
        companyId: issueAttachments.companyId,
        issueId: issueAttachments.issueId,
        issueCommentId: issueAttachments.issueCommentId,
        assetId: issueAttachments.assetId,
        provider: assets.provider,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
        originalFilename: assets.originalFilename,
        createdByAgentId: assets.createdByAgentId,
        createdByUserId: assets.createdByUserId,
        createdAt: issueAttachments.createdAt,
        updatedAt: issueAttachments.updatedAt,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .where(and(issueCondition, attachmentScopeCondition));

    const attachments = attachmentRows.map((row): IssueAttachment => ({
      ...row,
      contentPath: issueAttachmentContentPath(row.id),
    }));
    const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    const directAttachmentsByCommentId = new Map<string, IssueAttachment[]>();

    for (const attachment of attachments) {
      if (!attachment.issueCommentId) continue;
      const current = directAttachmentsByCommentId.get(attachment.issueCommentId) ?? [];
      current.push(attachment);
      directAttachmentsByCommentId.set(attachment.issueCommentId, current);
    }

    return comments.map((comment) => {
      const seen = new Set<string>();
      const commentAttachments: IssueAttachment[] = [];
      const addAttachment = (attachment: IssueAttachment | undefined) => {
        if (!attachment || seen.has(attachment.id)) return;
        seen.add(attachment.id);
        commentAttachments.push(attachment);
      };

      for (const attachment of directAttachmentsByCommentId.get(comment.id) ?? []) {
        addAttachment(attachment);
      }
      for (const id of referencedIdsByCommentId.get(comment.id) ?? []) {
        addAttachment(attachmentById.get(id));
      }

      return { ...comment, attachments: commentAttachments };
    });
  }

  async function readRunLogText(run: {
    logStore: string | null;
    logRef: string | null;
    logBytes: number | null;
  }) {
    if (run.logStore !== "local_file" || !run.logRef) return "";
    const logBytes = Number(run.logBytes ?? 0);
    if (!Number.isFinite(logBytes) || logBytes <= 0) return "";

    const store = getRunLogStore();
    let offset = 0;
    let content = "";
    let nextOffset: number | undefined = 0;

    while (nextOffset !== undefined) {
      const remainingBytes = ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_LOG_BYTES - Buffer.byteLength(content, "utf8");
      if (remainingBytes <= 0) break;
      const chunk = await store.read(
        { store: "local_file", logRef: run.logRef },
        {
          offset,
          limitBytes: Math.min(ISSUE_COMMENT_RUN_LOG_DERIVATION_CHUNK_BYTES, remainingBytes),
        },
      );
      content += chunk.content;
      nextOffset = chunk.nextOffset;
      offset = chunk.nextOffset ?? 0;
    }

    return content;
  }

  async function enrichCommentsWithDerivedAgentAttribution<
    T extends {
      id: string;
      companyId: string;
      issueId: string;
      authorAgentId?: string | null;
      authorUserId?: string | null;
      createdByRunId?: string | null;
      createdAt: Date | string;
    },
  >(comments: readonly T[]) {
    const candidates = comments.filter((comment) =>
      !comment.authorAgentId
      && !!comment.authorUserId
      && !comment.createdByRunId,
    );
    if (candidates.length === 0) return comments;

    const companyId = comments[0]?.companyId ?? null;
    const issueId = comments[0]?.issueId ?? null;
    if (!companyId || !issueId) return comments;

    const minCommentCreatedAtMs = candidates.reduce<number | null>((min, comment) => {
      const timestamp = toTimestampMs(comment.createdAt);
      if (timestamp === null) return min;
      return min === null ? timestamp : Math.min(min, timestamp);
    }, null);
    const maxCommentCreatedAtMs = candidates.reduce<number | null>((max, comment) => {
      const timestamp = toTimestampMs(comment.createdAt);
      if (timestamp === null) return max;
      return max === null ? timestamp : Math.max(max, timestamp);
    }, null);
    if (minCommentCreatedAtMs === null || maxCommentCreatedAtMs === null) return comments;

    const runs = await db
      .select({
        runId: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        createdAt: heartbeatRuns.createdAt,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        logStore: heartbeatRuns.logStore,
        logRef: heartbeatRuns.logRef,
        logBytes: heartbeatRuns.logBytes,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            sql`exists (
              select 1
              from ${activityLog}
              where ${activityLog.companyId} = ${companyId}
                and ${activityLog.entityType} = 'issue'
                and ${activityLog.entityId} = ${issueId}
                and ${activityLog.runId} = ${heartbeatRuns.id}
            )`,
          ),
          sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) >= ${new Date(minCommentCreatedAtMs).toISOString()}`,
          sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${new Date(maxCommentCreatedAtMs + ISSUE_COMMENT_RUN_LOG_DERIVATION_END_SLACK_MS).toISOString()}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    if (runs.length === 0) return comments;

    const runsWithLogs: Array<(typeof runs)[number] & { logContent: string }> = [];
    for (let index = 0; index < runs.length; index += ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_PARALLEL_READS) {
      const batch = runs.slice(index, index + ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_PARALLEL_READS);
      const batchWithLogs = await Promise.all(batch.map(async (run) => ({
        ...run,
        logContent: await readRunLogText(run),
      })));
      runsWithLogs.push(...batchWithLogs);
    }
    const derivedByCommentId = deriveIssueCommentRunLogAttribution(candidates, runsWithLogs);
    if (derivedByCommentId.size === 0) return comments;

    return comments.map((comment) => {
      const derived = derivedByCommentId.get(comment.id);
      return derived ? { ...comment, ...derived } : comment;
    });
  }

  async function assertAssignableAgent(companyId: string, agentId: string) {
    const assignee = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!assignee) throw notFound("Assignee agent not found");
    if (assignee.companyId !== companyId) {
      throw unprocessable("Assignee must belong to same company");
    }
    if (assignee.status === "pending_approval") {
      throw conflict("Cannot assign work to pending approval agents");
    }
    if (assignee.status === "terminated") {
      throw conflict("Cannot assign work to terminated agents");
    }
  }

  async function isTreeHoldInteractionCheckoutAllowed(
    companyId: string,
    checkoutRunId: string | null,
    _gate: ActiveIssueTreePauseHoldGate,
  ) {
    if (!checkoutRunId) return false;
    const run = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, checkoutRunId), eq(heartbeatRuns.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    const issueId = readStringFromRecord(run?.contextSnapshot, "issueId");
    if (!run || !issueId) return false;
    return isVerifiedIssueTreeControlInteractionWake(db, {
      companyId,
      issueId,
      agentId: run.agentId,
      runId: run.id,
      wakeupRequestId: run.wakeupRequestId,
      contextSnapshot: run.contextSnapshot as Record<string, unknown> | null | undefined,
    });
  }

  async function assertAssignableUser(companyId: string, userId: string) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!membership) {
      throw notFound("Assignee user not found");
    }
  }

  async function assertValidProjectWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    projectWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: projectWorkspaces.id,
        companyId: projectWorkspaces.companyId,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Project workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Project workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Project workspace must belong to the selected project");
    }
  }

  async function getAssignableCycle(
    companyId: string,
    projectId: string | null | undefined,
    cycleId: string,
    dbOrTx: DbReader = db,
  ) {
    const cycle = await dbOrTx
      .select({
        id: workCycles.id,
        companyId: workCycles.companyId,
        projectId: workCycles.projectId,
      })
      .from(workCycles)
      .where(eq(workCycles.id, cycleId))
      .then((rows) => rows[0] ?? null);
    if (!cycle) throw notFound("Cycle not found");
    if (cycle.companyId !== companyId) {
      throw unprocessable("Cycle must belong to the same company");
    }
    if (cycle.projectId && cycle.projectId !== projectId) {
      throw unprocessable("Project cycle can only be assigned to issues in that project");
    }
    return cycle;
  }

  async function assertValidExecutionWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    executionWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        projectId: executionWorkspaces.projectId,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Execution workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Execution workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Execution workspace must belong to the selected project");
    }
  }

  async function assertValidLabelIds(companyId: string, labelIds: string[], dbOrTx: any = db) {
    if (labelIds.length === 0) return;
    const existing = await dbOrTx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)));
    if (existing.length !== new Set(labelIds).size) {
      throw unprocessable("One or more labels are invalid for this company");
    }
  }

  async function syncIssueLabels(
    issueId: string,
    companyId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(labelIds)];
    await assertValidLabelIds(companyId, deduped, dbOrTx);
    await dbOrTx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
    if (deduped.length === 0) return;
    await dbOrTx.insert(issueLabels).values(
      deduped.map((labelId) => ({
        issueId,
        labelId,
        companyId,
      })),
    );
  }

  async function getIssueRelationSummaryMap(
    companyId: string,
    issueIds: string[],
    dbOrTx: DbReader = db,
  ): Promise<Map<string, IssueRelationSummaryMap>> {
    const uniqueIssueIds = [...new Set(issueIds)];
    const empty = new Map<string, IssueRelationSummaryMap>();
    for (const issueId of uniqueIssueIds) {
      empty.set(issueId, { blockedBy: [], blocks: [] });
    }
    if (uniqueIssueIds.length === 0) return empty;

    const [blockedByRows, blockingRows] = await Promise.all([
      dbOrTx
        .select({
          currentIssueId: issueRelations.relatedIssueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, uniqueIssueIds),
          ),
        ),
      dbOrTx
        .select({
          currentIssueId: issueRelations.issueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.issueId, uniqueIssueIds),
          ),
        ),
    ]);

    for (const row of blockedByRows) {
      empty.get(row.currentIssueId)?.blockedBy.push(summarizeIssueRelationRow(row));
    }
    for (const row of blockingRows) {
      empty.get(row.currentIssueId)?.blocks.push(summarizeIssueRelationRow(row));
    }

    const terminalByRoot = await terminalExplicitBlockersByRoot(
      companyId,
      [...empty.values()].flatMap((relations) => relations.blockedBy),
      dbOrTx,
    );

    for (const relations of empty.values()) {
      relations.blockedBy.sort((a, b) => a.title.localeCompare(b.title));
      for (const blocker of relations.blockedBy) {
        const terminalBlockers = terminalByRoot.get(blocker.id);
        if (terminalBlockers && terminalBlockers.length > 0) {
          blocker.terminalBlockers = terminalBlockers;
        }
      }
      relations.blocks.sort((a, b) => a.title.localeCompare(b.title));
    }

    return empty;
  }

  async function assertNoBlockingCycles(
    companyId: string,
    issueId: string,
    blockerIssueIds: string[],
    dbOrTx: DbReader = db,
  ) {
    if (blockerIssueIds.length === 0) return;

    const rows = await dbOrTx
      .select({
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));

    const adjacency = new Map<string, string[]>();
    for (const row of rows) {
      const list = adjacency.get(row.blockerIssueId) ?? [];
      list.push(row.blockedIssueId);
      adjacency.set(row.blockerIssueId, list);
    }

    for (const blockerIssueId of blockerIssueIds) {
      const queue = [...(adjacency.get(issueId) ?? [])];
      const visited = new Set<string>([issueId]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === blockerIssueId) {
          throw unprocessable("Blocking relations cannot contain cycles");
        }
        if (visited.has(current)) continue;
        visited.add(current);
        queue.push(...(adjacency.get(current) ?? []));
      }
    }
  }

  async function syncBlockedByIssueIds(
    issueId: string,
    companyId: string,
    blockedByIssueIds: string[],
    actor: { agentId?: string | null; userId?: string | null } = {},
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(blockedByIssueIds)];
    if (deduped.some((candidate) => candidate === issueId)) {
      throw unprocessable("Issue cannot be blocked by itself");
    }

    if (deduped.length > 0) {
      const lockedIssueIds = [issueId, ...deduped].sort();
      await dbOrTx.execute(
        sql`SELECT ${issues.id} FROM ${issues}
            WHERE ${and(eq(issues.companyId, companyId), inArray(issues.id, lockedIssueIds))}
            ORDER BY ${issues.id}
            FOR UPDATE`,
      );
      const relatedIssues = await dbOrTx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, deduped)));
      if (relatedIssues.length !== deduped.length) {
        throw unprocessable("Blocked-by issues must belong to the same company");
      }
      await assertNoBlockingCycles(companyId, issueId, deduped, dbOrTx);
    }

    await dbOrTx
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );

    if (deduped.length === 0) return;

    await dbOrTx.insert(issueRelations).values(
      deduped.map((blockerIssueId) => ({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })),
    );
  }

  async function isTerminalOrMissingHeartbeatRun(runId: string) {
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) return true;
    return TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status);
  }

  async function adoptStaleCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
    expectedCheckoutRunId: string;
  }) {
    const stale = await isTerminalOrMissingHeartbeatRun(input.expectedCheckoutRunId);
    if (!stale) return null;

    const now = new Date();
    const adopted = await db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          eq(issues.checkoutRunId, input.expectedCheckoutRunId),
        ),
      )
      .returning({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    return adopted;
  }

  async function adoptUnownedCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
  }) {
    const now = new Date();
    const adopted = await db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          isNull(issues.checkoutRunId),
          or(isNull(issues.executionRunId), eq(issues.executionRunId, input.actorRunId)),
        ),
      )
      .returning({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    return adopted;
  }

  async function clearExecutionRunIfTerminal(issueId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} for update`,
      );
      const issue = await tx
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue?.executionRunId) return false;

      await tx.execute(
        sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${issue.executionRunId} for update`,
      );
      const run = await tx
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, issue.executionRunId))
        .then((rows) => rows[0] ?? null);
      if (run && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) return false;

      const updated = await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, issueId),
            eq(issues.executionRunId, issue.executionRunId),
          ),
        )
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      return Boolean(updated);
    });
  }

  let workItemTypeColumnSupported: boolean | null = null;
  async function hasWorkItemTypeColumnInIssuesTable() {
    if (workItemTypeColumnSupported !== null) return workItemTypeColumnSupported;

    try {
      const rows = rowsFromDbExecuteResult<unknown>(await db.execute(sql`
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'issues'
          AND column_name = 'work_item_type'
        LIMIT 1
      `));
      const resolved = rows.length > 0;
      workItemTypeColumnSupported = resolved;
      return resolved;
    } catch {
      workItemTypeColumnSupported = false;
      return false;
    }
  }

  return {
    clearExecutionRunIfTerminal,
    actualAiSecondsMapForIssues: (companyId: string, issueIds: string[]) =>
      actualAiSecondsMapForIssues(db, companyId, issueIds),
    actualHumanSecondsMapForIssues: (companyId: string, issueIds: string[]) =>
      actualHumanSecondsMapForIssues(db, companyId, issueIds),

    list: async (companyId: string, filters?: IssueFilters) => {
      const requestedWorkItemType = filters?.workItemType?.trim() ?? "";
      const requestedWorkItemTypes = parseWorkItemTypeFilter(requestedWorkItemType);
      const conditions = [eq(issues.companyId, companyId)];
      const limit = typeof filters?.limit === "number" && Number.isFinite(filters.limit)
        ? Math.max(1, Math.floor(filters.limit))
        : undefined;
      const offset = typeof filters?.offset === "number" && Number.isFinite(filters.offset)
        ? Math.max(0, Math.floor(filters.offset))
        : 0;
      const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
      const inboxArchivedByUserId = filters?.inboxArchivedByUserId?.trim() || undefined;
      const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
      const awaitingDecisionForUserId = filters?.awaitingDecisionForUserId?.trim() || undefined;
      const contextUserId =
        unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId ?? awaitingDecisionForUserId;
      const includeBlockedBy = filters?.includeBlockedBy === true;
      const supportsWorkItemTypeColumn = await hasWorkItemTypeColumnInIssuesTable();
      if (requestedWorkItemType && requestedWorkItemTypes.length === 0) {
        return [];
      }
      if (
        requestedWorkItemTypes.length > 0 &&
        !supportsWorkItemTypeColumn &&
        !requestedWorkItemTypes.includes("ai_task")
      ) {
        return [];
      }
      const rawSearch = filters?.q?.trim() ?? "";
      const hasSearch = rawSearch.length > 0;
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = sql<boolean>`${issues.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = sql<boolean>`${issues.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWithMatch = sql<boolean>`${issues.identifier} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierContainsMatch = sql<boolean>`${issues.identifier} ILIKE ${containsPattern} ESCAPE '\\'`;
      const descriptionContainsMatch = sql<boolean>`${issues.description} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${issueComments}
          WHERE ${issueComments.issueId} = ${issues.id}
            AND ${issueComments.companyId} = ${companyId}
            AND ${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (filters?.descendantOf) {
        conditions.push(sql<boolean>`
          ${issues.id} IN (
            WITH RECURSIVE descendants(id) AS (
              SELECT ${issues.id}
              FROM ${issues}
              WHERE ${issues.companyId} = ${companyId}
                AND ${issues.parentId} = ${filters.descendantOf}
              UNION
              SELECT ${issues.id}
              FROM ${issues}
              JOIN descendants ON ${issues.parentId} = descendants.id
              WHERE ${issues.companyId} = ${companyId}
            )
            SELECT id FROM descendants
          )
        `);
      }
      const statuses = parseStatusFilter(filters?.status);
      if (statuses.length === 1) {
        conditions.push(eq(issues.status, statuses[0]));
      } else if (statuses.length > 1) {
        conditions.push(inArray(issues.status, statuses));
      }
      if (filters?.assigneeAgentId) {
        conditions.push(eq(issues.assigneeAgentId, filters.assigneeAgentId));
      }
      if (filters?.recoveryOwnerAgentId) {
        conditions.push(sql<boolean>`exists (
          select 1
          from ${issueRecoveryActions}
          where ${issueRecoveryActions.companyId} = ${companyId}
            and ${issueRecoveryActions.sourceIssueId} = ${issues.id}
            and ${issueRecoveryActions.ownerAgentId} = ${filters.recoveryOwnerAgentId}
            and ${issueRecoveryActions.status} in ('active', 'escalated')
        )`);
      }
      if (filters?.participantAgentId) {
        conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
      }
      if (filters?.assigneeUserId) {
        conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(companyId, touchedByUserId));
      }
      if (inboxArchivedByUserId) {
        conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(companyId, unreadForUserId));
      }
      if (awaitingDecisionForUserId) {
        conditions.push(
          or(
            and(
              eq(issues.status, "blocked"),
              or(
                eq(issues.assigneeUserId, awaitingDecisionForUserId),
                eq(issues.createdByUserId, awaitingDecisionForUserId),
              )!,
            ),
            // A board-owned recovery action is first-class board work even
            // when source ownership/status is intentionally preserved. Put it
            // in the same "Needs you" queue so watchdog escalations cannot be
            // hidden in an otherwise ordinary todo/in-review issue.
            sql`exists (
              select 1
              from ${issueRecoveryActions}
              where ${issueRecoveryActions.companyId} = ${companyId}
                and ${issueRecoveryActions.sourceIssueId} = ${issues.id}
                and ${issueRecoveryActions.ownerType} = 'board'
                and ${issueRecoveryActions.status} in ('active', 'escalated')
            )`,
            // Harness liveness only asks the board after manager and
            // same-company agent recovery paths are exhausted. Surface that
            // structured interaction in every authorized board member's
            // "Needs you" queue; otherwise it would be durable but discoverable
            // only by opening the exact recovery issue.
            sql`exists (
              select 1
              from ${issueThreadInteractions}
              where ${issueThreadInteractions.companyId} = ${companyId}
                and ${issueThreadInteractions.issueId} = ${issues.id}
                and ${issueThreadInteractions.status} = 'pending'
                and ${issueThreadInteractions.payload} -> 'context' ->> 'kind'
                  = 'issue_graph_liveness_board_escalation'
            )`,
          )!,
        );
      }
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters?.cycleId) conditions.push(eq(issues.cycleId, filters.cycleId));
      if (filters?.projectScopeRestrictedTo) {
        const allowed = filters.projectScopeRestrictedTo;
        if (allowed.length === 0) {
          conditions.push(isNull(issues.projectId));
        } else {
          conditions.push(
            or(isNull(issues.projectId), inArray(issues.projectId, allowed))!,
          );
        }
      }
      if (filters?.workspaceId) {
        conditions.push(or(
          eq(issues.executionWorkspaceId, filters.workspaceId),
          eq(issues.projectWorkspaceId, filters.workspaceId),
        )!);
      }
      if (filters?.executionWorkspaceId) {
        conditions.push(eq(issues.executionWorkspaceId, filters.executionWorkspaceId));
      }
      if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
      if (requestedWorkItemTypes.length === 1 && supportsWorkItemTypeColumn) {
        conditions.push(eq(issues.workItemType, requestedWorkItemTypes[0]!));
      } else if (requestedWorkItemTypes.length > 1 && supportsWorkItemTypeColumn) {
        conditions.push(inArray(issues.workItemType, requestedWorkItemTypes));
      }
      if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
      if (filters?.originKindPrefix) conditions.push(like(issues.originKind, `${filters.originKindPrefix}%`));
      if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
      if (!shouldIncludePluginOperationIssues(filters)) {
        conditions.push(nonPluginOperationIssueCondition());
      }
      if (filters?.labelId) {
        const labeledIssueIds = await db
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, filters.labelId)));
        if (labeledIssueIds.length === 0) return [];
        conditions.push(inArray(issues.id, labeledIssueIds.map((row) => row.issueId)));
      }
      if (hasSearch) {
        conditions.push(
          or(
            titleContainsMatch,
            identifierContainsMatch,
            descriptionContainsMatch,
            commentContainsMatch,
          )!,
        );
      }
      if (filters?.excludeRoutineExecutions && !filters?.originKind && !filters?.originId) {
        conditions.push(ne(issues.originKind, "routine_execution"));
      }
      conditions.push(isNull(issues.hiddenAt));

      const priorityOrder = sql`CASE ${issues.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = sql<number>`
        CASE
          WHEN ${titleStartsWithMatch} THEN 0
          WHEN ${titleContainsMatch} THEN 1
          WHEN ${identifierStartsWithMatch} THEN 2
          WHEN ${identifierContainsMatch} THEN 3
          WHEN ${commentContainsMatch} THEN 4
          WHEN ${descriptionContainsMatch} THEN 5
          ELSE 6
        END
      `;
      const canonicalLastActivityAt = issueCanonicalLastActivityAtExpr(companyId);
      const issueListSelectForList = supportsWorkItemTypeColumn
        ? issueListSelect
        : issueListSelectWithoutWorkItemType;
      const baseQuery = db
        .select(issueListSelectForList)
        .from(issues)
        .where(and(...conditions))
        .orderBy(
          hasSearch ? asc(searchOrder) : asc(priorityOrder),
          asc(priorityOrder),
          desc(canonicalLastActivityAt),
          desc(issues.updatedAt),
          desc(issues.id),
        );
      const pageQuery = offset > 0
        ? (limit === undefined ? baseQuery.offset(offset) : baseQuery.limit(limit).offset(offset))
        : (limit === undefined ? baseQuery : baseQuery.limit(limit));
      const rows = (await pageQuery).map((row) => ({
        ...row,
        ...(supportsWorkItemTypeColumn ? {} : { workItemType: "ai_task" as const }),
        description: decodeDatabaseTextPreview(row.description, ISSUE_LIST_DESCRIPTION_MAX_CHARS),
      }));
      const withLabels = await withIssueLabels(db, rows as IssueRow[]);
      const runMap = await activeRunMapForIssues(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (withRuns.length === 0) {
        return withRuns;
      }

      const issueIds = withRuns.map((row) => row.id);
      const [
        statsRows,
        readRows,
        lastActivityRows,
        blockedByMap,
        actualAiSecondsByIssueId,
        actualHumanSecondsByIssueId,
      ] = await Promise.all([
        contextUserId
          ? userCommentStatsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        contextUserId
          ? userReadStatsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        lastActivityStatsForIssues(db, companyId, issueIds),
        includeBlockedBy
          ? blockedByMapForIssues(db, companyId, issueIds)
          : Promise.resolve(new Map<string, IssueRelationIssueSummary[]>()),
        actualAiSecondsMapForIssues(db, companyId, issueIds),
        actualHumanSecondsMapForIssues(db, companyId, issueIds),
      ]);
      const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
      const lastActivityByIssueId = new Map(lastActivityRows.map((row) => [row.issueId, row]));
      const [blockerAttentionByIssueId, productivityReviewByIssueId] = await Promise.all([
        listIssueBlockerAttentionMap(db, companyId, withRuns),
        listIssueProductivityReviewMap(db, companyId, issueIds),
      ]);

      if (!contextUserId) {
        return withRuns.map((row) => {
          const activity = lastActivityByIssueId.get(row.id);
          const lastActivityAt = latestIssueActivityAt(
            row.updatedAt,
            activity?.latestCommentAt ?? null,
            activity?.latestLogAt ?? null,
          ) ?? row.updatedAt;
          return {
            ...row,
            actualAiSeconds: actualAiSecondsByIssueId.get(row.id) ?? 0,
            actualHumanSeconds: actualHumanSecondsByIssueId.get(row.id) ?? 0,
            ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
            lastActivityAt,
            ...(blockerAttentionByIssueId.has(row.id) ? { blockerAttention: blockerAttentionByIssueId.get(row.id) } : {}),
            ...(productivityReviewByIssueId.has(row.id)
              ? { productivityReview: productivityReviewByIssueId.get(row.id) }
              : {}),
          };
        });
      }

      const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));

      return withRuns.map((row) => {
        const activity = lastActivityByIssueId.get(row.id);
        const lastActivityAt = latestIssueActivityAt(
          row.updatedAt,
          activity?.latestCommentAt ?? null,
          activity?.latestLogAt ?? null,
        ) ?? row.updatedAt;
        return {
          ...row,
          actualAiSeconds: actualAiSecondsByIssueId.get(row.id) ?? 0,
          actualHumanSeconds: actualHumanSecondsByIssueId.get(row.id) ?? 0,
          ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
          lastActivityAt,
          ...(blockerAttentionByIssueId.has(row.id) ? { blockerAttention: blockerAttentionByIssueId.get(row.id) } : {}),
          ...(productivityReviewByIssueId.has(row.id)
            ? { productivityReview: productivityReviewByIssueId.get(row.id) }
            : {}),
          ...deriveIssueUserContext(row, contextUserId, {
            myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
            myLastReadAt: readByIssueId.get(row.id) ?? null,
            lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
          }),
        };
      });
    },

    countUnreadTouchedByUser: async (
      companyId: string,
      userId: string,
      status?: string | readonly string[],
    ) => {
      const conditions = [
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        nonPluginOperationIssueCondition(),
        unreadForUserCondition(companyId, userId),
      ];
      const statuses = parseStatusFilter(status);
      if (statuses.length === 1) {
        conditions.push(eq(issues.status, statuses[0]));
      } else if (statuses.length > 1) {
        conditions.push(inArray(issues.status, statuses));
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    markRead: async (companyId: string, issueId: string, userId: string, readAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueReadStates)
        .values({
          companyId,
          issueId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    markUnread: async (companyId: string, issueId: string, userId: string) => {
      const deleted = await db
        .delete(issueReadStates)
        .where(
          and(
            eq(issueReadStates.companyId, companyId),
            eq(issueReadStates.issueId, issueId),
            eq(issueReadStates.userId, userId),
          ),
        )
        .returning();
      return deleted.length > 0;
    },

    archiveInbox: async (companyId: string, issueId: string, userId: string, archivedAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueInboxArchives)
        .values({
          companyId,
          issueId,
          userId,
          archivedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueInboxArchives.companyId, issueInboxArchives.issueId, issueInboxArchives.userId],
          set: {
            archivedAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    unarchiveInbox: async (companyId: string, issueId: string, userId: string) => {
      const [row] = await db
        .delete(issueInboxArchives)
        .where(
          and(
            eq(issueInboxArchives.companyId, companyId),
            eq(issueInboxArchives.issueId, issueId),
            eq(issueInboxArchives.userId, userId),
          ),
        )
        .returning();
      return row ?? null;
    },

    getById: async (raw: string) => {
      const id = raw.trim();
      const identifier = normalizeIssueReferenceIdentifier(id);
      if (identifier) {
        return getIssueByIdentifier(identifier);
      }
      if (!isUuidLike(id)) {
        return null;
      }
      return getIssueByUuid(id);
    },

    getByIdentifier: async (identifier: string) => {
      return getIssueByIdentifier(identifier);
    },

    getCurrentScheduledRetry: async (issueId: string) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      return getCurrentScheduledRetryForIssue(issue.id, issue.companyId);
    },

    getRelationSummaries: async (issueId: string) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      const relations = await getIssueRelationSummaryMap(issue.companyId, [issueId], db);
      return relations.get(issueId) ?? { blockedBy: [], blocks: [] };
    },

    getDependencyReadiness: async (issueId: string, dbOrTx: any = db) => {
      const issue = await dbOrTx
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      const readiness = await listIssueDependencyReadinessMap(dbOrTx, issue.companyId, [issueId]);
      return readiness.get(issueId) ?? createIssueDependencyReadiness(issueId);
    },

    listDependencyReadiness: async (companyId: string, issueIds: string[], dbOrTx: any = db) => {
      return listIssueDependencyReadinessMap(dbOrTx, companyId, issueIds);
    },

    listBlockerAttention: async (
      companyId: string,
      issueRows: IssueBlockerAttentionInputNode[],
      dbOrTx: any = db,
    ) => {
      return listIssueBlockerAttentionMap(dbOrTx, companyId, issueRows);
    },

    listProductivityReviews: async (
      companyId: string,
      sourceIssueIds: string[],
      dbOrTx: any = db,
    ) => {
      return listIssueProductivityReviewMap(dbOrTx, companyId, sourceIssueIds);
    },

    listWakeableBlockedDependents: async (blockerIssueId: string) => {
      const blockerIssue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, blockerIssueId))
        .then((rows) => rows[0] ?? null);
      if (!blockerIssue) return [];

      const candidates = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
          workItemType: issues.workItemType,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, blockerIssue.companyId),
            eq(issueRelations.type, "blocks"),
            eq(issueRelations.issueId, blockerIssueId),
          ),
        );
      if (candidates.length === 0) return [];

      const candidateIds = candidates.map((candidate) => candidate.id);
      const blockerRows = await db
        .select({
          issueId: issueRelations.relatedIssueId,
          blockerIssueId: issueRelations.issueId,
          blockerStatus: issues.status,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, blockerIssue.companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, candidateIds),
          ),
        );

      const blockersByIssueId = new Map<string, Array<{ blockerIssueId: string; blockerStatus: string }>>();
      for (const row of blockerRows) {
        const list = blockersByIssueId.get(row.issueId) ?? [];
        list.push({ blockerIssueId: row.blockerIssueId, blockerStatus: row.blockerStatus });
        blockersByIssueId.set(row.issueId, list);
      }

      return candidates
        .filter((candidate) =>
          candidate.assigneeAgentId
          && !isHumanControlWorkItemType(candidate.workItemType)
          && !["backlog", "done", "cancelled"].includes(candidate.status))
        .map((candidate) => {
          const blockers = blockersByIssueId.get(candidate.id) ?? [];
          return {
            ...candidate,
            blockerIssueIds: blockers.map((blocker) => blocker.blockerIssueId),
            // A blocker in any TERMINAL state (done OR cancelled) is resolved —
            // mirrors listDependencyReadiness, so cancelling a blocker actually
            // wakes its dependents instead of leaving them stranded.
            allBlockersDone:
              blockers.length > 0 &&
              blockers.every(
                (blocker) => blocker.blockerStatus === "done" || blocker.blockerStatus === "cancelled",
              ),
          };
        })
        .filter((candidate) => candidate.allBlockersDone)
        .map((candidate) => ({
          id: candidate.id,
          assigneeAgentId: candidate.assigneeAgentId!,
          workItemType: candidate.workItemType,
          blockerIssueIds: candidate.blockerIssueIds,
        }));
    },

    getWakeableParentAfterChildCompletion: async (parentIssueId: string) => {
      const parent = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
          workItemType: issues.workItemType,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(eq(issues.id, parentIssueId))
        .then((rows) => rows[0] ?? null);
      if (
        !parent
        || !parent.assigneeAgentId
        || isHumanControlWorkItemType(parent.workItemType)
        || ["backlog", "done", "cancelled"].includes(parent.status)
      ) {
        return null;
      }

      const children = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, parent.companyId), eq(issues.parentId, parentIssueId)))
        .orderBy(asc(issues.issueNumber), asc(issues.createdAt));
      if (children.length === 0) return null;
      if (!children.every((child) => child.status === "done" || child.status === "cancelled")) {
        return null;
      }

      const childIdsForSummaries = children.slice(0, MAX_CHILD_COMPLETION_SUMMARIES).map((child) => child.id);
      const commentRows = childIdsForSummaries.length > 0
        ? await db
            .select({
              issueId: issueComments.issueId,
              body: issueComments.body,
              createdAt: issueComments.createdAt,
            })
            .from(issueComments)
            .where(and(eq(issueComments.companyId, parent.companyId), inArray(issueComments.issueId, childIdsForSummaries)))
            .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
        : [];
      const latestCommentByIssueId = new Map<string, string>();
      for (const comment of commentRows) {
        if (!latestCommentByIssueId.has(comment.issueId)) {
          latestCommentByIssueId.set(comment.issueId, comment.body);
        }
      }
      const childIssueSummaries: ChildIssueCompletionSummary[] = children
        .slice(0, MAX_CHILD_COMPLETION_SUMMARIES)
        .map((child) => ({
          ...child,
          summary: truncateInlineSummary(latestCommentByIssueId.get(child.id)),
        }));

      return {
        id: parent.id,
        assigneeAgentId: parent.assigneeAgentId,
        workItemType: parent.workItemType,
        childIssueIds: children.map((child) => child.id),
        childIssueSummaries,
        childIssueSummaryTruncated: children.length > childIssueSummaries.length,
      };
    },

    createChild: async (
      parentIssueId: string,
      data: IssueChildCreateInput,
    ) => {
      const parent = await db
        .select()
        .from(issues)
        .where(eq(issues.id, parentIssueId))
        .then((rows) => rows[0] ?? null);
      if (!parent) throw notFound("Parent issue not found");
      await assertChildIssueCreationAllowed(db, parent.companyId, parent.id);

      const {
        acceptanceCriteria,
        blockParentUntilDone,
        actorAgentId,
        actorUserId,
        ...issueData
      } = data;
      const description = appendAcceptanceCriteriaToDescription(issueData.description, acceptanceCriteria);
      if (actorAgentId) {
        const contractFields = resolveExecutionContractFields({
          description,
          executionContract: issueData.executionContract,
        });
        assertDelegatedIssueExecutionContract(contractFields.executionContract ?? null, {
          parentId: parent.id,
        });
      }
      const child = await issueService(db).create(parent.companyId, {
        ...issueData,
        parentId: parent.id,
        projectId: issueData.projectId ?? parent.projectId,
        goalId: issueData.goalId ?? parent.goalId,
        requestDepth: clampIssueRequestDepth(
          Math.max(clampIssueRequestDepth(parent.requestDepth) + 1, issueData.requestDepth ?? 0),
        ),
        description,
        inheritExecutionWorkspaceFromIssueId: parent.id,
      });

      if (blockParentUntilDone) {
        const existingBlockers = await db
          .select({ blockerIssueId: issueRelations.issueId })
          .from(issueRelations)
          .where(and(eq(issueRelations.companyId, parent.companyId), eq(issueRelations.relatedIssueId, parent.id), eq(issueRelations.type, "blocks")));
        await syncBlockedByIssueIds(
          parent.id,
          parent.companyId,
          [...new Set([...existingBlockers.map((row) => row.blockerIssueId), child.id])],
          { agentId: actorAgentId ?? null, userId: actorUserId ?? null },
        );
      }

      return {
        issue: child,
        parentBlockerAdded: Boolean(blockParentUntilDone),
      };
    },

    create: async (
      companyId: string,
      data: IssueCreateInput,
    ) => {
      const {
        labelIds: inputLabelIds,
        blockedByIssueIds,
        inheritExecutionWorkspaceFromIssueId,
        budgetLimits: _budgetLimits,
        factoryManagedCreate,
        ...issueData
      } = data;
      const initialExecutionPolicy = normalizeIssueExecutionPolicy(issueData.executionPolicy ?? null);
      if (initialExecutionPolicy?.factory) {
        const factory = initialExecutionPolicy.factory;
        if (
          !factoryManagedCreate
          || factoryManagedCreate.token !== FACTORY_ORCHESTRATION_AUTHORITY
          || factory.laneKind !== "execution"
          || factoryManagedCreate.policyHash !== factory.policyHash
          || factoryManagedCreate.controlIssueId !== factory.controlIssueId
        ) {
          throw unprocessable(
            "AI Factory snapshots can only be attached by the typed execution-lane service.",
            { code: "factory_managed_route_required" },
          );
        }
      }
      const contractFields = resolveExecutionContractFields({
        description: issueData.description,
        executionContract: issueData.executionContract,
      });
      issueData.description = contractFields.description ?? null;
      if (Object.prototype.hasOwnProperty.call(contractFields, "executionContract")) {
        issueData.executionContract = prepareInitialExecutionContract(contractFields.executionContract);
      } else {
        delete issueData.executionContract;
      }
      if (issueData.parentId && issueData.createdByAgentId) {
        assertDelegatedIssueExecutionContract(issueData.executionContract ?? null, {
          parentId: issueData.parentId,
        });
      }
      if (issueData.status === "done" && !initialExecutionPolicy?.factory) {
        assertIssueCompletionEvidenceOnCreate(
          normalizeExecutionContractValue(issueData.executionContract),
        );
      }
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspaceId;
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }
      if (data.assigneeAgentId && data.assigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      assertAgentAssignmentAllowedForWorkItem(issueData.workItemType, data.assigneeAgentId);
      if (data.assigneeAgentId) {
        await assertAssignableAgent(companyId, data.assigneeAgentId);
      }
      if (data.assigneeUserId) {
        await assertAssignableUser(companyId, data.assigneeUserId);
      }
      if (data.status === "in_progress" && !data.assigneeAgentId && !data.assigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      return db.transaction(async (tx) => {
        if (issueData.parentId) {
          const lockedParent = await assertChildIssueCreationAllowed(
            tx,
            companyId,
            issueData.parentId,
            { lockParent: true },
          );
          const parentPolicy = normalizeIssueExecutionPolicy(lockedParent.executionPolicy);
          if (
            parentPolicy?.factory?.laneKind === "control"
            && initialExecutionPolicy?.factory?.laneKind !== "execution"
          ) {
            throw unprocessable(
              "Children of an AI Factory control issue must be created through the typed execution-lane route.",
              {
                code: "factory_managed_route_required",
                managedRoute: `POST /api/issues/${lockedParent.id}/execution-lanes`,
              },
            );
          }
          if (initialExecutionPolicy?.factory?.laneKind === "execution") {
            if (
              parentPolicy?.factory?.laneKind !== "control"
              || parentPolicy.factory.policyHash !== initialExecutionPolicy.factory.policyHash
              || initialExecutionPolicy.factory.controlIssueId !== lockedParent.id
            ) {
              throw conflict("The execution lane does not match its locked control policy snapshot.", {
                code: "factory_control_snapshot_conflict",
                controlIssueId: lockedParent.id,
                controlPolicyHash: parentPolicy?.factory?.policyHash ?? null,
                lanePolicyHash: initialExecutionPolicy.factory.policyHash,
              });
            }
            const hold = await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(
              companyId,
              lockedParent.id,
            );
            if (hold) {
              throw conflict("AI Factory execution-lane creation is paused by an active issue-tree hold.", {
                code: "factory_execution_paused",
                holdId: hold.holdId,
                rootIssueId: hold.rootIssueId,
              });
            }
          }
        }
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, companyId);
        const projectGoalId = await getProjectDefaultGoalId(tx, companyId, issueData.projectId);
        let projectWorkspaceId = issueData.projectWorkspaceId ?? null;
        let executionWorkspaceId = issueData.executionWorkspaceId ?? null;
        let executionWorkspacePreference = issueData.executionWorkspacePreference ?? null;
        let executionWorkspaceSettings =
          (issueData.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null;
        const workspaceInheritanceIssueId = inheritExecutionWorkspaceFromIssueId ?? issueData.parentId ?? null;
        const hasExplicitExecutionWorkspaceOverride =
          issueData.executionWorkspaceId !== undefined ||
          issueData.executionWorkspacePreference !== undefined ||
          issueData.executionWorkspaceSettings !== undefined;
        if (workspaceInheritanceIssueId) {
          const workspaceSource = await getWorkspaceInheritanceIssue(tx, companyId, workspaceInheritanceIssueId);
          if (projectWorkspaceId == null && workspaceSource.projectWorkspaceId) {
            projectWorkspaceId = workspaceSource.projectWorkspaceId;
          }
          if (
            isolatedWorkspacesEnabled &&
            !hasExplicitExecutionWorkspaceOverride &&
            workspaceSource.executionWorkspaceId
          ) {
            const sourceWorkspace = await tx
              .select({
                id: executionWorkspaces.id,
                mode: executionWorkspaces.mode,
              })
              .from(executionWorkspaces)
              .where(eq(executionWorkspaces.id, workspaceSource.executionWorkspaceId))
              .then((rows) => rows[0] ?? null);
            if (sourceWorkspace) {
              executionWorkspaceId = sourceWorkspace.id;
              executionWorkspacePreference = "reuse_existing";
              executionWorkspaceSettings = {
                ...((workspaceSource.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? {}),
                mode: issueExecutionWorkspaceModeForPersistedWorkspace(sourceWorkspace.mode),
              };
            }
          }
        }
        // Cache the project policy lookup for this insert. Both the
        // default-settings block and the assignee-environment-promotion block
        // need the same row; without caching they'd issue two round-trips.
        let projectPolicyCached: ReturnType<typeof parseProjectExecutionWorkspacePolicy> | null = null;
        let projectPolicyLoaded = false;
        const loadProjectPolicyOnce = async () => {
          if (projectPolicyLoaded) return projectPolicyCached;
          projectPolicyLoaded = true;
          if (!issueData.projectId) return null;
          const projectRow = await tx
            .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
            .from(projects)
            .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          projectPolicyCached = parseProjectExecutionWorkspacePolicy(projectRow?.executionWorkspacePolicy);
          return projectPolicyCached;
        };

        if (
          executionWorkspaceSettings == null &&
          executionWorkspaceId == null &&
          issueData.projectId
        ) {
          executionWorkspaceSettings =
            defaultIssueExecutionWorkspaceSettingsForProject(
              gateProjectExecutionWorkspacePolicy(
                await loadProjectPolicyOnce(),
                isolatedWorkspacesEnabled,
              ),
            ) as Record<string, unknown> | null;
        }
        if (data.assigneeAgentId && isolatedWorkspacesEnabled) {
          const currentWorkspaceSettings = executionWorkspaceSettings == null
            ? {}
            : parseObject(executionWorkspaceSettings);
          const issueHasEnvironmentSelection =
            Object.prototype.hasOwnProperty.call(currentWorkspaceSettings, "environmentId");
          // Don't promote the assignee agent's defaultEnvironmentId if either
          // the issue or the project policy already specifies an environment.
          // resolveExecutionWorkspaceEnvironmentId treats issue settings as
          // higher priority than project policy, so promoting the agent's
          // default to issue settings would invert the documented priority
          // (project policy must win over agent default when explicitly set).
          let projectHasEnvironmentSelection = false;
          if (!issueHasEnvironmentSelection && issueData.projectId) {
            const projectPolicy = await loadProjectPolicyOnce();
            projectHasEnvironmentSelection = projectPolicy?.environmentId !== undefined;
          }
          if (!issueHasEnvironmentSelection && !projectHasEnvironmentSelection) {
            const assigneeAgent = await tx
              .select({ defaultEnvironmentId: agents.defaultEnvironmentId })
              .from(agents)
              .where(and(eq(agents.id, data.assigneeAgentId), eq(agents.companyId, companyId)))
              .then((rows) => rows[0] ?? null);
            if (typeof assigneeAgent?.defaultEnvironmentId === "string" && assigneeAgent.defaultEnvironmentId.length > 0) {
              executionWorkspaceSettings = {
                ...currentWorkspaceSettings,
                environmentId: assigneeAgent.defaultEnvironmentId,
              };
            }
          }
        }
        if (!projectWorkspaceId && issueData.projectId) {
          const project = await tx
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          const projectPolicy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
          projectWorkspaceId = projectPolicy?.defaultProjectWorkspaceId ?? null;
          if (!projectWorkspaceId) {
            projectWorkspaceId = await tx
              .select({ id: projectWorkspaces.id })
              .from(projectWorkspaces)
              .where(and(eq(projectWorkspaces.projectId, issueData.projectId), eq(projectWorkspaces.companyId, companyId)))
              .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
              .then((rows) => rows[0]?.id ?? null);
          }
        }
        if (projectWorkspaceId) {
          await assertValidProjectWorkspace(companyId, issueData.projectId, projectWorkspaceId, tx);
        }
        if (executionWorkspaceId) {
          await assertValidExecutionWorkspace(companyId, issueData.projectId, executionWorkspaceId, tx);
        }
        if (issueData.cycleId) {
          await getAssignableCycle(companyId, issueData.projectId, issueData.cycleId, tx);
        }
        // Self-correcting counter: use MAX(issue_number) + 1 if the counter
        // has drifted below the actual max, preventing identifier collisions.
        const [maxRow] = await tx
          .select({ maxNum: sql<number>`coalesce(max(${issues.issueNumber}), 0)` })
          .from(issues)
          .where(eq(issues.companyId, companyId));
        const currentMax = maxRow?.maxNum ?? 0;

        const [company] = await tx
          .update(companies)
          .set({
            issueCounter: sql`greatest(${companies.issueCounter}, ${currentMax}) + 1`,
          })
          .where(eq(companies.id, companyId))
          .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });

        const issueNumber = company.issueCounter;
        const identifier = `${company.issuePrefix}-${issueNumber}`;

        const values = {
          ...issueData,
          requestDepth: clampIssueRequestDepth(issueData.requestDepth),
          originKind: issueData.originKind ?? "manual",
          goalId: resolveIssueGoalId({
            projectId: issueData.projectId,
            goalId: issueData.goalId,
            projectGoalId,
            defaultGoalId: defaultCompanyGoal?.id ?? null,
          }),
          ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
          ...(executionWorkspaceId ? { executionWorkspaceId } : {}),
          ...(executionWorkspacePreference ? { executionWorkspacePreference } : {}),
          ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
          companyId,
          issueNumber,
          identifier,
        } as typeof issues.$inferInsert;
        if (values.status === "in_progress" && !values.startedAt) {
          values.startedAt = new Date();
        }
        if (values.status === "done") {
          values.completedAt = new Date();
        }
        if (values.status === "cancelled") {
          values.cancelledAt = new Date();
        }
        Object.assign(
          values,
          buildInitialIssueMonitorFields({
            policy: normalizeIssueExecutionPolicy(issueData.executionPolicy ?? null),
            status: values.status ?? "backlog",
            assigneeAgentId: values.assigneeAgentId ?? null,
            assigneeUserId: values.assigneeUserId ?? null,
          }),
        );

        const [issue] = await tx.insert(issues).values(values).returning();
        if (inputLabelIds) {
          await syncIssueLabels(issue.id, companyId, inputLabelIds, tx);
        }
        if (blockedByIssueIds !== undefined) {
          await syncBlockedByIssueIds(
            issue.id,
            companyId,
            blockedByIssueIds,
            {
              agentId: issueData.createdByAgentId ?? null,
              userId: issueData.createdByUserId ?? null,
            },
            tx,
          );
        }
        const [enriched] = await withIssueLabels(tx, [issue]);
        return enriched;
      });
    },

    update: async (
      id: string,
      data: Partial<typeof issues.$inferInsert> & {
        labelIds?: string[];
        blockedByIssueIds?: string[];
        actorAgentId?: string | null;
        actorUserId?: string | null;
        /** Server-internal authorization for the first immutable control snapshot. */
        factoryManagedPolicyPin?: ReturnType<typeof authorizeFactoryManagedPolicyPin>;
        /** Server-internal CAS proof produced by the typed transition route. */
        factoryManagedTransition?: FactoryManagedTransitionAuthorization;
      },
      dbOrTx: any = db,
    ) => {
      const existing = await dbOrTx
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
      if (!existing) return null;

      const {
        labelIds: nextLabelIds,
        blockedByIssueIds,
        actorAgentId,
        actorUserId,
        factoryManagedPolicyPin,
        factoryManagedTransition,
        ...issueData
      } = data;
      const contractFields = resolveExecutionContractFields({
        ...(Object.prototype.hasOwnProperty.call(issueData, "description")
          ? { description: issueData.description }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(issueData, "executionContract")
          ? { executionContract: issueData.executionContract }
          : {}),
      });
      if (Object.prototype.hasOwnProperty.call(contractFields, "description")) {
        issueData.description = contractFields.description ?? null;
      }
      let executionContractWillChange = false;
      if (Object.prototype.hasOwnProperty.call(contractFields, "executionContract")) {
        const preparedContract = prepareUpdatedExecutionContract({
          existing,
          next: contractFields.executionContract ?? null,
        });
        executionContractWillChange = preparedContract.changed;
        if (preparedContract.changed) {
          issueData.executionContract = preparedContract.value;
        } else {
          delete issueData.executionContract;
        }
      }
      const executionPolicyWillChange = Object.prototype.hasOwnProperty.call(issueData, "executionPolicy");
      if (executionPolicyWillChange) {
        const previousPolicy = normalizeIssueExecutionPolicy(existing.executionPolicy);
        const proposedPolicy = normalizeIssueExecutionPolicy(issueData.executionPolicy);
        if (!previousPolicy?.factory && proposedPolicy?.factory) {
          if (
            !factoryManagedPolicyPin
            || factoryManagedPolicyPin.token !== FACTORY_ORCHESTRATION_AUTHORITY
            || factoryManagedPolicyPin.policyHash !== proposedPolicy.factory.policyHash
            || proposedPolicy.factory.laneKind !== "control"
          ) {
            throw unprocessable(
              "AI Factory snapshots can only be attached by the typed execution-lane service.",
              { code: "factory_managed_route_required" },
            );
          }
        } else {
          assertFactoryExecutionPolicySnapshotPreserved({
            previous: existing.executionPolicy,
            next: issueData.executionPolicy,
          });
        }
      }
      const effectiveExecutionPolicy = normalizeIssueExecutionPolicy(
        issueData.executionPolicy !== undefined ? issueData.executionPolicy : existing.executionPolicy,
      );
      assertFactoryIssueAccessBoundaryPreserved({
        existing,
        patch: issueData,
      });
      const factoryStageMutation = effectiveExecutionPolicy?.factory?.laneKind === "execution"
        && factoryExecutionStageMutation({ existing, patch: issueData });
      if (factoryStageMutation) {
        assertFactoryExecutionPolicySnapshotConsistent({
          executionPolicy: effectiveExecutionPolicy,
          expectedControlIssueId: effectiveExecutionPolicy.factory?.controlIssueId ?? undefined,
        });
        const existingState = parseIssueExecutionState(existing.executionState);
        if (
          !factoryManagedTransition
          || factoryManagedTransition.token !== FACTORY_ORCHESTRATION_AUTHORITY
          || factoryManagedTransition.expectedStageRevision !== (existingState?.stageRevision ?? 0)
        ) {
          throw unprocessable(
            "AI Factory execution state can only change through the typed transition service.",
            {
              code: "factory_transition_required",
              expectedStageRevision: existingState?.stageRevision ?? 0,
            },
          );
        }
        const nextState = parseIssueExecutionState(
          issueData.executionState !== undefined ? issueData.executionState : existing.executionState,
        );
        if (
          factoryManagedTransition.decisionId
          && nextState?.lastDecisionId !== factoryManagedTransition.decisionId
        ) {
          throw conflict("Factory transition decision id does not match the execution state.", {
            code: "factory_execution_revision_conflict",
          });
        }
      }
      const parentWillChange = issueData.parentId !== undefined && issueData.parentId !== existing.parentId;
      const nextParentId = issueData.parentId !== undefined ? issueData.parentId : existing.parentId;
      if (
        nextParentId &&
        (parentWillChange || executionContractWillChange) &&
        (existing.createdByAgentId || actorAgentId)
      ) {
        assertDelegatedIssueExecutionContract(
          executionContractWillChange
            ? issueData.executionContract ?? null
            : normalizeExecutionContractValue(existing.executionContract),
          { parentId: nextParentId },
        );
      }
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspaceId;
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }

      if (issueData.status) {
        assertTransition(existing.status, issueData.status);
      }

      const patch: Partial<typeof issues.$inferInsert> = {
        ...issueData,
        updatedAt: new Date(),
      };
      if (issueData.requestDepth !== undefined) {
        patch.requestDepth = clampIssueRequestDepth(issueData.requestDepth);
      }

      const nextAssigneeAgentId =
        issueData.assigneeAgentId !== undefined ? issueData.assigneeAgentId : existing.assigneeAgentId;
      const nextAssigneeUserId =
        issueData.assigneeUserId !== undefined ? issueData.assigneeUserId : existing.assigneeUserId;
      const nextWorkItemType = issueData.workItemType !== undefined ? issueData.workItemType : existing.workItemType;

      if (nextAssigneeAgentId && nextAssigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      assertAgentAssignmentAllowedForWorkItem(nextWorkItemType, nextAssigneeAgentId);
      if (patch.status === "in_progress" && !nextAssigneeAgentId && !nextAssigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      if (patch.status === "in_progress") {
        const unresolvedBlockerIssueIds = blockedByIssueIds !== undefined
          ? await listUnresolvedBlockerIssueIds(dbOrTx, existing.companyId, blockedByIssueIds)
          : (
              await listIssueDependencyReadinessMap(dbOrTx, existing.companyId, [id])
            ).get(id)?.unresolvedBlockerIssueIds ?? [];
        if (unresolvedBlockerIssueIds.length > 0) {
          throw unprocessable("Issue is blocked by unresolved blockers", { unresolvedBlockerIssueIds });
        }
      }
      if (issueData.assigneeAgentId) {
        await assertAssignableAgent(existing.companyId, issueData.assigneeAgentId);
      }
      if (issueData.assigneeUserId) {
        await assertAssignableUser(existing.companyId, issueData.assigneeUserId);
      }
      const nextProjectId = issueData.projectId !== undefined ? issueData.projectId : existing.projectId;
      const nextProjectWorkspaceId =
        issueData.projectWorkspaceId !== undefined ? issueData.projectWorkspaceId : existing.projectWorkspaceId;
      const nextExecutionWorkspaceId =
        issueData.executionWorkspaceId !== undefined ? issueData.executionWorkspaceId : existing.executionWorkspaceId;
      const nextExecutionWorkspacePreference =
        issueData.executionWorkspacePreference !== undefined
          ? issueData.executionWorkspacePreference
          : existing.executionWorkspacePreference;
      const nextExecutionWorkspaceSettings =
        issueData.executionWorkspaceSettings !== undefined
          ? parseIssueExecutionWorkspaceSettings(issueData.executionWorkspaceSettings)
          : parseIssueExecutionWorkspaceSettings(existing.executionWorkspaceSettings);
      if (nextProjectWorkspaceId) {
        await assertValidProjectWorkspace(existing.companyId, nextProjectId, nextProjectWorkspaceId);
      }
      if (nextExecutionWorkspaceId) {
        await assertValidExecutionWorkspace(existing.companyId, nextProjectId, nextExecutionWorkspaceId);
      }
      const nextCycleId = issueData.cycleId !== undefined ? issueData.cycleId : existing.cycleId;
      if (nextCycleId) {
        try {
          await getAssignableCycle(existing.companyId, nextProjectId, nextCycleId, dbOrTx);
        } catch (err) {
          const projectChanged =
            issueData.projectId !== undefined &&
            issueData.projectId !== existing.projectId &&
            issueData.cycleId === undefined;
          if (!projectChanged) throw err;
          patch.cycleId = null;
        }
      }

      applyStatusSideEffects(issueData.status, patch);
      if (issueData.status && issueData.status !== "done") {
        patch.completedAt = null;
      }
      if (issueData.status && issueData.status !== "cancelled") {
        patch.cancelledAt = null;
      }
      if (issueData.status && issueData.status !== "in_progress") {
        patch.checkoutRunId = null;
        // Fix B: also clear the execution lock when leaving in_progress
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }
      if (
        (issueData.assigneeAgentId !== undefined && issueData.assigneeAgentId !== existing.assigneeAgentId) ||
        (issueData.assigneeUserId !== undefined && issueData.assigneeUserId !== existing.assigneeUserId)
      ) {
        patch.checkoutRunId = null;
        // Fix B: clear execution lock on reassignment, matching checkoutRunId clear
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
        // Drop overrides pinned to the prior assignee's adapter (e.g. claude model on codex agent).
        if (issueData.assigneeAdapterOverrides === undefined) {
          patch.assigneeAdapterOverrides = null;
        }
      }

      const completionRequested = issueData.status === "done";
      const factoryExecutionControlIssueId = effectiveExecutionPolicy?.factory?.laneKind === "execution"
        ? effectiveExecutionPolicy.factory.controlIssueId
        : null;
      const runUpdate = async (tx: any) => {
        let factoryDeliveryGatesChecked = false;
        let lockedExisting = existing;
        let lockedFactoryControl: typeof issues.$inferSelect | null = null;
        if (factoryExecutionControlIssueId) {
          // Factory topology mutations lock control before lane everywhere.
          // This serializes lane reopen against control completion/lane creation
          // and avoids parent-child lock inversion.
          lockedFactoryControl = await tx
            .select()
            .from(issues)
            .where(and(
              eq(issues.id, factoryExecutionControlIssueId),
              eq(issues.companyId, existing.companyId),
            ))
            .for("update")
            .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
          const controlPolicy = normalizeIssueExecutionPolicy(lockedFactoryControl?.executionPolicy);
          if (
            !lockedFactoryControl
            || controlPolicy?.factory?.laneKind !== "control"
            || controlPolicy.factory.policyHash !== effectiveExecutionPolicy?.factory?.policyHash
          ) {
            throw conflict("AI Factory execution lane has no matching locked control issue.", {
              code: "factory_control_snapshot_conflict",
              controlIssueId: factoryExecutionControlIssueId,
              issueId: existing.id,
            });
          }
        }
        // Every issue update takes the row lock before consulting cancel holds.
        // If a subtree cancel wins the lock, a stale update cannot commit after
        // the atomic cancel and silently revive or alter the issue.
        const lockedRow = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.id, id), eq(issues.companyId, existing.companyId)))
          .for("update")
          .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
        if (!lockedRow) return null;
        lockedExisting = lockedRow;
        const lockedExistingPolicy = normalizeIssueExecutionPolicy(lockedExisting.executionPolicy);
        // Re-evaluate against the locked row. This closes the race where a
        // factory snapshot is pinned after the optimistic read but before a
        // stale generic update attempts to move or declassify the issue.
        assertFactoryIssueAccessBoundaryPreserved({
          existing: lockedExisting,
          patch: issueData,
        });
        if (
          lockedExistingPolicy?.factory?.laneKind === "control"
          && ["done", "cancelled"].includes(lockedExisting.status)
          && (
            (issueData.status !== undefined && issueData.status !== lockedExisting.status)
            || blockedByIssueIds !== undefined
          )
        ) {
          throw conflict("Terminal AI Factory control topology is immutable.", {
            code: "factory_control_terminal",
            controlIssueId: lockedExisting.id,
            status: lockedExisting.status,
          });
        }
        if (
          lockedExistingPolicy?.factory?.laneKind === "control"
          && issueData.status === "cancelled"
          && lockedExisting.status !== "cancelled"
        ) {
          throw conflict(
            "AI Factory control issues must be cancelled through typed subtree control.",
            {
              code: "factory_tree_control_required",
              controlIssueId: lockedExisting.id,
              managedRoute: `/api/issues/${lockedExisting.id}/tree-control`,
            },
          );
        }
        const treeControl = issueTreeControlService(tx as Db);
        if (lockedExistingPolicy?.factory) {
          const activePauseHold = await treeControl.getActivePauseHoldGate(
            lockedExisting.companyId,
            lockedExisting.id,
          );
          if (activePauseHold) {
            throw conflict("AI Factory issue mutation is blocked by an active subtree pause hold", {
              code: "issue_tree_paused",
              holdId: activePauseHold.holdId,
              rootIssueId: activePauseHold.rootIssueId,
              issueId: lockedExisting.id,
            });
          }
        }
        const activeCancelHold = await treeControl.getActiveCancelHoldGate(
          lockedExisting.companyId,
          lockedExisting.id,
        );
        if (activeCancelHold) {
          throw conflict("Issue mutation is blocked by an active subtree cancel hold", {
            code: "issue_tree_cancelled",
            holdId: activeCancelHold.holdId,
            rootIssueId: activeCancelHold.rootIssueId,
            issueId: lockedExisting.id,
          });
        }
        if (
          lockedFactoryControl
          && ["done", "cancelled"].includes(lockedFactoryControl.status)
          && ["done", "cancelled"].includes(lockedExisting.status)
          && issueData.status !== undefined
          && !["done", "cancelled"].includes(issueData.status)
        ) {
          throw conflict("A factory lane cannot reopen after its control issue is terminal.", {
            code: "factory_control_terminal",
            controlIssueId: lockedFactoryControl.id,
            controlStatus: lockedFactoryControl.status,
            issueId: lockedExisting.id,
          });
        }
        if (blockedByIssueIds !== undefined) {
          await assertFactoryControlBlockerEdgesPreserved({
            executor: tx as Db,
            controlIssue: lockedExisting,
            proposedBlockerIssueIds: blockedByIssueIds,
          });
        }
        if (executionPolicyWillChange) {
          const lockedPolicy = normalizeIssueExecutionPolicy(lockedExisting.executionPolicy);
          const proposedPolicy = normalizeIssueExecutionPolicy(issueData.executionPolicy);
          if (lockedPolicy?.factory) {
            assertFactoryExecutionPolicySnapshotPreserved({
              previous: lockedExisting.executionPolicy,
              next: issueData.executionPolicy,
            });
          } else if (proposedPolicy?.factory) {
            if (
              !factoryManagedPolicyPin
              || factoryManagedPolicyPin.token !== FACTORY_ORCHESTRATION_AUTHORITY
              || factoryManagedPolicyPin.policyHash !== proposedPolicy.factory.policyHash
              || proposedPolicy.factory.laneKind !== "control"
            ) {
              throw unprocessable(
                "AI Factory snapshots can only be attached by the typed execution-lane service.",
                { code: "factory_managed_route_required" },
              );
            }
          }
        }
        if (factoryStageMutation) {
          if (
            lockedExisting.status !== existing.status
            || lockedExisting.assigneeAgentId !== existing.assigneeAgentId
            || lockedExisting.assigneeUserId !== existing.assigneeUserId
            || !isDeepStrictEqual(lockedExisting.executionState, existing.executionState)
          ) {
            throw conflict("AI Factory execution state changed while this transition was being applied.", {
              code: "factory_execution_revision_conflict",
              expectedStageRevision: factoryManagedTransition?.expectedStageRevision ?? null,
              currentStageRevision: parseIssueExecutionState(lockedExisting.executionState)?.stageRevision ?? 0,
            });
          }
          const hold = await issueTreeControlService(tx as Db).getActivePauseHoldGate(
            lockedExisting.companyId,
            lockedExisting.id,
          );
          if (hold) {
            throw conflict("This AI Factory lane is paused by an active issue-tree hold.", {
              code: "issue_tree_paused",
              holdId: hold.holdId,
              rootIssueId: hold.rootIssueId,
            });
          }

          const nextState = parseIssueExecutionState(
            issueData.executionState !== undefined ? issueData.executionState : lockedExisting.executionState,
          );
          const previousState = parseIssueExecutionState(lockedExisting.executionState);
          const nextStage = nextState?.currentStageId
            ? effectiveExecutionPolicy.stages.find((stage) => stage.id === nextState.currentStageId) ?? null
            : null;
          const enteringDeploymentStage = nextStage?.type === "deployment"
            && previousState?.currentStageId !== nextState?.currentStageId;
          const requiresIrreversibleActionApproval = enteringDeploymentStage
            && effectiveExecutionPolicy.factory?.production === true
            && effectiveExecutionPolicy.factory.policySnapshot?.productionAuthority
              .requireBoardApprovalForIrreversibleActions === true;
          let lockedDeliverySnapshot: Awaited<ReturnType<ReturnType<typeof deliveryService>["getSnapshot"]>> | null = null;
          const getLockedDeliverySnapshot = async () => {
            if (lockedDeliverySnapshot) return lockedDeliverySnapshot;
            // The approval target and the evidence gates must observe the same
            // immutable candidate while this issue transition is committed.
            await acquireIssueDeliveryLock(tx as Db, lockedExisting.companyId, lockedExisting.id);
            lockedDeliverySnapshot = await deliveryService(tx as Db).getSnapshot(
              lockedExisting.companyId,
              lockedExisting.id,
            );
            return lockedDeliverySnapshot;
          };
          if (requiresIrreversibleActionApproval) {
            const snapshot = await getLockedDeliverySnapshot();
            await assertFactoryIrreversibleActionApproval({
              executor: tx as Db,
              companyId: lockedExisting.companyId,
              issueId: lockedExisting.id,
              candidateSha: snapshot.candidateSha,
            });
          }
          const newlyCompletedStageIds = (nextState?.completedStageIds ?? [])
            .filter((stageId) => !(previousState?.completedStageIds ?? []).includes(stageId));
          if (newlyCompletedStageIds.length > 0) {
            const completedStageIds = new Set(nextState?.completedStageIds ?? []);
            const gatedStages = effectiveExecutionPolicy.stages
              .filter((stage) => completedStageIds.has(stage.id));
            const newlyAcceptedStage = effectiveExecutionPolicy.stages.find((stage) =>
              newlyCompletedStageIds.includes(stage.id)
              && (stage.key === "technical_acceptance" || stage.key === "final_acceptance"));
            if (newlyAcceptedStage) {
              if (
                !factoryManagedTransition?.decisionId
                || nextState?.lastDecisionId !== factoryManagedTransition.decisionId
                || nextState.lastDecisionOutcome !== "approved"
                || previousState?.currentStageId !== newlyAcceptedStage.id
                || !previousState.currentParticipant
              ) {
                throw conflict("Factory acceptance must be backed by the current typed approval decision.", {
                  code: "factory_acceptance_decision_required",
                  stageId: newlyAcceptedStage.id,
                  stageKey: newlyAcceptedStage.key,
                });
              }
              const snapshot = await getLockedDeliverySnapshot();
              if (!snapshot.candidateSha) {
                throw unprocessable("Factory acceptance requires an exact implementation candidate.", {
                  code: "factory_candidate_required",
                  stageId: newlyAcceptedStage.id,
                });
              }
              const isFinalAcceptance = newlyAcceptedStage.key === "final_acceptance";
              const deployment = snapshot.stages.deployment;
              if (
                isFinalAcceptance
                && (
                  deployment.state !== "succeeded"
                  || deployment.authority !== "provider_verified"
                  || deployment.stale
                  || deployment.environment?.trim().toLowerCase() !== "production"
                  || !deployment.providerExternalId
                  || !deployment.providerUrl
                )
              ) {
                throw conflict("Final acceptance requires the exact provider-verified production deployment target.", {
                  code: "factory_final_acceptance_target_required",
                  stageId: newlyAcceptedStage.id,
                });
              }
              const acceptanceDeliveryStage = isFinalAcceptance
                ? "business_acceptance" as const
                : "technical_acceptance" as const;
              const participant = previousState.currentParticipant;
              await deliveryService(tx as Db).appendPaperclipAction(
                lockedExisting.companyId,
                lockedExisting.id,
                {
                  stage: acceptanceDeliveryStage,
                  state: "accepted",
                  candidateSha: snapshot.candidateSha,
                  environment: isFinalAcceptance ? "production" : snapshot.environment,
                  provider: isFinalAcceptance ? deployment.provider : null,
                  providerExternalId: isFinalAcceptance ? deployment.providerExternalId : null,
                  providerUrl: isFinalAcceptance ? deployment.providerUrl : null,
                  summary: isFinalAcceptance
                    ? "Paperclip recorded final business acceptance for the verified production candidate"
                    : "Paperclip recorded technical acceptance for the verified candidate",
                  metadata: {
                    decisionId: factoryManagedTransition.decisionId,
                    acceptanceKind: acceptanceDeliveryStage,
                    paperclipFactory: {
                      version: 1,
                      stageId: newlyAcceptedStage.id,
                      stageKey: newlyAcceptedStage.key ?? null,
                      stageRevision: previousState.stageRevision ?? 0,
                      stageActivatedAt: previousState.currentStageActivatedAt ?? null,
                      participant: {
                        type: participant.type,
                        agentId: participant.type === "agent" ? participant.agentId ?? null : null,
                        userId: participant.type === "user" ? participant.userId ?? null : null,
                      },
                    },
                    ...(isFinalAcceptance ? {
                      verifiedDeploymentEventId: deployment.eventId,
                      verifiedDeploymentTarget: {
                        environment: "production",
                        provider: deployment.provider,
                        externalId: deployment.providerExternalId,
                        url: deployment.providerUrl,
                      },
                    } : {}),
                  },
                  observedAt: new Date(),
                  sourceFingerprint: [
                    "factory-acceptance",
                    lockedExisting.id,
                    newlyAcceptedStage.id,
                    String(previousState.stageRevision ?? 0),
                    factoryManagedTransition.decisionId,
                  ].join(":"),
                },
                actorUserId
                  ? { actorType: "user", userId: actorUserId }
                  : actorAgentId
                    ? { actorType: "agent", agentId: actorAgentId }
                    : { actorType: "system" },
              );
              // The acceptance event was appended inside this transaction;
              // force gate evaluation to project the new immutable ledger row.
              lockedDeliverySnapshot = null;
            }
            const gates = [...new Set(gatedStages.flatMap((stage) => stage.evidenceGates ?? []))];
            if (gates.length > 0 && nextState) {
              // Delivery mutations, corrections, and workflow advancement share
              // this lock. No contradictory event can land between this read
              // and the issue-state commit below.
              const snapshot = await getLockedDeliverySnapshot();
              const expectations = buildFactoryDeliveryEvidenceExpectations({
                policy: effectiveExecutionPolicy,
                state: nextState,
                candidateSha: snapshot.candidateSha,
              });
              const missing = evaluateDeliveryEvidenceGates(snapshot, gates, expectations)
                .filter((result) => !result.satisfied);
              if (missing.length > 0) {
                throw unprocessable(
                  "The AI Factory lane cannot advance until all completed-stage delivery evidence gates pass.",
                  {
                    code: "delivery_evidence_gate_unsatisfied",
                    newlyCompletedStageIds,
                    requiredStageKeys: gatedStages.map((stage) => stage.key ?? stage.id),
                    snapshotRevision: snapshot.revision,
                    missing,
                  },
                );
              }
            }
            factoryDeliveryGatesChecked = true;
          }
        }
        if (executionContractWillChange) {
          if (!isDeepStrictEqual(lockedExisting.executionContract, existing.executionContract)) {
            throw conflict("executionContract changed while this revision was being updated", {
              code: "execution_contract_revision_conflict",
            });
          }
          if (issueExecutionContractIsFrozen(lockedExisting)) {
            throw conflict(
              "executionContract is frozen once issue execution begins; create a replacement issue for a superseding contract",
              {
                code: "execution_contract_frozen",
                currentRevision:
                  executionContractRevision(normalizeExecutionContractValue(lockedExisting.executionContract)) ?? 1,
              },
            );
          }
        }
        if (parentWillChange) {
          if (lockedExisting.parentId !== existing.parentId) {
            throw conflict("Issue parent changed while this topology update was being applied", {
              code: "issue_parent_conflict",
            });
          }
          if (nextParentId) {
            await assertIssueParentUpdateAllowed(tx, lockedExisting, nextParentId, { lockRows: true });
          }
        }
        if (completionRequested && lockedExisting.status !== "done") {
          if (effectiveExecutionPolicy?.factory?.laneKind === "execution") {
            const nextState = parseIssueExecutionState(
              issueData.executionState !== undefined ? issueData.executionState : lockedExisting.executionState,
            );
            assertFactoryCompletionState({ policy: effectiveExecutionPolicy, state: nextState });
            const gates = [...new Set(effectiveExecutionPolicy.stages.flatMap((stage) => stage.evidenceGates ?? []))];
            if (gates.length > 0 && !factoryDeliveryGatesChecked) {
              await acquireIssueDeliveryLock(tx as Db, lockedExisting.companyId, lockedExisting.id);
              const snapshot = await deliveryService(tx as Db).getSnapshot(
                lockedExisting.companyId,
                lockedExisting.id,
              );
              const expectations = nextState
                ? buildFactoryDeliveryEvidenceExpectations({
                    policy: effectiveExecutionPolicy,
                    state: nextState,
                    candidateSha: snapshot.candidateSha,
                  })
                : {};
              const missing = evaluateDeliveryEvidenceGates(snapshot, gates, expectations)
                .filter((result) => !result.satisfied);
              if (missing.length > 0) {
                throw unprocessable(
                  "AI Factory completion requires current delivery evidence for every completed stage.",
                  {
                    code: "delivery_evidence_gate_unsatisfied",
                    snapshotRevision: snapshot.revision,
                    missing,
                  },
                );
              }
            }
          } else if (effectiveExecutionPolicy?.factory?.laneKind === "control") {
            await assertFactoryControlCompletion({
              executor: tx as Db,
              controlIssue: lockedExisting,
            });
          } else {
            await assertIssueCompletionEvidence(tx, {
              companyId: lockedExisting.companyId,
              issueId: lockedExisting.id,
              executionContract: executionContractWillChange
                ? normalizeExecutionContractValue(issueData.executionContract)
                : normalizeExecutionContractValue(lockedExisting.executionContract),
            });
          }
        }

        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, existing.companyId);
        const [currentProjectGoalId, nextProjectGoalId] = await Promise.all([
          getProjectDefaultGoalId(tx, existing.companyId, existing.projectId),
          getProjectDefaultGoalId(
            tx,
            existing.companyId,
            issueData.projectId !== undefined ? issueData.projectId : existing.projectId,
          ),
        ]);

        // Mirror the create() path: when the assignee changes to a non-null
        // agent, default the issue's executionWorkspaceSettings.environmentId
        // to the new agent's defaultEnvironmentId. Skip when:
        //   - this update explicitly sets executionWorkspaceSettings.environmentId
        //     (caller is making a deliberate override; respect it), OR
        //   - the project policy already specifies an environmentId (project
        //     policy must win over agent default per the documented priority
        //     order in resolveExecutionWorkspaceEnvironmentId), OR
        //   - the issue already has an environmentId that was *not* the prior
        //     assignee's default (i.e., the operator set it explicitly in an
        //     earlier update; preserve their choice). When the existing
        //     environmentId matches the prior assignee's default, treat it as
        //     auto-promoted and refresh it to the new assignee's default.
        const assigneeChanged =
          issueData.assigneeAgentId !== undefined &&
          issueData.assigneeAgentId !== null &&
          issueData.assigneeAgentId !== existing.assigneeAgentId;
        const explicitEnvInThisUpdate =
          issueData.executionWorkspaceSettings !== undefined &&
          Object.prototype.hasOwnProperty.call(
            parseObject(issueData.executionWorkspaceSettings),
            "environmentId",
          );
        if (assigneeChanged && isolatedWorkspacesEnabled && !explicitEnvInThisUpdate) {
          let projectHasEnvironmentSelection = false;
          if (nextProjectId) {
            const projectRow = await tx
              .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
              .from(projects)
              .where(and(eq(projects.id, nextProjectId), eq(projects.companyId, existing.companyId)))
              .then((rows: Array<{ executionWorkspacePolicy: unknown }>) => rows[0] ?? null);
            const projectPolicy = parseProjectExecutionWorkspacePolicy(projectRow?.executionWorkspacePolicy);
            projectHasEnvironmentSelection = projectPolicy?.environmentId !== undefined;
          }
          if (!projectHasEnvironmentSelection) {
            const baseSettings = nextExecutionWorkspaceSettings == null
              ? {}
              : parseObject(nextExecutionWorkspaceSettings);
            const existingEnvId = typeof baseSettings.environmentId === "string"
              ? baseSettings.environmentId
              : null;

            // Look up both the prior assignee (to detect auto-promoted env)
            // and the new assignee in a single query.
            type AgentRow = { id: string; defaultEnvironmentId: string | null };
            const agentRows: AgentRow[] = await tx
              .select({ id: agents.id, defaultEnvironmentId: agents.defaultEnvironmentId })
              .from(agents)
              .where(
                and(
                  eq(agents.companyId, existing.companyId),
                  inArray(
                    agents.id,
                    [issueData.assigneeAgentId!, existing.assigneeAgentId].filter(
                      (value): value is string => typeof value === "string",
                    ),
                  ),
                ),
              );

            const newAssignee = agentRows.find((row: AgentRow) => row.id === issueData.assigneeAgentId);
            const previousAssignee = existing.assigneeAgentId
              ? agentRows.find((row: AgentRow) => row.id === existing.assigneeAgentId)
              : null;

            const newDefaultEnvId =
              typeof newAssignee?.defaultEnvironmentId === "string" && newAssignee.defaultEnvironmentId.length > 0
                ? newAssignee.defaultEnvironmentId
                : null;
            const previousDefaultEnvId =
              typeof previousAssignee?.defaultEnvironmentId === "string" && previousAssignee.defaultEnvironmentId.length > 0
                ? previousAssignee.defaultEnvironmentId
                : null;

            const existingEnvWasAutoPromoted =
              existingEnvId === null ||
              (previousDefaultEnvId !== null && existingEnvId === previousDefaultEnvId);

            if (newDefaultEnvId && existingEnvWasAutoPromoted) {
              patch.executionWorkspaceSettings = {
                ...baseSettings,
                environmentId: newDefaultEnvId,
              };
            }
          }
        }

        patch.goalId = resolveNextIssueGoalId({
          currentProjectId: existing.projectId,
          currentGoalId: existing.goalId,
          currentProjectGoalId,
          projectId: issueData.projectId,
          goalId: issueData.goalId,
          projectGoalId: nextProjectGoalId,
          defaultGoalId: defaultCompanyGoal?.id ?? null,
        });
        const executionContractCompareAndSwap = executionContractWillChange
          ? existing.executionContract == null
            ? and(eq(issues.id, id), isNull(issues.executionContract))
            : and(eq(issues.id, id), eq(issues.executionContract, existing.executionContract))
          : eq(issues.id, id);
        const updated = await tx
          .update(issues)
          .set(patch)
          .where(executionContractCompareAndSwap)
          .returning()
          .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
        if (!updated) {
          if (executionContractWillChange) {
            throw conflict("executionContract changed while this revision was being updated", {
              code: "execution_contract_revision_conflict",
            });
          }
          return null;
        }
        if (nextLabelIds !== undefined) {
          await syncIssueLabels(updated.id, existing.companyId, nextLabelIds, tx);
        }
        if (blockedByIssueIds !== undefined) {
          await syncBlockedByIssueIds(
            updated.id,
            existing.companyId,
            blockedByIssueIds,
            {
              agentId: actorAgentId ?? null,
              userId: actorUserId ?? null,
            },
            tx,
          );
        }
        if (
          issueData.executionWorkspaceSettings !== undefined &&
          nextExecutionWorkspaceId &&
          nextExecutionWorkspacePreference === "reuse_existing"
        ) {
          const workspace = await tx
            .select({
              id: executionWorkspaces.id,
              metadata: executionWorkspaces.metadata,
            })
            .from(executionWorkspaces)
            .where(
              and(
                eq(executionWorkspaces.id, nextExecutionWorkspaceId),
                eq(executionWorkspaces.companyId, existing.companyId),
              ),
            )
            .then((rows: Array<{ id: string; metadata: unknown }>) => rows[0] ?? null);
          if (workspace) {
            await tx
              .update(executionWorkspaces)
              .set({
                metadata: mergeExecutionWorkspaceConfig(
                  (workspace.metadata as Record<string, unknown> | null) ?? null,
                  buildReusedExecutionWorkspaceConfigPatchFromIssueSettings(nextExecutionWorkspaceSettings),
                ),
                updatedAt: new Date(),
              })
              .where(eq(executionWorkspaces.id, workspace.id));
          }
        }
        const [enriched] = await withIssueLabels(tx, [updated]);
        return enriched;
      };

      return dbOrTx === db ? db.transaction(runUpdate) : runUpdate(dbOrTx);
    },

    clearExecutionWorkspaceEnvironmentSelection: async (companyId: string, environmentId: string) => {
      const rows = await db
        .select({
          id: issues.id,
          executionWorkspaceSettings: issues.executionWorkspaceSettings,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId));

      let cleared = 0;
      for (const row of rows) {
        const settings = parseIssueExecutionWorkspaceSettings(row.executionWorkspaceSettings);
        if (settings?.environmentId !== environmentId) continue;

        await db
          .update(issues)
          .set({
            executionWorkspaceSettings: {
              ...settings,
              environmentId: null,
            },
            updatedAt: new Date(),
          })
          .where(eq(issues.id, row.id));
        cleared += 1;
      }

      return cleared;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        const lockedIssue = await tx
          .select()
          .from(issues)
          .where(eq(issues.id, id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedIssue) return null;
        if (normalizeIssueExecutionPolicy(lockedIssue.executionPolicy)?.factory) {
          throw conflict(
            "AI Factory control and execution issues cannot be deleted through the generic issue API.",
            {
              code: "factory_teardown_required",
              issueId: lockedIssue.id,
            },
          );
        }
        const treeControl = issueTreeControlService(tx as unknown as Db);
        const pauseHold = await treeControl.getActivePauseHoldGate(
          lockedIssue.companyId,
          lockedIssue.id,
        );
        if (pauseHold) {
          throw conflict("Issue deletion is blocked by an active subtree pause hold", {
            code: "issue_tree_paused",
            holdId: pauseHold.holdId,
            rootIssueId: pauseHold.rootIssueId,
            issueId: lockedIssue.id,
          });
        }
        const cancelHold = await treeControl.getActiveCancelHoldGate(
          lockedIssue.companyId,
          lockedIssue.id,
        );
        if (cancelHold) {
          throw conflict("Issue deletion is blocked by an active subtree cancel hold", {
            code: "issue_tree_cancelled",
            holdId: cancelHold.holdId,
            rootIssueId: cancelHold.rootIssueId,
            issueId: lockedIssue.id,
          });
        }
        const attachmentAssetIds = await tx
          .select({ assetId: issueAttachments.assetId })
          .from(issueAttachments)
          .where(eq(issueAttachments.issueId, id));
        const issueDocumentIds = await tx
          .select({ documentId: issueDocuments.documentId })
          .from(issueDocuments)
          .where(eq(issueDocuments.issueId, id));

        const removedIssue = await tx
          .delete(issues)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (removedIssue && attachmentAssetIds.length > 0) {
          await tx
            .delete(assets)
            .where(inArray(assets.id, attachmentAssetIds.map((row) => row.assetId)));
        }

        if (removedIssue && issueDocumentIds.length > 0) {
          await tx
            .delete(documents)
            .where(inArray(documents.id, issueDocumentIds.map((row) => row.documentId)));
        }

        if (!removedIssue) return null;
        const [enriched] = await withIssueLabels(tx, [removedIssue]);
        return enriched;
      }),

    checkout: async (id: string, agentId: string, expectedStatuses: string[], checkoutRunId: string | null) => {
      const issueCompany = await db
        .select({ companyId: issues.companyId, workItemType: issues.workItemType })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!issueCompany) throw notFound("Issue not found");
      assertAgentAssignmentAllowedForWorkItem(issueCompany.workItemType, agentId);
      await assertAssignableAgent(issueCompany.companyId, agentId);

      const now = new Date();
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issueCompany.companyId, id);
      if (
        activePauseHold &&
        !(await isTreeHoldInteractionCheckoutAllowed(issueCompany.companyId, checkoutRunId, activePauseHold))
      ) {
        throw conflict("Issue checkout blocked by active subtree pause hold", {
          issueId: id,
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
          securityPrinciples: ["Complete Mediation", "Fail Securely", "Secure Defaults"],
        });
      }

      await clearExecutionRunIfTerminal(id);

      const dependencyReadiness = await listIssueDependencyReadinessMap(db, issueCompany.companyId, [id]);
      const unresolvedBlockerIssueIds = dependencyReadiness.get(id)?.unresolvedBlockerIssueIds ?? [];
      if (unresolvedBlockerIssueIds.length > 0) {
        throw unprocessable("Issue is blocked by unresolved blockers", { unresolvedBlockerIssueIds });
      }

      const sameRunAssigneeCondition = checkoutRunId
        ? and(
          eq(issues.assigneeAgentId, agentId),
          or(isNull(issues.checkoutRunId), eq(issues.checkoutRunId, checkoutRunId)),
        )
        : and(eq(issues.assigneeAgentId, agentId), isNull(issues.checkoutRunId));
      const executionLockCondition = checkoutRunId
        ? or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId))
        : isNull(issues.executionRunId);
      const updated = await db
        .update(issues)
        .set({
          assigneeAgentId: agentId,
          assigneeUserId: null,
          checkoutRunId,
          executionRunId: checkoutRunId,
          status: "in_progress",
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, id),
            inArray(issues.status, expectedStatuses),
            or(isNull(issues.assigneeAgentId), sameRunAssigneeCondition),
            executionLockCondition,
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);

      if (updated) {
        const [enriched] = await withIssueLabels(db, [updated]);
        return enriched;
      }

      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === checkoutRunId) &&
        checkoutRunId
      ) {
        const adopted = await db
          .update(issues)
          .set({
            checkoutRunId,
            executionRunId: checkoutRunId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issues.id, id),
              eq(issues.status, "in_progress"),
              eq(issues.assigneeAgentId, agentId),
              isNull(issues.checkoutRunId),
              or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId)),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (adopted) return adopted;
      }

      if (
        checkoutRunId &&
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId &&
        current.checkoutRunId !== checkoutRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId: agentId,
          actorRunId: checkoutRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });
        if (adopted) {
          const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0] ?? null);
          if (!row) throw notFound("Issue not found");
          const [enriched] = await withIssueLabels(db, [row]);
          return enriched;
        }
      }

      // If this run already owns it and it's in_progress, return it (no self-409)
      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        sameRunLock(current.checkoutRunId, checkoutRunId)
      ) {
        const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Issue not found");
        const [enriched] = await withIssueLabels(db, [row]);
        return enriched;
      }

      throw conflict("Issue checkout conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
      });
    },

    assertCheckoutOwner: async (id: string, actorAgentId: string, actorRunId: string | null) => {
      await clearExecutionRunIfTerminal(id);
      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        sameRunLock(current.checkoutRunId, actorRunId)
      ) {
        return { ...current, adoptedFromRunId: null as string | null };
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === actorRunId)
      ) {
        const adopted = await adoptUnownedCheckoutRun({
          issueId: id,
          actorAgentId,
          actorRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: null as string | null,
          };
        }
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId &&
        current.checkoutRunId !== actorRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId,
          actorRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: current.checkoutRunId,
          };
        }
      }

      throw conflict("Issue run ownership conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
        actorAgentId,
        actorRunId,
      });
    },

    release: async (id: string, actorAgentId?: string, actorRunId?: string | null) => {
      await clearExecutionRunIfTerminal(id);
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;
      if (actorAgentId && existing.assigneeAgentId && existing.assigneeAgentId !== actorAgentId) {
        throw conflict("Only assignee can release issue");
      }
      if (
        actorAgentId &&
        existing.status === "in_progress" &&
        existing.assigneeAgentId === actorAgentId &&
        existing.checkoutRunId &&
        !sameRunLock(existing.checkoutRunId, actorRunId ?? null)
      ) {
        const stale = await isTerminalOrMissingHeartbeatRun(existing.checkoutRunId);
        if (!stale) {
          throw conflict("Only checkout run can release issue", {
            issueId: existing.id,
            assigneeAgentId: existing.assigneeAgentId,
            checkoutRunId: existing.checkoutRunId,
            actorRunId: actorRunId ?? null,
          });
        }
      }

      const updated = await db
        .update(issues)
        .set({
          status: "todo",
          assigneeAgentId: null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      const [enriched] = await withIssueLabels(db, [updated]);
      return enriched;
    },

    adminForceRelease: async (id: string, options: { clearAssignee?: boolean } = {}) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${issues.id} from ${issues} where ${issues.id} = ${id} for update`,
        );
        const existing = await tx
          .select({
            id: issues.id,
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(eq(issues.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const patch: Partial<typeof issues.$inferInsert> = {
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        };
        if (options.clearAssignee) {
          patch.assigneeAgentId = null;
        }

        const updated = await tx
          .update(issues)
          .set(patch)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        const [enriched] = await withIssueLabels(tx, [updated]);
        return {
          issue: enriched,
          previous: {
            checkoutRunId: existing.checkoutRunId,
            executionRunId: existing.executionRunId,
          },
        };
      }),

    listLabels: (companyId: string) =>
      db.select().from(labels).where(eq(labels.companyId, companyId)).orderBy(asc(labels.name), asc(labels.id)),

    getLabelById: (id: string) =>
      db
        .select()
        .from(labels)
        .where(eq(labels.id, id))
        .then((rows) => rows[0] ?? null),

    createLabel: async (companyId: string, data: Pick<typeof labels.$inferInsert, "name" | "color">) => {
      const [created] = await db
        .insert(labels)
        .values({
          companyId,
          name: data.name.trim(),
          color: data.color,
        })
        .returning();
      return created;
    },

    deleteLabel: async (id: string) =>
      db
        .delete(labels)
        .where(eq(labels.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listComments: async (
      issueId: string,
      opts?: {
        afterCommentId?: string | null;
        order?: "asc" | "desc";
        limit?: number | null;
      },
    ) => {
      const order = opts?.order === "asc" ? "asc" : "desc";
      const afterCommentId = opts?.afterCommentId?.trim() || null;
      const limit =
        opts?.limit && opts.limit > 0
          ? Math.min(Math.floor(opts.limit), MAX_ISSUE_COMMENT_PAGE_LIMIT)
          : null;

      const conditions = [eq(issueComments.issueId, issueId)];
      if (afterCommentId) {
        const anchor = await db
          .select({
            id: issueComments.id,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, issueId), eq(issueComments.id, afterCommentId)))
          .then((rows) => rows[0] ?? null);

        if (!anchor) return [];
        conditions.push(
          order === "asc"
            ? or(
                gt(issueComments.createdAt, anchor.createdAt),
                and(eq(issueComments.createdAt, anchor.createdAt), gt(issueComments.id, anchor.id)),
              )!
            : or(
                lt(issueComments.createdAt, anchor.createdAt),
                and(eq(issueComments.createdAt, anchor.createdAt), lt(issueComments.id, anchor.id)),
              )!,
        );
      }

      const query = db
        .select()
        .from(issueComments)
        .where(and(...conditions))
        .orderBy(
          order === "asc" ? asc(issueComments.createdAt) : desc(issueComments.createdAt),
          order === "asc" ? asc(issueComments.id) : desc(issueComments.id),
        );

      const comments = limit ? await query.limit(limit) : await query;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      const enrichedComments = await enrichCommentsWithDerivedAgentAttribution(comments);
      const commentsWithAttachments = await attachIssueAttachmentsToComments(enrichedComments);
      return commentsWithAttachments.map((comment) => redactIssueComment(comment, censorUsernameInLogs));
    },

    getCommentCursor: async (issueId: string) => {
      const [latest, countRow] = await Promise.all([
        db
          .select({
            latestCommentId: issueComments.id,
            latestCommentAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({
            totalComments: sql<number>`count(*)::int`,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        totalComments: Number(countRow?.totalComments ?? 0),
        latestCommentId: latest?.latestCommentId ?? null,
        latestCommentAt: latest?.latestCommentAt ?? null,
      };
    },

    getComment: async (commentId: string) => {
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      const comment = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .then((rows) => rows[0] ?? null);
      if (!comment) return null;
      const [enrichedComment] = await enrichCommentsWithDerivedAgentAttribution([comment]);
      const [commentWithAttachments] = await attachIssueAttachmentsToComments([enrichedComment ?? comment]);
      return redactIssueComment(commentWithAttachments ?? { ...comment, attachments: [] }, censorUsernameInLogs);
    },

    removeComment: async (commentId: string) => {
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };

      return db.transaction(async (tx) => {
        const [comment] = await tx
          .delete(issueComments)
          .where(eq(issueComments.id, commentId))
          .returning();

        if (!comment) return null;

        await tx
          .update(issues)
          .set({ updatedAt: new Date() })
          .where(eq(issues.id, comment.issueId));

        return redactIssueComment(comment, currentUserRedactionOptions.enabled);
      });
    },

    addComment: async (
      issueId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null },
      options?: {
        authorType?: IssueCommentAuthorType | null;
        presentation?: IssueCommentPresentation | null;
        metadata?: IssueCommentMetadata | null;
        createdAt?: Date | string | null;
      },
    ) => {
      const issue = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      if (!issue) throw notFound("Issue not found");

      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      const authorType = issueCommentAuthorTypeSchema.parse(
        options?.authorType ?? (actor.agentId ? "agent" : actor.userId ? "user" : "system"),
      );
      assertIssueCommentAuthorTypeAllowed(actor, authorType);
      const presentation = issueCommentPresentationSchema.nullable().parse(options?.presentation ?? null);
      const metadata = issueCommentMetadataSchema.nullable().parse(options?.metadata ?? null);
      const createdAt = options?.createdAt ? new Date(options.createdAt) : null;
      const [comment] = await db
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          authorType,
          createdByRunId: actor.runId ?? null,
          body: redactedBody,
          presentation,
          metadata,
          ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
        })
        .returning();

      // Update issue's updatedAt so comment activity is reflected in recency sorting
      await db
        .update(issues)
        .set({ updatedAt: new Date() })
        .where(eq(issues.id, issueId));

      const [commentWithAttachments] = await attachIssueAttachmentsToComments([comment]);
      return redactIssueComment(commentWithAttachments ?? { ...comment, attachments: [] }, currentUserRedactionOptions.enabled);
    },

    createAttachment: async (input: {
      issueId: string;
      issueCommentId?: string | null;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      if (input.issueCommentId) {
        const comment = await db
          .select({ id: issueComments.id, companyId: issueComments.companyId, issueId: issueComments.issueId })
          .from(issueComments)
          .where(eq(issueComments.id, input.issueCommentId))
          .then((rows) => rows[0] ?? null);
        if (!comment) throw notFound("Issue comment not found");
        if (comment.companyId !== issue.companyId || comment.issueId !== issue.id) {
          throw unprocessable("Attachment comment must belong to same issue and company");
        }
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            companyId: issue.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [attachment] = await tx
          .insert(issueAttachments)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            assetId: asset.id,
            issueCommentId: input.issueCommentId ?? null,
          })
          .returning();

        return {
          id: attachment.id,
          companyId: attachment.companyId,
          issueId: attachment.issueId,
          issueCommentId: attachment.issueCommentId,
          assetId: attachment.assetId,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        };
      });
    },

    listAttachments: async (issueId: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.issueId, issueId))
        .orderBy(desc(issueAttachments.createdAt)),

    getAttachmentById: async (id: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.id, id))
        .then((rows) => rows[0] ?? null),

    removeAttachment: async (id: string) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: issueAttachments.id,
            companyId: issueAttachments.companyId,
            issueId: issueAttachments.issueId,
            issueCommentId: issueAttachments.issueCommentId,
            assetId: issueAttachments.assetId,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            createdAt: issueAttachments.createdAt,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(eq(issueAttachments.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(issueAttachments).where(eq(issueAttachments.id, id));
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
        return existing;
      }),

    findMentionedAgents: async (companyId: string, body: string) => {
      const re = /\B@([^\s@,!?.]+)/g;
      const tokens = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const normalized = normalizeAgentMentionToken(m[1]);
        if (normalized) tokens.add(normalized.toLowerCase());
      }

      const explicitAgentMentionIds = extractAgentMentionIds(body);
      if (tokens.size === 0 && explicitAgentMentionIds.length === 0) return [];
      const rows = await db.select({ id: agents.id, name: agents.name })
        .from(agents).where(eq(agents.companyId, companyId));
      const resolved = new Set<string>(explicitAgentMentionIds);
      for (const agent of rows) {
        if (tokens.has(agent.name.toLowerCase())) {
          resolved.add(agent.id);
        }
      }
      return [...resolved];
    },

    findMentionedProjectIds: async (
      issueId: string,
      opts?: { includeCommentBodies?: boolean },
    ) => {
      const issue = await db
        .select({
          companyId: issues.companyId,
          title: issues.title,
          description: issues.description,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) return [];

      const mentionedIds = new Set<string>();
      for (const source of [issue.title, issue.description ?? ""]) {
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }

      if (opts?.includeCommentBodies !== false) {
        const comments = await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId));

        for (const comment of comments) {
          for (const projectId of extractProjectMentionIds(comment.body)) {
            mentionedIds.add(projectId);
          }
        }
      }

      if (mentionedIds.size === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, issue.companyId),
            inArray(projects.id, [...mentionedIds]),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return [...mentionedIds].filter((projectId) => valid.has(projectId));
    },

    getAncestors: async (issueId: string) => {
      const raw: Array<{
        id: string; identifier: string | null; title: string; description: string | null;
        status: string; priority: string;
        assigneeAgentId: string | null; projectId: string | null; goalId: string | null;
      }> = [];
      const visited = new Set<string>([issueId]);
      const start = await db.select().from(issues).where(eq(issues.id, issueId)).then(r => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && raw.length < 50) {
        visited.add(currentId);
        const parent = await db.select({
          id: issues.id, identifier: issues.identifier, title: issues.title, description: issues.description,
          status: issues.status, priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId, projectId: issues.projectId,
          goalId: issues.goalId, parentId: issues.parentId,
        }).from(issues).where(eq(issues.id, currentId)).then(r => r[0] ?? null);
        if (!parent) break;
        raw.push({
          id: parent.id, identifier: parent.identifier ?? null, title: parent.title, description: parent.description ?? null,
          status: parent.status, priority: parent.priority,
          assigneeAgentId: parent.assigneeAgentId ?? null,
          projectId: parent.projectId ?? null, goalId: parent.goalId ?? null,
        });
        currentId = parent.parentId ?? null;
      }

      // Batch-fetch referenced projects and goals
      const projectIds = [...new Set(raw.map(a => a.projectId).filter((id): id is string => id != null))];
      const goalIds = [...new Set(raw.map(a => a.goalId).filter((id): id is string => id != null))];

      const projectMap = new Map<string, {
        id: string;
        name: string;
        description: string | null;
        status: string;
        goalId: string | null;
        workspaces: Array<{
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        }>;
        primaryWorkspace: {
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }>();
      const goalMap = new Map<string, { id: string; title: string; description: string | null; level: string; status: string }>();

      if (projectIds.length > 0) {
        const workspaceRows = await db
          .select()
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.projectId, projectIds))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
        const workspaceMap = new Map<string, Array<(typeof workspaceRows)[number]>>();
        for (const workspace of workspaceRows) {
          const existing = workspaceMap.get(workspace.projectId);
          if (existing) existing.push(workspace);
          else workspaceMap.set(workspace.projectId, [workspace]);
        }

        const rows = await db.select({
          id: projects.id, name: projects.name, description: projects.description,
          status: projects.status, goalId: projects.goalId,
        }).from(projects).where(inArray(projects.id, projectIds));
        for (const r of rows) {
          const projectWorkspaceRows = workspaceMap.get(r.id) ?? [];
          const workspaces = projectWorkspaceRows.map((workspace) => ({
            id: workspace.id,
            companyId: workspace.companyId,
            projectId: workspace.projectId,
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl ?? null,
            repoRef: workspace.repoRef ?? null,
            metadata: (workspace.metadata as Record<string, unknown> | null) ?? null,
            isPrimary: workspace.isPrimary,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          }));
          const primaryWorkspace = workspaces.find((workspace) => workspace.isPrimary) ?? workspaces[0] ?? null;
          projectMap.set(r.id, {
            ...r,
            workspaces,
            primaryWorkspace,
          });
          // Also collect goalIds from projects
          if (r.goalId && !goalIds.includes(r.goalId)) goalIds.push(r.goalId);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db.select({
          id: goals.id, title: goals.title, description: goals.description,
          level: goals.level, status: goals.status,
        }).from(goals).where(inArray(goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return raw.map(a => ({
        ...a,
        project: a.projectId ? projectMap.get(a.projectId) ?? null : null,
        goal: a.goalId ? goalMap.get(a.goalId) ?? null : null,
      }));
    },
  };
}
