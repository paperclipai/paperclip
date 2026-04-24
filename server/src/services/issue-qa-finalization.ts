import type { Db } from "@paperclipai/db";
import type {
  ExecutionWorkspace,
  IssueComment,
  IssueExecutionDecisionOutcome,
  IssueMergeStatus,
  IssueQaGateReasonCode,
  IssueStatus,
} from "@paperclipai/shared";
import {
  buildIssueQaGate,
  qaCommentHasQaPassMarker,
  qaCommentHasReleaseConfirmedMarker,
  selectLatestRelevantQaComment,
} from "./qa-gate.js";
import type { LogActivityInput } from "./activity-log.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { authorizedStandaloneQaReviewerAgentId } from "./qa-reviewer-pool.js";

const QA_MERGE_BLOCKED_MARKER = "[merge-blocked]";

export function qaCommentHasMergeBlockedMarker(body: string | null | undefined) {
  return typeof body === "string" && body.includes(QA_MERGE_BLOCKED_MARKER);
}

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
  workIntent?: string | null;
  qaReviewerAgentId?: string | null;
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

type PersistExecutionWorkspaceMergeStatus = (
  workspace: ExecutionWorkspace | null,
  mergeStatus: IssueMergeStatus | null,
) => Promise<unknown>;

type WorkflowLaneCompletionResult = {
  canComplete: boolean;
  blockingReasons: string[];
};

export type IssueQaFinalizationParentWakeup = {
  id: string;
  assigneeAgentId: string;
  childIssueIds: string[];
};

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

function buildQaCommentHistoryGate(input: {
  issue: QaIssueLike;
  comments: QaCommentLike[];
  qaAgentId: string;
}) {
  const latestDecisionOutcome =
    input.issue.executionState && typeof input.issue.executionState === "object"
      ? (input.issue.executionState.lastDecisionOutcome ?? null)
      : null;
  const qaGate = buildIssueQaGate({
    issue: { status: input.issue.status as IssueStatus },
    workIntent: input.issue.workIntent,
    assigneeRole: "qa",
    qaComments: input.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt ?? new Date(),
    })),
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

function hasMergeBlockedCommentForSelectedVerdict(input: {
  comments: QaCommentLike[];
  selectedComment: QaCommentLike;
}) {
  const selectedCommentCreatedAt = new Date(input.selectedComment.createdAt ?? 0).getTime();
  return input.comments.some((comment) => {
    if (!qaCommentHasMergeBlockedMarker(comment.body)) {
      return false;
    }
    const commentCreatedAt = new Date(comment.createdAt ?? 0).getTime();
    if (!Number.isFinite(selectedCommentCreatedAt) || !Number.isFinite(commentCreatedAt)) {
      return false;
    }
    return commentCreatedAt >= selectedCommentCreatedAt;
  });
}

