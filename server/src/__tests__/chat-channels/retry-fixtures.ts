// Shared retry and committed-response recovery fixture builders.
import { requestTaskRetry } from "../../services/task-retry.js";
import { withQueuedCommentIdsInWakePayload } from "../../services/issue-queued-comment-queue.js";
import { createSystemRecovery } from "../../services/system-recovery-state.js";
import { githubChatManagementService } from "../../services/chat-github-management.js";
import { githubResponseCommentService } from "../../services/chat-github-response-comments.js";
import { chatGitHubConfigurations } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, expect, vi } from "vitest";
import { agents, agentWakeupRequests, chatActions, chatDeliveries, chatEndpointResources, chatExternalPrincipals, chatMessageLinks, chatPublications, completionContracts, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunResults, nativeRunFinalizations, environmentLeases } from "@paperclipai/db";
import { type ChatProvider } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { type ChatChannelService } from "../../services/chat-channels.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { heartbeatService } from "../../services/heartbeat.js";
import { githubPublicAttachmentsFromMessage } from "../../services/chat-github-attachments.js";
import * as attachmentEgress from "../../services/remote-http-fetch.js";
import type { PrpStructuredRunResult, PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import { finalizeNativeRun, repairCommittedNativeChatResponse } from "../../services/native-runtime/native-run-finalizer.js";
import { NativeRunCoordinatorStore } from "../../services/native-runtime/native-run-coordinator-store.js";
import { PaperclipControlPlanePort } from "../../services/native-runtime/paperclip-control-plane-port.js";
import { type TestDb, makeThread, makeMessage, boardActor } from "./providers.js";
import type { ChatChannelHarness } from "./harness.js";
import type { GitHubHarness } from "./github-harness.js";

export function createRetryFixtures(h: ChatChannelHarness, gh: GitHubHarness) {
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const { seedCompany, readChatConversationsByEndpointId, readIssuesById, readChatPublicationsByEndpointId, readAgentWakeupRequestsById, createStorageService, chatWakeContext, configuredSlackEndpoint, configuredTeamsEndpoint, configuredTelegramEndpoint, configuredDiscordEndpoint, deliverMessage, linkLifecycleFixtureActor } = h;
  const { configuredGitHubEndpoint } = gh;

  type SharedEndpointProgress = {
    fixture: Awaited<ReturnType<typeof seedCompany>>;
    configured: Awaited<ReturnType<typeof configuredTelegramEndpoint>> | Awaited<ReturnType<typeof configuredSlackEndpoint>>;
    suffix: string;
  };

  async function failedChatRetryFixture(
    provider: "slack" | "telegram" | "github",
    externalActorId?: string,
    linkedOriginalActor = false,
    githubUnavailableFile = false,
    currentGitHubPr = false,
    shared?: SharedEndpointProgress,
  ) {
    // Keep the policy under which the source was admitted. Inserting an
    // upgraded GitHub policy after receipt correctly invalidates retry proof.
    const context = await safeNativeProgressFixture(
      provider,
      shared?.suffix ?? "91",
      "channel",
      externalActorId,
      linkedOriginalActor,
      githubUnavailableFile,
      false,
      currentGitHubPr,
      shared,
    );
    const [issue] = await readIssuesById(context.conversation.issueId);
    const [action] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.conversationId, context.conversation.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    const [receipt] = await readAgentWakeupRequestsById(action.id);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: context.fixture.companyId,
      agentId: context.fixture.assignedAgentId,
      status: "failed",
      errorCode: "adapter_failed",
      finishedAt: new Date(),
      wakeupRequestId: receipt.id,
      contextSnapshot: {
        issueId: issue.id,
        taskKey: issue.identifier,
        source: `chat:${provider}`,
        wakeCommentId: action.payload.commentId,
        wakeCommentIds: [action.payload.commentId],
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ status: "failed", runId })
      .where(eq(agentWakeupRequests.id, receipt.id));
    await db
      .update(issues)
      .set({
        description: "ORIGINAL task, not the failed request",
        status: "blocked",
        executionRunId: null,
      })
      .where(eq(issues.id, issue.id));
    return { ...context, issue, action, receipt, runId };
  }

  async function currentGitHubTaskRetryFixture(withPending = false, pendingCount = 1) {
    const f = await failedChatRetryFixture("github", "42", true);
    const companyId = f.fixture.companyId, issueId = f.issue.id;
    await githubResponseCommentService(db, f.providerFetch).tryAcknowledge(f.action.deliveryId!);
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId,
      nativePhase: "terminal_failure", runnerProfileJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: f.runId, phase: "terminal_failure" });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId: f.fixture.assignedAgentId, runId: f.runId,
      seq: 1, eventType: "native.local_process_stopped", payload: { processPid: 999999999, processGroupId: null } });
    let pending: typeof chatActions.$inferSelect | undefined;
    if (withPending) {
      for (let index = 0; index < pendingCount; index++) {
        await deliverMessage({ callbacks: f.runtime.configurations.get(f.endpoint.id)!.callbacks,
          endpointId: f.endpoint.id, provider: "github", thread: f.thread.thread,
          message: makeMessage({ id: String(990092 + index), text: `@maya continue saved follow-up ${index}`, userId: "42", mentioned: true }),
          trigger: "mention" });
        const [{ source }] = await db.select({ source: chatActions }).from(chatActions)
          .innerJoin(chatDeliveries, eq(chatDeliveries.id, chatActions.deliveryId)).where(and(
            eq(chatActions.conversationId, f.conversation.id), eq(chatActions.kind, "inbound_wakeup"),
            eq(chatDeliveries.providerEventId, `${f.thread.thread.id}:${990092 + index}`)));
        pending ??= source;
        await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution", runId: null })
          .where(eq(agentWakeupRequests.id, source.id));
        await githubResponseCommentService(db, f.providerFetch).tryAcknowledge(source.deliveryId!);
      }
    }
    const [originalDelivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, f.action.deliveryId!));

    await db.update(agents).set({ adapterType: "paperclip_runner", status: "running",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, f.fixture.assignedAgentId));
    await db.insert(heartbeatRuns).values({ companyId, agentId: f.fixture.assignedAgentId,
      status: "running", startedAt: new Date() });
    f.wakeup.mockImplementation(heartbeatService(db).wakeup);
    return { ...f, pending, originalDelivery };
  }

  async function busyChatRetryHttpFixture(withPending = false) {
    const f = await currentGitHubTaskRetryFixture(withPending);
    const originalPublications = await readChatPublicationsByEndpointId(f.endpoint.id);
    const { issueRoutes } = await import("../../routes/issues.js");
    const companyId = f.fixture.companyId, issueId = f.issue.id;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
    app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
    app.use(errorHandler);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let acquired = () => {};
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const holding = db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${companyId}:${f.action.principalId}`}, 0))`);
      acquired();
      await held;
    });
    await locked;
    f.wakeup.mockClear();
    return { ...f, app, companyId, issueId, originalPublications,
      releaseIdentity: async () => { release(); await holding; } };
  }

  async function successfulGitHubQueuedInputFixture() {
    const f = await currentGitHubTaskRetryFixture(true);
    const companyId = f.fixture.companyId, issueId = f.issue.id;
    const [saved] = await readAgentWakeupRequestsById(f.pending!.id);
    await db.update(agentWakeupRequests).set({ payload: withQueuedCommentIdsInWakePayload(saved.payload,
      [String(f.pending!.payload.commentId)]) }).where(eq(agentWakeupRequests.id, saved.id));
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null, nativePhase: "committed",
      completionContractId: contractId }).where(eq(heartbeatRuns.id, f.runId));
    const [result] = await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: f.runId,
      completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", canonicalSha256: resultId,
      resultJson: { terminal: { runTerminalState: "succeeded" }, summary: "Earlier review remains saved" } }).returning();
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, f.receipt.id));
    const input = { db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
      observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry };
    return { ...f, input, result };
  }

  async function deferredFailedRetryNoticeFixture(wakeOnDemand = true) {
    const context = await failedChatRetryFixture("telegram", undefined, true);
    const companyId = context.fixture.companyId, issueId = context.issue.id, leaseId = randomUUID();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId,
      nativePhase: "terminal_failure", runnerProfileJson: {},
      resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
        schema: "paperclip.workspace-restore-recovery.v1", runId: context.runId, leaseIds: [leaseId],
      } },
    }).where(eq(heartbeatRuns.id, context.runId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: context.runId, phase: "terminal_failure" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId,
      heartbeatRunId: context.runId, provider: "daytona", providerLeaseId: randomUUID(),
      status: "pending_cleanup", cleanupStatus: "failed", leasePolicy: "retain_on_failure",
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace", pendingCleanupInFlight: false },
    });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: "resolved", ownerType: "system",
      cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(),
      nextAction: "Verify and preserve the retained source before continuing.",
      evidence: { runId: context.runId, automaticRecovery: { replay: "blocked" },
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] },
        historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId: context.runId, leaseIds: [leaseId] },
        systemRecovery: { ...createSystemRecovery(context.runId), state: "exhausted", attempts: 2, retriesUsed: 1,
          attemptId: randomUUID(), firstFailureAt: Date.now() - 1000, deadlineAt: Date.now() + 60_000,
          preservationOperationIds: [randomUUID()] },
      },
    });
    const retry = await requestTaskRetry({ db, companyId, issueId, actorId: "owner-user",
      actorSource: "cloud_tenant", observedRunId: context.runId, idempotencyKey: randomUUID(),
      prepareChatRetry: context.service.prepareFailedChatRunRetry });
    await db.update(agents).set({ adapterType: "paperclip_runner", status: "running",
      runtimeConfig: { heartbeat: { wakeOnDemand, maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, context.fixture.assignedAgentId));
    await db.insert(heartbeatRuns).values({ companyId, agentId: context.fixture.assignedAgentId,
      status: "running", startedAt: new Date() });
    context.wakeup.mockImplementation(heartbeatService(db).wakeup);
    return { ...context, retry, admit: () => context.service.processFailedChatRunRetry(retry.chatActionId!) };
  }

  async function failedReviewedGitHubRetryFixture() {
    const context = await failedChatRetryFixture("github");
    await db
      .update(issues)
      .set({ status: "in_review" })
      .where(eq(issues.id, context.issue.id));
    await db
      .update(heartbeatRuns)
      .set({
        errorCode: "setup_failed",
        error: "reviewed_chat_execution_binding_not_authorized",
        startedAt: new Date(Date.now() - 10),
        finishedAt: new Date(),
        // Admission captures the prior display/session identity before any
        // execution starts. It is not evidence of a turn for this new run.
        sessionIdBefore: "prior-provider-session",
      })
      .where(eq(heartbeatRuns.id, context.runId));
    await db.insert(heartbeatRunEvents).values({
      companyId: context.fixture.companyId,
      agentId: context.fixture.assignedAgentId,
      runId: context.runId,
      seq: 1,
      eventType: "error",
      stream: "system",
      level: "error",
      message: "reviewed_chat_execution_binding_not_authorized",
    });
    return context;
  }

  async function safeNativeProgressFixture(
    provider: ChatProvider,
    suffix: string,
    teamsSurface: "channel" | "personal" = "channel",
    externalActorId?: string,
    linkedOriginalActor = false,
    githubUnavailableFile = false,
    upgradedGitHub = true,
    currentGitHubPr = false,
    shared?: SharedEndpointProgress,
  ) {
    const fixture = shared?.fixture ?? await seedCompany();
    const configured = shared?.configured ?? (
      provider === "slack"
        ? await configuredSlackEndpoint(fixture)
        : provider === "github"
          ? await configuredGitHubEndpoint(
              fixture,
              githubUnavailableFile
                ? { storage: createStorageService().storage }
                : {},
            )
          : provider === "discord"
            ? await configuredDiscordEndpoint(fixture)
            : provider === "microsoft-teams"
              ? await configuredTeamsEndpoint(fixture)
              : await configuredTelegramEndpoint(fixture));
    const { callbacks, endpoint, runtime, service } = configured;
    const telegramChatId = `77113${suffix.padStart(3, "0")}`;
    const teamsConversationId = `19:safe-progress-${suffix}@thread.${teamsSurface === "channel" ? "tacv2" : "v2"}`;
    const teamsServiceUrl = "https://smba.trafficmanager.net/amer/";
    const messageId =
      provider === "slack"
        ? `1789000${suffix}.100001`
        : provider === "github"
          ? `9900${suffix}`
          : provider === "discord"
            ? `55555555555556${suffix.padStart(3, "0")}`
            : provider === "microsoft-teams"
              ? `17400000${suffix.padStart(5, "0")}`
              : `${telegramChatId}:101`;
    const thread =
      provider === "slack"
        ? makeThread({
            channelId: `C-SAFE-PROGRESS-${suffix}`,
            id: `slack:C-SAFE-PROGRESS-${suffix}:${messageId}`,
            name: `safe-progress-${suffix}`,
          })
        : provider === "github"
          ? makeThread({
              channelId: currentGitHubPr ? "paperclipai/paperclip" : "github:paperclipai/paperclip",
              id: currentGitHubPr ? `github:paperclipai/paperclip:${700 + Number(suffix)}` : `github:paperclipai/paperclip:issue:${700 + Number(suffix)}`,
              name: "paperclipai/paperclip",
            })
          : provider === "discord"
            ? makeThread({
                channelId: `33333333333334${suffix.padStart(3, "0")}`,
                id: `discord:1457808928258658549:33333333333334${suffix.padStart(3, "0")}:${messageId}`,
                name: `safe-progress-${suffix}`,
              })
            : provider === "microsoft-teams"
              ? makeThread({
                  channelId: `teams:${Buffer.from(teamsConversationId).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`,
                  id: `teams:${Buffer.from(`${teamsConversationId}${teamsSurface === "channel" ? `;messageid=${messageId}` : ""}`).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`,
                  isDM: teamsSurface === "personal",
                  name: `safe-progress-${suffix}`,
                })
              : makeThread({
                  channelId: telegramChatId,
                  id: `telegram:${telegramChatId}`,
                  isDM: true,
                  name: `safe-progress-${suffix}`,
                });
    if (provider === "microsoft-teams" && teamsSurface === "channel") {
      await db.insert(chatEndpointResources).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "channel",
        providerResourceId: teamsConversationId,
        label: "Native progress channel",
        availability: "available",
        enabled: true,
      });
    }
    if (linkedOriginalActor) {
      const currentEndpoint = await service.get(endpoint.id);
      const originalActorId =
        externalActorId ??
        (provider === "telegram" ? telegramChatId : "U-SAFE-PROGRESS");
      await db.insert(chatExternalPrincipals).values({
        companyId: fixture.companyId,
        provider,
        providerAccountId: currentEndpoint.providerAccountId!,
        externalId: originalActorId,
        kind: "user",
        isBot: false,
      });
      await linkLifecycleFixtureActor({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        externalId: originalActorId,
      });
    }
    if (provider === "github" && currentGitHubPr) {
      const config = await githubChatManagementService(db).configuration(endpoint.id, "owner-user");
      await db.insert(chatGitHubConfigurations).values({ companyId: fixture.companyId, endpointId: endpoint.id,
        configuration: { ...config.configuration, toolsEnabled: true, defaults: { ...config.configuration.defaults,
          invocation: "mentions_only", events: [] } }, updatedByUserId: "owner-user" });
    }
    const sourceMessage = makeMessage({
      id: messageId,
      mentioned: !thread.thread.isDM,
      text: thread.thread.isDM
        ? "Show safe progress"
        : "@maya show safe progress",
      userId:
        externalActorId ??
        (provider === "telegram" ? telegramChatId : "U-SAFE-PROGRESS"),
    });
    if (currentGitHubPr) sourceMessage.raw = { action: "created", installation: { id: 2468 },
      repository: { id: 97531, full_name: "paperclipai/paperclip" }, issue: { number: 791, pull_request: {} },
      sender: { id: 42, login: "octocat", type: "User" }, comment: { id: Number(messageId), body: sourceMessage.text, user: { id: 42 } } };
    if (githubUnavailableFile) {
      const url =
        "https://github.com/user-attachments/files/31967808/private-current.txt";
      sourceMessage.text = `@maya inspect only this exact file: [file](${url})`;
      Object.assign(sourceMessage, { threadId: thread.thread.id });
      sourceMessage.raw = {
        type: "issue_comment",
        threadType: "issue",
        prNumber: 700 + Number(suffix),
        repository: { full_name: "paperclipai/paperclip" },
        comment: {
          id: Number(messageId),
          body: sourceMessage.text,
          user: { id: 42 },
        },
      };
      sourceMessage.formatted = {
        type: "root",
        children: [{ type: "link", url, children: [] }],
      };
      sourceMessage.attachments.push(
        ...githubPublicAttachmentsFromMessage(sourceMessage),
      );
    }
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider,
      thread: thread.thread,
      message: sourceMessage,
      trigger: thread.thread.isDM ? "direct_message" : "mention",
    });
    const conversations = await readChatConversationsByEndpointId(endpoint.id);
    const conversation = shared ? conversations.find(row => row.externalThreadId === thread.thread.id) : conversations[0];
    if (!conversation) throw new Error("Expected safe-progress conversation");
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected safe-progress runtime");

    if (provider === "github" && upgradedGitHub) {
      // These fixtures exercise upgraded bots' tool-owned reply model.
      const config = await githubChatManagementService(db).configuration(endpoint.id, "owner-user");
      await db.insert(chatGitHubConfigurations).values({ companyId: fixture.companyId, endpointId: endpoint.id, configuration: config.configuration, updatedByUserId: "owner-user" });
    }

    const createRun = async (label: string) => {
      const runId = randomUUID();
      const baseCreatedAt = new Date(Date.now() - 60_000);
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        runtimeMode: "native",
        status: "running",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider,
          providerMessageId: messageId,
        }),
      });
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:working:${endpoint.id}`,
        payload: {
          text: `Maya is working on ${label}…`,
          progressState: "working",
        },
        state: "pending",
        createdAt: baseCreatedAt,
        updatedAt: baseCreatedAt,
      });
      await service.processPendingPublications(100);
      return { baseCreatedAt, runId };
    };
    const addEvent = async (
      run: Awaited<ReturnType<typeof createRun>>,
      eventType = "item.completed",
      seq = 1,
      createdAt = new Date(run.baseCreatedAt.getTime() + 30_000 + seq),
    ) => {
      await db.insert(heartbeatRunEvents).values({
        companyId: fixture.companyId,
        runId: run.runId,
        agentId: fixture.assignedAgentId,
        seq,
        eventType,
        message: "PRIVATE native event prose must stay in Paperclip",
        payload: {
          toolName: "secret_internal_tool",
          arguments: { token: "PRIVATE-NATIVE-TOKEN" },
          result: "PRIVATE-NATIVE-RESULT",
          target: "PRIVATE-NATIVE-TARGET",
        },
        createdAt,
      });
    };
    return {
      addEvent,
      conversation,
      createRun,
      endpoint,
      fixture,
      messageId,
      providerRuntime,
      runtime,
      service,
      thread,
      wakeup: configured.wakeup,
      providerFetch:
        "providerFetch" in configured ? (configured.providerFetch as typeof globalThis.fetch) : undefined,
    };
  }

  async function committedChatResponseRecoveryFixture(
    provider: "slack" | "telegram" | "github",
    format: "coordinator" | "port" = "coordinator",
    githubUnavailableFile = false,
    beforeAcceptance?: (
      context: Awaited<ReturnType<typeof failedChatRetryFixture>>,
    ) => Promise<void>,
    summary?: (issueId: string) => string,
    finalize = true,
    shared?: SharedEndpointProgress,
  ) {
    const context = await failedChatRetryFixture(
      provider,
      provider === "github" ? "42" : undefined,
      false,
      githubUnavailableFile,
      false,
      shared,
    );
    if (provider === "github") {
      const config = await githubChatManagementService(db).configuration(context.endpoint.id, "owner-user");
      await db.insert(chatGitHubConfigurations).values({ companyId: context.fixture.companyId, endpointId: context.endpoint.id, configuration: config.configuration, updatedByUserId: "owner-user" });
    }
    await beforeAcceptance?.(context);
    const contractId = randomUUID();
    const sessionId = randomUUID();
    const runnerId = randomUUID();
    const contractSha256 = `recovered-response-${randomUUID()}`;
    await db.insert(completionContracts).values({
      id: contractId,
      companyId: context.fixture.companyId,
      issueId: context.issue.id,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v3",
      risk: "low",
      completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "recovered-response-v1",
        objective: "Answer the exact message",
        criteria: [
          { id: "response", requirement: "Return the requested answer" },
        ],
      },
      canonicalSha256: contractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db
      .update(heartbeatRuns)
      .set({
        runtimeMode: "native",
        nativeIssueId: context.issue.id,
        nativeSessionId: sessionId,
        runnerInstanceId: runnerId,
        completionContractId: contractId,
        completionContractSha256: contractSha256,
        status: "failed",
        errorCode: "adapter_failed",
        error: "provider_transport_failed: checkpoint is quarantined",
        finishedAt: new Date(),
        processPid: 987654,
        runnerProfileJson: {
          sessionCheckpoint: { retainedEvidence: "do not alter" },
        },
      })
      .where(eq(heartbeatRuns.id, context.runId));
    await db
      .update(issues)
      .set({ status: "in_review", executionRunId: null })
      .where(eq(issues.id, context.issue.id));
    const result: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary:
        summary?.(context.issue.id) ??
        "This is the exact accepted answer. I will wait for your next message.",
      completionClaim: {
        contractRevision: "recovered-response-v1",
        objectiveSatisfied: true,
        criteria: [
          { criterionId: "response", status: "satisfied", evidenceRefs: [] },
        ],
        remainingWork: [],
      },
      evidence: [],
      verification: [],
      attentionRequests: [],
      artifacts: [],
      continuation: {
        kind: "response_wake",
        summary: "Wait for the next authorized message.",
        idempotencyKey: `wait:${context.runId}`,
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
    const binding = {
      companyId: context.fixture.companyId,
      issueId: context.issue.id,
      runId: context.runId,
      agentId: context.fixture.assignedAgentId,
      normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId,
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      completionContractRevision: "recovered-response-v1",
      completionContractCriterionIds: ["response"],
    };
    if (format === "coordinator") {
      await new NativeRunCoordinatorStore(db, binding).completeRun({
        result,
        terminal,
        turnId: `turn-${context.runId}`,
      });
    } else {
      const controlPlaneSourceInstanceId = `control-${context.runId}`;
      const port = new PaperclipControlPlanePort(db, {
        companyId: binding.companyId,
        issueId: binding.issueId,
        runId: binding.runId,
        agentId: binding.agentId,
        sessionId,
        completionContractId: contractId,
        completionContractSha256: contractSha256,
        sourceInstanceId: runnerId,
        controlPlaneSourceInstanceId,
      });
      await port.openRun({
        identity: {
          companyId: binding.companyId,
          issueId: binding.issueId,
          runId: binding.runId,
          agentId: binding.agentId,
          sessionId,
        },
        backendKind: "mock",
        sourceInstanceId: runnerId,
      });
      await port.completeRun({
        result,
        terminal,
        turnId: `turn-${context.runId}`,
      });
      await db.insert(heartbeatRunEvents).values({
        companyId: binding.companyId,
        agentId: binding.agentId,
        runId: binding.runId,
        seq: 1,
        eventType: "run.result.accepted",
        sourceInstanceId: controlPlaneSourceInstanceId,
        payload: { prpEvent: { sourceKind: "control_plane" } },
      });
    }
    const [acceptedRow] = await db
      .select()
      .from(nativeRunResults)
      .where(eq(nativeRunResults.runId, context.runId));
    const accepted = { resultId: acceptedRow.id };
    if (finalize) await finalizeNativeRun({
      db,
      runId: context.runId,
      workspaceFinalizeStatus: "succeeded",
    });
    const [coordinator] = await db
      .select()
      .from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, context.runId));
    if (finalize) expect(coordinator.phase).toBe("committed");
    else expect(coordinator.phase).not.toBe("committed");
    await db
      .update(heartbeatRuns)
      .set({
        resultJson: {
          finalResponse: "PRIVATE provider narration must not be recovered",
          privateTrace: "PRIVATE tool arguments",
        },
      })
      .where(eq(heartbeatRuns.id, context.runId));
    const [beforeIssue] = await readIssuesById(context.issue.id);
    const repair = () =>
      repairCommittedNativeChatResponse(db, {
        companyId: context.fixture.companyId,
        issueId: context.issue.id,
        runId: context.runId,
      });
    return {
      ...context,
      accepted,
      result,
      terminal,
      binding,
      coordinator,
      beforeIssue,
      repair,
    };
  }

  async function githubOmissionFixture(
    unavailable = true,
    beforeAcceptance?: Parameters<
      typeof committedChatResponseRecoveryFixture
    >[3],
    summary?: Parameters<typeof committedChatResponseRecoveryFixture>[4],
  ) {
    const egress = vi
      .spyOn(attachmentEgress, "guardedRemoteHttpFetch")
      .mockResolvedValue(
        new Response("private file unavailable", { status: 404 }),
      );
    try {
      const context = await committedChatResponseRecoveryFixture(
        "github",
        "coordinator",
        unavailable,
        beforeAcceptance,
        summary,
      );
      return {
        ...context,
        egress,
        cleanup: async () => {
          try {
            await context.service.shutdown();
          } finally {
            egress.mockRestore();
          }
        },
      };
    } catch (error) {
      egress.mockRestore();
      throw error;
    }
  }

  async function linkedCommittedResponseFailure(
    context: Awaited<ReturnType<typeof committedChatResponseRecoveryFixture>>,
    runId: string = context.runId,
    messageId = "same-run-message",
  ) {
    const [failure] = await db
      .insert(chatPublications)
      .values({
        companyId: context.fixture.companyId,
        endpointId: context.endpoint.id,
        conversationId: context.conversation.id,
        issueId: context.issue.id,
        idempotencyKey: `run:${runId}:failed:${context.endpoint.id}`,
        payload: {
          text: "Maya stopped before completing this turn.",
          progressState: "failed",
        },
        state: "published",
        providerMessageId: messageId,
        publishedAt: new Date(),
        attempts: 1,
      })
      .returning();
    await db.insert(chatMessageLinks).values({
      companyId: context.fixture.companyId,
      endpointId: context.endpoint.id,
      conversationId: context.conversation.id,
      publicationId: failure.id,
      providerMessageId: messageId,
      direction: "outbound",
    });
    return failure;
  }

  async function deferredChatQueueFixture(admissionFails = false, beforeAdmission?: (service: ChatChannelService) => Promise<void>, linkedBoardUser = false) {
    const fixture = await seedCompany();
    let ownerId: string | null = null;
    const configured = await configuredSlackEndpoint(fixture, {
      linkedBoardUser,
      wakeup: async (agentId, opts) => {
        if (admissionFails)
          throw new Error("PRIVATE admission failure token=do-not-publish");
        const request = opts.durableChatRequest!;
        await db.transaction(async (tx) => {
          await request.authorize(
            tx as unknown as Parameters<typeof request.authorize>[0],
          );
          const [owner] = ownerId
            ? await tx
                .select()
                .from(agentWakeupRequests)
                .where(eq(agentWakeupRequests.id, ownerId))
            : [];
          const existingContext = owner?.payload?._paperclipWakeContext as
            Record<string, unknown> | undefined;
          const commentIds = [
            ...(Array.isArray(existingContext?.wakeCommentIds)
              ? existingContext.wakeCommentIds
              : []),
            request.commentId,
          ];
          const payload = {
            ...opts.payload,
            _paperclipWakeContext: {
              ...opts.contextSnapshot,
              wakeCommentIds: commentIds,
            },
          };
          if (owner)
            await tx
              .update(agentWakeupRequests)
              .set({ payload, coalescedCount: owner.coalescedCount + 1 })
              .where(eq(agentWakeupRequests.id, owner.id));
          await tx.insert(agentWakeupRequests).values({
            id: request.id,
            companyId: fixture.companyId,
            agentId,
            source: "assignment",
            reason: "issue_execution_deferred",
            status: owner ? "coalesced" : "deferred_issue_execution",
            payload: owner
              ? { ...opts.payload, coalescedIntoWakeupRequestId: owner.id }
              : payload,
            requestedByActorType: request.requestedByActorType,
            requestedByActorId: request.requestedByActorId,
            requestedAt: request.requestedAt,
            idempotencyKey: request.idempotencyKey,
          });
          ownerId ??= request.id;
        });
        return { accepted: true };
      },
    });
    const thread = makeThread({
      channelId: "CDEFERREDNOTICE",
      id: "slack:CDEFERREDNOTICE:1999000.1",
    });
    const send = async (id = "1999000.1") =>
      deliverMessage({
        callbacks: configured.callbacks,
        endpointId: configured.endpoint.id,
        thread: thread.thread,
        message: makeMessage({
          id,
          text: "@maya exact queued request",
          userId: linkedBoardUser ? "UBOARD" : undefined,
          mentioned: id === "1999000.1",
        }),
        trigger: id === "1999000.1" ? "mention" : "subscribed_message",
      });
    await beforeAdmission?.(configured.service);
    await send();
    const [conversation] = await readChatConversationsByEndpointId(configured.endpoint.id);
    const [action] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, configured.endpoint.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    const promote = async () => {
      const [owner] = await readAgentWakeupRequestsById(ownerId!);
      const runId = randomUUID();
      const contextSnapshot = owner.payload!._paperclipWakeContext as Record<
        string,
        unknown
      >;
      await db.transaction(async (tx) => {
        await tx.insert(heartbeatRuns).values({
          id: runId,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          status: "running",
          runtimeMode: "native",
          wakeupRequestId: owner.id,
          contextSnapshot,
        });
        await tx
          .update(agentWakeupRequests)
          .set({ runId, status: "claimed" })
          .where(eq(agentWakeupRequests.id, owner.id));
      });
      return runId;
    };
    return {
      ...configured,
      action,
      conversation,
      fixture,
      promote,
      send,
      thread,
    };
  }

  return { failedChatRetryFixture, currentGitHubTaskRetryFixture, busyChatRetryHttpFixture, successfulGitHubQueuedInputFixture, deferredFailedRetryNoticeFixture, failedReviewedGitHubRetryFixture, safeNativeProgressFixture, committedChatResponseRecoveryFixture, githubOmissionFixture, linkedCommittedResponseFailure, deferredChatQueueFixture };
}

export type RetryFixtures = ReturnType<typeof createRetryFixtures>;
