import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  approvals,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  companies,
  companyMemberships,
  completionContracts,
  closeRegisteredClients,
  createDb,
  heartbeatRuns,
  issueComments,
  issueAttachments,
  issueApprovals,
  issueThreadInteractions,
  issueQuestionResponseDeliveries,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  toolApplications,
  toolConnections,
  workspaceOperations,
} from "@paperclipai/db";
import type {
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../../vendor/paperclip-runner/index.js";

import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
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
import { questionResponseDeliveryValues } from "../question-response-delivery.js";
import { resolveExternalChatQuestionResponse } from "./external-chat-question-response.js";
import { materializeExternalChatQuestionResponseInput } from "./external-chat-question-response-input.js";
import * as nativeInteractionBridge from "./native-interaction-bridge.js";
import type { AskUserQuestionsInteraction } from "@paperclipai/shared";
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
    };
    const terminal: PrpTerminalState = {
      schema: "paperclip.prp.terminal.v1",
      turnTerminalState: "completed",
      runTerminalState: "succeeded",
      reportedWorkDisposition: "yielded",
      workAssessmentId: randomUUID(),
      statusDecisionId: randomUUID(),
    };
    await port.completeRun({
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
    responseKind: "button" | "form" = "button",
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
                selectionMode: "single" as const,
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
            answers: [{ questionId: "color", optionIds: ["cobalt"] }],
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
              optionId: "cobalt",
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

  async function seedGitHubBoardAnsweredTurn(withLink = true) {
    const fixture = await seedWaitTurn("github");
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
                selectionMode: "single",
                required: true,
                allowOther: false,
                options: [
                  { id: "cobalt", label: "Cobalt" },
                  { id: "amber", label: "Amber" },
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
        providerMessageId: "github-question",
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

  it.each([true, false])(
    "attests a native GitHub question answered in Board without inventing a provider action (link: %s)",
    async (withLink) => {
      const fixture = await seedGitHubBoardAnsweredTurn(withLink);
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
        externalChatProvider: "github",
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

  it.each([
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
  ] as const)(
    "rejects GitHub Board answer authority after %s",
    async (change) => {
      const fixture = await seedGitHubBoardAnsweredTurn();
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

  it.each(["generation", "identity", "membership", "reach"] as const)(
    "rechecks GitHub Board answer %s at publication after native completion",
    async (change) => {
      const fixture = await seedGitHubBoardAnsweredTurn();
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

  async function attestAnswer(
    fixture:
      | Awaited<ReturnType<typeof seedAnsweredChatTurn>>
      | Awaited<ReturnType<typeof seedGitHubBoardAnsweredTurn>>,
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
        | Awaited<ReturnType<typeof seedGitHubBoardAnsweredTurn>>;
      invoke: () => Promise<unknown>;
    }) => Promise<void>,
  ) {
    const fixture =
      provider === "github"
        ? await seedGitHubBoardAnsweredTurn()
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
          : await seedGitHubBoardAnsweredTurn();
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
      if (kind === "different_parent_issue")
        await db
          .update(heartbeatRuns)
          .set({ nativeIssueId: fixture.sourceRunId })
          .where(eq(heartbeatRuns.id, parent.runId));
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
      await expect(
        resolveChatRunPresentationAuthorizationReason(db, fixture),
      ).resolves.toBe("allow_chat_run_presentation");
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
        { authorizationReason: "allow_chat_run_presentation" },
      );
      await expect(
        db
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.commentId, comment.id)),
      ).resolves.toEqual([
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