export async function finalizeQaValidatedIssueFromComment<TIssue extends QaIssueLike>(input: {
  db: Db;
  issue: TIssue;
  comment: QaCommentLike;
  actor: CommentActor;
  logActivity: (db: Db, input: LogActivityInput) => Promise<unknown>;
  issues: {
    update: (
      issueId: string,
      patch: {
        status: "done";
        actorAgentId: string | null;
        actorUserId: string | null;
        completionGuardrailsSatisfied?: boolean;
      },
    ) => Promise<QaIssueLike | null>;
    addComment: (
      issueId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null },
    ) => Promise<unknown>;
    listComments?: (issueId: string) => Promise<QaCommentLike[]>;
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
  workflow?: {
    evaluateLaneCompletion?: (issue: TIssue) => Promise<WorkflowLaneCompletionResult>;
    getWakeableParentAfterChildCompletion?: (
      parentIssueId: string,
    ) => Promise<IssueQaFinalizationParentWakeup | null>;
  };
}) {
  const isWorkflowIssue = Boolean(input.issue.workflowTemplateKey || input.issue.workflowLaneRole);
  const isWorkflowQaLane = input.issue.workflowLaneRole === "qa";
  const workflowQaLaneFinalizableStatus =
    isWorkflowQaLane && (input.issue.status === "in_review" || input.issue.status === "blocked");
  if (isWorkflowIssue && !isWorkflowQaLane) {
    return {
      issue: input.issue,
      mergeStatus: null as IssueMergeStatus | null,
      parentWakeup: null as IssueQaFinalizationParentWakeup | null,
    };
  }
  if (!workflowQaLaneFinalizableStatus && input.issue.status !== "in_review") {
    return {
      issue: input.issue,
      mergeStatus: null as IssueMergeStatus | null,
      parentWakeup: null as IssueQaFinalizationParentWakeup | null,
    };
  }
  if (!input.comment.authorAgentId) {
    return {
      issue: input.issue,
      mergeStatus: null as IssueMergeStatus | null,
      parentWakeup: null as IssueQaFinalizationParentWakeup | null,
    };
  }

  const authorizedQaReviewerAgentId =
    isWorkflowQaLane
      ? input.issue.assigneeAgentId ?? null
      : authorizedStandaloneQaReviewerAgentId(input.issue);
  if (!authorizedQaReviewerAgentId || input.comment.authorAgentId !== authorizedQaReviewerAgentId) {
    return {
      issue: input.issue,
      mergeStatus: null as IssueMergeStatus | null,
      parentWakeup: null as IssueQaFinalizationParentWakeup | null,
    };
  }
  const currentCommentHasMarkers =
    qaCommentHasQaPassMarker(input.comment.body)
    && qaCommentHasReleaseConfirmedMarker(input.comment.body);
  if (!currentCommentHasMarkers && !input.actor.runId) {
    return {
      issue: input.issue,
      mergeStatus: null as IssueMergeStatus | null,
      parentWakeup: null as IssueQaFinalizationParentWakeup | null,
    };
  }

  const historicalComments = input.issues.listComments
    ? await input.issues.listComments(input.issue.id)
    : [];
  const qaComments = [
    input.comment,
    ...historicalComments,
  ]
    .filter((comment) => comment.authorAgentId === authorizedQaReviewerAgentId)
    .filter((comment, index, comments) => comments.findIndex((candidate) => candidate.id === comment.id) === index);
  const selectedComment = selectLatestRelevantQaComment(qaComments);
  if (!selectedComment) {
    return {
      issue: input.issue,
      mergeStatus: null as IssueMergeStatus | null,
      parentWakeup: null as IssueQaFinalizationParentWakeup | null,
    };
  }
  if (!qaCommentHasQaPassMarker(selectedComment.body) || !qaCommentHasReleaseConfirmedMarker(selectedComment.body)) {
    return {
      issue: input.issue,
      mergeStatus: null as IssueMergeStatus | null,
      parentWakeup: null as IssueQaFinalizationParentWakeup | null,
    };
  }

  if (isWorkflowQaLane) {
    const laneCompletion = input.workflow?.evaluateLaneCompletion
      ? await input.workflow.evaluateLaneCompletion(input.issue)
      : null;
    if (!laneCompletion?.canComplete) {
      return {
        issue: input.issue,
        mergeStatus: null as IssueMergeStatus | null,
        parentWakeup: null as IssueQaFinalizationParentWakeup | null,
      };
    }

    const closedIssue = await input.issues.update(input.issue.id, {
      status: "done",
      actorAgentId: input.actor.agentId ?? null,
      actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
      completionGuardrailsSatisfied: true,
    });
    if (!closedIssue) {
      return {
        issue: input.issue,
        mergeStatus: null as IssueMergeStatus | null,
        parentWakeup: null as IssueQaFinalizationParentWakeup | null,
      };
    }

    const parentWakeup =
      closedIssue.parentId && input.workflow?.getWakeableParentAfterChildCompletion
        ? await input.workflow.getWakeableParentAfterChildCompletion(closedIssue.parentId)
        : null;

    await input.logActivity(input.db, {
      companyId: closedIssue.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: "issue.qa_closed",
      entityType: "issue",
      entityId: closedIssue.id,
      details: {
        identifier: closedIssue.identifier,
        commentId: selectedComment.id,
        workflowLaneRole: closedIssue.workflowLaneRole ?? null,
        parentId: closedIssue.parentId ?? null,
      },
    });

    return {
      issue: closedIssue as TIssue,
      mergeStatus: null as IssueMergeStatus | null,
      parentWakeup,
    };
  }

  const qaGate = buildQaCommentHistoryGate({
    issue: input.issue,
    comments: qaComments,
    qaAgentId: authorizedQaReviewerAgentId,
  });
  if (!qaGate.canShip) {
    return {
      issue: input.issue,
      mergeStatus: null as IssueMergeStatus | null,
      parentWakeup: null as IssueQaFinalizationParentWakeup | null,
    };
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
    if (hasMergeBlockedCommentForSelectedVerdict({
      comments: historicalComments,
      selectedComment,
    })) {
      return {
        issue: input.issue,
        mergeStatus: mergeResult.status,
        parentWakeup: null as IssueQaFinalizationParentWakeup | null,
      };
    }
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
        commentId: selectedComment.id,
      },
    });
    return {
      issue: input.issue,
      mergeStatus: mergeResult.status,
      parentWakeup: null as IssueQaFinalizationParentWakeup | null,
    };
  }

  const closedIssue = await input.issues.update(input.issue.id, {
    status: "done",
    actorAgentId: input.actor.agentId ?? null,
    actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
    completionGuardrailsSatisfied: true,
  });
  if (!closedIssue) {
    return {
      issue: input.issue,
      mergeStatus: mergeResult.status,
      parentWakeup: null as IssueQaFinalizationParentWakeup | null,
    };
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
      commentId: selectedComment.id,
      targetBranch: mergeResult.status?.targetBranch ?? null,
      sourceBranch: mergeResult.status?.sourceBranch ?? null,
      mergedCommit: mergeResult.status?.mergedCommit ?? null,
    },
  });

  return {
    issue: closedIssue as TIssue,
    mergeStatus: mergeResult.status,
    parentWakeup: null as IssueQaFinalizationParentWakeup | null,
  };
}
