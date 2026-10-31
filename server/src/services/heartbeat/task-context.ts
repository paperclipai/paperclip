import { createHash } from "node:crypto";
import type { Db, agents, agentTaskSessions, heartbeatRuns } from "@paperclipai/db";
import { FAST_RESPONSE_AGENT_GUIDANCE, fastResponseHistoryBody } from "@paperclipai/shared";
import type { PaperclipTurnContext } from "@paperclipai/adapter-utils/server-utils";
import { parseObject } from "../../adapters/utils.js";
import { isConversation } from "../agent-conversations.js";
import { chatCompletionInstruction } from "../chat-completion-delivery.js";
import { getConversationConfirmationContext } from "../conversation-confirmation-context.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { getIssueContinuationSummaryDocument } from "../issue-continuation-summary.js";
import type { issueService } from "../issues.js";
import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";
import { redactQuarantinedBodyForHigherTrust, sanitizeQuarantinedCommentForHigherTrust } from "../source-trust.js";
import { getTaskPlanContext } from "../task-plan-context.js";
import { caseExecutionMarkdown, getCaseExecutionContext } from "../case-context.js";
import type { TrustPresetResolution } from "../trust-preset-resolver.js";
import { liveVoiceExecutionGuidance } from "../voice/voice-execution-guidance.js";
import { buildPaperclipWakePayload, ConfigurationIncompleteFailure, readHeartbeatWakeComments, PAPERCLIP_WAKE_PAYLOAD_KEY, type createHeartbeatRunPreparation } from "./run-preparation.js";
import { buildPaperclipTaskMarkdown } from "./task-markdown.js";
import { deriveCommentId, extractWakeCommentIds } from "../../modules/run-dispatch/index.js";
import { workspacePreferenceService } from "../workspace-preferences.js";

type RunPreparation = ReturnType<typeof createHeartbeatRunPreparation>;
type IssueContext = NonNullable<Awaited<ReturnType<RunPreparation["getIssueExecutionContext"]>>>;

