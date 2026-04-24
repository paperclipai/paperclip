import type { Db } from "@paperclipai/db";
import {
  resolveReleaseGateQaAgent as resolveSharedReleaseGateQaAgent,
  type ExecutionWorkspace,
  type IssueActionRequest,
  type IssueActionResult,
  type IssueComment,
  type IssueExecutionDecisionOutcome,
  type IssueQaGateReasonCode,
  type IssueStatus,
  type SubmitQaVerdictIssueActionPayload,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import type { LogActivityInput } from "./activity-log.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { finalizeQaValidatedIssueFromComment } from "./issue-qa-finalization.js";
import { buildIssueRoutingText } from "./issue-routing-heuristics.js";
import {
  buildIssueQaGate,
  isDeliveryScopedAssigneeRole,
  issueQaGateReasonMessage,
} from "./qa-gate.js";

type IssueActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

type PersistedIssue = {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  qaReviewerAgentId?: string | null;
  identifier: string | null;
  title: string | null;
  description: string | null;
  projectId: string | null;
  parentId: string | null;
  executionState?: { lastDecisionOutcome?: IssueExecutionDecisionOutcome | null } | null;
  executionWorkspaceId: string | null;
  workflowTemplateKey: string | null;
  workflowLaneRole: string | null;
  workflowRequiredArtifacts?: unknown[] | null;
};

type PersistedIssueDocument = {
  id: string;
  key: string;
  title: string | null;
  format: string;
  body: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
};

type ActivityLogger = (db: Db, input: LogActivityInput) => Promise<unknown>;

type AgentRecord = {
  id: string;
  companyId: string;
  role?: string | null;
  status?: string | null;
  name?: string | null;
};

type IssueWorkflowSummaryLike = {
  blockingReasons?: string[];
  lanes?: Array<{ role: string; issueId?: string | null; status?: string | null }>;
  activeRoles?: string[];
};

type IssueActionServiceDeps<TIssue extends PersistedIssue> = {
  db: Db;
  issues: {
    update: (
      issueId: string,
      patch: {
        status?: string;
        assigneeAgentId?: string | null;
        assigneeUserId?: string | null;
        actorAgentId?: string | null;
        actorUserId?: string | null;
        completionGuardrailsSatisfied?: boolean;
      },
    ) => Promise<TIssue | null>;
    addComment: (
      issueId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null },
    ) => Promise<IssueComment>;
    listComments?: (
      issueId: string,
      opts?: { order?: "asc" | "desc"; limit?: number | null },
    ) => Promise<IssueComment[]>;
    getWakeableParentAfterChildCompletion?: (
      parentIssueId: string,
    ) => Promise<{ id: string; assigneeAgentId: string; childIssueIds: string[] } | null>;
  };
  agents: {
    getById?: (agentId: string) => Promise<AgentRecord | null>;
    list?: (companyId: string) => Promise<AgentRecord[]>;
  };
  companies: {
    getById: (companyId: string) => Promise<{ releaseGateQaAgentId?: string | null } | null>;
  };
  projects: {
    getById: (projectId: string) => Promise<{ name?: string | null; executionWorkspacePolicy?: unknown } | null>;
  };
  issueWorkflow: {
    decorateIssue: (issue: TIssue) => Promise<TIssue & { workflowSummary?: IssueWorkflowSummaryLike | null }>;
    evaluateLaneCompletion: (issue: TIssue) => Promise<{ canComplete: boolean; blockingReasons: string[] }>;
  };
  issueMerge: {
    attemptQaPassAutoMerge: (input: {
      projectPolicy: ReturnType<typeof parseProjectExecutionWorkspacePolicy>;
      executionWorkspace: ExecutionWorkspace | null;
    }) => Promise<
      | { outcome: "not_applicable"; status: any | null }
      | { outcome: "blocked"; status: any }
      | { outcome: "merged"; status: any }
    >;
  };
  executionWorkspaces: {
    getById: (workspaceId: string) => Promise<ExecutionWorkspace | null>;
    update?: (workspaceId: string, patch: { metadata: Record<string, unknown> }) => Promise<unknown>;
  };
  documents: {
    getIssueDocumentByKey: (issueId: string, key: string) => Promise<PersistedIssueDocument | null>;
    upsertIssueDocument: (input: {
      issueId: string;
      key: string;
      title?: string | null;
      format: string;
      body: string;
      changeSummary?: string | null;
      baseRevisionId?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
      createdByRunId?: string | null;
    }) => Promise<{
      created: boolean;
      document: PersistedIssueDocument;
    }>;
  };
  logActivity: ActivityLogger;
};

