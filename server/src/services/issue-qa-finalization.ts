import type { Db } from "@paperclipai/db";
import type {
  ExecutionWorkspace,
  IssueComment,
  IssueExecutionDecisionOutcome,
  IssueMergeStatus,
  IssueQaGateReasonCode,
  IssueStatus,
} from "@paperclipai/shared";
import { buildIssueQaGate } from "./qa-gate.js";
import type { LogActivityInput } from "./activity-log.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";

const QA_PASS_MARKER_REGEX = /\[QA PASS\]/i;
const RELEASE_CONFIRMED_MARKER_REGEX = /\[RELEASE CONFIRMED\]/i;
const QA_MERGE_BLOCKED_MARKER = "[merge-blocked]";

type CommentActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

type QaIssueLike = {
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
  workflowLaneRole?: string | null;
};

type QaCommentLike = Pick<IssueComment, "id" | "body" | "authorAgentId" | "createdAt">;

type ResolveReleaseGateQaAgent = (
  companyId: string,
) => Promise<{
  releaseGateQaAgent: { id: string; name?: string | null } | null;
}>;

type PersistExecutionWorkspaceMergeStatus = (
  workspace: ExecutionWorkspace | null,
  mergeStatus: IssueMergeStatus | null,
) => Promise<unknown>;

function ensureQaOwnershipRequirement(
  canShip: boolean,
  missingRequirements: IssueQaGateReasonCode[],
  issue: QaIssueLike,
  qaAgentId: string,
) {
  if (issue.assigneeAgentId === qaAgentId) {
    return { canShip, missingRequirements };
  }
  if (missingRequirements.includes("qa_gate_requires_qa_assignee")) {
    return { canShip: false, missingRequirements };
  }
  return {
    canShip: false,
    missingRequirements: ["qa_gate_requires_qa_assignee", ...missingRequirements],
  };
}

function buildCurrentCommentQaGate(input: {
  issue: QaIssueLike;
  comment: QaCommentLike;
  qaAgentId: string;
}) {
  const latestDecisionOutcome =
    input.issue.executionState && typeof input.issue.executionState === "object"
      ? (input.issue.executionState.lastDecisionOutcome ?? null)
      : null;
  const qaGate = buildIssueQaGate({
    issue: { status: input.issue.status as IssueStatus },
    assigneeRole: "qa",
    qaComments: [{
      id: input.comment.id,
      body: input.comment.body,
      createdAt: input.comment.createdAt ?? new Date(),
    }],
    latestDecisionOutcome,
  });
  const ownership = ensureQaOwnershipRequirement(
    qaGate.canShip,
    qaGate.missingRequirements,
    input.issue,
    input.qaAgentId,
  );
  return {
    ...qaGate,
    canShip: ownership.canShip,
    missingRequirements: ownership.missingRequirements,
  };
}

