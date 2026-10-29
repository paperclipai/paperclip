import { notifyChatRunMilestones } from "../chat-run-milestone-notifications.js";
import { notifyNativeFinalizationWork } from "../native-finalization-notifications.js";
import { accessService } from "../access.js";
import { initializeRunIdentity } from "../run-identity.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq, ne, sql } from "drizzle-orm";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  approvals,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubConfigurations,
  chatGitHubReviews,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  companies,
  companyMemberships,
  completionContracts,
  closeRegisteredClients,
  createDb,
  subscribeDatabaseWork,
  heartbeatRuns,
  issueComments,
  issueAttachments,
  issueApprovals,
  issueThreadInteractions,
  issueQuestionResponseDeliveries,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  runIdentityContexts,
  statusDecisions,
  toolApplications,
  toolConnections,
  toolOauthStates,
  chatVoiceSessions, chatVoiceReplies, chatVoiceToolCalls,
  workspaceOperations,
} from "@paperclipai/db";
import { validatePrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import type {
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../../vendor/paperclip-runner/index.js";

import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { finalizeNativeRun, recoverCommittedNativeReviewResponse } from "./native-run-finalizer.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { configureAgentLifecycle, createAgentLifecycle, processAgentLifecycle } from "../agent-lifecycle.js";
import { createOAuthStateStore } from "../tool-access/oauth/state.js";
import { approvalRecords } from "../approvals.js";
import { issueApprovalService } from "../issue-approvals.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { nativeReviewResponseWork } from "./native-review-response-work.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../task-admission.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import { hasPublishedGitHubReview, readInheritedGitHubReviewWait } from "../chat-channels/github/review-wait.js";
import * as chatWaitAuthority from "./chat-attachment-reuse.js";
import * as publishedReviewAuthority from "../chat-channels/github/review-wait.js";
import { toolAccessService } from "../tool-access.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import {
  authorizeNativeChatReviewPresentation,
  hasMaterializedNativeReviewResponse,
} from "./native-chat-review-presentation.js";
import * as nativeChatReviewPresentation from "./native-chat-review-presentation.js";
import { resolveChatRunPresentationAuthorizationReason } from "../chat-run-publications.js";
import { resolveHeartbeatRunResponse } from "../heartbeat-run-summary.js";
import { issueService } from "../issues.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import {
  authorizeChatConversationForBoundRun,
  isExternalChatWaitAuthorizationContention,
  resolveExternalChatResponseWaitAuthorization,
} from "./chat-attachment-reuse.js";
import { attestReviewedExternalChatRun, buildPaperclipWakePayload } from "../heartbeat.js";
import { voiceCredentialFingerprint } from "../voice/voice-session-store.js";
import { nativeSha256 } from "./canonical.js";
import { questionResponseDeliveryValues } from "../question-response-delivery.js";
import { resolveExternalChatQuestionResponse } from "./external-chat-question-response.js";
import { listExternalReviewWaits } from "./external-review-wait.js";
import { materializeExternalChatQuestionResponseInput } from "./external-chat-question-response-input.js";
import * as nativeInteractionBridge from "./native-interaction-bridge.js";
import { defaultGitHubReviewPolicy, type AskUserQuestionsInteraction } from "@paperclipai/shared";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { subscribeAllCompanyLiveEvents } from "../live-events.js";