function qaReasonError(reasonCode: IssueQaGateReasonCode): never {
  throw unprocessable(issueQaGateReasonMessage(reasonCode), { reasonCode });
}

function buildQaRoutingComment(
  agentId: string,
  agentName: string | null | undefined,
  opts?: { alreadyAssigned?: boolean },
) {
  const label = (agentName ?? "qa-agent").trim() || "qa-agent";
  return [
    "[qa-routing]",
    opts?.alreadyAssigned
      ? `QA ownership stays with @${label} (${agentId}) because this delivery issue entered in_review.`
      : `Routed to QA @${label} (${agentId}) because this delivery issue entered in_review.`,
    "QA now owns the release gate for this issue.",
  ].join("\n");
}

function buildCanonicalQaVerdictComment(payload: SubmitQaVerdictIssueActionPayload) {
  const summaryLine = buildCanonicalQaVerdictSummaryLine(payload);
  const verificationLine = buildCanonicalQaVerdictVerificationLine(payload);
  const body: string[] = [summaryLine, verificationLine];
  if (payload.qaPass) body.push("[QA PASS]");
  if (payload.releaseConfirmed) body.push("[RELEASE CONFIRMED]");
  if (payload.summaryText?.trim()) {
    body.push("", "Smart Review Summary", "", payload.summaryText.trim());
  }
  if (payload.verificationText?.trim()) {
    body.push("", "Verification Evidence", "", payload.verificationText.trim());
  }
  return body.join("\n");
}

function buildCanonicalQaVerdictSummaryLine(payload: SubmitQaVerdictIssueActionPayload) {
  return [
    `[CQ:${payload.summary.codeQuality}]`,
    `[EH:${payload.summary.errorHandling}]`,
    `[TC:${payload.summary.testCoverage}]`,
    `[CM:${payload.summary.commentQuality}]`,
    `[DOC:${payload.summary.docsImpact}]`,
  ].join(" ");
}

function buildCanonicalQaVerdictVerificationLine(payload: SubmitQaVerdictIssueActionPayload) {
  return [
    `[TYPECHECK:${payload.verification.typecheck}]`,
    `[TESTS:${payload.verification.tests}]`,
    `[BUILD:${payload.verification.build}]`,
    `[SMOKE:${payload.verification.smoke}]`,
  ].join(" ");
}

function buildCanonicalQaVerdictDocument(payload: SubmitQaVerdictIssueActionPayload) {
  const body: string[] = [
    "# QA Verdict",
    "",
    "## Smart Review",
    "",
    buildCanonicalQaVerdictSummaryLine(payload),
    "",
    `- Code Quality: ${payload.summary.codeQuality}`,
    `- Error Handling: ${payload.summary.errorHandling}`,
    `- Test Coverage: ${payload.summary.testCoverage}`,
    `- Comment Quality: ${payload.summary.commentQuality}`,
    `- Docs Impact: ${payload.summary.docsImpact}`,
  ];

  if (payload.summaryText?.trim()) {
    body.push("", payload.summaryText.trim());
  }

  body.push(
    "",
    "## Verification",
    "",
    buildCanonicalQaVerdictVerificationLine(payload),
    "",
    `- Typecheck: ${payload.verification.typecheck}`,
    `- Tests: ${payload.verification.tests}`,
    `- Build: ${payload.verification.build}`,
    `- Smoke: ${payload.verification.smoke}`,
  );

  if (payload.verificationText?.trim()) {
    body.push("", payload.verificationText.trim());
  }

  body.push(
    "",
    "## Release Decision",
    "",
    `- QA Pass: ${payload.qaPass ? "yes" : "no"}`,
    `- Release Confirmed: ${payload.releaseConfirmed ? "yes" : "no"}`,
  );

  if (payload.qaPass) body.push("[QA PASS]");
  if (payload.releaseConfirmed) body.push("[RELEASE CONFIRMED]");
  return body.join("\n");
}