export interface HeartbeatTaskContextInput {
  run: Pick<typeof heartbeatRuns.$inferSelect, "id">;
  agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType">;
  task: {
    issueRef: Pick<IssueContext,
      "id" | "identifier" | "title" | "status" | "priority" | "workMode" |
      "conversationAgentId" | "description" | "projectId"> | null;
    issueContext: IssueContext | null;
    context: Record<string, unknown>;
    taskSession: Pick<typeof agentTaskSessions.$inferSelect, "lastRunId"> | null;
  };
  policy: {
    recovering?: boolean;
    trustPreset: Pick<TrustPresetResolution, "kind">;
    experimentalInstanceSettings: { enableSimplifiedEnglishInteractions?: boolean; enableCases?: boolean };
  };
  services: {
    issuesSvc: Pick<ReturnType<typeof issueService>, "getAncestors">;
    getPinnedSkillTestContext: RunPreparation["getPinnedSkillTestContext"];
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Rebuilds task prompt fields on the run's context; acquires no execution resources. */
export async function prepareHeartbeatTaskContext(db: Db, input: HeartbeatTaskContextInput) {
  const { run, agent } = input;
  const { issueRef, issueContext, context, taskSession } = input.task;
  const { trustPreset, experimentalInstanceSettings } = input.policy;
  const { issuesSvc, getPinnedSkillTestContext } = input.services;
  const admittedScope = parseObject(context.paperclipAgentJwtScope);
  if (!input.policy.recovering || (admittedScope.kind !== "standard" && admittedScope.kind !== "skill_test")) {
    const savedIssue = parseObject(context.paperclipIssue);
    const skillTest = input.policy.recovering
      ? savedIssue.workMode === "skill_test" || Boolean(context.paperclipSkillTest)
      : issueRef?.workMode === "skill_test";
    context.paperclipAgentJwtScope = skillTest && issueRef
      ? { kind: "skill_test", issueId: issueRef.id }
      : { kind: "standard" };
  }
  const isSkillTest = parseObject(context.paperclipAgentJwtScope).kind === "skill_test";
  const wakeCommentId = deriveCommentId(context, null);
  const commentIds = [...new Set([...extractWakeCommentIds(context), ...(wakeCommentId ? [wakeCommentId] : [])])];
  const [summary, ancestors, pinnedSkillTestRead, wakeComments] = await Promise.allSettled([
    issueRef && !isConversation(issueContext) ? getIssueContinuationSummaryDocument(db, issueRef.id) : Promise.resolve(null),
    issueRef ? issuesSvc.getAncestors(issueRef.id) : Promise.resolve([]),
    isSkillTest && issueRef ? getPinnedSkillTestContext(agent.companyId, issueRef.id) : Promise.resolve(null),
    readHeartbeatWakeComments(db, agent.companyId, readNonEmptyString(context.issueId), commentIds),
  ]);
  if (summary.status === "rejected") throw summary.reason;
  if (ancestors.status === "rejected") throw ancestors.reason;
  if (pinnedSkillTestRead.status === "rejected") throw pinnedSkillTestRead.reason;
  if (wakeComments.status === "rejected") throw wakeComments.reason;
  const wakeCommentRows = wakeComments.value;
  const selectedWakeComment = issueRef && wakeCommentId ? wakeCommentRows.find(comment => comment.id === wakeCommentId && comment.issueId === issueRef.id) ?? null : null;
  const wakeCommentContext = selectedWakeComment ? {
    id: selectedWakeComment.id,
    body: selectedWakeComment.deletedAt ? "" : selectedWakeComment.body,
    authorType: selectedWakeComment.authorType,
    authorAgentId: selectedWakeComment.authorAgentId,
    authorUserId: selectedWakeComment.authorUserId,
    presentation: selectedWakeComment.deletedAt ? null : selectedWakeComment.presentation,
    metadata: selectedWakeComment.deletedAt ? null : selectedWakeComment.metadata,
    deletedAt: selectedWakeComment.deletedAt,
    deletedByType: selectedWakeComment.deletedByType,
    deletedByAgentId: selectedWakeComment.deletedByAgentId,
    deletedByUserId: selectedWakeComment.deletedByUserId,
    deletedByRunId: selectedWakeComment.deletedByRunId,
    sourceTrust: selectedWakeComment.sourceTrust,
  } : null;
  const continuationSummary = summary.value;
  const issueAncestors = ancestors.value;
  const pinnedSkillTestContext = pinnedSkillTestRead.value;
  const exposeLowTrustRaw = trustPreset.kind === "low_trust_review";
  const safeContinuationSummary =
    continuationSummary && !exposeLowTrustRaw
      ? redactQuarantinedBodyForHigherTrust(continuationSummary)
      : continuationSummary;
  const safeWakeCommentContext =
    wakeCommentContext && !exposeLowTrustRaw
      ? sanitizeQuarantinedCommentForHigherTrust(wakeCommentContext)
      : wakeCommentContext;
  if (continuationSummary) {
    context.paperclipContinuationSummary = {
      key: safeContinuationSummary!.key,
      title: safeContinuationSummary!.title,
      body: safeContinuationSummary!.body,
      sourceTrust: safeContinuationSummary!.sourceTrust ?? null,
      updatedAt: safeContinuationSummary!.updatedAt.toISOString(),
    };
  } else {
    delete context.paperclipContinuationSummary;
  }
  if (isSkillTest && !pinnedSkillTestContext) {
    throw new ConfigurationIncompleteFailure("The skill test's saved version is unavailable.", {
      configurationIncomplete: { reason: "skill_unavailable", actionUrl: "/skills" },
    });
  }
  if (pinnedSkillTestContext) {
    context.paperclipSkillTest = {
      ...pinnedSkillTestContext,
      directive:
        "Use this pinned file inventory as the exact skill revision under test, regardless of synced runtime skills.",
    };
  } else {
    delete context.paperclipSkillTest;
  }
  const executionContinuation =
    issueRef && !isConversation(issueContext) && issueContext?.assigneeAgentId === agent.id
      ? await buildExecutionContinuation({
          db,
          companyId: agent.companyId,
          issueId: issueRef.id,
          agentId: agent.id,
          runId: run.id,
          context,
          previousContextRunId: taskSession?.lastRunId,
          summary: safeContinuationSummary?.body ?? null,
          exposeLowTrustRaw,
        })
      : null;
  context.executionContinuation = executionContinuation;
  const paperclipWakePayload = await buildPaperclipWakePayload({
    db,
    companyId: agent.companyId,
    agentId: agent.id,
    runId: run.id,
    contextSnapshot: context,
    wakeCommentRows,
    continuationSummary,
    issueSummary: issueRef
      ? {
          id: issueRef.id,
          identifier: issueRef.identifier,
          title: issueRef.title,
          description: issueContext?.description ?? null,
          status: issueRef.status,
          priority: issueRef.priority,
          workMode: issueRef.workMode,
          projectId: issueRef.projectId,
          executionPolicy: issueContext?.executionPolicy ?? null,
          originKind: issueContext?.originKind ?? null,
        }
      : null,
    exposeLowTrustRaw,
    simplifiedEnglishInteractions:
      experimentalInstanceSettings.enableSimplifiedEnglishInteractions ===
      true,
  });
  if (paperclipWakePayload) {
    context[PAPERCLIP_WAKE_PAYLOAD_KEY] = paperclipWakePayload;
  } else {
    delete context[PAPERCLIP_WAKE_PAYLOAD_KEY];
  }
  const safeWakeComments = (paperclipWakePayload?.comments ?? []).flatMap(
    (comment) =>
      typeof comment.id === "string" && typeof comment.body === "string"
        ? [
            {
              id: comment.id,
              body: fastResponseHistoryBody({ body: comment.body, origin: typeof comment.origin === "string" ? comment.origin : null }),
              attachments: Array.isArray(comment.attachments)
                ? comment.attachments.flatMap((attachment) => {
                    const descriptor = parseObject(attachment);
                    const id = readNonEmptyString(descriptor.id);
                    const filename = readNonEmptyString(
                      descriptor.filename,
                    );
                    const contentType = readNonEmptyString(
                      descriptor.contentType,
                    );
                    const contentPath = readNonEmptyString(
                      descriptor.contentPath,
                    );
                    const byteSize = descriptor.byteSize;
                    return id &&
                      filename &&
                      contentType &&
                      contentPath &&
                      typeof byteSize === "number"
                      ? [
                          {
                            id,
                            filename,
                            contentType,
                            byteSize,
                            contentPath,
                          },
                        ]
                      : [];
                  })
                : [],
            },
          ]
        : [],
  );
  // Always replace caller-supplied context with the immutable, company-scoped
  // conversation snapshot. It belongs only to the endpoint's assigned agent.
  const liveVoiceGuidance = issueContext?.chatAssignedAgentId === agent.id && issueContext.chatProvider === "speko"
    ? await liveVoiceExecutionGuidance(db, { companyId: agent.companyId, issueId: issueContext.id, agentId: agent.id })
    : null;
  context.paperclipTaskCommunicationGuidance =
    issueContext?.chatAssignedAgentId === agent.id
      ? issueContext.chatCommunicationGuidance
      : null;
  // Use the standing chat owner's saved presentation choice, never worker text.
  // Recovery retains the admitted choice instead of silently changing its prompt.
  const coordinatorWorkspace = agent.adapterType === "paperclip_runner" && isConversation(issueContext)
    && issueContext?.conversationUserId
    ? input.policy.recovering
      ? context.paperclipCoordinatorWorkspaceEnabled === true
      : (await workspacePreferenceService(db).get(issueContext.conversationUserId)).coordinatorWorkspaceEnabled
    : false;
  context.paperclipCoordinatorWorkspaceEnabled = Boolean(coordinatorWorkspace);
  const taskMarkdownInput = {
    coordinatorWorkspace: Boolean(coordinatorWorkspace),
    conversationConfirmations: issueRef && isConversation(issueContext)
      ? await getConversationConfirmationContext({ db, companyId: agent.companyId, issueId: issueRef.id, agentId: agent.id })
      : null,
    issue: issueRef
      ? {
          id: issueRef.id,
          identifier: issueRef.identifier,
          title: issueRef.title,
          titleNeedsGeneration: issueContext?.titleNeedsGeneration,
          workMode: issueRef.workMode,
          conversationAgentId: issueContext?.conversationAgentId,
          executionPolicy: issueContext?.executionPolicy,
          description: issueRef.description,
        }
      : null,
    ancestors: issueAncestors,
    wakeComment: safeWakeCommentContext,
    wakeComments: safeWakeComments,
    attachmentOmissions: paperclipWakePayload?.attachmentOmissions,
    externalChatProvider: paperclipWakePayload?.externalChatProvider,
    slackCommand: issueContext?.chatAssignedAgentId === agent.id
      ? issueContext.chatSlackCommand
      : null,
    nativeRunner: agent.adapterType === "paperclip_runner",
    interaction: {
      kind: readNonEmptyString(context.interactionKind),
      status: readNonEmptyString(context.interactionStatus),
    },
    planReview: paperclipWakePayload?.planReviewContext?.interaction
      ? {
          status: paperclipWakePayload.planReviewContext.interaction.status,
          reason: paperclipWakePayload.planReviewContext.interaction.result?.reason,
        }
      : null,
    acceptedPlanContinuation:
      readNonEmptyString(context.workspaceRefreshReason) ===
        "accepted_plan_confirmation" &&
      Object.keys(parseObject(context.acceptedPlanWakeRouting)).length ===
        0,
    acceptedPlan: (() => {
      const accepted = parseObject(
        parseObject(context.planReviewInteraction).acceptedTargetRevision,
      );
      const revisionId = readNonEmptyString(accepted.revisionId);
      if (!revisionId) return null;
      return {
        documentId: readNonEmptyString(accepted.documentId),
        revisionId,
        revisionNumber:
          typeof accepted.revisionNumber === "number"
            ? accepted.revisionNumber
            : null,
      };
    })(),
  };
  const taskPlan = issueRef && !isConversation(issueContext)
    ? await getTaskPlanContext({
        db,
        companyId: agent.companyId,
        issueId: issueRef.id,
        approvedRevisionId: taskMarkdownInput.acceptedPlan?.revisionId,
        exposeLowTrustRaw,
      })
    : null;
  // Unlike the frozen initial communication preferences, live-call context
  // must also reach resumed turns. Rebuild it from server records each wake.
  const liveVoiceTaskPrefix = liveVoiceGuidance ? `${liveVoiceGuidance}\n\n` : "";
  context.paperclipCasesEnabled = experimentalInstanceSettings.enableCases === true;
  const workflowCase = issueRef && experimentalInstanceSettings.enableCases
    ? await getCaseExecutionContext(db, { companyId: agent.companyId, issueId: issueRef.id, agentId: agent.id, runId: run.id, exposeLowTrustRaw })
    : null;
  if (workflowCase) context.paperclipCase = workflowCase;
  else delete context.paperclipCase;
  const assignmentPrefix = liveVoiceTaskPrefix + caseExecutionMarkdown(workflowCase);
  let taskMarkdown = assignmentPrefix + buildPaperclipTaskMarkdown({ ...taskMarkdownInput, taskPlan }) + chatCompletionInstruction(context);
  let taskMarkdownAssignment = assignmentPrefix + buildPaperclipTaskMarkdown({
    ...taskMarkdownInput,
    taskPlan,
    includeWakeComments: false,
  }) + chatCompletionInstruction(context);
  const taskMarkdownCompact = assignmentPrefix + buildPaperclipTaskMarkdown({
    ...taskMarkdownInput,
    taskPlan,
    includeDescription: false,
  }) + chatCompletionInstruction(context);
  const taskMarkdownAssignmentCompact = assignmentPrefix + buildPaperclipTaskMarkdown({
    ...taskMarkdownInput,
    taskPlan,
    includeDescription: false,
    includeWakeComments: false,
  }) + chatCompletionInstruction(context);
  if (issueRef) {
    context.paperclipIssue = {
      id: issueRef.id,
      identifier: issueRef.identifier,
      title: issueRef.title,
      description: isConversation(issueContext) ? null : issueRef.description,
      workMode: issueRef.workMode,
    };
  } else {
    delete context.paperclipIssue;
  }
  if (wakeCommentContext) {
    context.paperclipWakeComment = safeWakeCommentContext;
  } else {
    delete context.paperclipWakeComment;
  }
  if (taskMarkdown) {
    context.paperclipTaskMarkdown = taskMarkdown;
  } else {
    delete context.paperclipTaskMarkdown;
  }
  if (taskMarkdownAssignment) {
    context.paperclipTaskMarkdownAssignment = taskMarkdownAssignment;
  } else {
    delete context.paperclipTaskMarkdownAssignment;
  }
  if (taskMarkdownCompact && taskMarkdownCompact !== taskMarkdown) {
    context.paperclipTaskMarkdownCompact = taskMarkdownCompact;
  } else {
    delete context.paperclipTaskMarkdownCompact;
  }
  if (taskMarkdownAssignmentCompact && taskMarkdownAssignmentCompact !== taskMarkdownAssignment) {
    context.paperclipTaskMarkdownAssignmentCompact = taskMarkdownAssignmentCompact;
  } else {
    delete context.paperclipTaskMarkdownAssignmentCompact;
  }
  context.paperclipTaskCommunicationGuidance = [context.paperclipTaskCommunicationGuidance, FAST_RESPONSE_AGENT_GUIDANCE].filter(Boolean).join("\n\n");
  if (issueRef) {
    const redactedWakeContext = await createRunSecretRedactionRegistry(
      db,
    ).redactForIssue(agent.companyId, issueRef.id, {
      paperclipIssue: context.paperclipIssue,
      paperclipCase: context.paperclipCase,
      paperclipWakeComment: context.paperclipWakeComment,
      paperclipTaskCommunicationGuidance: context.paperclipTaskCommunicationGuidance,
      paperclipTaskMarkdown: context.paperclipTaskMarkdown,
      paperclipTaskMarkdownCompact: context.paperclipTaskMarkdownCompact,
      paperclipTaskMarkdownAssignment: context.paperclipTaskMarkdownAssignment,
      paperclipTaskMarkdownAssignmentCompact: context.paperclipTaskMarkdownAssignmentCompact,
    });
    context.paperclipIssue = redactedWakeContext.paperclipIssue;
    if (redactedWakeContext.paperclipCase) context.paperclipCase = redactedWakeContext.paperclipCase;
    context.paperclipTaskCommunicationGuidance = redactedWakeContext.paperclipTaskCommunicationGuidance;
    if (redactedWakeContext.paperclipWakeComment) {
      context.paperclipWakeComment =
        redactedWakeContext.paperclipWakeComment;
    }
    if (redactedWakeContext.paperclipTaskMarkdown) {
      context.paperclipTaskMarkdown =
        redactedWakeContext.paperclipTaskMarkdown;
    }
    if (redactedWakeContext.paperclipTaskMarkdownCompact) {
      context.paperclipTaskMarkdownCompact =
        redactedWakeContext.paperclipTaskMarkdownCompact;
    }
    if (redactedWakeContext.paperclipTaskMarkdownAssignment) {
      context.paperclipTaskMarkdownAssignment =
        redactedWakeContext.paperclipTaskMarkdownAssignment;
    }
    if (redactedWakeContext.paperclipTaskMarkdownAssignmentCompact) {
      context.paperclipTaskMarkdownAssignmentCompact =
        redactedWakeContext.paperclipTaskMarkdownAssignmentCompact;
    }
  }
  if (issueRef) {
    const digest = (value: string | null | undefined) =>
      value?.trim()
        ? createHash("sha256")
            .update(value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""))
            .digest("hex")
        : null;
    const redactedIssue = parseObject(context.paperclipIssue);
    context.paperclipTurnContext = {
      version: 1,
      assignment: {
        owner: "task_markdown",
        description: {
          id: issueRef.id,
          revision: digest(readNonEmptyString(redactedIssue.description)),
        },
      },
      events: {
        owner: "wake_prompt",
        comments: safeWakeComments.map((comment) => ({
          id: comment.id,
          revision: digest(comment.body),
        })),
      },
    } satisfies PaperclipTurnContext;
  } else {
    delete context.paperclipTurnContext;
  }
  const pinnedSkillTest = pinnedSkillTestContext
    ? { key: pinnedSkillTestContext.skillKey, versionId: pinnedSkillTestContext.skillVersionId } : null;
  return { continuationSummary, executionContinuation, paperclipWakePayload, safeWakeComments, safeWakeCommentContext, pinnedSkillTest };
}