describe("native external-chat response wait", () => {
  const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
  let temporary: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
      return;
    }
    temporary = await startEmbeddedPostgresTestDatabase(
      "native-external-chat-wait-",
    );
    db = createDb(temporary.connectionString);
  }, 30_000);

  afterAll(async () => {
    await temporary?.cleanup();
    if (externalTestDatabaseUrl)
      await closeRegisteredClients(externalTestDatabaseUrl);
  });

  async function seedWaitTurn(
    provider:
      | "telegram"
      | "discord"
      | "github"
      | "microsoft-teams"
      | "slack" = "telegram",
    attentionRequests: PrpStructuredRunResult["attentionRequests"] = [],
    resultOverrides: Partial<PrpStructuredRunResult> = {},
    deferCompletion = false,
    contractOverride?: { objective: string; criteria: Array<{ id: string; requirement: string }> },
  ) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const sessionId = randomUUID();
    const runnerInstanceId = randomUUID();
    const contractId = randomUUID();
    const endpointId = randomUUID();
    const resourceId = randomUUID();
    const conversationId = randomUUID();
    const principalId = randomUUID();
    const commentId = randomUUID();
    const deliveryId = randomUUID();
    const userId = `wait-user-${randomUUID()}`;
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const contractSha256 = `external-chat-wait-${randomUUID()}`;
    // Keep prefix uniqueness as strong as the company's primary key. A five-
    // digit random prefix can collide within this fixture-heavy suite.
    const issuePrefix = `W${companyId.replaceAll("-", "").toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "External chat wait",
      issuePrefix,
      issueCounter: 1,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Waiting chat agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      title: "Send the photo and wait",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v3",
      risk: "low",
      completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "external-chat-wait-v1",
        objective: "Send the requested photo and wait for the next message",
        criteria: [
          { id: "response", requirement: "Return the requested photo" },
        ],
        ...contractOverride,
      },
      canonicalSha256: contractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      contextSnapshot: {},
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `chat:telegram:${endpointId}`,
      name: "Telegram wait",
      type: "chat",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "Telegram wait",
      uid: `chat-telegram-${endpointId}`,
      connectionPurpose: "channel",
      transport: "chat_sdk",
      status: "active",
      enabled: true,
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider,
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
      providerAccountId: "telegram-bot",
      allowDirectMessages: true,
      allowUnlinkedPeople: false,
    });
    await db.insert(chatEndpointResources).values({
      id: resourceId,
      companyId,
      endpointId,
      type: provider === "github" ? "repository" : "direct_message",
      providerResourceId:
        provider === "github" ? "paperclip/test-repository" : "telegram-user",
      label:
        provider === "github"
          ? "Paperclip test repository"
          : "Telegram direct message",
      availability: "available",
      enabled: true,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      companyId,
      endpointId,
      resourceId,
      issueId,
      externalConversationId: "telegram-user",
      externalThreadId: "telegram:telegram-user",
      sessionGeneration: 1,
      externalLabel: "Telegram direct message",
      isDirectMessage: provider !== "github",
      state: "active",
    });
    await db.insert(chatExternalPrincipals).values({
      id: principalId,
      companyId,
      provider,
      providerAccountId: "telegram-bot",
      externalId: "telegram-user",
      kind: "user",
    });
    await db.insert(chatIdentityLinks).values({
      companyId,
      endpointId,
      principalId,
      paperclipUserId: userId,
      status: "linked",
    });
    await db.insert(authUsers).values({ id: userId, name: "Review owner", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorType: "user",
      authorUserId: userId,
      body: "Send the photo, keep this task in progress, and wait.",
    });
    await db.insert(chatDeliveries).values({
      id: deliveryId,
      companyId,
      endpointId,
      conversationId,
      principalId,
      providerEventId: "telegram-wait-message",
      deduplicationKey: "telegram-wait-message",
      eventKind: "message",
      normalizedEvent: {},
      state: "processed",
      attempts: 1,
      processedAt: new Date(),
    });
    await db.insert(chatMessageLinks).values({
      companyId,
      endpointId,
      conversationId,
      deliveryId,
      commentId,
      providerMessageId: "telegram-user:1",
      direction: "inbound",
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          source: `chat:${provider}`,
          paperclipHarnessCheckedOut: true,
          issueId,
          wakeCommentId: commentId,
          wakeCommentIds: [commentId],
          paperclipWake: {
            reason: "External chat message received",
            externalChatProvider: provider,
            checkedOutByHarness: true,
            issue: { id: issueId, workMode: "standard" },
            commentIds: [commentId],
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const port = new PaperclipControlPlanePort(db, {
      companyId,
      issueId,
      runId,
      agentId,
      sessionId,
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: `wait-control-${runId}`,
    });
    await port.openRun({
      identity: { companyId, issueId, runId, agentId, sessionId },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const result: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary:
        "The requested photo is prepared. I will wait for your next message.",
      completionClaim: {
        contractRevision: "external-chat-wait-v1",
        objectiveSatisfied: true,
        criteria: [
          {
            criterionId: "response",
            status: "satisfied",
            evidenceRefs: [],
          },
        ],
        remainingWork: [],
      },
      evidence: [],
      verification: [],
      attentionRequests,
      artifacts: [],
      continuation: {
        kind: "response_wake",
        summary: "Wait for the next authorized Telegram message.",
        idempotencyKey: `telegram-response-wait:${conversationId}`,
      },
      ...resultOverrides,
    };
    const terminal: PrpTerminalState = {
      schema: "paperclip.prp.terminal.v1",
      turnTerminalState: "completed",
      runTerminalState: "succeeded",
      reportedWorkDisposition: result.reportedWorkDisposition,
      workAssessmentId: randomUUID(),
      statusDecisionId: randomUUID(),
    };
    if (!deferCompletion) await port.completeRun({
      result,
      terminal,
      callerResultId: `wait-result-${runId}`,
    });
    await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        resultJson: {
          nativeResult: result as unknown as Record<string, unknown>,
        },
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));

    return {
      port, result, terminal,
      agentId,
      companyId,
      conversationId,
      endpointId,
      deliveryId,
      issueId,
      resourceId,
      runId,
      userId,
      commentId,
      principalId,
      storeBinding: { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
        runnerSourceInstanceId: runnerInstanceId, completionContractId: contractId,
        completionContractSha256: contractSha256, completionContractRevision: "external-chat-wait-v1",
        completionContractCriterionIds: ["response"] },
    };
  }

  async function placeWaitTurnInSetupTest(
    fixture: Awaited<ReturnType<typeof seedWaitTurn>>,
    options: {
      credentialFingerprint?: string;
      generation?: number;
      processedAt?: Date;
      receivedAt?: Date;
      setupStep?: "provider_setup" | "test";
      testStartedAt?: Date;
    } = {},
  ) {
    const testStartedAt =
      options.testStartedAt ?? new Date(Date.now() - 5_000);
    const receivedAt = options.receivedAt ?? new Date(Date.now() - 4_000);
    const processedAt = options.processedAt ?? new Date(Date.now() - 3_000);
    const generation = options.generation ?? 1;
    await db
      .update(chatEndpoints)
      .set({
        status: "verifying",
        setup: {
          step: options.setupStep ?? "test",
          testStartedAt: testStartedAt.toISOString(),
          runtimeGeneration: generation,
        } as (typeof chatEndpoints.$inferSelect)["setup"] & {
          runtimeGeneration: number;
        },
        updatedAt: new Date(),
      })
      .where(eq(chatEndpoints.id, fixture.endpointId));
    await db
      .update(chatDeliveries)
      .set({
        normalizedEvent: {
          runtimeContext: {
            generation,
            credentialFingerprint:
              options.credentialFingerprint ?? "a".repeat(64),
          },
        },
        processedAt,
        receivedAt,
        updatedAt: new Date(),
      })
      .where(eq(chatDeliveries.id, fixture.deliveryId));
    return { processedAt, receivedAt, testStartedAt };
  }

  async function seedAnsweredChatTurn(
    provider: "telegram" | "discord" | "slack" = "telegram",
    target?: {
      fixture: Awaited<ReturnType<typeof seedWaitTurn>>;
      gate: Awaited<ReturnType<typeof seedPriorCompletionReview>>;
    },
    responseKind: "button" | "form" | "multi" = "button",
  ) {
    const fixture = target?.fixture ?? await seedWaitTurn(provider);
    const gate = target?.gate ?? await seedPriorCompletionReview(fixture);
    const [current] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    const sourceRunId = randomUUID();
    const interactionId = randomUUID();
    const wakeId = randomUUID();
    const publicationId = randomUUID();
    const actionId = randomUUID();
    const formActionId = `pcfs:${"A".repeat(22)}`;
    const selectFieldId = `pcff:${"B".repeat(22)}`;
    const textFieldId = `pcff:${"C".repeat(22)}`;
    const selectValue = `pcfo:${"D".repeat(22)}`;
    const formExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const interactionPayload =
      responseKind === "form"
        ? {
            version: 1 as const,
            questions: [
              {
                id: "environment",
                prompt: "Choose an environment",
                selectionMode: "single" as const,
                required: true,
                allowOther: false,
                options: [{ id: "cedar", label: "Cedar" }],
              },
              {
                id: "note",
                prompt: "Enter a release note",
                selectionMode: "single" as const,
                required: true,
                allowOther: true,
                options: [
                  {
                    id: "__paperclip_text__",
                    label: "Type an answer",
                    freeText: true,
                  },
                ],
              },
            ],
          }
        : {
            version: 1 as const,
            questions: [
              {
                id: "color",
                prompt: "Choose a color",
                selectionMode: responseKind === "multi" ? "multi" as const : "single" as const,
                required: true,
                allowOther: false,
                options: [
                  { id: "cobalt", label: "Cobalt" },
                  { id: "amber", label: "Amber" },
                ],
              },
            ],
          };
    const interactionResult =
      responseKind === "form"
        ? {
            version: 1 as const,
            answers: [
              { questionId: "environment", optionIds: ["cedar"] },
              {
                questionId: "note",
                optionIds: [],
                otherText: "cobalt lantern82",
              },
            ],
          }
        : {
            version: 1 as const,
            answers: [{ questionId: "color", optionIds: responseKind === "multi" ? ["cobalt", "amber"] : ["cobalt"] }],
          };
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status: "succeeded",
      runtimeMode: "native",
      nativeIssueId: fixture.issueId,
      contextSnapshot: current!.contextSnapshot,
    });
    const [interaction] = await db
      .insert(issueThreadInteractions)
      .values({
        id: interactionId,
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        kind: "ask_user_questions",
        status: "answered",
        sourceRunId,
        createdByAgentId: fixture.agentId,
        resolvedByUserId: fixture.userId,
        resolvedAt: new Date(),
        idempotencyKey: `color-${interactionId}`,
        payload: interactionPayload,
        result: interactionResult,
      })
      .returning();
    const [responseDelivery] = await db
      .insert(issueQuestionResponseDeliveries)
      .values({
        ...questionResponseDeliveryValues(
          interaction! as unknown as AskUserQuestionsInteraction,
        ),
        status: "fallback_queued",
        deliveryMode: "wake_fallback",
        targetRunId: fixture.runId,
        attemptCount: 1,
        acknowledgedAt: new Date(),
      })
      .returning();
    await db.insert(chatPublications).values({
      id: publicationId,
      companyId: fixture.companyId,
      endpointId: fixture.endpointId,
      conversationId: fixture.conversationId,
      issueId: fixture.issueId,
      state: "published",
      idempotencyKey: `card-${interactionId}`,
      providerMessageId: "question-card",
      publishedAt: new Date(),
      payload: { interactionId } as never,
    });
    await db.insert(chatActions).values({
      id: actionId,
      companyId: fixture.companyId,
      endpointId: fixture.endpointId,
      conversationId: fixture.conversationId,
      principalId: fixture.principalId,
      kind:
        responseKind === "form" ? "question_form_submit" : "question_answer",
      status: "processed",
      providerActionId:
        responseKind === "form" ? formActionId : `answer-${interactionId}`,
      payload:
        responseKind === "form"
          ? {
              version: 1,
              publicationId,
              interactionId,
              formActionId,
              expiresAt: formExpiresAt,
              fields: [
                {
                  fieldId: selectFieldId,
                  kind: "single_select",
                  questionId: "environment",
                  required: true,
                  options: [{ optionId: "cedar", value: selectValue }],
                },
                {
                  fieldId: textFieldId,
                  kind: "text",
                  questionId: "note",
                  required: true,
                  minLength: 0,
                  maxLength: 3_000,
                  inputType: "text",
                },
              ],
            }
          : {
              version: 1,
              interactionId,
              publicationId,
              questionId: "color",
              ...(responseKind === "multi" ? { selectionOptions: [{ value: "opaque-cobalt", optionId: "cobalt" }, { value: "opaque-amber", optionId: "amber" }], selectionValues: ["opaque-cobalt", "opaque-amber"] } : { optionId: "cobalt" }),
            },
      result:
        responseKind === "form"
          ? { code: "question_form_answered", interactionId }
          : { interactionId, interactionStatus: "answered" },
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      requestedByActorType: "user",
      requestedByActorId: fixture.userId,
      idempotencyKey: `question-response:${interactionId}`,
      status: "claimed",
      runId: fixture.runId,
      payload: {
        issueId: fixture.issueId,
        interactionId,
        sourceRunId,
        sourceCommentId: fixture.commentId,
        mutation: "interaction",
        externalChatContinuation: true,
      },
    });
    const context: Record<string, unknown> = {
      issueId: fixture.issueId,
      taskId: fixture.issueId,
      source: "issue.interaction.respond",
      wakeReason: "issue_commented",
      interactionId,
      interactionKind: "ask_user_questions",
      interactionStatus: "answered",
      sourceRunId,
      sourceCommentId: fixture.commentId,
      wakeCommentId: fixture.commentId,
      wakeCommentIds: [fixture.commentId],
      externalChatContinuation: true,
    };
    await db
      .update(heartbeatRuns)
      .set({ wakeupRequestId: wakeId, contextSnapshot: context, status: "running" })
      .where(eq(heartbeatRuns.id, fixture.runId));
    return {
      ...fixture,
      gate,
      context,
      interactionId,
      sourceRunId,
      responseDeliveryId: responseDelivery!.id,
      wakeId,
      publicationId,
      actionId,
    };
  }

  async function seedBoardAnsweredTurn(withLink = true, provider: "github" | "slack" = "github", oversized = false) {
    const fixture = await seedWaitTurn(provider);
    if (provider === "slack") {
      await db.update(chatEndpointResources).set({ type: "channel" }).where(eq(chatEndpointResources.id, fixture.resourceId));
      await db.update(chatConversations).set({ isDirectMessage: false }).where(eq(chatConversations.id, fixture.conversationId));
    }
    const gate = await seedPriorCompletionReview(fixture);
    const [current] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status: "succeeded",
      runtimeMode: "native",
      nativeIssueId: fixture.issueId,
      contextSnapshot: current!.contextSnapshot,
    });
    await db
      .update(chatEndpoints)
      .set({
        setup: {
          step: "complete",
          runtimeGeneration: 1,
        } as typeof chatEndpoints.$inferInsert.setup,
      })
      .where(eq(chatEndpoints.id, fixture.endpointId));
    await db
      .update(chatDeliveries)
      .set({
        normalizedEvent: {
          runtimeContext: {
            generation: 1,
            credentialFingerprint: "a".repeat(64),
          },
        },
      })
      .where(eq(chatDeliveries.id, fixture.deliveryId));
    const interactionSvc = issueThreadInteractionService(db);
    const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;
    process.env.PAPERCLIP_PUBLIC_URL = withLink
      ? "https://board.paperclip.example"
      : "http://127.0.0.1:3103";
    let interaction: Awaited<ReturnType<typeof interactionSvc.create>>;
    try {
      interaction = await interactionSvc.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          sourceRunId,
          continuationPolicy: "wake_assignee",
          payload: {
            version: 1,
            questions: [
              {
                id: "color",
                prompt: "Choose a color",
                // Multi-select plus a custom answer intentionally needs Board.
                selectionMode: provider === "slack" ? "multi" : "single",
                required: true,
                allowOther: provider === "slack" && !oversized,
                options: [
                  { id: "cobalt", label: "Cobalt" },
                  { id: "amber", label: "Amber" },
                  ...(oversized ? Array.from({ length: 9 }, (_, index) => ({
                    id: `option-${index}`, label: `Option ${index}`, description: "Detail ".repeat(550),
                  })) : []),
                ],
              },
            ],
          },
        },
        { agentId: fixture.agentId, runId: sourceRunId },
      );
    } finally {
      if (previousPublicUrl === undefined)
        delete process.env.PAPERCLIP_PUBLIC_URL;
      else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
    }
    const publicationKey = `interaction:${interaction.id}:${fixture.endpointId}`;
    const [publication] = await db
      .update(chatPublications)
      .set({
        state: "published",
        providerMessageId: `${provider}-question`,
        publishedAt: new Date(),
      })
      .where(eq(chatPublications.idempotencyKey, publicationKey))
      .returning();
    expect(publication).toBeTruthy();
    await interactionSvc.answerQuestions(
      { id: fixture.issueId, companyId: fixture.companyId },
      interaction.id,
      { answers: [{ questionId: "color", optionIds: ["cobalt"] }] },
      { userId: fixture.userId },
    );
    const [delivery] = await db
      .update(issueQuestionResponseDeliveries)
      .set({
        status: "fallback_queued",
        deliveryMode: "wake_fallback",
        targetRunId: fixture.runId,
        attemptCount: 1,
        acknowledgedAt: new Date(),
      })
      .where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id))
      .returning();
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      requestedByActorType: "user",
      requestedByActorId: fixture.userId,
      idempotencyKey: `question-response:${interaction.id}`,
      status: "claimed",
      runId: fixture.runId,
      payload: {
        issueId: fixture.issueId,
        interactionId: interaction.id,
        sourceRunId,
        sourceCommentId: fixture.commentId,
        mutation: "interaction",
        externalChatContinuation: true,
      },
    });
    const context: Record<string, unknown> = {
      issueId: fixture.issueId,
      taskId: fixture.issueId,
      source: "issue.interaction.respond",
      wakeReason: "issue_commented",
      interactionId: interaction.id,
      interactionKind: "ask_user_questions",
      interactionStatus: "answered",
      sourceRunId,
      sourceCommentId: fixture.commentId,
      wakeCommentId: fixture.commentId,
      wakeCommentIds: [fixture.commentId],
      externalChatContinuation: true,
    };
    await db
      .update(heartbeatRuns)
      .set({
        wakeupRequestId: wakeId,
        contextSnapshot: context,
        status: "running",
      })
      .where(eq(heartbeatRuns.id, fixture.runId));
    return {
      ...fixture,
      gate,
      context,
      sourceRunId,
      interactionId: interaction.id,
      publicationId: publication!.id,
      responseDeliveryId: delivery!.id,
      wakeId,
    };
  }

  it.each(["telegram", "github", "github_board_answer", "slack_board_answer"] as const)(
    "reads small current external review waits without saved prompts (%s)", async source => {
      const fixture = await (async () => {
        if (source === "github_board_answer" || source === "slack_board_answer") {
          const answered = await seedBoardAnsweredTurn(true, source === "github_board_answer" ? "github" : "slack");
          await attestAnswer(answered);
          return answered;
        }
        return seedWaitTurn(source);
      })();
      const finalized = await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      expect(finalized.phase).toBe("committed");
      await db.update(statusDecisions).set({ toStatus: "in_review" }).where(eq(statusDecisions.id, finalized.decisionId!));
      await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, fixture.issueId));
      const [decision] = await db.select({ reason: statusDecisions.reasonCode, state: statusDecisions.applicationState })
        .from(statusDecisions).where(eq(statusDecisions.id, finalized.decisionId!));
      const governed = source === "github_board_answer" || source === "slack_board_answer";
      expect(decision).toEqual({ reason: governed ? "governed_response_waiting" : "external_chat_response_waiting", state: "applied" });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      expect(run!.status).toBe("succeeded");
      const contextSnapshot = { ...run!.contextSnapshot, savedPrompt: "external-wait-saved-input🙂".repeat(30_000) };
      await db.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, fixture.runId));
      await authorizeChatConversationForBoundRun(db, fixture, contextSnapshot, "read");
      const observed = createDb(temporary?.connectionString ?? externalTestDatabaseUrl!);
      const events: Array<Record<string, unknown>> = [], now = Date.now();
      const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
      installDatabaseResponseCapture(observed, { issues, heartbeatRuns }, capture);
      try {
        expect(await listExternalReviewWaits(observed, fixture.companyId, [fixture.issueId])).toEqual(governed ? [] : [
          expect.objectContaining({ companyId: fixture.companyId, issueId: fixture.issueId }),
        ]);
        capture.flush();
        const reads = events.filter(event => event.table === "issues" && event.operation === "select");
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.reduce((bytes, event) => bytes + Number(event.responseValueBytes), 0)).toBeLessThan(4096);
        expect(await listExternalReviewWaits(observed, randomUUID(), [fixture.issueId])).toEqual([]);
        expect(await listExternalReviewWaits(observed, fixture.companyId, [])).toEqual([]);
        await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, fixture.companyId));
        expect(await listExternalReviewWaits(observed, fixture.companyId, [fixture.issueId])).toEqual([]);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)))[0]?.contextSnapshot).toEqual(contextSnapshot);
      } finally { capture.flush(); await observed.$client.end(); }
    },
  );

  it("resumes an oversized Slack multi-select answered through its Paperclip handoff", async () => {
    const fixture = await seedBoardAnsweredTurn(true, "slack", true);
    const [publication] = await db.select().from(chatPublications).where(eq(chatPublications.id, fixture.publicationId));
    expect(publication!.payload.card?.actions).toEqual([
      { type: "link", label: "Open in Paperclip", url: expect.stringContaining(fixture.issueId) },
    ]);
    expect(publication!.payload.card?.selection).toBeUndefined();
    await expect(db.select().from(chatActions).where(eq(chatActions.companyId, fixture.companyId))).resolves.toEqual([]);
    await attestAnswer(fixture);
    const responses = await materializeExternalChatQuestionResponseInput({ db, binding: fixture, contextSnapshot: fixture.context });
    expect(responses).toHaveLength(1);
    expect(JSON.stringify(responses)).toContain("cobalt");
  });

  it.each((["github", "slack"] as const).flatMap(provider => [true, false].map(withLink => ({ provider, withLink }))))(
    "attests a native $provider question answered in Board without inventing a provider action (link: $withLink)",
    async ({ provider, withLink }) => {
      const fixture = await seedBoardAnsweredTurn(withLink, provider);
      await expect(
        db
          .select()
          .from(chatActions)
          .where(eq(chatActions.companyId, fixture.companyId)),
      ).resolves.toEqual([]);
      expect(
        await resolveExternalChatQuestionResponse(
          db,
          fixture,
          fixture.context,
          "read",
          true,
        ),
      ).not.toBeNull();
      await attestAnswer(fixture);
      expect(fixture.context.paperclipWake).toMatchObject({
        externalChatProvider: provider,
      });
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: fixture.context })
        .where(eq(heartbeatRuns.id, fixture.runId));
      const responses = await materializeExternalChatQuestionResponseInput({
        db,
        binding: fixture,
        contextSnapshot: fixture.context,
      });
      expect(responses).toHaveLength(1);
      expect(JSON.stringify(responses)).toContain("cobalt");
      expect(responses[0]!.interactionId).toBe(fixture.interactionId);
      const resultJson = await finishReviewResponse(fixture);
      expect(resultJson.externalChatReviewPresentation).toMatchObject({
        gateId: fixture.gate.id,
      });
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          resultJson,
        }),
      ).toBe(true);
      const publications = await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.issueId, fixture.issueId));
      await finishReviewResponse(fixture);
      await expect(
        db
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.issueId, fixture.issueId)),
      ).resolves.toEqual(publications);
      await expect(
        db
          .select({ status: issueThreadInteractions.status })
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, fixture.gate.id)),
      ).resolves.toEqual([{ status: "pending" }]);
    },
  );

  it.each((["github", "slack"] as const).flatMap(provider => ([
    "different_user",
    "viewer",
    "membership_revoked",
    "identity_revoked",
    "generation",
    "missing_runtime",
    "wrong_target",
    "wrong_wake",
    "unpublished",
    "provider_action",
    "deleted_source",
    "endpoint_paused",
    "resource_revoked",
    "answer_hash",
  ] as const).filter(change => provider === "github" || (change !== "generation" && change !== "missing_runtime")).map(change => ({ provider, change }))))(
    "rejects $provider Board answer authority after $change",
    async ({ provider, change }) => {
      const fixture = await seedBoardAnsweredTurn(true, provider);
      if (change === "different_user") {
        const otherUser = `other-${randomUUID()}`;
        await db
          .insert(companyMemberships)
          .values({
            companyId: fixture.companyId,
            principalType: "user",
            principalId: otherUser,
            status: "active",
            membershipRole: "member",
          });
        await db
          .update(issueThreadInteractions)
          .set({ resolvedByUserId: otherUser })
          .where(eq(issueThreadInteractions.id, fixture.interactionId));
        await db
          .update(agentWakeupRequests)
          .set({ requestedByActorId: otherUser })
          .where(eq(agentWakeupRequests.id, fixture.wakeId));
        const [interaction] = await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, fixture.interactionId));
        const receipt = questionResponseDeliveryValues(
          interaction! as unknown as AskUserQuestionsInteraction,
        );
        await db
          .update(issueQuestionResponseDeliveries)
          .set({ payloadSha256: receipt.payloadSha256 })
          .where(
            eq(issueQuestionResponseDeliveries.id, fixture.responseDeliveryId),
          );
      }
      if (change === "viewer" || change === "membership_revoked")
        await db
          .update(companyMemberships)
          .set(
            change === "viewer"
              ? { membershipRole: "viewer" }
              : { status: "suspended" },
          )
          .where(eq(companyMemberships.companyId, fixture.companyId));
      if (change === "identity_revoked")
        await db
          .update(chatIdentityLinks)
          .set({ status: "revoked" })
          .where(eq(chatIdentityLinks.endpointId, fixture.endpointId));
      if (change === "generation")
        await db
          .update(chatEndpoints)
          .set({
            setup: {
              step: "complete",
              runtimeGeneration: 2,
            } as typeof chatEndpoints.$inferInsert.setup,
          })
          .where(eq(chatEndpoints.id, fixture.endpointId));
      if (change === "missing_runtime")
        await db
          .update(chatDeliveries)
          .set({ normalizedEvent: {} })
          .where(eq(chatDeliveries.id, fixture.deliveryId));
      if (change === "wrong_target")
        await db
          .update(issueQuestionResponseDeliveries)
          .set({ targetRunId: fixture.sourceRunId })
          .where(
            eq(issueQuestionResponseDeliveries.id, fixture.responseDeliveryId),
          );
      if (change === "wrong_wake")
        await db
          .update(agentWakeupRequests)
          .set({ runId: fixture.sourceRunId })
          .where(eq(agentWakeupRequests.id, fixture.wakeId));
      if (change === "unpublished")
        await db
          .update(chatPublications)
          .set({ state: "pending", publishedAt: null, providerMessageId: null })
          .where(eq(chatPublications.id, fixture.publicationId));
      if (change === "provider_action")
        await db
          .insert(chatActions)
          .values({
            companyId: fixture.companyId,
            endpointId: fixture.endpointId,
            conversationId: fixture.conversationId,
            principalId: fixture.principalId,
            kind: "question_answer",
            status: "processed",
            providerActionId: randomUUID(),
            payload: {
              version: 1,
              interactionId: fixture.interactionId,
              publicationId: fixture.publicationId,
            },
            result: {},
          });
      if (change === "deleted_source")
        await db
          .update(issueComments)
          .set({ deletedAt: new Date() })
          .where(eq(issueComments.id, fixture.commentId));
      if (change === "endpoint_paused")
        await db
          .update(chatEndpoints)
          .set({ status: "paused" })
          .where(eq(chatEndpoints.id, fixture.endpointId));
      if (change === "resource_revoked")
        await db
          .update(chatEndpointResources)
          .set({ enabled: false })
          .where(eq(chatEndpointResources.id, fixture.resourceId));
      if (change === "answer_hash")
        await db
          .update(issueQuestionResponseDeliveries)
          .set({ payloadSha256: "b".repeat(64) })
          .where(
            eq(issueQuestionResponseDeliveries.id, fixture.responseDeliveryId),
          );
      expect(
        await attestReviewedExternalChatRun({
          db,
          ...fixture,
          contextSnapshot: fixture.context,
        }),
      ).toBe(false);
      expect(
        fixture.context.paperclipExternalChatQuestionResponse,
      ).toBeUndefined();
      await expect(
        db
          .select({ status: issueThreadInteractions.status })
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, fixture.gate.id)),
      ).resolves.toEqual([{ status: "pending" }]);
    },
  );

  it.each((["github", "slack"] as const).flatMap(provider => (["generation", "identity", "membership", "reach"] as const).filter(change => provider === "github" || change !== "generation").map(change => ({ provider, change }))))(
    "rechecks $provider Board answer $change at publication after native completion",
    async ({ provider, change }) => {
      const fixture = await seedBoardAnsweredTurn(true, provider);
      await attestAnswer(fixture);
      const resultJson = await finishReviewResponse(fixture);
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          resultJson,
        }),
      ).toBe(true);
      if (change === "generation")
        await db
          .update(chatEndpoints)
          .set({
            setup: {
              step: "complete",
              runtimeGeneration: 2,
            } as typeof chatEndpoints.$inferInsert.setup,
          })
          .where(eq(chatEndpoints.id, fixture.endpointId));
      if (change === "identity")
        await db
          .update(chatIdentityLinks)
          .set({ status: "revoked" })
          .where(eq(chatIdentityLinks.endpointId, fixture.endpointId));
      if (change === "membership")
        await db
          .update(companyMemberships)
          .set({ membershipRole: "viewer" })
          .where(eq(companyMemberships.companyId, fixture.companyId));
      if (change === "reach")
        await db
          .update(chatEndpointResources)
          .set({ enabled: false })
          .where(eq(chatEndpointResources.id, fixture.resourceId));
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          resultJson,
        }),
      ).toBe(false);
    },
  );

  it.each((["native", "legacy"] as const).flatMap(sourceRuntime => (["voice", "board"] as const).map(answerRoute => ({sourceRuntime, answerRoute}))))("authorizes $sourceRuntime Speko question continuation from its exact $answerRoute answer", async ({sourceRuntime, answerRoute}) => {
    const f = await seedAnsweredChatTurn();
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpointId));
    const [connection] = await db.update(toolConnections).set({ transport: "voice", status: "active", enabled: true }).where(eq(toolConnections.id, endpoint.connectionId)).returning();
    await db.update(chatEndpoints).set({ provider: "speko", setup: { step: "complete", runtimeGeneration: 1 } as typeof endpoint.setup }).where(eq(chatEndpoints.id, f.endpointId));
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    const sourceContext = JSON.parse(JSON.stringify(source.contextSnapshot).replaceAll("chat:telegram", "chat:speko").replaceAll('"telegram"', '"speko"'));
    await db.update(heartbeatRuns).set({ contextSnapshot: sourceContext, runtimeMode: sourceRuntime, nativeIssueId: sourceRuntime === "native" ? f.issueId : null }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const resolve = () => resolveExternalChatQuestionResponse(db, f, f.context, "read", true);
    expect(await resolve()).toBeNull();
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.interactionId));
    const sessionId = randomUUID();
    await db.insert(chatVoiceSessions).values({ id: sessionId, companyId: f.companyId, endpointId: f.endpointId,
      conversationId: f.conversationId, issueId: f.issueId, assignedAgentId: f.agentId, callerId: f.userId, callerAuthority: "member",
      mode: "browser", state: "ended", providerSessionId: randomUUID(), generation: 1, credentialFingerprint: voiceCredentialFingerprint(connection.credentialSecretRefs),
      toolTokenHash: "a".repeat(64), idempotencyKey: randomUUID(), requestFingerprint: "fixture", expiresAt: new Date(Date.now() + 60000) });
    await db.insert(chatVoiceReplies).values({ companyId: f.companyId, sessionId, publicationId: f.publicationId, cursor: 1,
      deliveredAt: new Date(interaction.resolvedAt!.getTime() - 1) });
    const [receipt] = answerRoute === "voice" ? await db.insert(chatVoiceToolCalls).values({ companyId: f.companyId, sessionId, providerToolCallId: randomUUID(),
      webhookId: randomUUID(), fingerprint: "signed-tool-fingerprint", tool: "answer_question",
      response: { status: "answered", interactionId: f.interactionId, resultSha256: nativeSha256(interaction.result) } }).returning() : [];
    if (answerRoute === "board") {
      await db.update(chatExternalPrincipals).set({ provider: "speko", externalId: `voice:${sessionId}` }).where(eq(chatExternalPrincipals.id, f.principalId));
      await db.insert(chatVoiceToolCalls).values({companyId: f.companyId, sessionId, providerToolCallId: randomUUID(),
        webhookId: randomUUID(), fingerprint: "accepted-source-request", tool: "submit_request", response: {status: "accepted"}});
    }
    // The answer also publishes a terminal acknowledgment. It cannot compete
    // with the pre-answer presentation as authority for the continuation.
    const [terminal] = await db.insert(chatPublications).values({ companyId: f.companyId, endpointId: f.endpointId,
      conversationId: f.conversationId, issueId: f.issueId, idempotencyKey: randomUUID(), state: "published",
      payload: { text: "Answered: High.", interactionId: f.interactionId } }).returning();
    await db.insert(chatVoiceReplies).values({ companyId: f.companyId, sessionId, publicationId: terminal.id, cursor: 2 });
    expect(await resolve()).toMatchObject({ provider: "speko", marker: { interactionId: f.interactionId } });
    // Voice authority is the authenticated session, not a synthetic provider
    // identity link. Exercise the real native run attestation and recheck path.
    await db.update(chatExternalPrincipals).set({ provider: "speko", externalId: `voice:${sessionId}` }).where(eq(chatExternalPrincipals.id, f.principalId));
    await db.delete(chatIdentityLinks).where(eq(chatIdentityLinks.principalId, f.principalId));
    await attestAnswer(f);
    expect(await authorizeChatConversationForBoundRun(db, f, f.context, "read")).toMatchObject({ conversationId: f.conversationId });
    await db.update(companyMemberships).set({ status: "removed" }).where(eq(companyMemberships.principalId, f.userId));
    await expect(authorizeChatConversationForBoundRun(db, f, f.context, "read")).rejects.toThrow(answerRoute === "board" ? "paperclip_runner_chat_attachment_binding_denied" : "paperclip_runner_chat_attachment_principal_denied");
    await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.principalId, f.userId));
    if (receipt) await db.update(chatVoiceToolCalls).set({ response: { ...receipt.response, resultSha256: "different-answer" } }).where(eq(chatVoiceToolCalls.id, receipt.id));
    else await db.update(issueComments).set({authorUserId: randomUUID()}).where(eq(issueComments.id, f.commentId));
    expect(await resolve()).toBeNull();
  });
  it.each(["valid", "wrong_task", "revoked_identity", "wrong_answer_actor"] as const)(
    "attests legacy Slack question continuations only with the durable source binding: %s",
    async (condition) => {
      const fixture = await seedAnsweredChatTurn("slack");
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.sourceRunId));
      const context = source!.contextSnapshot as Record<string, unknown>;
      await db.update(heartbeatRuns).set({
        runtimeMode: "legacy", nativeIssueId: null,
        contextSnapshot: { ...context, paperclipWake: {
          ...(context.paperclipWake as Record<string, unknown>),
          issue: { id: condition === "wrong_task" ? randomUUID() : fixture.issueId },
        } },
      }).where(eq(heartbeatRuns.id, fixture.sourceRunId));
      if (condition === "revoked_identity") {
        await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.principalId, fixture.principalId));
      }
      if (condition === "wrong_answer_actor") {
        await db.update(agentWakeupRequests).set({ requestedByActorId: "another-user" }).where(eq(agentWakeupRequests.id, fixture.wakeId));
      }
      expect(await attestReviewedExternalChatRun({ db, ...fixture, contextSnapshot: fixture.context })).toBe(condition === "valid");
      if (condition === "valid") {
        expect(fixture.context.paperclipExternalChatQuestionResponse).toMatchObject({ interactionId: fixture.interactionId });
      } else {
        expect(fixture.context.paperclipExternalChatQuestionResponse).toBeUndefined();
      }
    },
  );

  async function attestAnswer(
    fixture:
      | Awaited<ReturnType<typeof seedAnsweredChatTurn>>
      | Awaited<ReturnType<typeof seedBoardAnsweredTurn>>,
  ) {
    expect(
      await attestReviewedExternalChatRun({
        db,
        ...fixture,
        contextSnapshot: fixture.context,
      }),
    ).toBe(true);
    expect(fixture.context.paperclipExternalChatQuestionResponse).toMatchObject(
      {
        schema: "paperclip.external_chat_question_response.v1",
        interactionId: fixture.interactionId,
        sourceRunId: fixture.sourceRunId,
        responseDeliveryId: fixture.responseDeliveryId,
      },
    );
    fixture.context.paperclipExternalChatExecutionBound = true;
    fixture.context.paperclipWake = await buildPaperclipWakePayload({
      db,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      runId: fixture.runId,
      contextSnapshot: fixture.context,
    });
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: fixture.context })
      .where(eq(heartbeatRuns.id, fixture.runId));
  }

  async function withAnsweredFileTool(
    provider: "telegram" | "discord" | "github",
    tool: "register_deliverable" | "reuse_chat_attachment",
    check: (input: {
      fixture:
        | Awaited<ReturnType<typeof seedAnsweredChatTurn>>
        | Awaited<ReturnType<typeof seedBoardAnsweredTurn>>;
      invoke: () => Promise<unknown>;
    }) => Promise<void>,
  ) {
    const fixture =
      provider === "github"
        ? await seedBoardAnsweredTurn()
        : await seedAnsweredChatTurn(provider);
    await attestAnswer(fixture);
    const root = await mkdtemp(path.join(tmpdir(), "answered-chat-file-"));
    try {
      const workspaceRoot = path.join(root, "workspace");
      await mkdir(workspaceRoot);
      const storage = createStorageService(
        createLocalDiskStorageProvider(path.join(root, "storage")),
      );
      const body = Buffer.from("Cobalt\n");
      const filename = "answer.txt";
      await writeFile(path.join(workspaceRoot, filename), body);
      const runner = new PaperclipRunnerToolAuthority(db, {
        ...fixture,
        workspaceRoot,
        storage,
      });
      let sourceAttachmentId: string | null = null;
      if (tool === "reuse_chat_attachment") {
        const stored = await storage.putFile({
          companyId: fixture.companyId,
          namespace: `issues/${fixture.issueId}`,
          originalFilename: filename,
          contentType: "text/plain",
          body,
        });
        const attachment = await issueService(db).createAttachment({
          issueId: fixture.issueId,
          issueCommentId: fixture.commentId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByUserId: fixture.userId,
        });
        sourceAttachmentId = attachment.id;
      }
      await check({
        fixture,
        invoke: () =>
          runner.execute({
            tool,
            callId: randomUUID(),
            arguments: {
              idempotencyKey: "answer-file-v1",
              title: "Chosen color",
              ...(tool === "register_deliverable"
                ? {
                    filename,
                    contentRef: filename,
                    contentType: "text/plain",
                    byteSize: body.length,
                    sha256: createHash("sha256").update(body).digest("hex"),
                  }
                : {
                    sourceCommentId: fixture.commentId,
                    attachmentId: sourceAttachmentId,
                  }),
            },
          }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it.each(
    (["direct", "answered_question"] as const).flatMap((source) =>
      (["error", "paused", "terminated", "pending_approval"] as const).map(
        (status) => ({ source, status }),
      ),
    ),
  )(
    "uses current invokability for pre-start reviewed GitHub $source with agent $status",
    async ({ source, status }) => {
      const fixture =
        source === "direct"
          ? await seedWaitTurn("github")
          : await seedBoardAnsweredTurn();
      if (source === "direct") await seedPriorCompletionReview(fixture);
      // A previous run's failure projects `error` onto the agent. The next
      // already-claimed turn attests before execution-start changes it to
      // `running`; this does not grant permission to clear an operator gate.
      await db
        .update(agents)
        .set({
          status,
          errorReason: status === "error" ? "Prior run failed" : null,
        })
        .where(eq(agents.id, fixture.agentId));
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, fixture.runId));
      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, fixture.issueId));
      const gates = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, fixture.issueId));
      expect(issue).toMatchObject({
        status: "in_review",
        assigneeAgentId: fixture.agentId,
        executionRunId: fixture.runId,
      });
      expect(gates.some((gate) => gate.status === "pending")).toBe(true);
      const context = structuredClone(run!.contextSnapshot!);
      const onQuestionResponseAttested = vi.fn();
      await expect(
        attestReviewedExternalChatRun({
          db,
          ...fixture,
          contextSnapshot: context,
          onQuestionResponseAttested,
        }),
      ).resolves.toBe(status === "error");
      expect(onQuestionResponseAttested).toHaveBeenCalledTimes(
        status === "error" && source === "answered_question" ? 1 : 0,
      );
      // Attestation proves the current exact binding without checking out,
      // approving, retiring, or otherwise rewriting any durable authority.
      expect(
        await db.select().from(issues).where(eq(issues.id, fixture.issueId)),
      ).toEqual([issue]);
      expect(
        await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, fixture.runId)),
      ).toEqual([run]);
      expect(
        await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.issueId, fixture.issueId)),
      ).toEqual(gates);
      expect(
        await db
          .select({ status: agents.status })
          .from(agents)
          .where(eq(agents.id, fixture.agentId)),
      ).toEqual([{ status }]);
    },
  );

  it.each([
    "execution_owner",
    "identity_revoked",
    "retired_conversation",
    "wrong_comment",
  ] as const)(
    "does not treat an invokable errored agent as reviewed-chat authority after %s",
    async (change) => {
      const fixture = await seedWaitTurn("github");
      await seedPriorCompletionReview(fixture);
      await db
        .update(agents)
        .set({ status: "error" })
        .where(eq(agents.id, fixture.agentId));
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, fixture.runId));
      const context = structuredClone(run!.contextSnapshot!);
      if (change === "execution_owner")
        await db
          .update(issues)
          .set({ executionRunId: null })
          .where(eq(issues.id, fixture.issueId));
      if (change === "identity_revoked")
        await db
          .update(chatIdentityLinks)
          .set({ status: "revoked" })
          .where(eq(chatIdentityLinks.endpointId, fixture.endpointId));
      if (change === "retired_conversation")
        await db
          .update(chatConversations)
          .set({ state: "completed" })
          .where(eq(chatConversations.id, fixture.conversationId));
      if (change === "wrong_comment") {
        context.wakeCommentId = randomUUID();
        context.wakeCommentIds = [context.wakeCommentId];
      }
      await expect(
        attestReviewedExternalChatRun({
          db,
          ...fixture,
          contextSnapshot: context,
        }),
      ).resolves.toBe(false);
    },
  );

  it.each(["valid", "tampered_selection", "revoked_identity"])("attests only the committed Slack multiple-choice response: %s", async condition => {
    const fixture = await seedAnsweredChatTurn("slack", undefined, "multi");
    if (condition === "tampered_selection") {
      const [action] = await db.select().from(chatActions).where(eq(chatActions.id, fixture.actionId));
      await db.update(chatActions).set({ payload: { ...action!.payload, selectionValues: ["opaque-amber", "opaque-cobalt"] } }).where(eq(chatActions.id, fixture.actionId));
    }
    if (condition === "revoked_identity") await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.principalId, fixture.principalId));
    expect(await attestReviewedExternalChatRun({ db, ...fixture, contextSnapshot: fixture.context })).toBe(condition === "valid");
  });

  it("attests a genuine Slack mixed-question modal answer for its native continuation", async () => {
    const fixture = await seedAnsweredChatTurn("slack", undefined, "form");
    await expect(
      attestReviewedExternalChatRun({
        db,
        ...fixture,
        contextSnapshot: fixture.context,
      }),
    ).resolves.toBe(true);
    expect(fixture.context.paperclipExternalChatQuestionResponse).toMatchObject({
      schema: "paperclip.external_chat_question_response.v1",
      interactionId: fixture.interactionId,
      responseDeliveryId: fixture.responseDeliveryId,
      sourceRunId: fixture.sourceRunId,
    });
  });

  it("attests an accepted Slack modal answer after its opaque token expires", async () => {
    const fixture = await seedAnsweredChatTurn("slack", undefined, "form");
    const answeredAt = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const [interaction] = await db
      .update(issueThreadInteractions)
      .set({ resolvedAt: answeredAt })
      .where(eq(issueThreadInteractions.id, fixture.interactionId))
      .returning();
    const [action] = await db
      .select()
      .from(chatActions)
      .where(eq(chatActions.id, fixture.actionId));
    if (!interaction || !action) throw new Error("Expected modal answer state");
    await db
      .update(chatActions)
      .set({
        payload: {
          ...action.payload,
          expiresAt: new Date(
            answeredAt.getTime() + 60 * 60 * 1_000,
          ).toISOString(),
        },
      })
      .where(eq(chatActions.id, action.id));
    await db
      .update(issueQuestionResponseDeliveries)
      .set({
        payloadSha256: questionResponseDeliveryValues(
          interaction as unknown as AskUserQuestionsInteraction,
        ).payloadSha256,
      })
      .where(eq(issueQuestionResponseDeliveries.id, fixture.responseDeliveryId));
    await expect(
      attestReviewedExternalChatRun({
        db,
        ...fixture,
        contextSnapshot: fixture.context,
      }),
    ).resolves.toBe(true);
  });

  it("does not attest a Slack modal answer after current principal authorization is revoked", async () => {
    const fixture = await seedAnsweredChatTurn("slack", undefined, "form");
    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, fixture.userId),
        ),
      );
    await expect(
      attestReviewedExternalChatRun({
        db,
        ...fixture,
        contextSnapshot: fixture.context,
      }),
    ).resolves.toBe(false);
  });

  it.each(["result", "field", "expiry"] as const)(
    "does not attest a Slack modal answer with a tampered %s receipt",
    async (mutation) => {
      const fixture = await seedAnsweredChatTurn("slack", undefined, "form");
      const [action] = await db
        .select()
        .from(chatActions)
        .where(eq(chatActions.id, fixture.actionId));
      if (!action) throw new Error("Expected modal answer action");
      if (mutation === "result") {
        await db
          .update(chatActions)
          .set({
            result: {
              code: "question_form_answered",
              interactionId: randomUUID(),
            },
          })
          .where(eq(chatActions.id, action.id));
      } else {
        const payload = structuredClone(action.payload);
        if (mutation === "expiry") {
          payload.expiresAt = new Date(0).toISOString();
        } else {
          const fields = Array.isArray(payload.fields) ? payload.fields : [];
          const first = fields[0] as
            | { options?: Array<{ optionId?: string }> }
            | undefined;
          if (!first?.options?.[0])
            throw new Error("Expected modal select field");
          first.options[0].optionId = "forged-option";
        }
        await db
          .update(chatActions)
          .set({ payload })
          .where(eq(chatActions.id, action.id));
      }
      await expect(
        attestReviewedExternalChatRun({
          db,
          ...fixture,
          contextSnapshot: fixture.context,
        }),
      ).resolves.toBe(false);
      expect(fixture.context).not.toHaveProperty(
        "paperclipExternalChatQuestionResponse",
      );
    },
  );

  it.each([
    ["telegram", "register_deliverable"],
    ["discord", "register_deliverable"],
    ["telegram", "reuse_chat_attachment"],
    ["discord", "reuse_chat_attachment"],
    ["github", "register_deliverable"],
    ["github", "reuse_chat_attachment"],
  ] as const)(
    "describes %s answered-question %s delivery from current authority without duplicate effects",
    async (provider, tool) => {
      await withAnsweredFileTool(
        provider,
        tool,
        async ({ fixture, invoke }) => {
          // Answer text is intentionally ephemeral. A prompt-shape predicate on
          // the durable wake is not the authority for this file delivery mode.
          expect(fixture.context.paperclipWake).not.toHaveProperty(
            "questionResponse",
          );
          const first = await invoke();
          expect(first).toMatchObject({
            disposition: "applied",
            fileDelivery: {
              provider,
              mode:
                provider === "github"
                  ? "paperclip_task_only"
                  : "provider_attachment",
              preparationState: "prepared",
              providerDeliveryConfirmed: false,
            },
          });
          const attachments = await db
            .select()
            .from(issueAttachments)
            .where(eq(issueAttachments.issueId, fixture.issueId));
          expect(attachments).toHaveLength(
            tool === "register_deliverable" ? 1 : 2,
          );
          expect(await invoke()).toEqual(first);
          expect(
            await db
              .select()
              .from(issueAttachments)
              .where(eq(issueAttachments.issueId, fixture.issueId)),
          ).toEqual(attachments);
          const [gate] = await db
            .select()
            .from(issueThreadInteractions)
            .where(eq(issueThreadInteractions.id, fixture.gate.id));
          expect(gate).toEqual(fixture.gate);

          // Receipt replay still rechecks the real destination; a prior mode
          // does not survive current reach revocation or repeat the file effect.
          if (provider === "github") {
            await db
              .update(chatEndpointResources)
              .set({ enabled: false })
              .where(eq(chatEndpointResources.id, fixture.resourceId));
          } else {
            await db
              .update(chatEndpoints)
              .set({ allowDirectMessages: false })
              .where(eq(chatEndpoints.id, fixture.endpointId));
          }
          await expect(invoke()).rejects.toThrow(
            "paperclip_runner_chat_attachment_destination_denied",
          );
          expect(
            await db
              .select()
              .from(issueAttachments)
              .where(eq(issueAttachments.issueId, fixture.issueId)),
          ).toEqual(attachments);
        },
      );
    },
  );

  it.each(["register_deliverable", "reuse_chat_attachment"] as const)(
    "rejects a forged GitHub Board answer marker before %s effects",
    async (tool) => {
      await withAnsweredFileTool(
        "github",
        tool,
        async ({ fixture, invoke }) => {
          const attachments = await db
            .select()
            .from(issueAttachments)
            .where(eq(issueAttachments.issueId, fixture.issueId));
          const context = structuredClone(fixture.context);
          (
            context.paperclipExternalChatQuestionResponse as Record<
              string,
              unknown
            >
          ).bindingSha256 = "0".repeat(64);
          await db
            .update(heartbeatRuns)
            .set({ contextSnapshot: context })
            .where(eq(heartbeatRuns.id, fixture.runId));
          await expect(invoke()).rejects.toThrow(
            "paperclip_runner_chat_attachment_binding_denied",
          );
          await expect(
            db
              .select()
              .from(issueAttachments)
              .where(eq(issueAttachments.issueId, fixture.issueId)),
          ).resolves.toEqual(attachments);
        },
      );
    },
  );

  it.each([
    ["register_deliverable", "forged_marker"],
    ["reuse_chat_attachment", "forged_marker"],
    ["register_deliverable", "changed_generation"],
    ["reuse_chat_attachment", "changed_generation"],
    ["register_deliverable", "membership_revoked"],
    ["reuse_chat_attachment", "membership_revoked"],
  ] as const)(
    "denies answered-question %s file preparation before effects for %s",
    async (tool, mutation) => {
      await withAnsweredFileTool(
        "telegram",
        tool,
        async ({ fixture, invoke }) => {
          const attachments = await db
            .select()
            .from(issueAttachments)
            .where(eq(issueAttachments.issueId, fixture.issueId));
          const [before] = await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, fixture.runId));
          if (mutation === "forged_marker") {
            const context = structuredClone(fixture.context);
            const marker =
              context.paperclipExternalChatQuestionResponse as Record<
                string,
                unknown
              >;
            marker.bindingSha256 = "0".repeat(64);
            await db
              .update(heartbeatRuns)
              .set({ contextSnapshot: context })
              .where(eq(heartbeatRuns.id, fixture.runId));
          } else if (mutation === "changed_generation") {
            await db
              .update(chatConversations)
              .set({ sessionGeneration: 2 })
              .where(eq(chatConversations.id, fixture.conversationId));
          } else {
            await db
              .update(companyMemberships)
              .set({ status: "suspended" })
              .where(
                and(
                  eq(companyMemberships.companyId, fixture.companyId),
                  eq(companyMemberships.principalId, fixture.userId),
                ),
              );
          }
          await expect(invoke()).rejects.toThrow(
            mutation === "membership_revoked"
              ? "paperclip_runner_chat_attachment_principal_denied"
              : "paperclip_runner_chat_attachment_binding_denied",
          );
          expect(
            await db
              .select()
              .from(issueAttachments)
              .where(eq(issueAttachments.issueId, fixture.issueId)),
          ).toEqual(attachments);
          const [after] = await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, fixture.runId));
          expect(after?.resultJson).toEqual(before?.resultJson);
        },
      );
    },
  );

  async function seedSequentialQuestionChain(depth = 2) {
    const fixture = await seedAnsweredChatTurn();
    const parents: Array<Awaited<ReturnType<typeof seedAnsweredChatTurn>>> = [];
    let cursor = fixture;
    for (let index = 1; index < depth; index += 1) {
      cursor = await seedAnsweredChatTurn("telegram", {
        fixture: { ...fixture, runId: cursor.sourceRunId },
        gate: fixture.gate,
      });
      parents.unshift(cursor);
    }
    for (const parent of parents) {
      await db
        .update(issues)
        .set({ executionRunId: parent.runId })
        .where(eq(issues.id, fixture.issueId));
      await attestAnswer(parent);
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded" })
        .where(eq(heartbeatRuns.id, parent.runId));
    }
    await db
      .update(issues)
      .set({ executionRunId: fixture.runId })
      .where(eq(issues.id, fixture.issueId));
    return { fixture, parents };
  }

  it.each([1, 3])(
    "reports only the latest durable answer time for a %i-question chain after a long wait",
    async (depth) => {
      const { fixture, parents } = await seedSequentialQuestionChain(depth);
      const answeredAt = new Date(Date.now() + 7_200_000);
      const originalCreatedAt = new Date(answeredAt.getTime() - 14_400_000);
      for (const parent of parents) {
        const [earlier] = await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, parent.interactionId));
        expect(answeredAt.getTime()).toBeGreaterThan(
          earlier!.resolvedAt!.getTime(),
        );
      }
      await db
        .update(issueComments)
        .set({ createdAt: originalCreatedAt })
        .where(eq(issueComments.id, fixture.commentId));
      const [interaction] = await db
        .update(issueThreadInteractions)
        .set({ resolvedAt: answeredAt })
        .where(eq(issueThreadInteractions.id, fixture.interactionId))
        .returning();
      const delivery = questionResponseDeliveryValues(
        interaction as unknown as AskUserQuestionsInteraction,
      );
      await db
        .update(issueQuestionResponseDeliveries)
        .set({ payloadSha256: delivery.payloadSha256 })
        .where(
          eq(issueQuestionResponseDeliveries.id, fixture.responseDeliveryId),
        );
      // Neither a caller timestamp nor an untrusted marker field is the source.
      fixture.context.answeredAtMs = 1;
      fixture.context.paperclipExternalChatQuestionResponse = {
        answeredAtMs: 2,
      };
      const onQuestionResponseAttested = vi.fn();
      expect(
        await attestReviewedExternalChatRun({
          db,
          ...fixture,
          contextSnapshot: fixture.context,
          onQuestionResponseAttested,
        }),
      ).toBe(true);
      expect(onQuestionResponseAttested).toHaveBeenCalledExactlyOnceWith(
        answeredAt.getTime(),
      );
      expect(fixture.context.sourceCommentId).toBe(fixture.commentId);
      expect(fixture.context.wakeCommentIds).toEqual([fixture.commentId]);
      expect(
        fixture.context.paperclipExternalChatQuestionResponse,
      ).not.toHaveProperty("answeredAtMs");
      const [comment] = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, fixture.commentId));
      expect(comment!.createdAt).toEqual(originalCreatedAt);
    },
  );

  it.each(["forged_source", "stale_answer", "unattested_principal"] as const)(
    "does not expose an answered-question timestamp for %s",
    async (kind) => {
      const fixture = await seedAnsweredChatTurn();
      if (kind === "forged_source") {
        fixture.context.sourceRunId = randomUUID();
        await db
          .update(heartbeatRuns)
          .set({ contextSnapshot: fixture.context })
          .where(eq(heartbeatRuns.id, fixture.runId));
      }
      if (kind === "stale_answer")
        await db
          .update(issueQuestionResponseDeliveries)
          .set({ payloadSha256: "0".repeat(64) })
          .where(
            eq(issueQuestionResponseDeliveries.id, fixture.responseDeliveryId),
          );
      if (kind === "unattested_principal")
        await db
          .update(chatIdentityLinks)
          .set({ status: "revoked" })
          .where(eq(chatIdentityLinks.principalId, fixture.principalId));
      fixture.context.answeredAtMs = 1;
      const onQuestionResponseAttested = vi.fn();
      expect(
        await attestReviewedExternalChatRun({
          db,
          ...fixture,
          contextSnapshot: fixture.context,
          onQuestionResponseAttested,
        }),
      ).toBe(false);
      expect(onQuestionResponseAttested).not.toHaveBeenCalled();
    },
  );

  it("does not expose an answered-question timestamp before its attestation transaction commits", async () => {
    const fixture = await seedAnsweredChatTurn();
    const onQuestionResponseAttested = vi.fn();
    let validatedInsideTransaction = false;
    const rolledBackDb = {
      transaction: async (operation: (tx: typeof db) => Promise<unknown>) =>
        db.transaction(async (tx) => {
          await operation(tx as unknown as typeof db);
          validatedInsideTransaction = true;
          throw new Error("timing_attestation_test_rollback");
        }),
    } as unknown as typeof db;
    await expect(
      attestReviewedExternalChatRun({
        db: rolledBackDb,
        ...fixture,
        contextSnapshot: fixture.context,
        onQuestionResponseAttested,
      }),
    ).rejects.toThrow("timing_attestation_test_rollback");
    expect(validatedInsideTransaction).toBe(true);
    expect(onQuestionResponseAttested).not.toHaveBeenCalled();
  });

  it("authorizes sequential chat questions through exact durable parents and preserves the original request", async () => {
    const { fixture, parents } = await seedSequentialQuestionChain(3);
    await attestAnswer(fixture);
    const resolved = await resolveExternalChatQuestionResponse(
      db,
      fixture,
      fixture.context,
      "read",
    );
    expect(resolved?.interactionIds).toEqual([
      ...parents.map((parent) => parent.interactionId),
      fixture.interactionId,
    ]);
    expect(resolved?.marker.sourceCommentId).toBe(fixture.commentId);
    expect(fixture.context.source).toBe("issue.interaction.respond");
    expect(fixture.context.wakeCommentIds).toEqual([fixture.commentId]);
    const responses = await materializeExternalChatQuestionResponseInput({
      db, binding: fixture, contextSnapshot: fixture.context,
    });
    expect(responses.map((response) => response.interactionId)).toEqual(resolved!.interactionIds);
    const resultJson = await finishReviewResponse(fixture);
    expect(
      await authorizeNativeChatReviewPresentation(db, {
        ...fixture,
        resultJson,
      }),
    ).toBe(true);
    expect(
      await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, fixture.gate.id)),
    ).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it.each(["execution_owner", "agent_paused", "membership_revoked"] as const)(
    "rechecks current sequential answer input authority after attestation: %s",
    async (kind) => {
      const { fixture } = await seedSequentialQuestionChain();
      await attestAnswer(fixture);
      if (kind === "execution_owner")
        await db
          .update(issues)
          .set({ executionRunId: fixture.sourceRunId })
          .where(eq(issues.id, fixture.issueId));
      if (kind === "agent_paused")
        await db
          .update(agents)
          .set({ status: "paused" })
          .where(eq(agents.id, fixture.agentId));
      if (kind === "membership_revoked")
        await db
          .update(companyMemberships)
          .set({ status: "suspended" })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalId, fixture.userId),
            ),
          );
      await expect(
        materializeExternalChatQuestionResponseInput({
          db,
          binding: fixture,
          contextSnapshot: fixture.context,
        }),
      ).rejects.toThrow(
        kind === "membership_revoked"
          ? "paperclip_runner_chat_attachment_principal_denied"
          : "reviewed_chat_execution_binding_not_authorized",
      );
    },
  );

  it("materializes a sequential answer chain atomically with authorization before a coherent ancestor rewrite", async () => {
    const { fixture, parents } = await seedSequentialQuestionChain();
    await attestAnswer(fixture);
    const parent = parents[0]!;
    let reached!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original =
      nativeInteractionBridge.materializeNativeInteractionResponses;
    const spy = vi
      .spyOn(nativeInteractionBridge, "materializeNativeInteractionResponses")
      .mockImplementationOnce(async (input) => {
        reached();
        await released;
        return original(input);
      });
    const prompt = materializeExternalChatQuestionResponseInput({
      db,
      binding: fixture,
      contextSnapshot: fixture.context,
    });
    let mutation: Promise<void> | null = null;
    let mutationPid = 0;
    try {
      await Promise.race([
        ready,
        prompt.then(() => {
          throw new Error("materialization_barrier_not_reached");
        }),
      ]);
      mutation = db.transaction(async (tx) => {
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
        mutationPid = Number(backend!.pid);
        const [interaction] = await tx
          .update(issueThreadInteractions)
          .set({
            result: {
              version: 1,
              answers: [{ questionId: "color", optionIds: ["amber"] }],
            },
          })
          .where(eq(issueThreadInteractions.id, parent.interactionId))
          .returning();
        const [action] = await tx
          .select()
          .from(chatActions)
          .where(eq(chatActions.id, parent.actionId));
        await tx
          .update(chatActions)
          .set({ payload: { ...action!.payload, optionId: "amber" } })
          .where(eq(chatActions.id, parent.actionId));
        await tx
          .update(issueQuestionResponseDeliveries)
          .set({
            payloadSha256: questionResponseDeliveryValues(
              interaction! as unknown as AskUserQuestionsInteraction,
            ).payloadSha256,
          })
          .where(
            eq(issueQuestionResponseDeliveries.id, parent.responseDeliveryId),
          );
      });
      await vi.waitFor(async () => {
        expect(mutationPid).toBeGreaterThan(0);
        const [waiting] = await db.execute(
          sql`select exists(select 1 from pg_locks where pid = ${mutationPid} and not granted) as waiting`,
        );
        expect(waiting!.waiting).toBe(true);
      });
      release();
      const captured = await prompt;
      await mutation;
      expect(captured.map((response) => response.interactionId)).toEqual([
        parent.interactionId,
        fixture.interactionId,
      ]);
      expect(JSON.stringify(captured)).toContain("Cobalt");
      expect(JSON.stringify(captured)).not.toContain("Amber");
      await expect(
        materializeExternalChatQuestionResponseInput({
          db,
          binding: fixture,
          contextSnapshot: fixture.context,
        }),
      ).rejects.toThrow("reviewed_chat_execution_binding_not_authorized");
    } finally {
      release();
      await Promise.allSettled([prompt, ...(mutation ? [mutation] : [])]);
      spy.mockRestore();
    }
  });

  it.each([
    "missing_parent_marker",
    "missing_parent_delivery",
    "tampered_parent_answer",
    "rewritten_parent_answer_and_receipt",
    "duplicate_parent_action",
    "revoked_parent_principal",
    "wrong_parent_actor",
    "source_cycle",
    "different_parent_issue",
  ] as const)(
    "rejects an unauthenticated sequential chat question chain: %s",
    async (kind) => {
      const { fixture, parents } = await seedSequentialQuestionChain();
      const parent = parents[0]!;
      if (kind === "missing_parent_marker") {
        const context = { ...parent.context };
        delete context.paperclipExternalChatQuestionResponse;
        await db
          .update(heartbeatRuns)
          .set({ contextSnapshot: context })
          .where(eq(heartbeatRuns.id, parent.runId));
      }
      if (kind === "missing_parent_delivery")
        await db
          .delete(issueQuestionResponseDeliveries)
          .where(
            eq(issueQuestionResponseDeliveries.id, parent.responseDeliveryId),
          );
      if (kind === "tampered_parent_answer")
        await db
          .update(issueThreadInteractions)
          .set({
            result: {
              version: 1,
              answers: [{ questionId: "color", optionIds: ["amber"] }],
            },
          })
          .where(eq(issueThreadInteractions.id, parent.interactionId));
      if (kind === "rewritten_parent_answer_and_receipt") {
        const [interaction] = await db
          .update(issueThreadInteractions)
          .set({
            result: {
              version: 1,
              answers: [{ questionId: "color", optionIds: ["amber"] }],
            },
          })
          .where(eq(issueThreadInteractions.id, parent.interactionId))
          .returning();
        const [action] = await db
          .select()
          .from(chatActions)
          .where(eq(chatActions.id, parent.actionId));
        await db
          .update(chatActions)
          .set({ payload: { ...action!.payload, optionId: "amber" } })
          .where(eq(chatActions.id, parent.actionId));
        await db
          .update(issueQuestionResponseDeliveries)
          .set({
            payloadSha256: questionResponseDeliveryValues(
              interaction! as unknown as AskUserQuestionsInteraction,
            ).payloadSha256,
          })
          .where(
            eq(issueQuestionResponseDeliveries.id, parent.responseDeliveryId),
          );
      }
      if (kind === "duplicate_parent_action") {
        const [action] = await db
          .select()
          .from(chatActions)
          .where(eq(chatActions.id, parent.actionId));
        await db
          .insert(chatActions)
          .values({
            ...action!,
            id: randomUUID(),
            providerActionId: "duplicate-parent-response",
          });
      }
      if (kind === "revoked_parent_principal")
        await db
          .update(chatIdentityLinks)
          .set({ status: "revoked" })
          .where(eq(chatIdentityLinks.principalId, fixture.principalId));
      if (kind === "wrong_parent_actor")
        await db
          .update(agentWakeupRequests)
          .set({ requestedByActorId: "another-user" })
          .where(eq(agentWakeupRequests.id, parent.wakeId));
      if (kind === "different_parent_issue") {
        // Deliberately corrupt historical data; normal writes reject this rebind.
        await db.transaction(async (tx) => {
          await tx.execute(sql`set local session_replication_role = replica`);
          await tx.update(heartbeatRuns).set({ nativeIssueId: fixture.sourceRunId }).where(eq(heartbeatRuns.id, parent.runId));
        });
      }
      if (kind === "source_cycle") {
        const [wake] = await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, parent.wakeId));
        await db
          .update(agentWakeupRequests)
          .set({ payload: { ...wake!.payload, sourceRunId: fixture.runId } })
          .where(eq(agentWakeupRequests.id, parent.wakeId));
        await db
          .update(issueThreadInteractions)
          .set({ sourceRunId: fixture.runId })
          .where(eq(issueThreadInteractions.id, parent.interactionId));
        await db
          .update(issueQuestionResponseDeliveries)
          .set({ sourceRunId: fixture.runId })
          .where(
            eq(issueQuestionResponseDeliveries.id, parent.responseDeliveryId),
          );
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: { ...parent.context, sourceRunId: fixture.runId },
          })
          .where(eq(heartbeatRuns.id, parent.runId));
      }
      expect(
        await attestReviewedExternalChatRun({
          db,
          ...fixture,
          contextSnapshot: fixture.context,
        }),
      ).toBe(false);
      expect(
        fixture.context.paperclipExternalChatQuestionResponse,
      ).toBeUndefined();
    },
  );

  it("bounds sequential question ancestry without silently dropping earlier answers", async () => {
    const { fixture, parents } = await seedSequentialQuestionChain(9);
    const deepestAllowed = parents.at(-1)!;
    expect(
      (
        await resolveExternalChatQuestionResponse(
          db,
          deepestAllowed,
          deepestAllowed.context,
          "read",
        )
      )?.interactionIds,
    ).toHaveLength(8);
    expect(
      await attestReviewedExternalChatRun({
        db,
        ...fixture,
        contextSnapshot: fixture.context,
      }),
    ).toBe(false);
  });

  it("revalidates sequential question ancestors before publishing the later answer", async () => {
    const { fixture, parents } = await seedSequentialQuestionChain();
    await attestAnswer(fixture);
    const resultJson = await finishReviewResponse(fixture);
    expect(
      await authorizeNativeChatReviewPresentation(db, {
        ...fixture,
        resultJson,
      }),
    ).toBe(true);
    await db
      .update(agentWakeupRequests)
      .set({ requestedByActorId: "another-user" })
      .where(eq(agentWakeupRequests.id, parents[0]!.wakeId));
    expect(
      await authorizeNativeChatReviewPresentation(db, {
        ...fixture,
        resultJson,
      }),
    ).toBe(false);
  });

  it.each(["telegram", "discord"] as const)(
    "retains authenticated %s answer continuation presentation without resolving prior review",
    async (provider) => {
      const fixture = await seedAnsweredChatTurn(provider);
      await attestAnswer(fixture);
      const resultJson = await finishReviewResponse(fixture);
      expect(resultJson.externalChatReviewPresentation).toMatchObject({
        gateId: fixture.gate.id,
      });
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          resultJson,
        }),
      ).toBe(true);
      const [gate] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, fixture.gate.id));
      expect(gate!.status).toBe("pending");
    },
  );

  it.each([
    "wake_actor",
    "different_responder",
    "revoked_link",
    "wrong_option",
    "wrong_digest",
    "wrong_target",
    "wrong_wake_target",
    "missing_wake_receipt",
    "unprocessed_action",
    "duplicate_action",
    "source_issue",
    "source_batch",
    "execution_owner",
  ] as const)(
    "does not attest an unbound answered-chat continuation: %s",
    async (kind) => {
      const fixture = await seedAnsweredChatTurn();
      if (kind === "wake_actor")
        await db
          .update(agentWakeupRequests)
          .set({ requestedByActorId: "another-user" })
          .where(eq(agentWakeupRequests.id, fixture.wakeId));
      if (kind === "different_responder") {
        // A legitimate linked second responder must not inherit the original author's scope.
        const principalId = randomUUID();
        await db
          .insert(chatExternalPrincipals)
          .values({
            id: principalId,
            companyId: fixture.companyId,
            provider: "telegram",
            providerAccountId: "telegram-bot",
            externalId: "second-user",
            kind: "user",
          });
        await db
          .insert(chatIdentityLinks)
          .values({
            companyId: fixture.companyId,
            endpointId: fixture.endpointId,
            principalId,
            paperclipUserId: "second-user",
            status: "linked",
          });
        await db
          .insert(companyMemberships)
          .values({
            companyId: fixture.companyId,
            principalType: "user",
            principalId: "second-user",
            status: "active",
            membershipRole: "member",
          });
        await db
          .update(chatActions)
          .set({ principalId })
          .where(eq(chatActions.id, fixture.actionId));
        await db
          .update(issueThreadInteractions)
          .set({ resolvedByUserId: "second-user" })
          .where(eq(issueThreadInteractions.id, fixture.interactionId));
        await db
          .update(agentWakeupRequests)
          .set({ requestedByActorId: "second-user" })
          .where(eq(agentWakeupRequests.id, fixture.wakeId));
      }
      if (kind === "revoked_link")
        await db
          .update(chatIdentityLinks)
          .set({ status: "revoked" })
          .where(eq(chatIdentityLinks.principalId, fixture.principalId));
      if (kind === "wrong_option") {
        const [action] = await db
          .select()
          .from(chatActions)
          .where(eq(chatActions.id, fixture.actionId));
        await db
          .update(chatActions)
          .set({ payload: { ...action!.payload, optionId: "amber" } })
          .where(eq(chatActions.id, fixture.actionId));
      }
      if (kind === "wrong_digest")
        await db
          .update(issueQuestionResponseDeliveries)
          .set({ payloadSha256: "b".repeat(64) })
          .where(
            eq(issueQuestionResponseDeliveries.id, fixture.responseDeliveryId),
          );
      if (kind === "wrong_target")
        await db
          .update(issueQuestionResponseDeliveries)
          .set({ targetRunId: fixture.sourceRunId })
          .where(
            eq(issueQuestionResponseDeliveries.id, fixture.responseDeliveryId),
          );
      if (kind === "wrong_wake_target")
        await db
          .update(agentWakeupRequests)
          .set({ runId: fixture.sourceRunId })
          .where(eq(agentWakeupRequests.id, fixture.wakeId));
      if (kind === "missing_wake_receipt")
        await db
          .update(heartbeatRuns)
          .set({ wakeupRequestId: null })
          .where(eq(heartbeatRuns.id, fixture.runId));
      if (kind === "unprocessed_action")
        await db
          .update(chatActions)
          .set({ status: "issued" })
          .where(eq(chatActions.id, fixture.actionId));
      if (kind === "duplicate_action") {
        const [action] = await db
          .select()
          .from(chatActions)
          .where(eq(chatActions.id, fixture.actionId));
        await db
          .insert(chatActions)
          .values({
            ...action!,
            id: randomUUID(),
            providerActionId: "duplicate-response",
          });
      }
      if (kind === "source_issue" || kind === "source_batch") {
        const [source] = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, fixture.sourceRunId));
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: {
              ...source!.contextSnapshot,
              ...(kind === "source_issue"
                ? { issueId: randomUUID() }
                : { wakeCommentIds: [randomUUID(), fixture.commentId] }),
            },
          })
          .where(eq(heartbeatRuns.id, fixture.sourceRunId));
      }
      if (kind === "execution_owner")
        await db
          .update(issues)
          .set({ executionRunId: fixture.sourceRunId })
          .where(eq(issues.id, fixture.issueId));
      expect(
        await attestReviewedExternalChatRun({
          db,
          ...fixture,
          contextSnapshot: fixture.context,
        }),
      ).toBe(false);
      expect(
        fixture.context.paperclipExternalChatQuestionResponse,
      ).toBeUndefined();
      expect(
        await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, fixture.gate.id)),
      ).toEqual([expect.objectContaining({ status: "pending" })]);
    },
  );

  it.each([
    "revoked_link",
    "revoked_membership",
    "demoted_membership",
    "changed_generation",
    "changed_answer",
    "changed_gate",
  ] as const)(
    "revalidates answered-chat presentation at dispatch: %s",
    async (kind) => {
      const fixture = await seedAnsweredChatTurn();
      await attestAnswer(fixture);
      const resultJson = await finishReviewResponse(fixture);
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          resultJson,
        }),
      ).toBe(true);
      if (kind === "revoked_link")
        await db
          .update(chatIdentityLinks)
          .set({ status: "revoked" })
          .where(eq(chatIdentityLinks.principalId, fixture.principalId));
      if (kind === "revoked_membership")
        await db
          .update(companyMemberships)
          .set({ status: "suspended" })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalId, fixture.userId),
            ),
          );
      if (kind === "demoted_membership")
        await db
          .update(companyMemberships)
          .set({ membershipRole: "viewer" })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalId, fixture.userId),
            ),
          );
      if (kind === "changed_generation")
        await db
          .update(chatConversations)
          .set({ sessionGeneration: 2 })
          .where(eq(chatConversations.id, fixture.conversationId));
      if (kind === "changed_answer")
        await db
          .update(issueThreadInteractions)
          .set({
            result: {
              version: 1,
              answers: [{ questionId: "color", optionIds: ["amber"] }],
            },
          })
          .where(eq(issueThreadInteractions.id, fixture.interactionId));
      if (kind === "changed_gate")
        await db
          .update(issueThreadInteractions)
          .set({ status: "accepted" })
          .where(eq(issueThreadInteractions.id, fixture.gate.id));
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          resultJson,
        }),
      ).toBe(false);
    },
  );

  it("does not register a fallback after an answered-chat principal is revoked without a review gate", async () => {
    const fixture = await seedAnsweredChatTurn();
    await attestAnswer(fixture);
    await db
      .update(issueThreadInteractions)
      .set({ status: "accepted" })
      .where(eq(issueThreadInteractions.id, fixture.gate.id));
    await db
      .update(issues)
      .set({ status: "in_progress" })
      .where(eq(issues.id, fixture.issueId));
    await db
      .update(chatIdentityLinks)
      .set({ status: "revoked" })
      .where(eq(chatIdentityLinks.principalId, fixture.principalId));
    await finishReviewResponse(fixture);
    expect(
      await db
        .select()
        .from(statusDecisions)
        .where(eq(statusDecisions.runId, fixture.runId)),
    ).toEqual([
      expect.objectContaining({
        reasonCode: "external_chat_response_wait_authorization_lost",
        decisionJson: expect.objectContaining({ effects: [] }),
      }),
    ]);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, fixture.companyId)),
    ).toHaveLength(1);
  });

  it("accepts the exact admitted answer while its post-wakeup delivery receipt is still finishing", async () => {
    const fixture = await seedAnsweredChatTurn();
    await db
      .update(issueQuestionResponseDeliveries)
      .set({ status: "delivering", deliveryMode: null, targetRunId: null })
      .where(
        eq(issueQuestionResponseDeliveries.id, fixture.responseDeliveryId),
      );
    await attestAnswer(fixture);
    await db
      .update(issueQuestionResponseDeliveries)
      .set({
        status: "fallback_queued",
        deliveryMode: "wake_fallback",
        targetRunId: fixture.runId,
      })
      .where(
        eq(issueQuestionResponseDeliveries.id, fixture.responseDeliveryId),
      );
    const resultJson = await finishReviewResponse(fixture);
    expect(
      await authorizeNativeChatReviewPresentation(db, {
        ...fixture,
        resultJson,
      }),
    ).toBe(true);
  });

  it("takes the answered-chat identity advisory before identity rows during concurrent revocation", async () => {
    const fixture = await seedAnsweredChatTurn();
    await attestAnswer(fixture);
    let release!: () => void;
    let acquired!: () => void;
    let revoke!: () => void;
    let confirmRevoked!: () => void;
    let rejectRevoked!: (error: unknown) => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const shouldRevoke = new Promise<void>((resolve) => {
      revoke = resolve;
    });
    const revoked = new Promise<void>((resolve, reject) => {
      confirmRevoked = resolve;
      rejectRevoked = reject;
    });
    const holder = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${fixture.companyId}:${fixture.principalId}`}, 0))`,
      );
      acquired();
      await shouldRevoke;
      try {
        await tx
          .select()
          .from(chatIdentityLinks)
          .where(eq(chatIdentityLinks.principalId, fixture.principalId))
          .for("update", { noWait: true });
        await tx
          .update(chatIdentityLinks)
          .set({ status: "revoked" })
          .where(eq(chatIdentityLinks.principalId, fixture.principalId));
        confirmRevoked();
      } catch (error) {
        rejectRevoked(error);
        throw error;
      } finally {
        await released;
      }
    });
    await ready;
    let readerPid = 0;
    const reader = db
      .transaction(async (tx) => {
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
        readerPid = Number(backend!.pid);
        return authorizeChatConversationForBoundRun(
          tx as unknown as typeof db,
          fixture,
          fixture.context,
        );
      })
      .then(
        () => "unexpectedly_authorized",
        (error: Error) => error.message,
      );
    try {
      await vi.waitFor(async () => {
        expect(readerPid).toBeGreaterThan(0);
        const [waiting] = await db.execute(
          sql`select exists(select 1 from pg_locks where pid = ${readerPid} and locktype = 'advisory' and not granted) as waiting`,
        );
        expect(waiting!.waiting).toBe(true);
      });
      revoke();
      await Promise.race([revoked, holder]);
    } finally {
      revoke();
      release();
      await Promise.allSettled([holder, reader]);
    }
    expect(await reader).toBe(
      "paperclip_runner_chat_attachment_binding_denied",
    );
  });

  async function seedPriorCompletionReview(
    fixture: Awaited<ReturnType<typeof seedWaitTurn>>,
  ) {
    const [current] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    const [accepted] = await db
      .select()
      .from(nativeRunResults)
      .where(eq(nativeRunResults.runId, fixture.runId));
    const runId = randomUUID();
    const sessionId = randomUUID();
    const runnerInstanceId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: fixture.issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      completionContractId: current!.completionContractId,
      completionContractSha256: current!.completionContractSha256,
      contextSnapshot: {},
      createdAt: new Date(Date.now() - 60_000),
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, fixture.issueId));
    const port = new PaperclipControlPlanePort(db, {
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      agentId: fixture.agentId,
      runId,
      sessionId,
      completionContractId: current!.completionContractId!,
      completionContractSha256: current!.completionContractSha256!,
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: `review-control-${runId}`,
    });
    await port.openRun({
      identity: {
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        agentId: fixture.agentId,
        runId,
        sessionId,
      },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const result = {
      ...(accepted!.resultJson.result as PrpStructuredRunResult),
      reportedWorkDisposition: "needs_review" as const,
    };
    delete result.continuation;
    result.attentionRequests = [{ kind: "review", ownerClass: "human", summary: "Approve the prepared response before continuing." }];
    const terminal = {
      ...(accepted!.resultJson.terminal as PrpTerminalState),
      reportedWorkDisposition: "needs_review" as const,
    };
    await port.completeRun({
      result,
      terminal,
      callerResultId: `prior-review-${runId}`,
    });
    await finalizeNativeRun({
      db,
      runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    const [gate] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.sourceRunId, runId));
    expect(gate).toMatchObject({
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: null,
      createdByUserId: null,
    });
    await db
      .update(issues)
      .set({ executionRunId: fixture.runId })
      .where(eq(issues.id, fixture.issueId));
    await db
      .update(heartbeatRuns)
      .set({ startedAt: new Date(gate!.createdAt.getTime() + 1) })
      .where(eq(heartbeatRuns.id, fixture.runId));
    return gate!;
  }

  async function finishReviewResponse(
    fixture: Awaited<ReturnType<typeof seedWaitTurn>>,
  ) {
    await finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    return run!.resultJson!;
  }

  async function seedRecoverableReviewResponse() {
    const fixture = await seedWaitTurn();
    const gate = await seedPriorCompletionReview(fixture);
    await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.runId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator!.phase).toBe("committed");
    const input = { companyId: fixture.companyId, issueId: fixture.issueId, runId: fixture.runId,
      decisionId: coordinator!.decisionId!, resultId: coordinator!.resultId!, assessmentId: coordinator!.assessmentId!, onlyWhenDue: true };
    return { ...fixture, gate, input };
  }

  it.each(["reconciler", "finalizer"] as const)("defers periodic governed-response %s repair to its registered worker", async path => {
    const fixture = await seedRecoverableReviewResponse();
    await db.update(heartbeatRuns).set({ resultJson: sql`${heartbeatRuns.resultJson} - 'externalChatReviewPresentation'` })
      .where(eq(heartbeatRuns.id, fixture.runId));
    if (path === "reconciler") await reconcileNativeFinalizations(db, [fixture.runId], { skipNativeReviewResponse: true });
    else await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true, skipNativeReviewResponse: true });
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).toHaveLength(0);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run.resultJson?.externalChatReviewPresentation).toBeUndefined();
    const work = nativeReviewResponseWork(db);
    const [entry] = await work.load({ companyId: fixture.companyId, runId: fixture.runId });
    expect(entry?.id).toBe(fixture.runId);
    expect(await work.check(entry)).toBeNull();
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).toHaveLength(1);
  });

  it("recovers scheduled governed responses once under concurrent callers and preserves deleted receipts", async () => {
    const fixture = await seedRecoverableReviewResponse();
    const work = nativeReviewResponseWork(db);
    const [entry] = await work.load({ companyId: fixture.companyId });
    expect(entry?.id).toBe(fixture.runId);
    expect(await Promise.all([recoverCommittedNativeReviewResponse(db, fixture.input),
      recoverCommittedNativeReviewResponse(db, fixture.input)])).toEqual(expect.arrayContaining([true, false]));
    const comments = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId));
    expect(comments).toHaveLength(1);
    expect(await db.select().from(chatPublications).where(eq(chatPublications.commentId, comments[0].id))).toHaveLength(1);
    expect(await work.load({ companyId: fixture.companyId })).toEqual([]);
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comments[0].id));
    expect(await work.load({ companyId: fixture.companyId })).toEqual([]);
    expect(await recoverCommittedNativeReviewResponse(db, fixture.input)).toBe(false);
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).toHaveLength(1);
  });

  it("lets status replay finish while governed response recovery waits for its coordinator", async () => {
    const fixture = await seedRecoverableReviewResponse();
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, fixture.input.decisionId));
    let recovery: Promise<{ value?: boolean; error?: unknown }> | undefined;
    try {
      await db.transaction(async tx => {
        await tx.select().from(nativeRunFinalizations)
          .where(eq(nativeRunFinalizations.runId, fixture.runId)).for("update");
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        recovery = recoverCommittedNativeReviewResponse(db, fixture.input)
          .then(value => ({ value }), error => ({ error }));
        await vi.waitFor(async () => {
          const [waiting] = await db.execute<{ count: number }>(sql`
            select count(*)::int as count from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and ${backend.pid} = any(pg_blocking_pids(pid))`);
          expect(waiting.count).toBe(1);
        });


        await tx.execute(sql`set local lock_timeout = '500ms'`);
        const replay = await commitNativeStatusDecision({
          db: tx as unknown as typeof db, companyId: fixture.companyId,
          issueId: fixture.issueId, runId: fixture.runId,
          assessmentId: fixture.input.assessmentId,
          priorStatus: issue.status, priorStatusVersion: issue.statusVersion,
          priorDecisionId: issue.lastStatusDecisionId,
          decision: decision.decisionJson as unknown as Parameters<typeof commitNativeStatusDecision>[0]["decision"],
        });
        expect(replay.replayed).toBe(true);
      });
    } finally {
      if (recovery) {
        const result = await recovery;
        expect(result.error).toBeUndefined();
        expect(result.value).toBe(true);
      }
    }
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).toHaveLength(1);
    expect(await recoverCommittedNativeReviewResponse(db, fixture.input)).toBe(false);
  });

  it.each(["future", "claim"])("defers scheduled governed responses behind a new %s under the owner lock", async kind => {
    const fixture = await seedRecoverableReviewResponse();
    const work = nativeReviewResponseWork(db);
    const [entry] = await work.load({ companyId: fixture.companyId });
    const at = new Date(Date.now() + 60_000);
    const transaction = db.transaction.bind(db);
    const intercept = vi.spyOn(db, "transaction").mockImplementationOnce((async (callback, options) => {
      await transaction(async tx => {
        await tx.update(nativeRunFinalizations).set(kind === "future" ? { nextAttemptAt: at }
          : { leaseOwner: "another-finalizer", leaseExpiresAt: at }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      });
      return transaction(callback, options);
    }) as typeof db.transaction);
    try {
      expect(await work.check(entry)).toEqual(kind === "future" ? { ...entry, dueAt: at.getTime() } : null);
    } finally { intercept.mockRestore(); }
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).toHaveLength(0);
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(await recoverCommittedNativeReviewResponse(db, fixture.input)).toBe(true);
  });

  it("propagates scheduled governed response contention and rolls back its proof restoration", async () => {
    const fixture = await seedRecoverableReviewResponse();
    await db.update(heartbeatRuns).set({ resultJson: sql`${heartbeatRuns.resultJson} - 'externalChatReviewPresentation'` })
      .where(eq(heartbeatRuns.id, fixture.runId));
    let release!: () => void, observed!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { observed = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, fixture.endpointId)).for("update");
      observed(); await hold;
    });
    await locked;
    try {
      await expect(recoverCommittedNativeReviewResponse(db, fixture.input)).rejects.toBeDefined();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      expect(run.resultJson?.externalChatReviewPresentation).toBeUndefined();
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).toHaveLength(0);
    } finally { release(); await holder; }
    expect(await recoverCommittedNativeReviewResponse(db, fixture.input)).toBe(true);
  });

  it.each(["gate", "agent", "principal", "company"])("leaves scheduled governed response authority with its owner after %s changes", async kind => {
    const fixture = await seedRecoverableReviewResponse();
    if (kind === "gate") await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, fixture.gate.id));
    if (kind === "agent") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, fixture.agentId));
    if (kind === "principal") await db.update(companyMemberships).set({ status: "suspended" })
      .where(and(eq(companyMemberships.companyId, fixture.companyId), eq(companyMemberships.principalId, fixture.userId)));
    expect(await recoverCommittedNativeReviewResponse(db, { ...fixture.input,
      ...(kind === "company" ? { companyId: randomUUID() } : {}) })).toBe(false);
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).toHaveLength(0);
  });

  it.each(["milestone", "finalization"] as const)("ignores repeated unscoped routine %s hints without reconstructing dormant governed responses", async source => {
    const fixture = await seedRecoverableReviewResponse();
    await db.update(companyMemberships).set({ status: "suspended" }).where(and(
      eq(companyMemberships.companyId, fixture.companyId), eq(companyMemberships.principalId, fixture.userId)));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 10_000 })
        .toEqual({ active: 0, next: null });
      const debug = db.$client.options.debug;
      const queries: string[] = [];
      db.$client.options.debug = (_connection, query) => {
        if (query.startsWith("select") && query.includes("native_run_finalizations")) queries.push(query);
      };
      try {
        for (let i = 0; i < 3; i++) {
          await db.transaction(tx => source === "milestone" ? notifyChatRunMilestones(tx, { companyId: fixture.companyId })
            : notifyNativeFinalizationWork(tx, { companyId: fixture.companyId }));
          await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
            .toEqual({ active: 0, next: null });
        }
        expect(queries).toEqual([]);
      } finally { db.$client.options.debug = debug; }
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); }
  });

  it("wakes dormant governed responses through the real company membership restoration owner", async () => {
    const fixture = await seedRecoverableReviewResponse();
    const [member] = await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, fixture.companyId), eq(companyMemberships.principalId, fixture.userId)));
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, member.id));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 10_000 })
        .toEqual({ active: 0, next: null });
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).toHaveLength(0);
      await accessService(db).updateMember(fixture.companyId, member.id, { status: "active" });
      await expect.poll(async () => ({ count: (await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).length,
        active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
        .toEqual({ count: 1, active: 0, next: null });
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); }
  });

  it.each(["approve", "reject", "cancel", "unlink"] as const)("reactivates dormant governed responses after approval %s", async action => {
    const fixture = await seedRecoverableReviewResponse();
    const [approval] = await db.insert(approvals).values({ companyId: fixture.companyId,
      type: "hire_agent", status: "pending", payload: {} }).returning();
    await issueApprovalService(db).link(fixture.issueId, approval.id);
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
    const comments = () => db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId));
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await comments()).toHaveLength(0);
      if (action === "unlink") await issueApprovalService(db).unlink(fixture.issueId, approval.id);
      else if (action === "cancel") await approvalRecords(db).cancel(approval.id);
      else await approvalRecords(db).resolveApproval(approval.id, action === "approve" ? "approved" : "rejected", fixture.userId, null);
      await expect.poll(async () => (await comments()).length, { timeout: 5_000 }).toBe(1);
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); }
  });

  it.each([
    ["resolver", "single"], ["resolver", "bulk"],
    ["linker", "single"], ["linker", "bulk"],
  ] as const)("retains a settled task wake when %s starts first during concurrent %s approval linking", async (first, kind) => {
    const fixture = await seedWaitTurn();
    const [approval] = await db.insert(approvals).values({ companyId: fixture.companyId,
      type: "request_board_approval", status: "pending", payload: {} }).returning();
    const observed: string[] = [];
    const reads: Promise<void>[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.nativeReviewResponse, (event, hints) => {
      if (event !== "settled" || ![...(hints ?? [])].some(hint => {
        const scope = JSON.parse(hint);
        return scope.companyId === fixture.companyId && scope.issueId === fixture.issueId;
      })) return;
      reads.push(db.select({ status: approvals.status }).from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(eq(issueApprovals.issueId, fixture.issueId), eq(approvals.id, approval.id)))
        .then(rows => { for (const row of rows) observed.push(row.status); }));
    });
    let release!: () => void, ready!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { ready = resolve; });
    let holderPid = 0, resolverPid = 0, linkerPid = 0;
    let linked = false, resolved = false;
    const link = async (tx: typeof db) => {
      if (kind === "single") await issueApprovalService(tx).link(fixture.issueId, approval.id);
      else await issueApprovalService(tx).linkManyForApproval(approval.id, [fixture.issueId]);
    };
    const holder = db.transaction(async tx => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      holderPid = Number(backend.pid);
      if (first === "resolver") {


        await tx.execute(sql`lock table approvals in share mode`);
      } else {
        await link(tx as unknown as typeof db);
      }
      ready();
      await hold;
    });
    let resolver: Promise<unknown> | undefined, linker: Promise<unknown> | undefined;
    const blocked = async (pid: number, by: number) => {
      if (!pid || !by) return false;
      const [row] = await db.execute(sql`select ${by} = any(pg_blocking_pids(${pid})) as blocked`);
      return row.blocked === true;
    };
    try {
      await held;
      resolver = db.transaction(async tx => {
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
        resolverPid = Number(backend.pid);
        await approvalRecords(tx as unknown as typeof db).resolveApproval(approval.id, "approved", fixture.userId, null);
      }).then(() => { resolved = true; });
      await expect.poll(async () => resolved || await blocked(resolverPid, holderPid), { timeout: 5000 }).toBe(true);
      if (first === "resolver") {
        linker = db.transaction(async tx => {
          const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
          linkerPid = Number(backend.pid);
          await link(tx as unknown as typeof db);
        }).then(() => { linked = true; });
        await expect.poll(async () => linked || await blocked(linkerPid, resolverPid), { timeout: 5000 }).toBe(true);
      }


      await Promise.all(reads);
      release();
      await Promise.all([holder, resolver, linker]);
      await Promise.all(reads);
      expect(observed).toContain("approved");
    } finally {
      release();
      await Promise.allSettled([holder, resolver, linker]);
      await Promise.all(reads);
      unsubscribe();
    }
  });

  it.each(["cancel", "unlink"] as const)("keeps governed response approval %s behind outer commit and scoped to linked tasks", async action => {
    const fixture = await seedRecoverableReviewResponse();
    const [approval, unrelated] = await db.insert(approvals).values([
      { companyId: fixture.companyId, type: "hire_agent", status: "pending", payload: {} },
      { companyId: fixture.companyId, type: "hire_agent", status: "pending", payload: {} },
    ]).returning();
    await issueApprovalService(db).link(fixture.issueId, approval.id);
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
    const comments = () => db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId));
    const mutate = async (tx: typeof db) => {
      if (action === "cancel") await approvalRecords(tx).cancel(approval.id);
      else await issueApprovalService(tx).unlink(fixture.issueId, approval.id);
    };
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      const previousDebug = db.$client.options.debug;
      const queries: string[] = [];
      db.$client.options.debug = (_connection, query) => { if (query.includes('"native_run_finalizations"')) queries.push(query); };
      try {
        await approvalRecords(db).cancel(unrelated.id);
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(queries).toEqual([]);
      } finally { db.$client.options.debug = previousDebug; }
      const rollback = new Error("rollback governed approval change");
      await expect(db.transaction(async tx => {
        await mutate(tx as unknown as typeof db);
        expect(await comments()).toHaveLength(0);
        throw rollback;
      })).rejects.toBe(rollback);
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await comments()).toHaveLength(0);
      await db.transaction(async tx => {
        await mutate(tx as unknown as typeof db);
        expect(await comments()).toHaveLength(0);
      });
      await expect.poll(async () => (await comments()).length, { timeout: 5_000 }).toBe(1);
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); }
  });

  it("wakes dormant governed response recovery after real agent resume", async () => {
    const fixture = await seedRecoverableReviewResponse();
    await db.update(agents).set({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["manual"], lifecycleOperation: null })
      .where(eq(agents.id, fixture.agentId));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
    const lifecycle = configureAgentLifecycle(db, {
      requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete",
    });
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).toHaveLength(0);
      await createAgentLifecycle(db).resumeAgent(fixture.agentId);
      await processAgentLifecycle(db, fixture.agentId);
      await expect.poll(async () => (await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0].status).toBe("idle");
      await expect.poll(async () => (await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).length,
        { timeout: 5_000 }).toBe(1);
      expect(errors).toEqual([]);
    } finally { await lifecycle.stop(); await coordinator.stop(); }
  });

  it.each(["skip", "withdraw", "reject_suggestions", "complete_verdicts", "decline_connection"] as const)(
    "reactivates governed responses after competing interaction %s", async action => {
      const fixture = await seedRecoverableReviewResponse();
      const service = issueThreadInteractionService(db);
      const issue = { id: fixture.issueId, companyId: fixture.companyId };
      const actor = { userId: fixture.userId };
      const competing = action === "decline_connection"
        ? await service.createConnectionIntent(issue, { sourceRunId: fixture.runId,
            addresseeUserId: fixture.userId, idempotencyKey: `review-competing:${randomUUID()}`,
            payload: { version: 1, serviceSlug: "notion", serviceName: "Notion", serviceLogoUrl: null,
              requestingAgentId: fixture.agentId, requestingAgentName: "Agent", phase: "requested" } })
        : action === "complete_verdicts"
          ? await service.create(issue, { kind: "request_item_verdicts", payload: { version: 1,
              prompt: "Review this item", items: [{ id: "one", label: "One" }] } }, actor)
          : await service.create(issue, { kind: "suggest_tasks", payload: { version: 1,
              tasks: [{ clientKey: "child", title: "A suggested task" }] } }, actor);
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
      const comments = () => db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId));
      try {
        await worker.ready;
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
          { timeout: 10_000 }).toEqual({ active: 0, next: null });
        expect(await comments()).toHaveLength(0);
        if (action === "skip") await service.skipInteraction(issue, competing.id, {}, actor);
        else if (action === "withdraw") await service.withdrawInteraction(issue, competing.id, {}, actor);
        else if (action === "reject_suggestions") await service.rejectInteraction(issue, competing.id, {}, actor);
        else if (action === "complete_verdicts") await service.submitItemVerdicts(issue, competing.id,
          { verdicts: [{ id: "one", verdict: "approve" }] }, actor);
        else await service.resolveConnectionIntent(issue, competing.id, { version: 1, outcome: "declined" }, actor);
        await expect.poll(async () => (await comments()).length, { timeout: 5_000 }).toBe(1);
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); }
    });

  it.each(["status", "assignment"] as const)("preserves governed response policy through task %s changes", async change => {
    const fixture = await seedRecoverableReviewResponse();
    await db.update(issues).set(change === "status" ? { status: "blocked" } : { assigneeAgentId: null })
      .where(eq(issues.id, fixture.issueId));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
    const comments = () => db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId));
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await comments()).toHaveLength(0);
      if (change === "assignment") {
        await expect(issueService(db).update(fixture.issueId, { assigneeAgentId: fixture.agentId }))
          .rejects.toThrow("Agent assignment cannot change while this task is bound to an external channel");
        expect(await comments()).toHaveLength(0);
      } else {
        await issueService(db).update(fixture.issueId, { status: "in_review" });
        await expect.poll(async () => (await comments()).length, { timeout: 5_000 }).toBe(1);
      }
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); }
  });

  it("reactivates governed responses after OAuth confirmation denial", async () => {
    const fixture = await seedRecoverableReviewResponse();
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.companyId, fixture.companyId));
    const competing = await issueThreadInteractionService(db).create({ id: fixture.issueId, companyId: fixture.companyId },
      { kind: "request_confirmation", payload: { version: 1, prompt: "Connect your account", target: {
        type: "custom", key: `connection:${connection.id}`, revisionId: randomUUID(), label: "Connect account" } } },
      { userId: fixture.userId });
    const [state] = await db.insert(toolOauthStates).values({ state: randomUUID(), companyId: fixture.companyId,
      connectionId: connection.id, codeVerifier: "test-verifier", issueId: fixture.issueId, interactionId: competing.id,
      subjectUserId: fixture.userId, expiresAt: new Date(Date.now() + 60_000) }).returning();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
    const comments = () => db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId));
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await comments()).toHaveLength(0);
      const rollback = new Error("rollback OAuth denial");
      await expect(db.transaction(async tx => {
        await createOAuthStateStore(tx as unknown as typeof db).rejectPendingOAuthInteraction(state,
          { actorType: "user", actorId: fixture.userId });
        expect(await comments()).toHaveLength(0);
        throw rollback;
      })).rejects.toBe(rollback);
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, competing.id)))[0].status).toBe("pending");
      await db.transaction(async tx => {
        await createOAuthStateStore(tx as unknown as typeof db).rejectPendingOAuthInteraction(state,
          { actorType: "user", actorId: fixture.userId });
        expect(await comments()).toHaveLength(0);
      });
      await expect.poll(async () => (await comments()).length, { timeout: 5_000 }).toBe(1);
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); }
  });

  it("reactivates governed responses when pending execution policy is cleared without changing task status", async () => {
    const fixture = await seedRecoverableReviewResponse();
    await db.update(issues).set({ executionState: { status: "pending", currentStageId: randomUUID(),
      currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "user", userId: fixture.userId, agentId: null },
      returnAssignee: { type: "agent", agentId: fixture.agentId, userId: null }, reviewRequest: null,
      completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, monitor: null, changesRequestedCount: 0 } })
      .where(eq(issues.id, fixture.issueId));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
    const comments = () => db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId));
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await comments()).toHaveLength(0);
      await issueService(db).updateForCompany(fixture.issueId, fixture.companyId, { executionState: null });
      expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0].status).toBe("in_review");
      await expect.poll(async () => (await comments()).length, { timeout: 5_000 }).toBe(1);
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); }
  });

  it("wakes governed responses from the real coordinator retry release", async () => {
    const fixture = await seedRecoverableReviewResponse();
    const store = new NativeRunCoordinatorStore(db, fixture.storeBinding);
    await store.claimFinalization({ leaseOwner: "review-response-fixture", leaseTtlMs: 30_000 });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
    const comments = () => db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId));
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await comments()).toHaveLength(0);
      await store.markFinalizationRetry({ leaseOwner: "review-response-fixture", failureCode: "review_response_retry", retryAfterMs: 1000 });
      expect(await comments()).toHaveLength(0);
      await expect.poll(async () => (await comments()).length, { timeout: 5_000 }).toBe(1);
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); }
  });

  it("retains the first governed-response wake through idle drain without passive SQL", async () => {
    const fixture = await seedRecoverableReviewResponse();
    const [approval] = await db.insert(approvals).values({ companyId: fixture.companyId,
      type: "hire_agent", status: "pending", payload: {} }).returning();
    await issueApprovalService(db).link(fixture.issueId, approval.id);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let canRun = true;
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
      canReconcile: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => canRun);
    const comments = () => db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId));
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      canRun = false;
      await approvalRecords(db).cancel(approval.id);
      await expect.poll(() => idleWorkSnapshot().active).toBe(0);
      expect(await comments()).toHaveLength(0);
      expect(coordinator.nextWakeAt()).not.toBeNull();
      const previousDebug = db.$client.options.debug;
      const queries: string[] = [];
      db.$client.options.debug = (_connection, query) => { queries.push(query); };
      try { await vi.advanceTimersByTimeAsync(120_000); expect(queries).toEqual([]); }
      finally { db.$client.options.debug = previousDebug; }
      canRun = true; worker.wake();
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await comments()).toHaveLength(1);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); vi.useRealTimers(); }
  });

  it("retains failed governed-response recovery across drain and retries after resume", async () => {
    const fixture = await seedRecoverableReviewResponse();
    let release!: () => void, observed!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { observed = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, fixture.endpointId)).for("update");
      observed(); await hold;
    });
    await locked;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let canRun = true;
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
      canReconcile: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => canRun);
    const comments = () => db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId));
    try {
      await worker.ready;
      await expect.poll(() => ({ errors: errors.length, active: idleWorkSnapshot().active }),
        { timeout: 10_000 }).toEqual({ errors: 1, active: 0 });
      expect(await comments()).toHaveLength(0);
      expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now());
      canRun = false;
      worker.wake();
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
      const previousDebug = db.$client.options.debug;
      const queries: string[] = [];
      db.$client.options.debug = (_connection, query) => { queries.push(query); };
      try { await vi.advanceTimersByTimeAsync(120_000); expect(queries).toEqual([]); }
      finally { db.$client.options.debug = previousDebug; }
      release(); await holder;
      canRun = true; worker.wake();
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await comments()).toHaveLength(1);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      expect(errors).toHaveLength(1);
    } finally { release(); await holder; await coordinator.stop(); vi.useRealTimers(); }
  });

  it("reconstructs the governed-response deadline after shutdown without early presentation", async () => {
    const fixture = await seedRecoverableReviewResponse();
    const store = new NativeRunCoordinatorStore(db, fixture.storeBinding);
    await store.claimFinalization({ leaseOwner: "review-future", leaseTtlMs: 30_000 });
    await store.markFinalizationRetry({ leaseOwner: "review-future", failureCode: "review_fixture", retryAfterMs: 60_000 });
    const [state] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const at = state.nextAttemptAt!.getTime();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
    const comments = () => db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId));
    await worker.ready;
    await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
      { timeout: 10_000 }).toEqual({ active: 0, next: at });
    await coordinator.stop();
    expect(coordinator.nextWakeAt()).toBeNull();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const previousDebug = db.$client.options.debug;
    const queries: string[] = [];
    db.$client.options.debug = (_connection, query) => { queries.push(query); };
    try { await vi.advanceTimersByTimeAsync(30_000); expect(queries).toEqual([]); }
    finally { db.$client.options.debug = previousDebug; }
    const resumed = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    try {
      const restarted = nativeReviewResponseWork(db).register(resumed, () => true);
      await restarted.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: resumed.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: at });
      expect(await comments()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(Math.max(0, at - Date.now()));
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await comments()).toHaveLength(1);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(resumed.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally { await resumed.stop(); vi.useRealTimers(); }
  });

  it("reconstructs scheduled governed responses at startup and leaves their history quiet", async () => {
    const fixture = await seedRecoverableReviewResponse();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeReviewResponseWork(db).register(coordinator, () => true);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, fixture.runId))).toHaveLength(1);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const previousDebug = db.$client.options.debug;
      const queries: string[] = [];
      db.$client.options.debug = (_connection, query) => { queries.push(query); };
      try { await vi.advanceTimersByTimeAsync(120_000); expect(queries).toEqual([]); }
      finally { db.$client.options.debug = previousDebug; }
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); vi.useRealTimers(); }
  });

  it.each(["telegram", "discord"] as const)(
    "presents the exact %s response without resolving a pre-existing native completion review",
    async (provider) => {
      const fixture = await seedWaitTurn(provider);
      const gate = await seedPriorCompletionReview(fixture);
      const selectedComment = await issueService(db).addComment(
        fixture.issueId,
        "Prepared exactly these files for this chat response.",
        { agentId: fixture.agentId, runId: fixture.runId },
        { authorizationReason: "paperclip_runner_protocol" },
      );
      const selected = [];
      for (const [originalFilename, contentType] of [
        ["original-cat.png", "image/png"],
        ["original-notes.txt", "text/plain"],
      ]) {
        selected.push(
          await issueService(db).createAttachment({
            issueId: fixture.issueId,
            issueCommentId: selectedComment.id,
            provider: "local_disk",
            objectKey: `issues/${fixture.issueId}/${originalFilename}`,
            contentType: contentType!,
            byteSize: 128,
            sha256: "a".repeat(64),
            originalFilename,
            createdByAgentId: fixture.agentId,
            createdByRunId: fixture.runId,
          }),
        );
      }
      expect(
        await db
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.issueId, fixture.issueId)),
      ).toEqual([]);
      const resultJson = await finishReviewResponse(fixture);
      expect(resultJson).toMatchObject({
        finalizationPhase: "committed",
        finalizationReasonCode: "governed_response_waiting",
        externalChatReviewPresentation: {
          runId: fixture.runId,
          gateId: gate.id,
          gateDecisionId: (gate.payload as { target: { revisionId: string } })
            .target.revisionId,
        },
      });
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          resultJson,
        }),
      ).toBe(true);
      expect(
        await resolveChatRunPresentationAuthorizationReason(db, fixture),
      ).toBe("allow_chat_run_presentation");
      const response = resolveHeartbeatRunResponse({
        resultJson,
        preferFinalResponseOverExistingComment: true,
        externalChatResponseWakeSummaryAuthorized: true,
        externalChatReviewResponseSummaryAuthorized: true,
      });
      expect(response.text).toBe(
        "The requested photo is prepared. I will wait for your next message.",
      );
      const first = await issueService(db).addComment(
        fixture.issueId,
        response.text!,
        { agentId: fixture.agentId, runId: fixture.runId },
        { authorizationReason: "allow_chat_run_presentation" },
      );
      const second = await issueService(db).addComment(
        fixture.issueId,
        response.text!,
        { agentId: fixture.agentId, runId: fixture.runId },
        { authorizationReason: "allow_chat_run_presentation" },
      );
      expect(second.id).toBe(first.id);
      const publications = await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.issueId, fixture.issueId));
      expect(publications).toHaveLength(3);
      expect(publications).toEqual(
        expect.arrayContaining(
          selected.map((attachment) =>
            expect.objectContaining({
              commentId: selectedComment.id,
              state: "pending",
              idempotencyKey: `attachment:${attachment.id}:${fixture.endpointId}`,
              payload: expect.objectContaining({
                attachmentIds: [attachment.id],
              }),
            }),
          ),
        ),
      );
      await expect(
        issueService(db).addComment(
          fixture.issueId,
          "Not the accepted summary",
          { agentId: fixture.agentId, runId: fixture.runId },
          { authorizationReason: "allow_chat_run_presentation" },
        ),
      ).rejects.toMatchObject({
        status: 409,
        details: { code: "chat_review_response_presentation_denied" },
      });
      expect(
        await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, gate.id)),
      ).toEqual([
        expect.objectContaining({ status: "pending", resolvedAt: null }),
      ]);
      expect(
        await db.select().from(issues).where(eq(issues.id, fixture.issueId)),
      ).toEqual([expect.objectContaining({ status: "in_review" })]);
      expect(
        await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, fixture.companyId)),
      ).toEqual([]);
    },
  );

  it.each([
    "approval",
    "agent_gate",
    "new_attention",
    "semantic_attention",
    "revoked_endpoint",
  ] as const)(
    "does not mint a review-presentation grant for %s",
    async (kind) => {
      const fixture = await seedWaitTurn(
        "telegram",
        kind === "semantic_attention"
          ? [
              {
                kind: "approval",
                summary: "Approve a separate action",
                ownerClass: "human",
              },
            ]
          : [],
      );
      const gate = await seedPriorCompletionReview(fixture);
      if (kind === "approval") {
        const [approval] = await db
          .insert(approvals)
          .values({
            companyId: fixture.companyId,
            type: "hire_agent",
            status: "pending",
            payload: {},
          })
          .returning();
        await db.insert(issueApprovals).values({
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          approvalId: approval!.id,
        });
      } else if (kind === "agent_gate") {
        await db
          .update(issueThreadInteractions)
          .set({ createdByAgentId: fixture.agentId })
          .where(eq(issueThreadInteractions.id, gate.id));
      } else if (kind === "new_attention") {
        await db.insert(issueThreadInteractions).values({
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          kind: "request_confirmation",
          status: "pending",
          sourceRunId: fixture.runId,
          createdByAgentId: fixture.agentId,
          title: "Current confirmation",
          payload: gate.payload,
        });
      } else if (kind === "revoked_endpoint") {
        await db
          .update(chatEndpoints)
          .set({ status: "paused" })
          .where(eq(chatEndpoints.id, fixture.endpointId));
      }
      const resultJson = await finishReviewResponse(fixture);
      expect(resultJson.externalChatReviewPresentation).toBeNull();
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          resultJson,
        }),
      ).toBe(false);
      expect(
        await resolveChatRunPresentationAuthorizationReason(db, fixture),
      ).toBe("internal_agent_write");
      expect(
        await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, gate.id)),
      ).toEqual([expect.objectContaining({ status: "pending" })]);
    },
  );

  it.each(["next_run", "concurrent_other_issue"] as const)(
    "keeps a committed successful response authorized after runtime failure in %s",
    async (failureScope) => {
      const fixture = await seedWaitTurn("discord");
      const gate = await seedPriorCompletionReview(fixture);
      const resultJson = await finishReviewResponse(fixture);
      const laterIssueId =
        failureScope === "next_run" ? fixture.issueId : randomUUID();
      const laterRunId = randomUUID();
      if (laterIssueId !== fixture.issueId) {
        await db
          .insert(issues)
          .values({
            id: laterIssueId,
            companyId: fixture.companyId,
            title: "Concurrent task",
            status: "in_progress",
            assigneeAgentId: fixture.agentId,
          });
      }
      await db
        .insert(heartbeatRuns)
        .values({
          id: laterRunId,
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          runtimeMode: "native",
          nativeIssueId: laterIssueId,
          status: "running",
          startedAt: new Date(),
        });
      await db
        .update(issues)
        .set({ executionRunId: laterRunId })
        .where(eq(issues.id, laterIssueId));
      const failRun = async (tx: typeof db) => {
        await tx
          .update(heartbeatRuns)
          .set({
            status: "failed",
            errorCode: "adapter_failed",
            finishedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, laterRunId));
        await tx
          .update(issues)
          .set({ executionRunId: null })
          .where(eq(issues.id, laterIssueId));
        // This is finalizeAgentStatus's failed-last-running-run projection,
        // not a user pause, termination, or permission change.
        await tx
          .update(agents)
          .set({ status: "error", errorReason: "Later runner startup failed" })
          .where(eq(agents.id, fixture.agentId));
      };
      if (failureScope === "concurrent_other_issue") {
        let ready!: () => void;
        let release!: () => void;
        const observed = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const holder = db.transaction(async (tx) => {
          await failRun(tx as unknown as typeof db);
          ready();
          await released;
        });
        await observed;
        try {
          const attempt = await db
            .transaction((tx) =>
              authorizeNativeChatReviewPresentation(
                tx as unknown as typeof db,
                { ...fixture, resultJson },
                "nonblocking",
              ),
            )
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
          expect(attempt).toHaveProperty("error");
          if ("error" in attempt)
            expect(
              isExternalChatWaitAuthorizationContention(attempt.error),
            ).toBe(true);
        } finally {
          release();
          await holder;
        }
      } else {
        await db.transaction((tx) => failRun(tx as unknown as typeof db));
      }
      expect(
        await db.transaction((tx) =>
          authorizeNativeChatReviewPresentation(
            tx as unknown as typeof db,
            { ...fixture, resultJson },
            "nonblocking",
          ),
        ),
      ).toBe(true);
      const summary = (resultJson.nativeResult as { summary: string }).summary;
      const append = () =>
        issueService(db).addComment(
          fixture.issueId,
          summary,
          { agentId: fixture.agentId, runId: fixture.runId },
          { authorizationReason: "allow_chat_run_presentation" },
        );
      const first = await append();
      expect((await append()).id).toBe(first.id);
      expect(
        await db
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.commentId, first.id)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, gate.id)),
      ).toEqual([gate]);
      expect(
        await db
          .select({ status: agents.status })
          .from(agents)
          .where(eq(agents.id, fixture.agentId)),
      ).toEqual([{ status: "error" }]);
      expect(
        await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, laterRunId)),
      ).toEqual([{ status: "failed" }]);
      expect(
        await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, fixture.companyId)),
      ).toEqual([]);
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          runId: laterRunId,
          issueId: laterIssueId,
          resultJson,
        }),
      ).toBe(false);
      await db
        .update(companyMemberships)
        .set({ status: "suspended" })
        .where(eq(companyMemberships.principalId, fixture.userId));
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          resultJson,
        }),
      ).toBe(false);
    },
  );

  it.each([
    "gate_changed",
    "gate_policy_changed",
    "failed_run",
    "status_changed",
    "revoked_endpoint",
    "revoked_principal",
    "agent_paused",
    "agent_budget_paused",
    "agent_terminated",
    "agent_pending_approval",
    "spoofed_marker",
    "changed_summary",
    "changed_context",
    "wrong_destination",
  ] as const)(
    "rejects a stale or forged committed response grant: %s",
    async (kind) => {
      const fixture = await seedWaitTurn();
      const gate = await seedPriorCompletionReview(fixture);
      const resultJson = await finishReviewResponse(fixture);
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          resultJson,
        }),
      ).toBe(true);
      if (kind === "gate_changed")
        await db
          .update(issueThreadInteractions)
          .set({ status: "accepted" })
          .where(eq(issueThreadInteractions.id, gate.id));
      if (kind === "status_changed")
        await db
          .update(issues)
          .set({ status: "cancelled" })
          .where(eq(issues.id, fixture.issueId));
      if (kind === "gate_policy_changed")
        await db
          .update(issueThreadInteractions)
          .set({ effectiveResolverPolicy: "anyone" })
          .where(eq(issueThreadInteractions.id, gate.id));
      if (kind === "failed_run")
        await db
          .update(heartbeatRuns)
          .set({ status: "failed" })
          .where(eq(heartbeatRuns.id, fixture.runId));
      if (kind === "revoked_endpoint")
        await db
          .update(chatEndpoints)
          .set({ status: "paused" })
          .where(eq(chatEndpoints.id, fixture.endpointId));
      if (kind === "revoked_principal")
        await db
          .update(companyMemberships)
          .set({ status: "suspended" })
          .where(eq(companyMemberships.principalId, fixture.userId));
      if (
        [
          "agent_paused",
          "agent_budget_paused",
          "agent_terminated",
          "agent_pending_approval",
        ].includes(kind)
      )
        await db
          .update(agents)
          .set({
            status:
              kind === "agent_terminated"
                ? "terminated"
                : kind === "agent_pending_approval"
                  ? "pending_approval"
                  : "paused",
            pauseReason:
              kind === "agent_budget_paused"
                ? "budget"
                : kind === "agent_paused"
                  ? "manual"
                  : null,
          })
          .where(eq(agents.id, fixture.agentId));
      if (kind === "spoofed_marker")
        resultJson.externalChatReviewPresentation = {
          ...(resultJson.externalChatReviewPresentation as object),
          gateId: randomUUID(),
        };
      if (kind === "changed_summary")
        resultJson.nativeResult = {
          ...(resultJson.nativeResult as object),
          summary: "Unapproved replacement prose",
        };
      if (kind === "changed_context")
        await db
          .update(heartbeatRuns)
          .set({ contextSnapshot: { source: "chat:github" } })
          .where(eq(heartbeatRuns.id, fixture.runId));
      expect(
        await authorizeNativeChatReviewPresentation(db, {
          ...fixture,
          resultJson,
          ...(kind === "wrong_destination"
            ? {
                destination: {
                  endpointId: fixture.endpointId,
                  conversationId: randomUUID(),
                },
              }
            : {}),
        }),
      ).toBe(false);
      if (
        [
          "gate_changed",
          "gate_policy_changed",
          "failed_run",
          "status_changed",
          "revoked_endpoint",
          "revoked_principal",
          "agent_paused",
          "agent_budget_paused",
          "agent_terminated",
          "agent_pending_approval",
          "changed_context",
        ].includes(kind)
      ) {
        await expect(
          issueService(db).addComment(
            fixture.issueId,
            "Must remain private",
            { agentId: fixture.agentId, runId: fixture.runId },
            { authorizationReason: "allow_chat_run_presentation" },
          ),
        ).rejects.toMatchObject({
          status: 409,
          details: { code: "chat_review_response_presentation_denied" },
        });
      }
    },
  );

  it("retries a contended review-response comment outside issue and governance locks", async () => {
    const fixture = await seedWaitTurn();
    await seedPriorCompletionReview(fixture);
    const resultJson = await finishReviewResponse(fixture);
    let release!: () => void;
    let locked!: () => void;
    const lockObserved = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = db.transaction(async (tx) => {
      await tx
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, fixture.endpointId))
        .for("update");
      locked();
      await lockRelease;
    });
    await lockObserved;
    let observeBackoff!: () => void;
    let releaseBackoff!: () => void;
    const backoffObserved = new Promise<void>((resolve) => {
      observeBackoff = resolve;
    });
    const backoffRelease = new Promise<void>((resolve) => {
      releaseBackoff = resolve;
    });
    const originalRetry =
      nativeChatReviewPresentation.retryNativeChatReviewPresentation;
    const retry = vi
      .spyOn(nativeChatReviewPresentation, "retryNativeChatReviewPresentation")
      .mockImplementation((attempt) =>
        originalRetry(async () => {
          try {
            return await attempt();
          } catch (error) {
            if (isExternalChatWaitAuthorizationContention(error)) {
              // Observe the actual rollback/backoff boundary, not a wall-clock
              // instant that may land inside a subsequent short transaction.
              observeBackoff();
              await backoffRelease;
            }
            throw error;
          }
        }),
      );
    let finished = false;
    const append = issueService(db)
      .addComment(
        fixture.issueId,
        (resultJson.nativeResult as { summary: string }).summary,
        { agentId: fixture.agentId, runId: fixture.runId },
        { authorizationReason: "allow_chat_run_presentation" },
      )
      .finally(() => {
        finished = true;
      });
    const appendOutcome = append.then(
      (comment) => ({ comment }),
      (error: unknown) => ({ error }),
    );
    try {
      await backoffObserved;
      expect(finished).toBe(false);
      await db.transaction(async (tx) => {
        await tx
          .select()
          .from(issues)
          .where(eq(issues.id, fixture.issueId))
          .for("update", { noWait: true });
        await tx
          .select()
          .from(nativeRunFinalizations)
          .where(eq(nativeRunFinalizations.runId, fixture.runId))
          .for("update", { noWait: true });
        await tx
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.issueId, fixture.issueId))
          .for("update", { noWait: true });
      });
    } finally {
      release();
      releaseBackoff();
      await Promise.allSettled([holding, appendOutcome]);
      retry.mockRestore();
    }
    const outcome = await appendOutcome;
    if ("error" in outcome) throw outcome.error;
    const { comment } = outcome;
    expect(
      await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.commentId, comment.id)),
    ).toHaveLength(1);
  });

  it("keeps earlier queued response files authorized after another wait retains the same review", async () => {
    const fixture = await seedWaitTurn();
    await seedPriorCompletionReview(fixture);
    const resultJson = await finishReviewResponse(fixture);
    const [current] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    const [accepted] = await db
      .select()
      .from(nativeRunResults)
      .where(eq(nativeRunResults.runId, fixture.runId));
    const runId = randomUUID();
    const sessionId = randomUUID();
    const runnerInstanceId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      runtimeMode: "native",
      nativeIssueId: fixture.issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      status: "running",
      completionContractId: current!.completionContractId,
      completionContractSha256: current!.completionContractSha256,
      contextSnapshot: current!.contextSnapshot,
      resultJson: { nativeResult: accepted!.resultJson.result },
      startedAt: new Date(),
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, fixture.issueId));
    const port = new PaperclipControlPlanePort(db, {
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      agentId: fixture.agentId,
      runId,
      sessionId,
      completionContractId: current!.completionContractId!,
      completionContractSha256: current!.completionContractSha256!,
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: `later-control-${runId}`,
    });
    await port.openRun({
      identity: {
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        agentId: fixture.agentId,
        runId,
        sessionId,
      },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    await port.completeRun({
      result: accepted!.resultJson.result as PrpStructuredRunResult,
      terminal: accepted!.resultJson.terminal as PrpTerminalState,
    });
    const laterResult = await finishReviewResponse({ ...fixture, runId });
    expect(laterResult.externalChatReviewPresentation).toBeTruthy();
    expect(
      await authorizeNativeChatReviewPresentation(
        db,
        {
          ...fixture,
          resultJson,
          destination: {
            endpointId: fixture.endpointId,
            conversationId: fixture.conversationId,
          },
        },
        "read",
      ),
    ).toBe(true);
    const [firstComment] = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.createdByRunId, fixture.runId),
          eq(issueComments.authorType, "agent"),
        ),
      );
    await db
      .delete(chatPublications)
      .where(eq(chatPublications.commentId, firstComment!.id));
    await db
      .delete(issueComments)
      .where(eq(issueComments.id, firstComment!.id));
    await db
      .update(heartbeatRuns)
      .set({ resultJson: { keepUnrelatedMetadata: "yes" } })
      .where(eq(heartbeatRuns.id, fixture.runId));
    await reconcileNativeFinalizations(db, [fixture.runId]);
    await reconcileNativeFinalizations(db, [fixture.runId]);
    const [repaired] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    expect(repaired!.resultJson).toMatchObject({
      keepUnrelatedMetadata: "yes",
      externalChatReviewPresentation: resultJson.externalChatReviewPresentation,
    });
    const comments = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.createdByRunId, fixture.runId),
          eq(issueComments.authorType, "agent"),
        ),
      );
    expect(comments).toHaveLength(1);
    expect(
      await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.commentId, comments[0]!.id)),
    ).toHaveLength(1);
    expect(
      await hasMaterializedNativeReviewResponse(db, {
        ...fixture,
        decisionId: String(resultJson.decisionId),
      }),
    ).toBe(true);
    expect(
      await hasMaterializedNativeReviewResponse(db, {
        ...fixture,
        decisionId: randomUUID(),
      }),
    ).toBe(false);
    const updatedAt = repaired!.updatedAt;
    await db
      .update(issueComments)
      .set({ deletedAt: new Date() })
      .where(eq(issueComments.id, comments[0]!.id));
    await reconcileNativeFinalizations(db, [fixture.runId]);
    const [unchanged] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    expect(unchanged!.updatedAt).toEqual(updatedAt);
    expect(
      await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.createdByRunId, fixture.runId)),
    ).toEqual([
      expect.objectContaining({
        id: comments[0]!.id,
        deletedAt: expect.any(Date),
      }),
    ]);
  });

  it.each(["running", "succeeded", "gate_changed", "ownership_held"] as const)(
    "repairs the committed presentation crash boundary exactly once: %s",
    async (state) => {
      const fixture = await seedWaitTurn();
      const gate = await seedPriorCompletionReview(fixture);
      const selectedComment = await issueService(db).addComment(
        fixture.issueId,
        "Prepared the original file",
        { agentId: fixture.agentId, runId: fixture.runId },
        { authorizationReason: "paperclip_runner_protocol" },
      );
      const attachment = await issueService(db).createAttachment({
        issueId: fixture.issueId,
        issueCommentId: selectedComment.id,
        provider: "local_disk",
        objectKey: `issues/${fixture.issueId}/original.txt`,
        contentType: "text/plain",
        byteSize: 128,
        sha256: "b".repeat(64),
        originalFilename: "original.txt",
        createdByAgentId: fixture.agentId,
        createdByRunId: fixture.runId,
      });
      // Live finalization commits the grant while heartbeat still owns terminal
      // status/presentation. Simulate its process dying before those later steps.
      await finalizeNativeRun({
        db,
        runId: fixture.runId,
        workspaceFinalizeStatus: "succeeded",
        projectRunStatus: false,
      });
      const [committed] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, fixture.runId));
      expect(
        committed!.resultJson?.externalChatReviewPresentation,
      ).toBeTruthy();
      const marker = committed!.resultJson!.externalChatReviewPresentation;
      await db
        .update(heartbeatRuns)
        .set({
          status:
            state === "succeeded" || state === "gate_changed"
              ? "succeeded"
              : "running",
          resultJson: { keepUnrelatedMetadata: "yes" },
          ...(state === "ownership_held"
            ? {
                nativePhase: "terminal_failure",
                errorCode: "native_execution_ownership_unverified",
              }
            : {}),
        })
        .where(eq(heartbeatRuns.id, fixture.runId));
      if (state === "gate_changed")
        await db
          .update(issueThreadInteractions)
          .set({ status: "accepted" })
          .where(eq(issueThreadInteractions.id, gate.id));
      const presentationSignals: Array<Record<string, unknown>> = [];
      const visibilityChecks: Array<Promise<Array<{ runId: string | null }>>> = [];
      const unsubscribe = subscribeAllCompanyLiveEvents((event) => {
        if (
          event.companyId !== fixture.companyId ||
          event.type !== "heartbeat.run.event" ||
          event.payload.runId !== fixture.runId ||
          event.payload.eventType !== "run.presentation.resolved"
        ) return;
        presentationSignals.push(event.payload);
        visibilityChecks.push(
          db
            .select({ runId: issueComments.createdByRunId })
            .from(issueComments)
            .where(and(
              eq(issueComments.createdByRunId, fixture.runId),
              eq(issueComments.authorType, "agent"),
              ne(issueComments.id, selectedComment.id),
            )),
        );
      });
      try {
        await finalizeNativeRun({
          db,
          runId: fixture.runId,
          workspaceFinalizeStatus: "succeeded",
          projectRunStatus: true,
        });
        await finalizeNativeRun({
          db,
          runId: fixture.runId,
          workspaceFinalizeStatus: "succeeded",
          projectRunStatus: true,
        });
      } finally {
        unsubscribe();
      }
      const [repaired] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, fixture.runId));
      expect(repaired!.resultJson?.keepUnrelatedMetadata).toBe("yes");
      if (state === "ownership_held") {
        expect(repaired).toMatchObject({
          status: "running",
          nativePhase: "terminal_failure",
          errorCode: "native_execution_ownership_unverified",
        });
      } else {
        expect(repaired!.resultJson?.externalChatReviewPresentation).toEqual(
          marker,
        );
        expect(repaired!.status).toBe("succeeded");
      }
      const publications = await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.issueId, fixture.issueId));
      if (state === "gate_changed" || state === "ownership_held")
        expect(publications).toEqual([]);
      else {
        expect(publications).toHaveLength(2);
        expect(publications).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              idempotencyKey: `attachment:${attachment.id}:${fixture.endpointId}`,
            }),
          ]),
        );
      }
      if (state === "gate_changed" || state === "ownership_held") {
        expect(presentationSignals).toEqual([]);
        expect(visibilityChecks).toEqual([]);
      } else {
        expect(presentationSignals).toEqual([{
          runId: fixture.runId,
          agentId: fixture.agentId,
          issueId: fixture.issueId,
          eventType: "run.presentation.resolved",
        }]);
        await expect(Promise.all(visibilityChecks)).resolves.toEqual([
          [{ runId: fixture.runId }],
        ]);
      }
      expect(
        await db
          .select()
          .from(statusDecisions)
          .where(eq(statusDecisions.issueId, fixture.issueId)),
      ).toHaveLength(2);
      expect(
        await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.issueId, fixture.issueId)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, fixture.companyId)),
      ).toEqual([]);
    },
  );

  it("does not overwrite an ownership hold racing the committed replay projection", async () => {
    const fixture = await seedWaitTurn();
    await seedPriorCompletionReview(fixture);
    await finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: false,
    });
    // Arrange the retained execution lock explicitly: the earlier review
    // status projection is allowed to have released the normal run lock.
    await db
      .update(issues)
      .set({ executionRunId: fixture.runId })
      .where(eq(issues.id, fixture.issueId));
    let locked!: () => void;
    let release!: () => void;
    const lockObserved = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, fixture.runId))
        .for("update");
      locked();
      await lockRelease;
      await tx
        .update(heartbeatRuns)
        .set({
          status: "running",
          nativePhase: "terminal_failure",
          errorCode: "native_execution_ownership_unverified",
        })
        .where(eq(heartbeatRuns.id, fixture.runId));
    });
    await lockObserved;
    const replay = finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    try {
      await vi.waitFor(
        async () => {
          let coordinatorOwned = false;
          try {
            await db.transaction((tx) =>
              tx
                .select()
                .from(nativeRunFinalizations)
                .where(eq(nativeRunFinalizations.runId, fixture.runId))
                .for("update", { noWait: true }),
            );
          } catch (error) {
            coordinatorOwned = isExternalChatWaitAuthorizationContention(error);
          }
          expect(coordinatorOwned).toBe(true);
        },
        { interval: 5, timeout: 1_000 },
      );
    } finally {
      release();
      await holder;
    }
    await replay;
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({
      status: "running",
      nativePhase: "terminal_failure",
      errorCode: "native_execution_ownership_unverified",
    });
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.issueId));
    expect(issue!.executionRunId).toBe(fixture.runId);
    expect(
      await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.issueId, fixture.issueId)),
    ).toEqual([]);
  });

  it("keeps presentation authority when heartbeat appends only adapter runtime-service display metadata", async () => {
    const fixture = await seedWaitTurn();
    await seedPriorCompletionReview(fixture);
    const resultJson = await finishReviewResponse(fixture);
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    const context = {
      ...run!.contextSnapshot,
      paperclipRuntimeServices: [
        { name: "preview", url: "http://127.0.0.1:9000" },
      ],
      paperclipRuntimePrimaryUrl: "http://127.0.0.1:9000",
    };
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: context })
      .where(eq(heartbeatRuns.id, fixture.runId));
    expect(
      await authorizeNativeChatReviewPresentation(db, {
        ...fixture,
        resultJson,
      }),
    ).toBe(true);
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { ...context, wakeCommentIds: [randomUUID()] } })
      .where(eq(heartbeatRuns.id, fixture.runId));
    expect(
      await authorizeNativeChatReviewPresentation(db, {
        ...fixture,
        resultJson,
      }),
    ).toBe(false);
  });

  it("does not rewrite an already-materialized latest response during real reconciliation", async () => {
    const fixture = await seedWaitTurn();
    await seedPriorCompletionReview(fixture);
    await finishReviewResponse(fixture);
    await db
      .insert(workspaceOperations)
      .values({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        heartbeatRunId: fixture.runId,
        phase: "workspace_finalize",
        status: "succeeded",
        finishedAt: new Date(),
      });
    const [before] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    await reconcileNativeFinalizations(db, [fixture.runId]);
    await reconcileNativeFinalizations(db, [fixture.runId]);
    const [after] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    expect(after!.updatedAt).toEqual(before!.updatedAt);
    expect(after!.resultJson).toEqual(before!.resultJson);
    expect(
      await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.issueId, fixture.issueId)),
    ).toHaveLength(1);
  });

  it.each([
    ["Slack fresh setup", "slack", 1],
    ["GitHub fresh setup", "github", 1],
    ["Discord fresh setup", "discord", 1],
    ["Teams fresh setup", "microsoft-teams", 1],
    ["Telegram fresh setup", "telegram", 1],
    ["GitHub reconnect setup", "github", 8],
  ])(
    "authorizes an exact response wait during the current %s test window",
    async (_label, provider, generation) => {
      const fixture = await seedWaitTurn(
        provider as Parameters<typeof seedWaitTurn>[0],
      );
      if (provider === "github") {
        // Only upgraded GitHub bots keep the selected final internal. Legacy
        // connection fixtures retain their automatic presentation behavior.
        await db.insert(chatGitHubConfigurations).values({
          companyId: fixture.companyId,
          endpointId: fixture.endpointId,
          configuration: {
            version: 1,
            toolsEnabled: true,
            responsibleUserId: fixture.userId,
            memberAccess: "all_linked",
            people: [],
            defaults: defaultGitHubReviewPolicy(),
            repositories: {},
          },
          updatedByUserId: fixture.userId,
        });
      }
      await placeWaitTurnInSetupTest(fixture, { generation });

      await expect(
        resolveExternalChatResponseWaitAuthorization({
          db,
          binding: fixture,
        }),
      ).resolves.toBe("authorized");
      await finalizeNativeRun({
        db,
        runId: fixture.runId,
        workspaceFinalizeStatus: "succeeded",
        projectRunStatus: true,
      });
      await expect(
        db
          .select()
          .from(statusDecisions)
          .where(eq(statusDecisions.issueId, fixture.issueId)),
      ).resolves.toEqual([
        expect.objectContaining({
          reasonCode: "external_chat_response_waiting",
          decisionJson: expect.objectContaining({ effects: [] }),
        }),
      ]);
      const [finalizedRun] = await db
        .select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, fixture.runId));
      const authorizationReason = provider === "github"
        ? "internal_agent_write" : "allow_chat_run_presentation";
      await expect(
        resolveChatRunPresentationAuthorizationReason(db, fixture),
      ).resolves.toBe(authorizationReason);
      const response = resolveHeartbeatRunResponse({
        resultJson: finalizedRun!.resultJson,
        preferFinalResponseOverExistingComment: true,
        externalChatResponseWakeSummaryAuthorized: true,
      });
      expect(response).toEqual(
        expect.objectContaining({
          text: "The requested photo is prepared. I will wait for your next message.",
          decision: expect.objectContaining({ commentAction: "create" }),
        }),
      );
      const comment = await issueService(db).addComment(
        fixture.issueId,
        response.text!,
        { agentId: fixture.agentId, runId: fixture.runId },
        { authorizationReason },
      );
      await expect(
        db
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.commentId, comment.id)),
      ).resolves.toEqual(provider === "github" ? [] : [
        expect.objectContaining({
          conversationId: fixture.conversationId,
          endpointId: fixture.endpointId,
          state: "pending",
        }),
      ]);
    },
  );

  it("rejects stale or revoked setup-test provenance without weakening active policy", async () => {
    type Fixture = Awaited<ReturnType<typeof seedWaitTurn>>;
    type Times = Awaited<ReturnType<typeof placeWaitTurnInSetupTest>>;
    const expectRevoked = async (
      label: string,
      mutate: (fixture: Fixture, times: Times) => Promise<void>,
    ) => {
      const fixture = await seedWaitTurn("github");
      const times = await placeWaitTurnInSetupTest(fixture, { generation: 4 });
      await mutate(fixture, times);
      await expect(
        resolveExternalChatResponseWaitAuthorization({
          db,
          binding: fixture,
        }),
        label,
      ).resolves.toBe("revoked");
    };

    await expectRevoked("received before the current test", async (fixture, times) => {
      await db
        .update(chatDeliveries)
        .set({ receivedAt: new Date(times.testStartedAt.getTime() - 1) })
        .where(eq(chatDeliveries.id, fixture.deliveryId));
    });
    await expectRevoked("processed before the current test", async (fixture, times) => {
      await db
        .update(chatDeliveries)
        .set({ processedAt: new Date(times.testStartedAt.getTime() - 1) })
        .where(eq(chatDeliveries.id, fixture.deliveryId));
    });
    await expectRevoked("prior runtime generation", async (fixture) => {
      await db
        .update(chatDeliveries)
        .set({
          normalizedEvent: {
            runtimeContext: {
              generation: 3,
              credentialFingerprint: "a".repeat(64),
            },
          },
        })
        .where(eq(chatDeliveries.id, fixture.deliveryId));
    });
    await expectRevoked("malformed runtime generation", async (fixture) => {
      await db.execute(sql`
        update chat_endpoints
        set setup = jsonb_set(setup, '{runtimeGeneration}', '"4"'::jsonb)
        where id = ${fixture.endpointId}
      `);
    });
    await expectRevoked("invalid runtime fingerprint", async (fixture) => {
      await db
        .update(chatDeliveries)
        .set({
          normalizedEvent: {
            runtimeContext: {
              generation: 4,
              credentialFingerprint: "not-a-runtime-fingerprint",
            },
          },
        })
        .where(eq(chatDeliveries.id, fixture.deliveryId));
    });
    await expectRevoked("missing runtime fence", async (fixture) => {
      await db
        .update(chatDeliveries)
        .set({ normalizedEvent: {} })
        .where(eq(chatDeliveries.id, fixture.deliveryId));
    });
    await expectRevoked("invalid test timestamp", async (fixture) => {
      await db
        .update(chatEndpoints)
        .set({
          setup: {
            step: "test",
            testStartedAt: "not-a-timestamp",
            runtimeGeneration: 4,
          } as (typeof chatEndpoints.$inferSelect)["setup"] & {
            runtimeGeneration: number;
          },
        })
        .where(eq(chatEndpoints.id, fixture.endpointId));
    });
    await expectRevoked("wrong setup step", async (fixture, times) => {
      await db
        .update(chatEndpoints)
        .set({
          setup: {
            step: "provider_setup",
            testStartedAt: times.testStartedAt.toISOString(),
            runtimeGeneration: 4,
          } as (typeof chatEndpoints.$inferSelect)["setup"] & {
            runtimeGeneration: number;
          },
        })
        .where(eq(chatEndpoints.id, fixture.endpointId));
    });
    for (const status of ["paused", "revoked"] as const) {
      await expectRevoked(`${status} endpoint`, async (fixture) => {
        await db
          .update(chatEndpoints)
          .set({ status })
          .where(eq(chatEndpoints.id, fixture.endpointId));
      });
    }
    await expectRevoked("expired principal link", async (fixture) => {
      await db
        .update(chatIdentityLinks)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(chatIdentityLinks.principalId, fixture.principalId));
    });
    await expectRevoked("disabled current resource", async (fixture) => {
      await db
        .update(chatEndpointResources)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(chatEndpointResources.id, fixture.resourceId));
    });
  });

  it("loses setup-test response authority when reconnect rotates the window before commit", async () => {
    const fixture = await seedWaitTurn("github");
    await placeWaitTurnInSetupTest(fixture, { generation: 4 });
    let releaseEndpoint!: () => void;
    let endpointLocked!: () => void;
    const endpointRelease = new Promise<void>((resolve) => {
      releaseEndpoint = resolve;
    });
    const endpointLockObserved = new Promise<void>((resolve) => {
      endpointLocked = resolve;
    });
    const endpointHolder = db.transaction(async (tx) => {
      await tx
        .select({ id: chatEndpoints.id })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, fixture.endpointId))
        .for("update");
      await tx
        .update(chatEndpoints)
        .set({
          setup: {
            step: "test",
            testStartedAt: new Date().toISOString(),
            runtimeGeneration: 5,
          } as (typeof chatEndpoints.$inferSelect)["setup"] & {
            runtimeGeneration: number;
          },
          updatedAt: new Date(),
        })
        .where(eq(chatEndpoints.id, fixture.endpointId));
      endpointLocked();
      await endpointRelease;
    });
    await endpointLockObserved;
    const finalization = finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    const joined = Promise.allSettled([endpointHolder, finalization]);
    let waitError: unknown = null;
    try {
      await vi.waitFor(
        async () => {
          const [coordinator] = await db
            .select({ phase: nativeRunFinalizations.phase })
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, fixture.runId));
          expect(coordinator?.phase).toBe("arbitrating");
        },
        { timeout: 1_000, interval: 5 },
      );
    } catch (error) {
      waitError = error;
    } finally {
      releaseEndpoint();
    }
    const [holderOutcome, finalizationOutcome] = await joined;
    if (waitError) throw waitError;
    if (holderOutcome.status === "rejected") throw holderOutcome.reason;
    if (finalizationOutcome.status === "rejected") {
      throw finalizationOutcome.reason;
    }

    await expect(
      db
        .select()
        .from(statusDecisions)
        .where(eq(statusDecisions.issueId, fixture.issueId)),
    ).resolves.toEqual([
      expect.objectContaining({
        reasonCode: "external_chat_response_wait_authorization_lost",
        decisionJson: expect.objectContaining({ effects: [] }),
      }),
    ]);
  });

  it("retains setup-test response authority when the endpoint activates before commit", async () => {
    const fixture = await seedWaitTurn("github");
    await placeWaitTurnInSetupTest(fixture, { generation: 4 });
    let releaseEndpoint!: () => void;
    let endpointLocked!: () => void;
    const endpointRelease = new Promise<void>((resolve) => {
      releaseEndpoint = resolve;
    });
    const endpointLockObserved = new Promise<void>((resolve) => {
      endpointLocked = resolve;
    });
    const endpointHolder = db.transaction(async (tx) => {
      await tx
        .select({ id: chatEndpoints.id })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, fixture.endpointId))
        .for("update");
      await tx
        .update(chatEndpoints)
        .set({
          status: "active",
          setup: { step: "complete", testStartedAt: null },
          updatedAt: new Date(),
        })
        .where(eq(chatEndpoints.id, fixture.endpointId));
      endpointLocked();
      await endpointRelease;
    });
    await endpointLockObserved;
    const finalization = finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    const joined = Promise.allSettled([endpointHolder, finalization]);
    let waitError: unknown = null;
    try {
      await vi.waitFor(
        async () => {
          const [coordinator] = await db
            .select({ phase: nativeRunFinalizations.phase })
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, fixture.runId));
          expect(coordinator?.phase).toBe("arbitrating");
        },
        { timeout: 1_000, interval: 5 },
      );
    } catch (error) {
      waitError = error;
    } finally {
      releaseEndpoint();
    }
    const [holderOutcome, finalizationOutcome] = await joined;
    if (waitError) throw waitError;
    if (holderOutcome.status === "rejected") throw holderOutcome.reason;
    if (finalizationOutcome.status === "rejected") {
      throw finalizationOutcome.reason;
    }

    await expect(
      db
        .select()
        .from(statusDecisions)
        .where(eq(statusDecisions.issueId, fixture.issueId)),
    ).resolves.toEqual([
      expect.objectContaining({
        reasonCode: "external_chat_response_waiting",
        decisionJson: expect.objectContaining({ effects: [] }),
      }),
    ]);
  });

  it("parks a verified external-chat response wait without scheduling work", async () => {
    const fixture = await seedWaitTurn();
    await finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });

    await expect(
      db.select().from(issues).where(eq(issues.id, fixture.issueId)),
    ).resolves.toEqual([
      expect.objectContaining({ status: "in_progress", statusVersion: 1 }),
    ]);
    await expect(
      db
        .select()
        .from(statusDecisions)
        .where(eq(statusDecisions.issueId, fixture.issueId)),
    ).resolves.toEqual([
      expect.objectContaining({
        toStatus: "in_progress",
        reasonCode: "external_chat_response_waiting",
        decisionJson: expect.objectContaining({ effects: [] }),
      }),
    ]);
    await expect(
      db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, fixture.companyId),
            eq(agentWakeupRequests.agentId, fixture.agentId),
          ),
        ),
    ).resolves.toEqual([]);
    await expect(
      db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.id, fixture.conversationId)),
    ).resolves.toEqual([
      expect.objectContaining({
        issueId: fixture.issueId,
        sessionGeneration: 1,
        state: "active",
      }),
    ]);
  });

  it.each([
    [3, "yielded", "in_review", "response_wake", false],
    [5, "yielded", "in_review", "response_wake", false],
    [5, "done", "done", null, false],
    [3, "yielded", "in_review", "monitor", false],
    [3, "yielded", "in_review", "response_wake", true],
    [3, "yielded", "in_review", "response_wake", false, "tree_resume"],
    [3, "yielded", "in_review", "response_wake", false, "continued_review"],
    [3, "yielded", "in_review", "monitor", false, "continued_review"],
    [3, "yielded", "in_progress", "response_wake", false, "new_head"],
  ] as const)("settles a published %s/5 review reporting %s in %s with %s, separate approval: %s, resume: %s", async (score, disposition, status, continuationKind, separateApproval, resumeMode?: "tree_resume" | "continued_review" | "new_head") => {
    const resumed = resumeMode !== undefined;
    const savedPublication = resumeMode === "continued_review" || resumeMode === "new_head";
    const unreviewedHead = resumeMode === "new_head";
    const fixture = await seedWaitTurn("github", [], {
      reportedWorkDisposition: disposition,
      summary: disposition === "done" ? "Review is 5/5 and required checks passed." : "Review published; waiting for the next PR update.",
      ...(disposition === "done" ? { continuation: undefined } : {}),
      ...(continuationKind === "monitor" ? { continuation: { kind: "monitor", summary: "Wait for the saved check.", idempotencyKey: "review-monitor" } } : {}),
    });
    await db.update(issues).set({ title: "Review the pull request", originKind: "chat_channel",
      createdByUserId: fixture.userId, responsibleUserId: fixture.userId }).where(eq(issues.id, fixture.issueId));
    const oldRequest = score === 3 && !resumed ? await seedPriorCompletionReview(fixture) : null;
    if (continuationKind === "monitor") {
      await new PaperclipRunnerToolAuthority(db, fixture).execute({ tool: "set_task_monitor", callId: randomUUID(),
        arguments: { idempotencyKey: "review-monitor", monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString(), notes: "Check PR status." } } });
    }
    const [review] = await db.insert(chatGitHubReviews).values({
      companyId: fixture.companyId, endpointId: fixture.endpointId, issueId: fixture.issueId,
      runId: fixture.runId, repositoryId: "1", repository: "paperclip/test-repository", pullNumber: 1,
      headSha: "a".repeat(40), deliveryId: fixture.deliveryId, configurationRevision: 1,
      policySnapshot: defaultGitHubReviewPolicy(), event: {
        event: "opened", deliveryId: fixture.deliveryId, repositoryId: "1", repository: "paperclip/test-repository",
        pullNumber: 1, title: "Review the pull request", body: "", baseSha: "b".repeat(40), headSha: "a".repeat(40),
        baseBranch: "master", author: { id: "1", login: "author", isBot: false }, sender: { id: "1", login: "author" },
        draft: false, labels: [],
      },
      state: "completed", assessment: { complete: true, score, reviewedCommit: "a".repeat(40),
        summary: "Review published", rationale: "Review complete", findings: [],
        coverage: { reviewedPaths: [], omittedPaths: [], limitations: [] },
      },
      checkId: "123",
    }).returning();
    await expect(hasPublishedGitHubReview(db, fixture)).resolves.toBe(false);
    // A completed but unpublished head must not hide another published head from this run.
    const [published] = await db.insert(chatGitHubReviews).values({ ...review!, id: randomUUID(), deliveryId: randomUUID(), headSha: "c".repeat(40), assessment: { ...review!.assessment!, reviewedCommit: "c".repeat(40) }, createdAt: new Date(Date.now() + 10) }).returning();
    await db.insert(chatActions).values({
      companyId: fixture.companyId, endpointId: fixture.endpointId, kind: "github_review_publication",
      providerActionId: `github_publication:${fixture.issueId}:assessment:${createHash("sha256").update(JSON.stringify(published!.id)).digest("hex")}`,
      status: "processed", payload: { operation: "assessment", reviewId: published!.id },
      result: { reviewId: published!.id, checkUrl: "https://github.com/paperclip/test-repository/runs/123" },
    });
    if (oldRequest) {
      const [older] = await db.insert(chatGitHubReviews).values({
        ...review!, id: randomUUID(), runId: oldRequest.sourceRunId, deliveryId: randomUUID(),
      }).returning();
      await db.insert(chatActions).values({ companyId: fixture.companyId, endpointId: fixture.endpointId,
        kind: "github_review_publication", status: "processed",
        providerActionId: `github_publication:${fixture.issueId}:assessment:${createHash("sha256").update(JSON.stringify(older!.id)).digest("hex")}`,
      });
    }
    let inheritedOriginalRunId: string | null = null;
    if (resumed) {
      await db.update(chatEndpointResources).set({ metadata: { providerRepositoryId: "1" } }).where(eq(chatEndpointResources.id, fixture.resourceId));
      await db.update(chatConversations).set({ externalThreadId: "github:paperclip/test-repository:1" }).where(eq(chatConversations.id, fixture.conversationId));
      // A tree resume inherits its requester through the accepted identity
      // ledger, while its immediate wake correctly has no chat envelope.
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      const originalRunId = randomUUID();
      inheritedOriginalRunId = originalRunId;
      await db.insert(heartbeatRuns).values({ ...run!, id: originalRunId, activeIdentityContextId: null, status: "succeeded", finishedAt: new Date() });
      const [origin] = await db.insert(runIdentityContexts).values({
        companyId: fixture.companyId, runId: originalRunId, revision: 1,
        messageId: fixture.commentId, responsibleUserId: fixture.userId,
        cause: "chat_message", correlationId: "dispatch", status: "accepted",
      }).returning();
      const [continuation] = await db.insert(runIdentityContexts).values({
        companyId: fixture.companyId, runId: fixture.runId, revision: 1,
        parentContextId: origin!.id, responsibleUserId: fixture.userId,
        cause: "issue_tree_resumed", correlationId: "dispatch", status: "accepted",
      }).returning();
      await db.update(heartbeatRuns).set({ activeIdentityContextId: continuation!.id,
        responsibleUserId: fixture.userId, contextSnapshot: {
          source: "issue.tree_resume", wakeReason: "issue_tree_resumed",
          issueId: fixture.issueId, paperclipHarnessCheckedOut: true,
          paperclipWake: { checkedOutByHarness: true, issue: { id: fixture.issueId }, commentIds: [] },
        },
      }).where(eq(heartbeatRuns.id, fixture.runId));
    }
    await expect(hasPublishedGitHubReview(db, fixture)).resolves.toBe(true);
    await expect(hasPublishedGitHubReview(db, { ...fixture, runId: randomUUID() })).resolves.toBe(false);
    if (resumed) {
      const [inheritedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      await expect(readInheritedGitHubReviewWait(db, inheritedRun!)).resolves.toMatchObject({ kind: "published" });
      await expect(resolveExternalChatResponseWaitAuthorization({ db, binding: fixture })).resolves.toBe("authorized");
      for (const binding of [
        { ...fixture, companyId: randomUUID() }, { ...fixture, issueId: randomUUID() },
        { ...fixture, agentId: randomUUID() },
      ]) await expect(resolveExternalChatResponseWaitAuthorization({ db, binding })).resolves.not.toBe("authorized");
      await db.update(chatActions).set({ status: "pending" }).where(eq(chatActions.companyId, fixture.companyId));
      await expect(resolveExternalChatResponseWaitAuthorization({ db, binding: fixture })).resolves.not.toBe("authorized");
      await db.update(chatActions).set({ status: "processed" }).where(eq(chatActions.companyId, fixture.companyId));
      await db.update(chatEndpointResources).set({ enabled: false }).where(eq(chatEndpointResources.endpointId, fixture.endpointId));
      await expect(resolveExternalChatResponseWaitAuthorization({ db, binding: fixture })).resolves.toBe("revoked");
      await db.update(chatEndpointResources).set({ enabled: true }).where(eq(chatEndpointResources.endpointId, fixture.endpointId));
      await db.update(heartbeatRuns).set({ responsibleUserId: "different-requester" }).where(eq(heartbeatRuns.id, fixture.runId));
      await expect(resolveExternalChatResponseWaitAuthorization({ db, binding: fixture })).resolves.not.toBe("authorized");
      await db.update(heartbeatRuns).set({ responsibleUserId: fixture.userId }).where(eq(heartbeatRuns.id, fixture.runId));
      await db.update(chatConversations).set({ externalThreadId: "github:paperclip/other-repository:1" }).where(eq(chatConversations.id, fixture.conversationId));
      await expect(resolveExternalChatResponseWaitAuthorization({ db, binding: fixture })).resolves.not.toBe("authorized");
      await db.update(chatConversations).set({ externalThreadId: "github:paperclip/test-repository:1" }).where(eq(chatConversations.id, fixture.conversationId));
      await db.update(chatEndpointResources).set({ metadata: { providerRepositoryId: "2" } }).where(eq(chatEndpointResources.id, fixture.resourceId));
      await expect(resolveExternalChatResponseWaitAuthorization({ db, binding: fixture })).resolves.not.toBe("authorized");
      await db.update(chatEndpointResources).set({ metadata: { providerRepositoryId: "1" } }).where(eq(chatEndpointResources.id, fixture.resourceId));
      const [newHead] = await db.insert(chatGitHubReviews).values({ ...review!, id: randomUUID(),
        deliveryId: randomUUID(), runId: null, headSha: "d".repeat(40), state: "queued", createdAt: new Date(Date.now() + 1000),
      }).returning();
      await expect(resolveExternalChatResponseWaitAuthorization({ db, binding: fixture })).resolves.not.toBe("authorized");
      await db.delete(chatGitHubReviews).where(eq(chatGitHubReviews.id, newHead!.id));
      if (savedPublication) {
        await db.update(chatGitHubReviews).set({ runId: inheritedOriginalRunId }).where(eq(chatGitHubReviews.issueId, fixture.issueId));
        await expect(hasPublishedGitHubReview(db, fixture)).resolves.toBe(false);
        await expect(resolveExternalChatResponseWaitAuthorization({ db, binding: fixture })).resolves.toBe("authorized");
      }
    }
    if (unreviewedHead) {
      await db.insert(chatGitHubReviews).values({ ...review!, id: randomUUID(), runId: null,
        deliveryId: randomUUID(), headSha: "e".repeat(40), state: "queued", createdAt: new Date(Date.now() + 1000),
      });
      await expect(resolveExternalChatResponseWaitAuthorization({ db, binding: fixture })).resolves.toBe("revoked");
    }
    const [stored] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, fixture.runId));
    await expect(nativeCompletionFeedback(db, fixture.runId, stored!.resultJson.result as PrpStructuredRunResult)).resolves.toContain("accepted");
    if (oldRequest) {
      const pending = async () => (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, oldRequest.id)))[0]!.status;
      expect(await pending()).toBe("pending");
      const reported = stored!.resultJson.result as PrpStructuredRunResult;
      await expect(nativeCompletionFeedback(db, fixture.runId, { ...reported,
        completionClaim: { ...reported.completionClaim, contractRevision: "stale" } })).rejects.toThrow("Stale completionClaim");
      expect(await pending()).toBe("pending");
      if (separateApproval) {
        const [approval] = await db.insert(approvals).values({ companyId: fixture.companyId, type: "hire_agent", status: "pending", payload: {} }).returning();
        await db.insert(issueApprovals).values({ companyId: fixture.companyId, issueId: fixture.issueId, approvalId: approval!.id });
        await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
        expect(await pending()).toBe("pending");
        expect((await issueService(db).list(fixture.companyId, { touchedByUserId: fixture.userId })).map(issue => issue.id)).toContain(fixture.issueId);
        return;
      }
      expect(await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true,
        failpoint: "status_projection" })).toMatchObject({ phase: "retryable_failure" });
      expect(await pending()).toBe("pending");
    }
    await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const all = await issueService(db).list(fixture.companyId);
    expect(all.find(issue => issue.id === fixture.issueId)).toMatchObject({ status,
      ...(status === "in_review" ? { reviewAttention: { state: "covered", paths: [expect.objectContaining({ kind: continuationKind === "monitor" ? "monitor" : "external_response" })] } } : {}),
    });
    expect(await issueService(db).list(fixture.companyId, { touchedByUserId: fixture.userId })).toEqual([]);
    expect(await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.issueId, fixture.issueId), eq(issueThreadInteractions.status, "pending"),
    ))).toEqual([]);
    if (oldRequest) expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, oldRequest.id)))
      .toEqual([expect.objectContaining({ status: "cancelled", result: expect.objectContaining({ outcome: "withdrawn" }) })]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toEqual([]);
    if (resumed) {
      await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toEqual([]);
      expect(await db.select().from(chatActions).where(and(eq(chatActions.companyId, fixture.companyId), eq(chatActions.kind, "github_review_publication")))).toHaveLength(1);
      if (unreviewedHead) {
        expect((await db.select().from(statusDecisions).where(eq(statusDecisions.runId, fixture.runId)))[0])
          .toMatchObject({ reasonCode: "external_chat_response_wait_authorization_lost" });
      }
    }
    if (status === "in_review" && continuationKind === "response_wake") {
      const attention = async () => (await issueService(db).listReviewAttention(fixture.companyId, [{ id: fixture.issueId, companyId: fixture.companyId, status }])).get(fixture.issueId)?.state;
      await db.update(chatEndpointResources).set({ enabled: false }).where(eq(chatEndpointResources.endpointId, fixture.endpointId));
      expect(await attention()).toBe("stalled");
      await db.update(chatEndpointResources).set({ enabled: true }).where(eq(chatEndpointResources.endpointId, fixture.endpointId));
      await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, fixture.companyId));
      expect(await attention()).toBe("stalled");
      await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.companyId, fixture.companyId));
      await db.update(chatEndpoints).set({ status: "revoked" }).where(eq(chatEndpoints.id, fixture.endpointId));
      expect((await issueService(db).listReviewAttention(fixture.companyId, [{
        id: fixture.issueId, companyId: fixture.companyId, status,
      }])).get(fixture.issueId)?.state).toBe("stalled");
    }
  });

  async function seedPublishedReviewCompletionTurn(contractOverride?: Parameters<typeof seedWaitTurn>[4]) {
    const fixture = await seedWaitTurn("github", [], {}, true, contractOverride);
    await db.update(chatEndpointResources).set({ metadata: { providerRepositoryId: "1" } })
      .where(eq(chatEndpointResources.id, fixture.resourceId));
    await db.update(chatConversations).set({ externalThreadId: "github:paperclip/test-repository:1" })
      .where(eq(chatConversations.id, fixture.conversationId));
    const [identity] = await db.insert(runIdentityContexts).values({ companyId: fixture.companyId,
      runId: fixture.runId, revision: 1, messageId: fixture.commentId, responsibleUserId: fixture.userId,
      cause: "chat_message", correlationId: "dispatch", status: "accepted" }).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: identity!.id, responsibleUserId: fixture.userId })
      .where(eq(heartbeatRuns.id, fixture.runId));
    const [review] = await db.insert(chatGitHubReviews).values({ companyId: fixture.companyId,
      endpointId: fixture.endpointId, issueId: fixture.issueId, runId: fixture.runId,
      repositoryId: "1", repository: "paperclip/test-repository", pullNumber: 1, headSha: "a".repeat(40),
      deliveryId: fixture.deliveryId, configurationRevision: 1, policySnapshot: defaultGitHubReviewPolicy(),
      event: { event: "opened", deliveryId: fixture.deliveryId, repositoryId: "1", repository: "paperclip/test-repository",
        pullNumber: 1, title: "Review", body: "", baseSha: "b".repeat(40), headSha: "a".repeat(40),
        baseBranch: "master", author: { id: "1", login: "author", isBot: false }, sender: { id: "1", login: "author" }, draft: false, labels: [] },
      state: "completed", assessment: { complete: true, score: 3, reviewedCommit: "a".repeat(40),
        summary: "Quantity is ignored", rationale: "Review complete", findings: [],
        coverage: { reviewedPaths: [], omittedPaths: [], limitations: [] } }, checkId: "123" }).returning();
    await db.insert(chatActions).values({ companyId: fixture.companyId, endpointId: fixture.endpointId,
      kind: "github_review_publication", status: "processed", payload: { operation: "assessment", reviewId: review!.id },
      providerActionId: `github_publication:${fixture.issueId}:assessment:${createHash("sha256").update(JSON.stringify(review!.id)).digest("hex")}` });
    return { ...fixture, review: review! };
  }

  it.each([false, true])("binds a low-score Retry wait to its accepted newer source after a predecessor failed before identity: %s", async acceptedSource => {
    const objective = "Review the current head. A lower score stays In review with a passive response wake; only a merged PR or 5/5 with passing checks is Done.";
    const fixture = await seedPublishedReviewCompletionTurn({ objective,
      criteria: [{ id: "response", requirement: objective }] });
    await db.update(chatGitHubReviews).set({ policySnapshot: { ...fixture.review.policySnapshot, ratingThreshold: 5 },
      assessment: { ...fixture.review.assessment!, score: 2 } }).where(eq(chatGitHubReviews.id, fixture.review.id));
    const previousRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: previousRunId, companyId: fixture.companyId, agentId: fixture.agentId,
      issueId: fixture.issueId, status: "failed", errorCode: "chat_failed_run_retry_not_authorized",
      finishedAt: new Date(), contextSnapshot: { issueId: fixture.issueId, source: "chat:github" } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    await db.update(heartbeatRuns).set({ activeIdentityContextId: null, retryOfRunId: previousRunId,
      contextSnapshot: { ...run!.contextSnapshot, retryOfRunId: previousRunId, wakeReason: "retry_failed_run" } })
      .where(eq(heartbeatRuns.id, fixture.runId));
    await db.delete(runIdentityContexts).where(eq(runIdentityContexts.id, run!.activeIdentityContextId!));
    await initializeRunIdentity(db, { companyId: fixture.companyId, issueId: fixture.issueId,
      runId: fixture.runId, responsibleUserId: fixture.userId, parentRunId: previousRunId,
      messageIds: acceptedSource ? [fixture.commentId] : [], cause: "retry_failed_run" });
    const authority = new PaperclipRunnerToolAuthority(db, fixture);
    const read = () => authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} });
    const { resolveCompletionContinuation } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/completion-continuation.ts", import.meta.url).href);
    const report = { ...fixture.result, continuation: undefined, completionClaim: {
      ...fixture.result.completionClaim, objectiveSatisfied: false,
      criteria: [{ criterionId: "response", status: "unknown" as const, evidenceRefs: [] }],
      remainingWork: [{ description: "Author must fix the quantity defect before this review can reach the passing score.", blocksCompletion: true }],
    } };
    if (!acceptedSource) {
      await expect(resolveCompletionContinuation(report, fixture.runId, read)).rejects.toThrow("no eligible saved monitor");
      expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0].status).not.toBe("done");
      return;
    }
    const resolved = await resolveCompletionContinuation(report, fixture.runId, read) as PrpStructuredRunResult;
    expect(resolved).toMatchObject({ reportedWorkDisposition: "yielded", continuation: { kind: "response_wake" } });
    await expect(nativeCompletionFeedback(db, fixture.runId, resolved)).resolves.toContain("accepted");
    await fixture.port.completeRun({ result: resolved, terminal: fixture.terminal, callerResultId: `retry-wait-${fixture.runId}` });
    await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]).toMatchObject({ status: "in_review" });
    expect((await db.select().from(statusDecisions).where(eq(statusDecisions.runId, fixture.runId)))[0])
      .toMatchObject({ reasonCode: "external_chat_response_waiting", toStatus: "in_review", decisionJson: { effects: [] } });
    await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toHaveLength(0);
    expect(await db.select().from(chatActions).where(and(eq(chatActions.companyId, fixture.companyId),
      eq(chatActions.kind, "github_review_publication")))).toHaveLength(1);
  });

  async function seedInheritedReviewCompletionTurn(resume: boolean) {
    const fixture = await seedPublishedReviewCompletionTurn();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    const predecessorId = randomUUID();
    await db.insert(heartbeatRuns).values({ ...run!, id: predecessorId, activeIdentityContextId: null,
      status: "succeeded", finishedAt: new Date() });
    await db.update(chatGitHubReviews).set({ runId: predecessorId }).where(eq(chatGitHubReviews.id, fixture.review.id));
    if (resume) {
      const [origin] = await db.insert(runIdentityContexts).values({ companyId: fixture.companyId,
        runId: predecessorId, revision: 1, messageId: fixture.commentId, responsibleUserId: fixture.userId,
        cause: "chat_message", correlationId: "dispatch", status: "accepted" }).returning();
      await db.update(runIdentityContexts).set({ messageId: null, parentContextId: origin!.id,
        cause: "issue_tree_resumed" }).where(eq(runIdentityContexts.id, run!.activeIdentityContextId!));
      await db.update(heartbeatRuns).set({ contextSnapshot: { source: "issue.tree_resume", wakeReason: "issue_tree_resumed",
        issueId: fixture.issueId, paperclipHarnessCheckedOut: true,
        paperclipWake: { checkedOutByHarness: true, issue: { id: fixture.issueId }, commentIds: [] } },
      }).where(eq(heartbeatRuns.id, fixture.runId));
    }
    return { ...fixture, predecessorId };
  }

  it.each([undefined, null, "malformed-first"] as const)("derives an omitted inherited GitHub review wait after normal tree resume: %s", async absent => {
    const fixture = await seedInheritedReviewCompletionTurn(true);
    const authority = new PaperclipRunnerToolAuthority(db, fixture);
    const read = () => authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} });
    const { resolveCompletionContinuation } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/completion-continuation.ts", import.meta.url).href);
    const report = { ...fixture.result, continuation: absent === "malformed-first" ? "response_wake" : absent };
    if (absent === "malformed-first") {
      expect(await resolveCompletionContinuation(report, fixture.runId, read)).toEqual(report);
      expect(validatePrpStructuredRunResult(report).ok).toBe(false);
      delete report.continuation;
    }
    const resolved = await resolveCompletionContinuation(report, fixture.runId, read) as PrpStructuredRunResult;
    expect(resolved).toMatchObject({ reportedWorkDisposition: "yielded", continuation: { kind: "response_wake" } });
    await expect(nativeCompletionFeedback(db, fixture.runId, resolved)).resolves.toContain("accepted");
    await fixture.port.completeRun({ result: resolved, terminal: fixture.terminal, callerResultId: `wait-result-${fixture.runId}` });
    await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]).toMatchObject({ status: "in_review" });
    expect((await db.select().from(statusDecisions).where(eq(statusDecisions.runId, fixture.runId)))[0])
      .toMatchObject({ reasonCode: "external_chat_response_waiting", decisionJson: { effects: [] } });
    await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toHaveLength(0);
    expect(await db.select().from(chatActions).where(and(eq(chatActions.companyId, fixture.companyId),
      eq(chatActions.kind, "github_review_publication")))).toHaveLength(1);
  });

  async function seedCurrentAuthorReply(fixture: Awaited<ReturnType<typeof seedInheritedReviewCompletionTurn>>) {
    const [reply] = await db.insert(chatActions).values({ companyId: fixture.companyId,
      endpointId: fixture.endpointId, conversationId: fixture.conversationId, deliveryId: fixture.deliveryId,
      kind: "github_review_publication", status: "processed", providerActionId: `github_publication:${fixture.issueId}:comment:${randomUUID()}`,
      payload: { operation: "comment", session: { companyId: fixture.companyId, issueId: fixture.issueId,
        runId: fixture.runId, agentId: fixture.agentId }, body: "Quantity is ignored by the current total calculation." },
      result: { id: "123", url: "https://github.com/paperclip/test-repository/pull/1#issuecomment-123" },
    }).returning();
    return reply!;
  }

  it.each([undefined, null] as const)("derives an omitted inherited review wait only after this author reply is delivered: %s", async continuation => {
    const fixture = await seedInheritedReviewCompletionTurn(false);
    await seedCurrentAuthorReply(fixture);
    const authority = new PaperclipRunnerToolAuthority(db, fixture);
    const { resolveCompletionContinuation } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/completion-continuation.ts", import.meta.url).href);
    const resolved = await resolveCompletionContinuation({ ...fixture.result, continuation }, fixture.runId,
      () => authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} })) as PrpStructuredRunResult;
    expect(resolved).toMatchObject({ continuation: { kind: "response_wake" } });
    await expect(nativeCompletionFeedback(db, fixture.runId, resolved)).resolves.toContain("accepted");
    await fixture.port.completeRun({ result: resolved, terminal: fixture.terminal, callerResultId: `wait-result-${fixture.runId}` });
    await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]).toMatchObject({ status: "in_review" });
    expect((await db.select().from(statusDecisions).where(eq(statusDecisions.runId, fixture.runId)))[0])
      .toMatchObject({ reasonCode: "external_chat_response_waiting", decisionJson: { effects: [] } });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toHaveLength(0);
  });

  it.each(["missing_parent", "wrong_cause", "principal_revoked", "new_head", "pending_publication"] as const)(
    "does not derive an inherited tree resume wait after %s", async gate => {
      const fixture = await seedInheritedReviewCompletionTurn(true);
      if (gate === "missing_parent" || gate === "wrong_cause") await db.update(runIdentityContexts)
        .set(gate === "missing_parent" ? { parentContextId: null } : { cause: "chat_message" })
        .where(eq(runIdentityContexts.runId, fixture.runId));
      if (gate === "principal_revoked") await db.update(companyMemberships).set({ status: "suspended" })
        .where(eq(companyMemberships.companyId, fixture.companyId));
      if (gate === "new_head") await db.insert(chatGitHubReviews).values({ ...fixture.review, id: randomUUID(),
        runId: null, deliveryId: randomUUID(), headSha: "c".repeat(40), state: "queued", assessment: null,
        createdAt: new Date(Date.now() + 1000) });
      if (gate === "pending_publication") await db.update(chatActions).set({ status: "received" })
        .where(eq(chatActions.companyId, fixture.companyId));
      const context = new PaperclipRunnerToolAuthority(db, fixture)
        .execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} });
      if (gate === "principal_revoked") await expect(context).rejects.toThrow("task is no longer available");
      else expect(await context).toMatchObject({ completionContinuation: null });
    });

  it.each(["missing", "pending", "unknown", "mixed_unknown", "mixed_missing_assessment", "other_run", "other_source", "ack_only", "partial_assessment", "new_head", "revoked"] as const)(
    "does not derive an inherited author reply wait after %s", async gate => {
      const fixture = await seedInheritedReviewCompletionTurn(false);
      const reply = await seedCurrentAuthorReply(fixture);
      if (gate === "missing") await db.delete(chatActions).where(eq(chatActions.id, reply.id));
      if (gate === "pending" || gate === "unknown") await db.update(chatActions)
        .set({ status: gate === "pending" ? "received" : "failed", result: { deliveryUnknown: true } })
        .where(eq(chatActions.id, reply.id));
      if (gate === "mixed_unknown") await db.insert(chatActions).values({ ...reply, id: randomUUID(),
        providerActionId: `github_publication:${randomUUID()}`, status: "failed", result: { deliveryUnknown: true } });
      if (gate === "mixed_missing_assessment") await db.insert(chatActions).values({ ...reply, id: randomUUID(),
        providerActionId: `github_publication:${randomUUID()}`, payload: { ...reply.payload,
          operation: "assessment", reviewId: fixture.review.id }, result: { published: 1, total: 2 } });
      if (gate === "other_run") await db.update(chatActions).set({ payload: { ...reply.payload,
        session: { companyId: fixture.companyId, issueId: fixture.issueId, runId: fixture.predecessorId, agentId: fixture.agentId } } })
        .where(eq(chatActions.id, reply.id));
      if (gate === "other_source") {
        const [source] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, fixture.deliveryId));
        const [other] = await db.insert(chatDeliveries).values({ ...source!, id: randomUUID(), providerEventId: randomUUID(), deduplicationKey: randomUUID() }).returning();
        await db.update(chatActions).set({ deliveryId: other!.id }).where(eq(chatActions.id, reply.id));
      }
      if (gate === "partial_assessment") {
        const [partial] = await db.insert(chatGitHubReviews).values({ ...fixture.review, id: randomUUID(),
          runId: fixture.runId, deliveryId: randomUUID(), createdAt: new Date(Date.now() - 86_400_000), publicationReceipts: {
            partial: { id: "123", url: "https://github.com/paperclip/test-repository/pull/1#issuecomment-123", digest: "partial" },
          } }).returning();
        await db.update(chatActions).set({ status: "failed", payload: { ...reply.payload,
          operation: "assessment", reviewId: partial!.id }, result: { code: "publication_failed" } })
          .where(eq(chatActions.id, reply.id));
      }
      if (gate === "ack_only") await db.update(chatActions).set({ kind: "github_response_comment" })
        .where(eq(chatActions.id, reply.id));
      if (gate === "new_head") await db.insert(chatGitHubReviews).values({ ...fixture.review, id: randomUUID(),
        runId: null, deliveryId: randomUUID(), headSha: "c".repeat(40), state: "queued", assessment: null,
        createdAt: new Date(Date.now() + 1000) });
      if (gate === "revoked") await db.update(toolConnections).set({ enabled: false })
        .where(eq(toolConnections.companyId, fixture.companyId));
      const context = await new PaperclipRunnerToolAuthority(db, fixture)
        .execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} });
      expect(context).toMatchObject({ completionContinuation: null });
    });

  it.each(["current", "resume", "reply"] as const)("projects only bound authority while deriving a published GitHub completion wait: %s", async turn => {
    const fixture = turn === "current" ? await seedPublishedReviewCompletionTurn() : await seedInheritedReviewCompletionTurn(turn === "resume");
    const reply = turn === "reply" ? await seedCurrentAuthorReply(fixture as Awaited<ReturnType<typeof seedInheritedReviewCompletionTurn>>) : null;
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    const payload = "unused-saved-review-rendering".repeat(32768);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { retained: payload }, stdoutExcerpt: payload, stderrExcerpt: payload,
      contextSnapshot: { ...run.contextSnapshot, executionContinuation: { savedInput: payload },
        paperclipTaskMarkdown: payload, paperclipWake: { ...(run.contextSnapshot!.paperclipWake as object), retainedPayload: payload } },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    if (reply) await db.update(chatActions).set({ result: { ...reply.result, savedProviderOutput: payload } }).where(eq(chatActions.id, reply.id));
    const observed = createDb(temporary?.connectionString ?? externalTestDatabaseUrl!);
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(observed, { heartbeatRuns, chatActions }, capture);
    try {
      const context = await new PaperclipRunnerToolAuthority(observed, fixture)
        .execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} });
      expect(context).toMatchObject({ completionContinuation: { kind: "response_wake" } });
      capture.flush();
      const reads = events.filter(event => event.table === "heartbeat_runs" && event.operation === "select");
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.reduce((bytes, event) => bytes + Number(event.responseValueBytes), 0)).toBeLessThan(16 * 1024);
      const actionReads = events.filter(event => event.table === "chat_actions" && event.operation === "select");
      expect(actionReads.reduce((bytes, event) => bytes + Number(event.responseValueBytes), 0)).toBeLessThan(16 * 1024);
      expect(JSON.stringify(context)).not.toContain(payload);
    } finally { capture.flush(); await observed.$client.end(); }
  });

  it.each([undefined, null, "malformed-first"] as const)("derives an omitted published GitHub review wait through current task context: %s", async absent => {
    const fixture = await seedPublishedReviewCompletionTurn();
    const authority = new PaperclipRunnerToolAuthority(db, fixture);
    const read = () => authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} });
    const { resolveCompletionContinuation } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/completion-continuation.ts", import.meta.url).href);
    const report = { ...fixture.result, continuation: absent === "malformed-first" ? "response_wake" : absent };
    if (absent === "malformed-first") {
      // Explicit malformed input remains invalid; the next omitted report can
      // recover from authoritative state without changing its disposition.
      expect(await resolveCompletionContinuation(report, fixture.runId, read)).toEqual(report);
      expect(validatePrpStructuredRunResult(report).ok).toBe(false);
      delete report.continuation;
    }
    const resolved = await resolveCompletionContinuation(report, fixture.runId, read) as PrpStructuredRunResult;
    expect(resolved).toMatchObject({ reportedWorkDisposition: "yielded", continuation: { kind: "response_wake" } });
    await expect(nativeCompletionFeedback(db, fixture.runId, resolved)).resolves.toContain("accepted");
    await fixture.port.completeRun({ result: resolved, terminal: fixture.terminal, callerResultId: `wait-result-${fixture.runId}` });
    await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]).toMatchObject({ status: "in_review" });
    expect((await db.select().from(statusDecisions).where(eq(statusDecisions.runId, fixture.runId)))[0])
      .toMatchObject({ reasonCode: "external_chat_response_waiting", decisionJson: { effects: [] } });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toHaveLength(0);
  });

  it.each(["missing_publication", "pending_publication", "unknown_publication", "new_head", "other_run", "review_mismatch", "principal_revoked", "connection_revoked", "endpoint_revoked", "ownership_changed"] as const)(
    "does not derive a published GitHub completion wait after %s", async gate => {
      const fixture = await seedPublishedReviewCompletionTurn();
      if (gate === "missing_publication") await db.delete(chatActions).where(eq(chatActions.companyId, fixture.companyId));
      if (gate === "pending_publication" || gate === "unknown_publication") await db.update(chatActions)
        .set({ status: gate === "pending_publication" ? "received" : "failed", result: { deliveryUnknown: true } })
        .where(eq(chatActions.companyId, fixture.companyId));
      if (gate === "new_head") await db.insert(chatGitHubReviews).values({ ...fixture.review, id: randomUUID(),
        runId: null, deliveryId: randomUUID(), headSha: "c".repeat(40), state: "queued", assessment: null,
        createdAt: new Date(Date.now() + 1000) });
      if (gate === "other_run") {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
        const previousId = randomUUID();
        await db.insert(heartbeatRuns).values({ ...run!, id: previousId, activeIdentityContextId: null,
          status: "succeeded", finishedAt: new Date() });
        await db.update(chatGitHubReviews).set({ runId: previousId }).where(eq(chatGitHubReviews.id, fixture.review.id));
      }
      if (gate === "review_mismatch") await db.update(chatGitHubReviews).set({ assessment: {
        ...fixture.review.assessment!, reviewedCommit: "f".repeat(40),
      } }).where(eq(chatGitHubReviews.id, fixture.review.id));
      if (gate === "principal_revoked") await db.update(companyMemberships).set({ status: "suspended" })
        .where(eq(companyMemberships.companyId, fixture.companyId));
      if (gate === "connection_revoked") await db.update(toolConnections).set({ enabled: false })
        .where(eq(toolConnections.companyId, fixture.companyId));
      if (gate === "endpoint_revoked") await db.update(chatEndpoints).set({ status: "revoked" })
        .where(eq(chatEndpoints.id, fixture.endpointId));
      if (gate === "ownership_changed") await db.update(issues).set({ executionRunId: null })
        .where(eq(issues.id, fixture.issueId));
      const authority = new PaperclipRunnerToolAuthority(db, fixture);
      const { resolveCompletionContinuation } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/completion-continuation.ts", import.meta.url).href);
      await expect(resolveCompletionContinuation({ ...fixture.result, continuation: undefined }, fixture.runId,
        () => authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} }))).rejects.toThrow();
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toHaveLength(0);
    },
  );

  it("serializes an actual connection disable against the final status committer proof", async () => {
    const fixture = await seedPublishedReviewCompletionTurn();
    const authority = new PaperclipRunnerToolAuthority(db, fixture);
    const { resolveCompletionContinuation } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/completion-continuation.ts", import.meta.url).href);
    const result = await resolveCompletionContinuation({ ...fixture.result, continuation: null }, fixture.runId,
      () => authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} })) as PrpStructuredRunResult;
    await nativeCompletionFeedback(db, fixture.runId, result);
    await fixture.port.completeRun({ result, terminal: fixture.terminal, callerResultId: `wait-result-${fixture.runId}` });
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.companyId, fixture.companyId));
    const applicationName = `review-wait-race-${fixture.runId}`;
    const writerDb = createDb(externalTestDatabaseUrl ?? temporary!.connectionString, { applicationName });
    let writer: Promise<unknown> | undefined;
    let writerFinished = false, serialized = false;
    const readProof = publishedReviewAuthority.readInheritedGitHubReviewWait;
    const readForCommit = chatWaitAuthority.readPublishedGitHubReviewCompletionContinuationInTransaction;
    const commitGuard = vi.spyOn(chatWaitAuthority, "readPublishedGitHubReviewCompletionContinuationInTransaction")
      .mockImplementationOnce(async (...args) => {
        const [committer] = await args[0].execute(sql`select pg_backend_pid() as pid`);
        const proofGuard = vi.spyOn(publishedReviewAuthority, "readInheritedGitHubReviewWait")
          .mockImplementationOnce(async (...proofArgs) => {
            const proof = await readProof(...proofArgs);
            // This is the same maintained writer used by PATCH tool-connections.
            // It does not borrow the task's issue lock to disable a chat connection.
            writer = toolAccessService(writerDb).updateConnection(connection!.id, { enabled: false })
              .finally(() => { writerFinished = true; });
            await vi.waitFor(async () => {
              const waiting = await db.execute(sql`select query from pg_stat_activity
                where application_name = ${applicationName} and wait_event_type = 'Lock'`);
              expect(writerFinished || waiting.length > 0).toBe(true);
              if (waiting.length) expect(String(waiting[0]!.query)).toContain('update "tool_connections"');
              serialized = !writerFinished && waiting.length > 0;
              if (serialized) {
                const blockers = await db.execute(sql`select pg_blocking_pids(pid) as blockers from pg_stat_activity where application_name = ${applicationName} and wait_event_type = 'Lock'`);
                expect(blockers[0]!.blockers).toContain(Number(committer!.pid));
              }
            });
            return proof;
          });
        try { return await readForCommit(...args); }
        finally { proofGuard.mockRestore(); }
      });
    try {
      await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      await writer;
      expect(serialized).toBe(true);
      expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]).toMatchObject({ status: "in_review" });
      expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connection!.id)))[0]).toMatchObject({ enabled: false });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toHaveLength(0);
    } finally { commitGuard.mockRestore(); await Promise.allSettled(writer ? [writer] : []); await writerDb.$client.end({ timeout: 1 }); }
  });

  it.each((["current", "resume", "reply"] as const).flatMap(turn =>
    (["before_feedback", "before_finalization", "during_commit"] as const).map(phase => ({ turn, phase }))))(
    "rechecks a projected GitHub completion wait $turn $phase", async ({ turn, phase }) => {
      const fixture = turn === "current" ? await seedPublishedReviewCompletionTurn() : await seedInheritedReviewCompletionTurn(turn === "resume");
      const reply = turn === "reply" ? await seedCurrentAuthorReply(fixture as Awaited<ReturnType<typeof seedInheritedReviewCompletionTurn>>) : null;
      const authority = new PaperclipRunnerToolAuthority(db, fixture);
      const { resolveCompletionContinuation } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/completion-continuation.ts", import.meta.url).href);
      const result = await resolveCompletionContinuation({ ...fixture.result, continuation: null }, fixture.runId,
        () => authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} })) as PrpStructuredRunResult;
      const revoke = () => reply
        ? db.update(chatActions).set({ status: "failed", result: { deliveryUnknown: true } }).where(eq(chatActions.id, reply.id))
        : turn === "resume" ? db.update(chatActions).set({ status: "received" }).where(eq(chatActions.companyId, fixture.companyId))
        : db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.companyId, fixture.companyId));
      if (phase === "before_feedback") {
        await revoke();
        await expect(nativeCompletionFeedback(db, fixture.runId, result)).rejects.toThrow("no longer authorized");
        return;
      }
      await nativeCompletionFeedback(db, fixture.runId, result);
      await fixture.port.completeRun({ result, terminal: fixture.terminal, callerResultId: `wait-result-${fixture.runId}` });
      let guard: ReturnType<typeof vi.spyOn> | undefined;
      if (phase === "before_finalization") await revoke();
      if (phase === "during_commit") {
        const read = chatWaitAuthority.readPublishedGitHubReviewCompletionContinuationInTransaction;
        guard = vi.spyOn(chatWaitAuthority, "readPublishedGitHubReviewCompletionContinuationInTransaction")
          .mockImplementation(async (...args) => {
            if (reply) await args[0].update(chatActions).set({ status: "failed", result: { deliveryUnknown: true } }).where(eq(chatActions.id, reply.id));
            else if (turn === "resume") await args[0].update(chatActions).set({ status: "received" }).where(eq(chatActions.companyId, fixture.companyId));
            else await args[0].update(toolConnections).set({ enabled: false }).where(eq(toolConnections.companyId, fixture.companyId));
            return read(...args);
          });
      }
      try {
        const finalized = await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
        expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]).toMatchObject({ status: "in_progress" });
        const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, fixture.runId));
        if (phase === "during_commit") {
          expect(finalized).toMatchObject({ phase: "retryable_failure" });
          expect(decisions).toHaveLength(0);
        } else expect(decisions.at(-1)).toMatchObject({ reasonCode: "external_chat_response_wait_authorization_lost" });
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toHaveLength(0);
      } finally { guard?.mockRestore(); }
    },
  );

  it("admits a real repository-access request to Mine until it is resolved", async () => {
    const fixture = await seedWaitTurn("github", [{ kind: "approval", ownerClass: "human", summary: "Grant repository access so I can read the diff." }], {
      reportedWorkDisposition: "needs_review", continuation: undefined,
    });
    await db.update(issues).set({ responsibleUserId: fixture.userId }).where(eq(issues.id, fixture.issueId));
    await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect((await issueService(db).list(fixture.companyId, { touchedByUserId: fixture.userId })).map(issue => issue.id)).toContain(fixture.issueId);
    const [request] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, fixture.issueId));
    expect(request).toMatchObject({ status: "pending", addresseeUserId: fixture.userId });
    await issueThreadInteractionService(db).withdrawInteraction(
      { id: fixture.issueId, companyId: fixture.companyId }, request!.id,
      { reason: "Repository access restored." }, { userId: fixture.userId },
    );
    expect(await issueService(db).list(fixture.companyId, { touchedByUserId: fixture.userId })).toEqual([]);
  });

  it("does not schedule a fallback run when current chat permission is revoked", async () => {
    const fixture = await seedWaitTurn();
    await db
      .update(companyMemberships)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(eq(companyMemberships.principalId, fixture.userId));
    await finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });

    await expect(
      db
        .select()
        .from(statusDecisions)
        .where(eq(statusDecisions.issueId, fixture.issueId)),
    ).resolves.toEqual([
      expect.objectContaining({
        reasonCode: "external_chat_response_wait_authorization_lost",
        decisionJson: expect.objectContaining({ effects: [] }),
      }),
    ]);
    await expect(
      db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, fixture.companyId),
            eq(agentWakeupRequests.agentId, fixture.agentId),
          ),
        ),
    ).resolves.toEqual([]);
  });

  it("retries a contended endpoint proof without deadlocking or scheduling work", async () => {
    const fixture = await seedWaitTurn();
    let releaseEndpoint!: () => void;
    let endpointLocked!: () => void;
    const endpointRelease = new Promise<void>((resolve) => {
      releaseEndpoint = resolve;
    });
    const endpointLockObserved = new Promise<void>((resolve) => {
      endpointLocked = resolve;
    });
    const endpointHolder = db.transaction(async (tx) => {
      await tx
        .select({ id: chatEndpoints.id })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, fixture.endpointId))
        .for("update");
      endpointLocked();
      await endpointRelease;
    });
    await endpointLockObserved;

    const finalization = finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    let contentionAssertionError: unknown = null;
    try {
      let firstArbitrationUpdatedAt = 0;
      await vi.waitFor(
        async () => {
          const [coordinator] = await db
            .select({
              assessmentId: nativeRunFinalizations.assessmentId,
              phase: nativeRunFinalizations.phase,
              updatedAt: nativeRunFinalizations.updatedAt,
            })
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, fixture.runId));
          expect(coordinator).toEqual(
            expect.objectContaining({
              assessmentId: expect.any(String),
              phase: "arbitrating",
            }),
          );
          firstArbitrationUpdatedAt = coordinator!.updatedAt.getTime();
        },
        { timeout: 1_000, interval: 5 },
      );
      await vi.waitFor(
        async () => {
          const [coordinator] = await db
            .select({ updatedAt: nativeRunFinalizations.updatedAt })
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, fixture.runId));
          expect(coordinator!.updatedAt.getTime()).toBeGreaterThan(
            firstArbitrationUpdatedAt,
          );
        },
        { timeout: 1_000, interval: 5 },
      );
    } catch (error) {
      contentionAssertionError = error;
    } finally {
      releaseEndpoint();
    }
    await endpointHolder;
    if (contentionAssertionError) throw contentionAssertionError;
    await finalization;

    await expect(
      db
        .select()
        .from(statusDecisions)
        .where(eq(statusDecisions.issueId, fixture.issueId)),
    ).resolves.toEqual([
      expect.objectContaining({
        reasonCode: "external_chat_response_waiting",
        decisionJson: expect.objectContaining({ effects: [] }),
      }),
    ]);
    await expect(
      db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, fixture.companyId),
            eq(agentWakeupRequests.agentId, fixture.agentId),
          ),
        ),
    ).resolves.toEqual([]);
  });
});