async function getAgentRole<TIssue extends PersistedIssue>(
  deps: IssueActionServiceDeps<TIssue>,
  agentId: string,
  companyId: string,
) {
  if (typeof deps.agents.getById !== "function") return null;
  const agent = await deps.agents.getById(agentId);
  if (!agent || agent.companyId !== companyId) return null;
  return typeof agent.role === "string" ? agent.role : null;
}

async function resolveReleaseGateQaAgent<TIssue extends PersistedIssue>(
  deps: IssueActionServiceDeps<TIssue>,
  companyId: string,
) {
  const [company, agents] = await Promise.all([
    deps.companies.getById(companyId),
    typeof deps.agents.list === "function" ? deps.agents.list(companyId) : Promise.resolve([]),
  ]);
  const qaAgents = agents.filter((agent) => agent.companyId === companyId && agent.role === "qa");
  const resolution = resolveSharedReleaseGateQaAgent(qaAgents, {
    configuredAgentId: company?.releaseGateQaAgentId ?? null,
  });
  return {
    ...resolution,
    blockingReason:
      resolution.resolution === "configured_unavailable"
        ? "Configured release-gate QA owner is unavailable."
        : resolution.resolution === "none"
          ? "No eligible QA agent is available for the release gate."
          : resolution.resolution === "ambiguous"
            ? "Release-gate QA ownership is ambiguous and must be configured explicitly."
            : null,
  };
}

async function listQaCommentsForIssue<TIssue extends PersistedIssue>(
  deps: IssueActionServiceDeps<TIssue>,
  input: {
    issueId: string;
    companyId: string;
    authorAgentId?: string | null;
  },
) {
  if (typeof deps.issues.listComments !== "function") return [] as IssueComment[];
  const comments = await deps.issues.listComments(input.issueId, { order: "desc", limit: 500 });
  const authorIds = [...new Set(
    comments
      .map((comment) => comment.authorAgentId)
      .filter((agentId): agentId is string => typeof agentId === "string" && agentId.length > 0),
  )];
  const roleByAuthorId = new Map<string, string | null>();
  await Promise.all(authorIds.map(async (authorId) => {
    roleByAuthorId.set(authorId, await getAgentRole(deps, authorId, input.companyId));
  }));
  return comments.filter((comment) => {
    if (!comment.authorAgentId) return false;
    if (roleByAuthorId.get(comment.authorAgentId) !== "qa") return false;
    if (input.authorAgentId && comment.authorAgentId !== input.authorAgentId) return false;
    return true;
  });
}