export async function finalizeQaValidatedIssueFromComment<TIssue extends QaIssueLike>(input: {
  db: Db;
  issue: TIssue;
  comment: QaCommentLike;
  actor: CommentActor;
  logActivity: (db: Db, input: LogActivityInput) => Promise<unknown>;
  resolveReleaseGateQaAgent: ResolveReleaseGateQaAgent;
  issues: {
    update: (
      issueId: string,
      patch: {
        status: "done";
        actorAgentId: string | null;
        actorUserId: string | null;
      },
    ) => Promise<QaIssueLike | null>;
    addComment: (
      issueId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null },
    ) => Promise<unknown>;
  };
  issueMerge: {
    attemptQaPassAutoMerge: (input: {
      projectPolicy: ReturnType<typeof parseProjectExecutionWorkspacePolicy>;
      executionWorkspace: ExecutionWorkspace | null;
    }) => Promise<
      | { outcome: "not_applicable"; status: IssueMergeStatus | null }
      | { outcome: "blocked"; status: IssueMergeStatus }
      | { outcome: "merged"; status: IssueMergeStatus }
    >;
  };
  projects: {
    getById: (projectId: string) => Promise<{ executionWorkspacePolicy?: unknown } | null>;
  };
  executionWorkspaces: {
    getById: (workspaceId: string) => Promise<ExecutionWorkspace | null>;
  };
  persistExecutionWorkspaceMergeStatus: PersistExecutionWorkspaceMergeStatus;
}) {
  if (input.issue.workflowTemplateKey || input.issue.workflowLaneRole) {
    return { issue: input.issue, mergeStatus: null as IssueMergeStatus | null };
  }
  if (input.issue.status !== "in_review") return { issue: input.issue, mergeStatus: null };
  if (!input.comment.authorAgentId) return { issue: input.issue, mergeStatus: null };

  const qaResolution = await input.resolveReleaseGateQaAgent(input.issue.companyId);
  if (!qaResolution.releaseGateQaAgent || input.comment.authorAgentId !== qaResolution.releaseGateQaAgent.id) {
    return { issue: input.issue, mergeStatus: null };
  }
  if (!QA_PASS_MARKER_REGEX.test(input.comment.body) || !RELEASE_CONFIRMED_MARKER_REGEX.test(input.comment.body)) {
    return { issue: input.issue, mergeStatus: null };
  }

  const qaGate = buildCurrentCommentQaGate({
    issue: input.issue,
    comment: input.comment,
    qaAgentId: qaResolution.releaseGateQaAgent.id,
  });
  if (!qaGate.canShip) {
    return { issue: input.issue, mergeStatus: null };
  }

  const [project, executionWorkspace] = await Promise.all([
    input.issue.projectId ? input.projects.getById(input.issue.projectId) : Promise.resolve(null),
    input.issue.executionWorkspaceId ? input.executionWorkspaces.getById(input.issue.executionWorkspaceId) : Promise.resolve(null),
  ]);
  const projectPolicy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy ?? null);
  const mergeResult = await input.issueMerge.attemptQaPassAutoMerge({
    projectPolicy,
    executionWorkspace,
  });
  if (mergeResult.status && executionWorkspace) {
    await input.persistExecutionWorkspaceMergeStatus(executionWorkspace, mergeResult.status);
  }

  if (mergeResult.outcome === "blocked") {
    await input.issues.addComment(
      input.issue.id,
      [
        QA_MERGE_BLOCKED_MARKER,
        "QA validation passed, but auto-merge is blocked.",
        mergeResult.status.reason ?? "Orchestrero could not determine the merge blocker.",
      ].join("\n"),
      {
        agentId: input.actor.agentId ?? undefined,
        userId: input.actor.actorType === "user" ? input.actor.actorId : undefined,
        runId: input.actor.runId,
      },
    );
    await input.logActivity(input.db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "issue-merge",
      action: "issue.auto_merge_blocked",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier ?? null,
        targetBranch: mergeResult.status.targetBranch,
        sourceBranch: mergeResult.status.sourceBranch,
        reason: mergeResult.status.reason,
      },
    });
    return { issue: input.issue, mergeStatus: mergeResult.status };
  }

  const closedIssue = await input.issues.update(input.issue.id, {
    status: "done",
    actorAgentId: input.actor.agentId ?? null,
    actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
  });
  if (!closedIssue) {
    return { issue: input.issue, mergeStatus: mergeResult.status };
  }

  await input.logActivity(input.db, {
    companyId: closedIssue.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    agentId: input.actor.agentId,
    runId: input.actor.runId,
    action: mergeResult.outcome === "merged" ? "issue.auto_merged" : "issue.qa_closed",
    entityType: "issue",
    entityId: closedIssue.id,
    details: {
      identifier: closedIssue.identifier,
      commentId: input.comment.id,
      targetBranch: mergeResult.status?.targetBranch ?? null,
      sourceBranch: mergeResult.status?.sourceBranch ?? null,
      mergedCommit: mergeResult.status?.mergedCommit ?? null,
    },
  });

  return {
    issue: closedIssue as TIssue,
    mergeStatus: mergeResult.status,
  };
}