async function computeIssueQaGate<TIssue extends PersistedIssue>(
  deps: IssueActionServiceDeps<TIssue>,
  issue: TIssue,
) {
  const assigneeRole = issue.assigneeAgentId
    ? await getAgentRole(deps, issue.assigneeAgentId, issue.companyId)
    : null;
  const projectName =
    issue.projectId
      ? (await deps.projects.getById(issue.projectId).catch(() => null))?.name ?? null
      : null;
  const qaResolution = await resolveReleaseGateQaAgent(deps, issue.companyId);
  const qaComments = await listQaCommentsForIssue(deps, {
    issueId: issue.id,
    companyId: issue.companyId,
    authorAgentId: qaResolution.releaseGateQaAgent?.id ?? null,
  });
  const latestDecisionOutcome =
    issue.executionState && typeof issue.executionState === "object"
      ? (issue.executionState.lastDecisionOutcome ?? null)
      : null;
  const qaGate = buildIssueQaGate({
    issue: { status: issue.status as IssueStatus },
    assigneeRole,
    issueText: buildIssueRoutingText({
      identifier: issue.identifier ?? null,
      title: issue.title ?? "",
      projectName,
    }),
    qaComments,
    latestDecisionOutcome,
  });
  if (!qaGate.isDeliveryScoped || !["in_review", "done"].includes(issue.status)) {
    return qaGate;
  }
  const qaOwnershipFailure: IssueQaGateReasonCode | null =
    qaResolution.releaseGateQaAgent == null
      ? (qaResolution.eligibleQaAgents.length === 0
        ? "qa_gate_no_eligible_qa_agent"
        : "qa_gate_requires_qa_assignee")
      : issue.assigneeAgentId !== qaResolution.releaseGateQaAgent.id
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

async function persistExecutionWorkspaceMergeStatus<TIssue extends PersistedIssue>(
  deps: IssueActionServiceDeps<TIssue>,
  workspace: ExecutionWorkspace | null,
  mergeStatus: any,
) {
  if (!workspace || !mergeStatus || typeof deps.executionWorkspaces.update !== "function") return;
  const metadata = {
    ...((workspace.metadata as Record<string, unknown> | null) ?? {}),
    merge: {
      state: mergeStatus.state,
      targetBranch: mergeStatus.targetBranch,
      sourceBranch: mergeStatus.sourceBranch,
      repoRoot: mergeStatus.repoRoot,
      reason: mergeStatus.reason,
      mergedCommit: mergeStatus.mergedCommit,
      mergedAt: mergeStatus.mergedAt?.toISOString?.() ?? null,
      lastAttemptedAt: mergeStatus.lastAttemptedAt?.toISOString?.() ?? null,
    },
  };
  await deps.executionWorkspaces.update(workspace.id, { metadata });
}

async function evaluateWorkflowRootCompletion<TIssue extends PersistedIssue>(
  deps: IssueActionServiceDeps<TIssue>,
  issue: TIssue,
) {
  if (!issue.workflowTemplateKey || issue.workflowLaneRole) return null;
  const decoratedIssue = await deps.issueWorkflow.decorateIssue(issue);
  const workflowSummary = decoratedIssue.workflowSummary;
  if (!workflowSummary) return null;
  const blockingReasons = [...(workflowSummary.blockingReasons ?? [])];
  for (const lane of workflowSummary.lanes ?? []) {
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
  };
}

function isTerminalIssueStatus(status: string) {
  return status === "done" || status === "cancelled";
}

function buildIssueCommentActor(actor: IssueActor) {
  return {
    agentId: actor.agentId ?? undefined,
    userId: actor.actorType === "user" ? actor.actorId : undefined,
    runId: actor.runId,
  };
}

async function logIssueUpdated<TIssue extends PersistedIssue>(
  deps: IssueActionServiceDeps<TIssue>,
  issue: TIssue,
  actor: IssueActor,
  details: Record<string, unknown>,
) {
  await deps.logActivity(deps.db, {
    companyId: issue.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    action: "issue.updated",
    entityType: "issue",
    entityId: issue.id,
    details: {
      identifier: issue.identifier ?? null,
      ...details,
    },
  });
}

async function logIssueCommentAdded<TIssue extends PersistedIssue>(
  deps: IssueActionServiceDeps<TIssue>,
  issue: TIssue,
  actor: IssueActor,
  comment: IssueComment,
  extra?: Record<string, unknown>,
) {
  await deps.logActivity(deps.db, {
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
      identifier: issue.identifier ?? null,
      issueTitle: issue.title ?? null,
      parentId: issue.parentId ?? null,
      ...extra,
    },
  });
}

async function logIssueDocumentUpserted<TIssue extends PersistedIssue>(
  deps: IssueActionServiceDeps<TIssue>,
  issue: TIssue,
  actor: IssueActor,
  result: { created: boolean; document: PersistedIssueDocument },
) {
  await deps.logActivity(deps.db, {
    companyId: issue.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    action: result.created ? "issue.document_created" : "issue.document_updated",
    entityType: "issue",
    entityId: issue.id,
    details: {
      identifier: issue.identifier ?? null,
      key: result.document.key,
      documentId: result.document.id,
      title: result.document.title,
      format: result.document.format,
      revisionNumber: result.document.latestRevisionNumber,
    },
  });
}

function validateStructuredQaVerdict(
  payload: SubmitQaVerdictIssueActionPayload,
) {
  if (payload.summary.testCoverage === "na") {
    qaReasonError("qa_gate_missing_test_coverage_verdict");
  }
  if (Object.values(payload.summary).includes("fail")) {
    qaReasonError("qa_gate_failing_review");
  }
  const requiredVerification = [
    payload.verification.typecheck,
    payload.verification.tests,
    payload.verification.build,
  ];
  if (!payload.qaPass) {
    qaReasonError("qa_gate_missing_qa_pass");
  }
  if (!payload.releaseConfirmed) {
    qaReasonError("qa_gate_missing_release_confirmation");
  }
  if (requiredVerification.some((value) => value !== "pass")) {
    qaReasonError("qa_gate_failing_verification");
  }
  if (!["pass", "na"].includes(payload.verification.smoke)) {
    qaReasonError("qa_gate_failing_verification");
  }
}

function assigneeDiffersFromIssue<TIssue extends PersistedIssue>(
  issue: TIssue,
  payload: {
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
  },
) {
  const nextAssigneeAgentId =
    payload.assigneeAgentId === undefined ? issue.assigneeAgentId : payload.assigneeAgentId;
  const nextAssigneeUserId =
    payload.assigneeUserId === undefined ? issue.assigneeUserId : payload.assigneeUserId;
  return nextAssigneeAgentId !== issue.assigneeAgentId || nextAssigneeUserId !== issue.assigneeUserId;
}

export function issueActionService<TIssue extends PersistedIssue>(
  deps: IssueActionServiceDeps<TIssue>,
) {
  async function execute(input: {
    issue: TIssue;
    actor: IssueActor;
    action: IssueActionRequest;
  }): Promise<IssueActionResult> {
    switch (input.action.type) {
      case "reopen_issue": {
        if (!isTerminalIssueStatus(input.issue.status)) {
          throw unprocessable("Only closed issues can be reopened.");
        }
        const nextStatus = input.action.payload.status ?? "todo";
        const updated = await deps.issues.update(input.issue.id, {
          status: nextStatus,
          actorAgentId: input.actor.agentId ?? null,
          actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
        });
        if (!updated) {
          throw unprocessable("Issue not found");
        }
        await logIssueUpdated(deps, updated, input.actor, {
          status: nextStatus,
          reopened: true,
          reopenedFrom: input.issue.status,
        });
        let comment: IssueComment | null = null;
        if (input.action.payload.body?.trim()) {
          comment = await deps.issues.addComment(
            updated.id,
            input.action.payload.body.trim(),
            buildIssueCommentActor(input.actor),
          );
          await logIssueCommentAdded(deps, updated, input.actor, comment, {
            reopened: true,
            reopenedFrom: input.issue.status,
          });
        }
        return { type: input.action.type, issue: updated as any, comment };
      }

      case "handoff_issue": {
        if (!input.action.payload.body?.trim()) {
          throw unprocessable("handoff_issue requires a handoff note");
        }
        if (
          input.action.payload.assigneeAgentId !== undefined
          && input.action.payload.assigneeAgentId !== null
          && input.action.payload.assigneeUserId !== undefined
          && input.action.payload.assigneeUserId !== null
        ) {
          throw unprocessable("Issue can only have one assignee");
        }
        if (!assigneeDiffersFromIssue(input.issue, input.action.payload)) {
          throw unprocessable("handoff_issue requires an assignee change");
        }

        let nextStatus = input.issue.status;
        if (input.action.payload.reopen && isTerminalIssueStatus(input.issue.status)) {
          nextStatus = "todo";
        }

        const updated = await deps.issues.update(input.issue.id, {
          ...(nextStatus !== input.issue.status ? { status: nextStatus } : {}),
          ...(input.action.payload.assigneeAgentId !== undefined
            ? { assigneeAgentId: input.action.payload.assigneeAgentId }
            : {}),
          ...(input.action.payload.assigneeUserId !== undefined
            ? { assigneeUserId: input.action.payload.assigneeUserId }
            : {}),
          actorAgentId: input.actor.agentId ?? null,
          actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
        });
        if (!updated) {
          throw unprocessable("Issue not found");
        }
        await logIssueUpdated(deps, updated, input.actor, {
          ...(nextStatus !== input.issue.status
            ? {
              status: nextStatus,
              reopened: isTerminalIssueStatus(input.issue.status) && !isTerminalIssueStatus(nextStatus),
              reopenedFrom: isTerminalIssueStatus(input.issue.status) ? input.issue.status : undefined,
            }
            : {}),
          assigneeAgentId: updated.assigneeAgentId,
          assigneeUserId: updated.assigneeUserId,
          _previous: {
            status: input.issue.status,
            assigneeAgentId: input.issue.assigneeAgentId,
            assigneeUserId: input.issue.assigneeUserId,
          },
        });

        let comment: IssueComment | null = null;
        comment = await deps.issues.addComment(
          updated.id,
          input.action.payload.body.trim(),
          buildIssueCommentActor(input.actor),
        );
        await logIssueCommentAdded(deps, updated, input.actor, comment, {
          ...(nextStatus !== input.issue.status
            ? {
              reopened: isTerminalIssueStatus(input.issue.status) && !isTerminalIssueStatus(nextStatus),
              reopenedFrom: isTerminalIssueStatus(input.issue.status) ? input.issue.status : undefined,
            }
            : {}),
        });

        return {
          type: input.action.type,
          issue: updated as any,
          comment,
        };
      }

      case "append_note": {
        let issue = input.issue;
        if (isTerminalIssueStatus(issue.status) && !input.action.payload.reopen && input.actor.actorType === "agent") {
          throw conflict("Issue is closed. Reopen it before posting agent updates.");
        }
        if (input.action.payload.reopen && isTerminalIssueStatus(issue.status)) {
          const reopened = await deps.issues.update(issue.id, {
            status: "todo",
            actorAgentId: input.actor.agentId ?? null,
            actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
          });
          if (!reopened) {
            throw unprocessable("Issue not found");
          }
          issue = reopened;
          await logIssueUpdated(deps, issue, input.actor, {
            status: "todo",
            reopened: true,
            reopenedFrom: input.issue.status,
          });
        }
        const comment = await deps.issues.addComment(
          issue.id,
          input.action.payload.body,
          buildIssueCommentActor(input.actor),
        );
        await logIssueCommentAdded(deps, issue, input.actor, comment, {
          ...(issue.id !== input.issue.id || issue.status !== input.issue.status
            ? { reopened: true, reopenedFrom: input.issue.status }
            : {}),
        });
        return { type: input.action.type, issue: issue as any, comment };
      }

      case "enter_review": {
        const currentAssigneeRole = input.issue.assigneeAgentId
          ? await getAgentRole(deps, input.issue.assigneeAgentId, input.issue.companyId)
          : null;
        let assigneeAgentId = input.issue.assigneeAgentId;
        let assigneeUserId = input.issue.assigneeUserId;
        let qaAutoRouting: { agentId: string; agentName: string | null; alreadyAssigned?: boolean } | null = null;

        if (
          !input.issue.workflowTemplateKey &&
          !input.issue.workflowLaneRole &&
          isDeliveryScopedAssigneeRole(currentAssigneeRole)
        ) {
          const qaResolution = await resolveReleaseGateQaAgent(deps, input.issue.companyId);
          if (!qaResolution.releaseGateQaAgent) {
            qaReasonError(
              qaResolution.resolution === "none" ? "qa_gate_no_eligible_qa_agent" : "qa_gate_requires_qa_assignee",
            );
          }
          assigneeAgentId = qaResolution.releaseGateQaAgent.id;
          assigneeUserId = null;
          qaAutoRouting = {
            agentId: qaResolution.releaseGateQaAgent.id,
            agentName: qaResolution.releaseGateQaAgent.name ?? null,
            alreadyAssigned: input.issue.assigneeAgentId === qaResolution.releaseGateQaAgent.id,
          };
        }
        if ((input.issue.workflowTemplateKey || input.issue.workflowLaneRole) && !assigneeAgentId && !assigneeUserId) {
          throw unprocessable("Workflow issues must have an assignee before entering review.");
        }

        const updated = await deps.issues.update(input.issue.id, {
          status: "in_review",
          assigneeAgentId,
          assigneeUserId,
          actorAgentId: input.actor.agentId ?? null,
          actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
        });
        if (!updated) {
          throw unprocessable("Issue not found");
        }
        await logIssueUpdated(deps, updated, input.actor, {
          status: "in_review",
          assigneeAgentId: updated.assigneeAgentId,
          assigneeUserId: updated.assigneeUserId,
          _previous: {
            status: input.issue.status,
            assigneeAgentId: input.issue.assigneeAgentId,
            assigneeUserId: input.issue.assigneeUserId,
          },
        });

        let comment: IssueComment | null = null;
        if (qaAutoRouting) {
          const routingComment = await deps.issues.addComment(
            updated.id,
            buildQaRoutingComment(qaAutoRouting.agentId, qaAutoRouting.agentName, {
              alreadyAssigned: qaAutoRouting.alreadyAssigned === true,
            }),
            {},
          );
          await deps.logActivity(deps.db, {
            companyId: updated.companyId,
            actorType: "system",
            actorId: "qa-routing",
            action: "issue.qa_routed",
            entityType: "issue",
            entityId: updated.id,
            details: {
              identifier: updated.identifier ?? null,
              qaAgentId: qaAutoRouting.agentId,
              qaAgentName: qaAutoRouting.agentName,
              alreadyAssigned: qaAutoRouting.alreadyAssigned === true,
            },
          });
          comment = routingComment;
        }
        if (input.action.payload.body?.trim()) {
          comment = await deps.issues.addComment(
            updated.id,
            input.action.payload.body.trim(),
            buildIssueCommentActor(input.actor),
          );
          await logIssueCommentAdded(deps, updated, input.actor, comment);
        }
        return { type: input.action.type, issue: updated as any, comment };
      }

      case "complete_issue": {
        if (input.issue.workflowTemplateKey && !input.issue.workflowLaneRole) {
          const rootCompletion = await evaluateWorkflowRootCompletion(deps, input.issue);
          if (rootCompletion && !rootCompletion.canComplete) {
            throw unprocessable(
              rootCompletion.blockingReasons[0] ?? "Workflow root cannot be closed while specialist lanes remain incomplete",
              { blockingReasons: rootCompletion.blockingReasons },
            );
          }
        }
        if (input.issue.workflowLaneRole && (input.issue.workflowRequiredArtifacts?.length ?? 0) > 0) {
          const laneCompletion = await deps.issueWorkflow.evaluateLaneCompletion(input.issue);
          if (!laneCompletion.canComplete) {
            throw unprocessable(
              laneCompletion.blockingReasons[0] ?? "Workflow requirements are not satisfied",
              { blockingReasons: laneCompletion.blockingReasons },
            );
          }
        }
        if (!input.issue.workflowTemplateKey && !input.issue.workflowLaneRole) {
          const qaGate = await computeIssueQaGate(deps, input.issue);
          const gateFailure = qaGate.isDeliveryScoped ? (qaGate.missingRequirements[0] ?? null) : null;
          if (gateFailure) {
            qaReasonError(gateFailure);
          }
        }

        const updated = await deps.issues.update(input.issue.id, {
          status: "done",
          actorAgentId: input.actor.agentId ?? null,
          actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
          completionGuardrailsSatisfied: true,
        });
        if (!updated) {
          throw unprocessable("Issue not found");
        }
        await logIssueUpdated(deps, updated, input.actor, {
          status: "done",
          _previous: { status: input.issue.status },
        });
        let comment: IssueComment | null = null;
        if (input.action.payload.body?.trim()) {
          comment = await deps.issues.addComment(
            updated.id,
            input.action.payload.body.trim(),
            buildIssueCommentActor(input.actor),
          );
          await logIssueCommentAdded(deps, updated, input.actor, comment);
        }
        return { type: input.action.type, issue: updated as any, comment };
      }

      case "submit_qa_verdict": {
        if (input.issue.workflowLaneRole === "qa") {
          const authorizedWorkflowQaAgentId = input.issue.assigneeAgentId ?? null;
          if (!authorizedWorkflowQaAgentId) {
            throw unprocessable("Workflow QA lane must be assigned to an active QA reviewer.");
          }
          if (input.actor.agentId !== authorizedWorkflowQaAgentId) {
            throw unprocessable("Only the assigned workflow QA lane owner can submit typed QA verdicts for this issue.");
          }
          const authorizedRole = await getAgentRole(deps, authorizedWorkflowQaAgentId, input.issue.companyId);
          if (authorizedRole !== "qa") {
            throw unprocessable("Workflow QA lane must be assigned to an active QA reviewer.");
          }
        } else {
          const qaResolution = await resolveReleaseGateQaAgent(deps, input.issue.companyId);
          if (!qaResolution.releaseGateQaAgent) {
            throw unprocessable(
              qaResolution.blockingReason ?? "No authorized release-gate QA owner is available for this company.",
            );
          }
          if (input.actor.agentId !== qaResolution.releaseGateQaAgent.id) {
            throw unprocessable(
              "Only the authorized release-gate QA agent can submit typed QA verdicts for this issue.",
            );
          }
        }
        if (!input.issue.workflowTemplateKey && !input.issue.workflowLaneRole && input.issue.status !== "in_review") {
          qaReasonError("qa_gate_requires_in_review");
        }
        validateStructuredQaVerdict(input.action.payload);

        const existingQaVerdictDocument = await deps.documents.getIssueDocumentByKey(input.issue.id, "qa-verdict");
        const qaVerdictDocument = await deps.documents.upsertIssueDocument({
          issueId: input.issue.id,
          key: "qa-verdict",
          title: "QA verdict",
          format: "markdown",
          body: buildCanonicalQaVerdictDocument(input.action.payload),
          changeSummary: "Updated from typed QA verdict submission.",
          baseRevisionId: existingQaVerdictDocument?.latestRevisionId ?? null,
          createdByAgentId: input.actor.agentId ?? null,
          createdByUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
          createdByRunId: input.actor.runId ?? null,
        });
        await logIssueDocumentUpserted(deps, input.issue, input.actor, qaVerdictDocument);

        const generatedCommentBody = buildCanonicalQaVerdictComment(input.action.payload);
        const comment = await deps.issues.addComment(
          input.issue.id,
          generatedCommentBody,
          buildIssueCommentActor(input.actor),
        );
        await logIssueCommentAdded(deps, input.issue, input.actor, comment);

        const finalized = await finalizeQaValidatedIssueFromComment({
          db: deps.db,
          issue: {
            ...input.issue,
            title: input.issue.title ?? undefined,
          },
          comment,
          actor: input.actor,
          logActivity: deps.logActivity,
          issues: {
            update: async (issueId, patch) => deps.issues.update(issueId, patch) as any,
            addComment: deps.issues.addComment,
            listComments: deps.issues.listComments
              ? async (issueId: string) => deps.issues.listComments!(issueId, { order: "desc", limit: 500 })
              : undefined,
          },
          issueMerge: deps.issueMerge,
          projects: deps.projects,
          executionWorkspaces: {
            getById: deps.executionWorkspaces.getById,
          },
          persistExecutionWorkspaceMergeStatus: async (workspace, mergeStatus) =>
            persistExecutionWorkspaceMergeStatus(deps, workspace, mergeStatus),
          workflow: {
            evaluateLaneCompletion: async (workflowIssue) => await deps.issueWorkflow.evaluateLaneCompletion(workflowIssue),
            getWakeableParentAfterChildCompletion: deps.issues.getWakeableParentAfterChildCompletion
              ? async (parentIssueId) => await deps.issues.getWakeableParentAfterChildCompletion!(parentIssueId)
              : undefined,
          },
        });

        return {
          type: input.action.type,
          issue: finalized.issue as any,
          comment,
          generatedCommentBody,
        };
      }
    }
  }

  return {
    execute,
    buildCanonicalQaVerdictComment,
    buildCanonicalQaVerdictDocument,
  };
}
