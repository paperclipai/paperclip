import { environmentService } from "../../services/environments.js";
import { databaseWorkPending, reconcileDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db";
import { configureAgentLifecycle } from "../../services/agent-lifecycle.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "../../services/adapter-execution-control.js";
import { chatRunSourceMessageId } from "../../services/chat-channels/run-origin.js";
import * as durableChatWakeup from "../../services/durable-chat-wakeup.js";
import { conflict } from "../../errors.js";
import * as githubTaskPreparation from "../../services/chat-channels/github/task-preparation.js";
import { budgetPolicies, costEvents } from "@paperclipai/db";
import { budgetService } from "../../services/budgets.js";
import { readFreshWorkspaceReadiness } from "../../services/fresh-workspace-continuation.js";
import { requestTaskRetry, reconcileTaskChatRetryReceipts } from "../../services/task-retry.js";
import * as taskRetryModule from "../../services/task-retry.js";
import { taskInterruptionPresentation } from "../../services/task-interruption-presentation.js";
import { withQueuedCommentIdsInWakePayload } from "../../services/issue-queued-comment-queue.js";
import { createSystemRecovery } from "../../services/system-recovery-state.js";
import { remoteTerminationReceipt } from "../../services/remote-execution-termination.js";
import type { Db } from "@paperclipai/db";
import { dueChatAction } from "../../services/chat-action-work.js";
import { CHAT_ACTION_QUEUES } from "../../services/chat-work-notifications.js";
import { DELIVERY_QUEUES } from "../../services/delivery-work-notifications.js";
import { secretService } from "../../services/secrets.js";
import { githubChatManagementService } from "../../services/chat-github-management.js";
import { githubResponseCommentService } from "../../services/chat-github-response-comments.js";
import { initializeRunIdentity } from "../../services/run-identity.js";
import { prepareHeartbeatExecutionConfiguration } from "../../services/heartbeat/execution-configuration.js";
import { appendHeartbeatRunEvent } from "../../services/heartbeat-run-events.js";
import { companySkillService } from "../../services/company-skills.js";
import { companyObservability } from "@paperclipai/db";
import * as runIdentityModule from "../../services/run-identity.js";
import * as heartbeatModule from "../../services/heartbeat.js";
import { chatGitHubConfigurations } from "@paperclipai/db";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { agents, agentWakeupRequests, activityLog, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatMessageLinks, chatPublications, completionContracts, companyMemberships, companySkills, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunResults, nativeRunFinalizations, environmentLeases, executionWorkspaces, executionWorkspaceSnapshots, workspaceOperations, toolConnections } from "@paperclipai/db";
import { defaultGitHubReviewPolicy } from "@paperclipai/shared";
import type { Message } from "chat";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { unadmittedChatWakeupCondition, authorizeFailedChatRunRetryWake } from "../../services/durable-chat-wakeup.js";
import type { ChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { instanceSettingsService } from "../../services/instance-settings.js";
import { enqueueChatRunMilestones, resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { resolveRunScopedMentionedSkillKeys } from "../../services/heartbeat/run-preparation.js";
import { type TestDb, describeEmbeddedPostgres, FakeEndpointRuntime, FakeChatSdkRuntime, makeThread, makeMessage, boardActor } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";
import { createRetryFixtures } from "./retry-fixtures.js";

describeEmbeddedPostgres("chat channels: github retry and recovery", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const rf = createRetryFixtures(h, gh);
  const { seedCompany, readChatConversationsByEndpointId, readChatEndpointsById, readIssueCommentsByIssueId, readChatDeliveriesByEndpointId, readHeartbeatRunsById, readChatActionsById, readChatPublicationsByEndpointId, readChatActionsByProviderActionId, readHeartbeatRunsByCompanyId, readAgentWakeupRequestsById, createService, createStorageService, retirePublicationFixture, chatWakeContext, addSelectedChatFinal, qualifySetupRoundTrip, deliverMessage } = h;
  const { signedGitHubWebhookRequest, configuredGitHubEndpoint, deliverLegacyGitHubReceipt, attachFakeGitHubIssueCommentWebhook } = gh;
  const { failedChatRetryFixture, currentGitHubTaskRetryFixture, successfulGitHubQueuedInputFixture, failedReviewedGitHubRetryFixture, githubOmissionFixture } = rf;

  it.each([
    "ordinary",
    "held_add",
    "restart",
    "rotation",
    "connection_revoked",
  ])(
    "GitHub terminal receipt composes pinned HTTP and durable source authority (%s)",
    async (mode) => {
      const fixture = await seedCompany();
      let earlyFinal: (() => Promise<void>) | undefined;
      const { callbacks, endpoint, runtime, service, wakeup, providerFetch } =
        await configuredGitHubEndpoint(fixture, {
          scheduleDeferredWork: () => undefined,
          ...(mode === "final_before_add"
            ? {
                wakeup: async () => {
                  await earlyFinal!();
                  return { accepted: true };
                },
              }
            : {}),
        });
      // Pin the upgraded reply policy before admission. Changing it after the
      // source arrives would correctly invalidate its saved authorization.
      const currentEndpoint = await service.get(endpoint.id);
      const [principal] = await db.insert(chatExternalPrincipals).values({
        companyId: fixture.companyId,
        provider: "github",
        providerAccountId: currentEndpoint.providerAccountId!,
        externalId: "42",
        kind: "user",
        displayName: "Octocat",
        handle: "octocat",
        isBot: false,
      }).returning();
      await db.insert(chatIdentityLinks).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: principal.id,
        paperclipUserId: "owner-user",
        status: "linked",
        confirmedAt: new Date(),
      });
      const config = await githubChatManagementService(db).configuration(endpoint.id, "owner-user");
      await db.insert(chatGitHubConfigurations).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        configuration: { ...config.configuration, toolsEnabled: true },
        updatedByUserId: "owner-user",
      });
      await db.update(chatEndpoints).set({ allowGroupChats: true }).where(eq(chatEndpoints.id, endpoint.id));
      let activeService = service;
      const pins: ChatSdkEndpointRuntime[] = [];
      const calls: Array<{ method: string; path: string }> = [];
      const remote = new Map<string, number>();
      let failRemoval = mode === "remove_retry";
      let removing = false;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let heldOnce = false;
      const inFlight: Promise<unknown>[] = [];
      const configuration = runtime.configurations.get(endpoint.id)!;
      if (
        configuration.providerConfig.provider !== "github" ||
        !("appId" in configuration.providerConfig.credentials)
      )
        throw new Error("Expected GitHub App runtime");
      const appId = Number(configuration.providerConfig.credentials.appId);
      const requestFetch: typeof fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        calls.push({ method: init.method ?? "GET", path: url.pathname });
        if (
          !heldOnce &&
          ((mode === "held_token" && url.pathname.includes("/access_tokens")) ||
            (mode === "held_add" &&
              init.method === "POST" &&
              url.pathname.endsWith("/reactions")))
        ) {
          heldOnce = true;
          entered();
          await new Promise<void>((resolve, reject) => {
            const abort = () =>
              reject(new Error("synthetic held receipt deadline"));
            init.signal!.addEventListener("abort", abort, { once: true });
            void held.then(() => {
              init.signal!.removeEventListener("abort", abort);
              resolve();
            });
          });
        }
        if (url.pathname.includes("/access_tokens"))
          return Response.json(
            { token: "synthetic-joined-token" },
            { status: 201 },
          );
        if (url.pathname === "/app")
          return Response.json({ id: appId, slug: "receipt-fixture" });
        if (url.pathname.startsWith("/users/"))
          return Response.json({
            id: removing && mode === "unknown_bot" ? null : 9001,
            login: "receipt-fixture[bot]",
            type: "Bot",
          });
        const match = /\/issues\/comments\/(\d+)\/reactions(?:\/(\d+))?$/.exec(
          url.pathname,
        );
        if (!match) throw new Error("Unexpected synthetic GitHub receipt route");
        if (init.method === "POST") {
          const id = match[1] === "5603841952" ? 700 : 701;
          remote.set(match[1]!, id);
          return Response.json(
            { id, content: "eyes", user: { id: 9001 } },
            { status: 201 },
          );
        }
        if (init.method === "DELETE") {
          if (failRemoval) {
            failRemoval = false;
            return Response.json(
              {},
              { status: 429, headers: { "retry-after": "60" } },
            );
          }
          expect(Number(match[2])).toBe(remote.get(match[1]!));
          remote.delete(match[1]!);
          return new Response(null, { status: 204 });
        }
        if (mode === "connection_revoked")
          await db
            .update(toolConnections)
            .set({ enabled: false })
            .where(eq(toolConnections.id, endpoint.connectionId));
        if (mode === "incomplete_page")
          return Response.json(
            url.searchParams.get("page") === "1"
              ? Array.from({ length: 100 }, (_, index) => ({
                  id: 1000 + index,
                  content: "eyes",
                  user: { id: 10000 + index },
                }))
              : null,
          );
        return Response.json([
          { id: 702, content: "eyes", user: { id: 9002 } },
          ...(remote.has(match[1]!)
            ? [{ id: remote.get(match[1]!), content: "eyes", user: { id: 9001 } }]
            : []),
        ]);
      };
      const attach = (target: FakeEndpointRuntime) => {
        const pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        pins.push(pinned);
        Object.assign(target, {
          applyGitHubReceiptReaction: (
            input: Parameters<typeof pinned.applyGitHubReceiptReaction>[0],
            check: () => Promise<void>,
          ) => pinned.applyGitHubReceiptReaction(input, check, requestFetch),
        });
      };
      const originalRuntime = runtime.endpoints.get(endpoint.id)!;
      attach(originalRuntime);
      const thread = makeThread({
        channelId: "github:paperclipai/paperclip",
        id: "github:paperclipai/paperclip:issue:5",
      });
      const runId = randomUUID();
      const publish = async () => {
        const [conversation] = await service.listConversations(endpoint.id);
        await db
          .insert(heartbeatRuns)
          .values({
            id: runId,
            companyId: fixture.companyId,
            agentId: fixture.assignedAgentId,
            status: "succeeded",
            contextSnapshot: await chatWakeContext({
              endpointId: endpoint.id,
              issueId: conversation.issueId,
              provider: "github",
              providerMessageId: "5603841952",
            }),
          });
        await addSelectedChatFinal({
          companyId: fixture.companyId,
          issueId: conversation.issueId,
          agentId: fixture.assignedAgentId,
          runId,
          body: "PINNED-GITHUB-RECEIPT-FINAL",
        });
        await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { authorizationReason: "internal_agent_write" } } }).where(eq(heartbeatRuns.id, runId));
        // Model a terminal publication persisted before the tool-owned reply
        // upgrade. Its suppression must still remove the old eyes receipt,
        // including when the original add HTTP request has not settled yet.
        await db.insert(chatPublications).values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId!,
          idempotencyKey: `run:${runId}:completed:${endpoint.id}`,
          payload: { text: "PINNED-GITHUB-RECEIPT-FINAL", progressState: "completed" },
          state: "pending",
        });
        await enqueueChatRunMilestones(db);
        await service.processPendingPublications();
      };
      earlyFinal = publish;
      try {
        await db
          .update(chatEndpoints)
          .set({ status: "active" })
          .where(eq(chatEndpoints.id, endpoint.id));
        const deliveryWork = deliverLegacyGitHubReceipt({
          callbacks,
          endpointId: endpoint.id,
          provider: "github",
          thread: thread.thread,
          message: makeMessage({
            id: "5603841952",
            userId: "42",
            userName: "octocat",
            text: "@maya answer exactly once",
            mentioned: true,
          }),
          trigger: "mention",
        }, service);
        inFlight.push(deliveryWork);
        if (mode === "held_token" || mode === "held_add") {
          await ready;
          const finalWork = publish();
          inFlight.push(finalWork);
          await vi.waitFor(async () => {
            const rows = await db
              .select({ state: chatPublications.state })
              .from(chatPublications)
              .where(
                and(
                  eq(chatPublications.endpointId, endpoint.id),
                  eq(chatPublications.idempotencyKey, `run:${runId}:completed:${endpoint.id}`),
                ),
              );
            expect(rows).toHaveLength(1);
          });
          // Wait for durable staging, not settlement while the receipt owns
          // the credential lease. Neither reply nor cleanup can overtake it.
          expect(
            originalRuntime.posts.filter(
              (post) => post.text === "PINNED-GITHUB-RECEIPT-FINAL",
            ),
          ).toHaveLength(0);
          expect(calls.some((call) => call.method === "DELETE")).toBe(false);
          release();
          await Promise.all([deliveryWork, finalWork]);
          const pendingRemovals = await db
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                like(chatActions.providerActionId, "receipt_reaction_remove:%"),
              ),
            );
          expect(pendingRemovals).toHaveLength(1);
        } else {
          await deliveryWork;
          if (mode !== "final_before_add") await publish();
        }
        const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
        const [removal] = await readChatActionsByProviderActionId(`receipt_reaction_remove:${delivery.id}`);
        expect(removal).toBeDefined();
        if (!["final_before_add", "held_token", "held_add"].includes(mode))
          expect(removal.payload.githubReceipt).toEqual({
            botUserId: "9001",
            reactionId: "700",
          });
        if (mode === "newer_followup")
          await deliverLegacyGitHubReceipt({
            callbacks,
            endpointId: endpoint.id,
            provider: "github",
            thread: thread.thread,
            message: makeMessage({
              id: "5603841953",
              userId: "42",
              userName: "octocat",
              text: "A separate fresh queued question",
            }),
            trigger: "subscribed_message",
          }, service);
        removing = true;
        if (["restart", "unknown_bot"].includes(mode)) {
          await service.shutdown();
          const next = createService(new FakeChatSdkRuntime(), providerFetch, {
            scheduleDeferredWork: () => undefined,
          });
          next.runtime.initializeHook = async (id) => {
            if (id === endpoint.id) attach(next.runtime.endpoints.get(id)!);
          };
          activeService = next.service;
        }
        if (mode === "rotation") {
          const [current] = await readChatEndpointsById(endpoint.id);
          await db
            .update(chatEndpoints)
            .set({
              setup: {
                ...current.setup,
                runtimeGeneration:
                  Number((current.setup as InternalSetupState).runtimeGeneration ?? 0) + 1,
              } as InternalSetupState,
            })
            .where(eq(chatEndpoints.id, endpoint.id));
        }
        const blocked = [
          "unknown_bot",
          "incomplete_page",
          "connection_revoked",
        ].includes(mode);
        await activeService.processPendingReceiptReactions(1, removal.id);
        if (mode === "remove_retry") {
          const [failed] = await readChatActionsById(removal.id);
          expect(failed).toMatchObject({
            status: "failed",
            result: { retryable: true, attempts: 1 },
          });
          await db
            .update(chatActions)
            .set({
              result: { ...failed.result, retryAt: new Date(0).toISOString() },
            })
            .where(eq(chatActions.id, removal.id));
        }
        // Blocked operations retain their failed audit result. Retry only the
        // explicit rate-limit case; successful cases also prove idempotency.
        if (!blocked) await activeService.processPendingReceiptReactions(1, removal.id);
        const [result] = await readChatActionsById(removal.id);
        expect(result.status).toBe(
          mode === "rotation" ? "cancelled" : blocked ? "failed" : "processed",
        );
        expect(remote.has("5603841952")).toBe(blocked || mode === "rotation");
        expect(remote.has("5603841953")).toBe(mode === "newer_followup");
        expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(
          blocked || mode === "rotation" || mode === "final_before_add"
            ? 0
            : mode === "remove_retry"
              ? 2
              : 1,
        );
        expect(
          calls.filter(
            (call) => call.method === "POST" && call.path.endsWith("/reactions"),
          ),
        ).toHaveLength(
          mode === "final_before_add" ? 0 : mode === "newer_followup" ? 2 : 1,
        );
        expect(
          originalRuntime.posts.filter(
            (post) => post.text === "PINNED-GITHUB-RECEIPT-FINAL",
          ),
        ).toHaveLength(0);
        expect(wakeup).toHaveBeenCalledTimes(mode === "newer_followup" ? 2 : 1);
      } finally {
        release();
        await Promise.allSettled(inFlight);
        try {
          await retirePublicationFixture(activeService, endpoint.id);
        } finally {
          if (activeService !== service) await service.shutdown();
          await Promise.all(pins.map((pin) => pin.shutdown()));
        }
      }
    },
  );

  it("retries saved GitHub input after a successful run without replaying that run", async () => {
    const f = await successfulGitHubQueuedInputFixture();
    try {
      const { input } = f;
      const companyId = f.fixture.companyId;
      const before = (await readHeartbeatRunsById(f.runId))[0];
      const [request, duplicate] = await Promise.all([requestTaskRetry(input),
        requestTaskRetry({ ...input, idempotencyKey: randomUUID() })]);
      expect(request.accepted).toBe(true);
      expect(duplicate.requestId).toBe(request.requestId);
      await reconcileTaskChatRetryReceipts(db, { companyId });
      const [source] = await readAgentWakeupRequestsById(f.pending!.id);
      expect(source.runId).toBeTruthy();
      const [successor] = await readHeartbeatRunsById(source.runId!);
      expect(successor).toMatchObject({ status: "queued", retryOfRunId: null,
        contextSnapshot: { wakeCommentIds: [f.pending!.payload.commentId] } });
      await reconcileTaskChatRetryReceipts(db, { companyId });
      expect((await readAgentWakeupRequestsById(request.requestId!))[0])
        .toMatchObject({ status: "coalesced", runId: successor.id });
      expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.wakeupRequestId === f.pending!.id)).toHaveLength(1);
      expect((await readHeartbeatRunsById(f.runId))[0]).toEqual(before);
      expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.result.id)))[0]).toEqual(f.result);
    } finally { await f.service.shutdown(); }
  });

  it.each(["issue.comment.reopen", "boardMessageRetry"] as const)(
    "resumes saved GitHub input after a successful board turn: %s", async origin => {
      const f = await successfulGitHubQueuedInputFixture();
      try {
        const [previous] = await readHeartbeatRunsById(f.runId);
        await db.update(heartbeatRuns).set({ responsibleUserId: f.input.actorId, contextSnapshot: {
          ...previous.contextSnapshot, ...(origin === "boardMessageRetry" ? { boardMessageRetry: true } : { source: origin }),
        } }).where(eq(heartbeatRuns.id, f.runId));
        const before = (await readHeartbeatRunsById(f.runId))[0];
        const retry = await requestTaskRetry(f.input);
        await reconcileTaskChatRetryReceipts(db, { companyId: f.fixture.companyId, requestId: retry.requestId! });
        const [saved] = await readAgentWakeupRequestsById(f.pending!.id);
        expect(saved.runId).toBeTruthy();
        expect((await readHeartbeatRunsById(saved.runId!))[0]).toMatchObject({ retryOfRunId: null,
          contextSnapshot: { source: "chat:github", wakeCommentIds: [f.pending!.payload.commentId] } });
        expect((await readHeartbeatRunsById(f.runId))[0]).toEqual(before);
      } finally { await f.service.shutdown(); }
    });

  it("keeps a board message queued separately when saved GitHub Retry resumes after cleanup", async () => {
    const f = await successfulGitHubQueuedInputFixture();
    try {
      const companyId = f.fixture.companyId;
      const lease = { id: randomUUID(), companyId, issueId: f.issue.id, heartbeatRunId: f.runId,
        provider: "daytona", providerLeaseId: randomUUID(), leasePolicy: "ephemeral" };
      await db.insert(environmentLeases).values({ ...lease, status: "pending_cleanup" });
      await db.update(issues).set({ status: "in_review", executionRunId: f.runId }).where(eq(issues.id, f.issue.id));
      const retry = await requestTaskRetry(f.input);
      await reconcileTaskChatRetryReceipts(db, { companyId, requestId: retry.requestId! });
      expect((await readAgentWakeupRequestsById(f.pending!.id))[0].runId).toBeNull();
      const [comment] = await db.insert(issueComments).values({ companyId, issueId: f.issue.id,
        authorType: "user", authorUserId: f.input.actorId, body: "A separate board follow-up" }).returning();
      const [board] = await db.insert(agentWakeupRequests).values({ companyId, agentId: f.fixture.assignedAgentId,
        source: "automation", triggerDetail: "system", reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: f.input.actorId,
        payload: withQueuedCommentIdsInWakePayload({ issueId: f.issue.id, commentId: comment.id,
          _paperclipWakeContext: { issueId: f.issue.id, source: "issue.comment.reopen", wakeReason: "issue_commented" },
        }, [comment.id]),
      }).returning();
      await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
        metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) },
      }).where(eq(environmentLeases.id, lease.id));
      await reconcileTaskChatRetryReceipts(db, { companyId, requestId: retry.requestId! });
      const [saved] = await readAgentWakeupRequestsById(f.pending!.id);
      expect(saved.runId).toBeTruthy();
      expect((await readHeartbeatRunsById(saved.runId!))[0]).toMatchObject({ status: "queued",
        contextSnapshot: { wakeCommentIds: [f.pending!.payload.commentId] } });
      expect((await readAgentWakeupRequestsById(board.id))[0]).toEqual(board);
    } finally { await f.service.shutdown(); }
  });

  it.each(["reconnected", "snapshot_newer_input"] as const)(
    "admits current GitHub task Retry without replaying obsolete input: %s", async kind => {
      const f = await currentGitHubTaskRetryFixture(kind.includes("newer_input"));
      const { pending, originalDelivery } = f;
      try {
        const companyId = f.fixture.companyId, issueId = f.issue.id;
        if (kind.includes("reconnected")) await f.service.configure(f.endpoint.id, { action: "reconnect" }, "owner-user");
        let snapshotActionId: string | undefined;
        if (kind === "snapshot_newer_input") {
          const leaseId = randomUUID(), providerLeaseId = randomUUID();
          await db.update(heartbeatRuns).set({ errorCode: "execution_finalization_deadline_exceeded",
            resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
              schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } },
            runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
              descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
              workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd: "/workspace", resourceDisposition: "destroy" } },
          }).where(eq(heartbeatRuns.id, f.runId));
          for (const current of [{ id: leaseId, providerLeaseId }, { id: randomUUID(), providerLeaseId: randomUUID() }]) {
            const lease = { ...current, companyId, issueId, heartbeatRunId: f.runId,
              provider: "daytona", status: "released", cleanupStatus: "success", releasedAt: new Date() };
            await db.insert(environmentLeases).values({ ...lease, metadata: { remoteExecutionTermination:
              remoteTerminationReceipt(lease, { providerLeaseId: current.providerLeaseId, state: "stopped" }) } });
          }
          for (const cause of ["native_continuation_requires_reconciliation", "execution_finalization_deadline_exceeded"]) {
            const id = randomUUID();
            if (cause === "native_continuation_requires_reconciliation") snapshotActionId = id;
            await db.insert(issueRecoveryActions).values({ id, companyId, sourceIssueId: issueId,
              kind: "active_run_watchdog", status: "resolved", ownerType: "system", outcome: "blocked", cause,
              fingerprint: randomUUID(), nextAction: "Preserved snapshot needs fresh continuation", evidence: {
                runId: f.runId, automaticRecovery: { replay: "blocked" },
                ...(cause === "native_continuation_requires_reconciliation" ? {
                  systemRecovery: { ...createSystemRecovery(f.runId), state: "complete", phase: "reconcile_effects" },
                } : {}),
              } });
          }
        }
        const input = { db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
          observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry };
        const request = await requestTaskRetry(input);
        expect(request.accepted).toBe(true);
        if (snapshotActionId) {
          const [saved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, snapshotActionId));
          await db.update(issueRecoveryActions).set({ evidence: { ...saved.evidence,
            systemRecovery: { ...saved.evidence.systemRecovery as Record<string, unknown>, intentId: request.requestId },
          } }).where(eq(issueRecoveryActions.id, snapshotActionId));
        }
        expect((await requestTaskRetry(input)).requestId).toBe(request.requestId);
        expect(await f.service.processFailedChatRunRetry(request.chatActionId!)).toMatchObject({ status: "queued" });
        const [wake] = await readAgentWakeupRequestsById(request.chatActionId!);
        expect(wake.runId).toBeTruthy();
        const expectedComment = pending?.payload.commentId ?? f.action.payload.commentId;
        const [run] = await readHeartbeatRunsById(wake.runId!);
        expect(run).toMatchObject({ status: "queued", retryOfRunId: f.runId,
          contextSnapshot: { wakeCommentIds: [expectedComment], taskRetryRequestId: request.requestId } });
        if (snapshotActionId) {
          const { readFreshWorkspaceReadiness } = await import("../../services/fresh-workspace-continuation.js");
          expect(await readFreshWorkspaceReadiness(db, run)).toMatchObject({
            mode: "fresh_isolated_workspace", sourceRunId: f.runId, retryIntentId: request.requestId,
          });
          expect((await readHeartbeatRunsById(f.runId))[0].runnerProfileJson?.nativeWorkspaceSync)
            .toMatchObject({ state: "prepared", finalHostSha256: null });
        }
        if (pending) expect((await readAgentWakeupRequestsById(pending.id))[0])
          .toMatchObject({ status: "coalesced", runId: wake.runId });
        await f.service.processFailedChatRunRetry(request.chatActionId!);
        await heartbeatService(db).resumeQueuedRuns();
        expect((await readHeartbeatRunsByCompanyId(companyId)).filter(r => r.contextSnapshot?.taskRetryRequestId === request.requestId))
          .toHaveLength(1);
        expect((await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, originalDelivery.id)))[0].normalizedEvent)
          .toEqual(originalDelivery.normalizedEvent);
      } finally { await f.service.shutdown(); }
    },
  );

  it.each(["person", "restart_recovery"])("continues an accepted GitHub task Retry from recovered saved work when its chat replay is refused after the click: %s", async initiator => {
    const f = await currentGitHubTaskRetryFixture(initiator === "person_with_input_before_stop");
    try {
      const companyId = f.fixture.companyId, issueId = f.issue.id;
      const leaseId = randomUUID(), providerLeaseId = randomUUID(), workspaceId = randomUUID(), snapshotId = randomUUID();
      if (f.pending) {
        await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 60_000) })
          .where(eq(agentWakeupRequests.id, f.pending.id));
        await db.update(chatActions).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(chatActions.id, f.pending.id));
        await db.update(issueComments).set({ createdAt: new Date(Date.now() - 60_000) })
          .where(eq(issueComments.id, String(f.pending.payload.commentId)));
        await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 30_000) }).where(eq(heartbeatRuns.id, f.runId));
      }
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
      await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
        name: "Review workspace", providerType: "cloud_sandbox", mode: "isolated_workspace", strategyType: "project_primary",
        cwd: `/workspaces/${workspaceId}`, metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 2,
          snapshotId, source: { kind: "empty" }, location: null, writerRunId: null, dirty: false } } });
      await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId, executionWorkspaceId: workspaceId,
        sourceOperationId: randomUUID(), sourceRunId: f.runId, generation: 1, epoch: 2, status: "committed", sha256: "c".repeat(64) });
      await db.update(heartbeatRuns).set({ errorCode: "native_continuation_requires_reconciliation",
        error: "runner_remote_process_identity_unavailable",
        resultJson: { stopReason: "adapter_failed", workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
          schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } },
        runnerProfileJson: { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", epoch: 2, state: "saved",
          leaseId, providerLeaseId, remoteCwd: `/workspaces/${workspaceId}`, snapshotId, workspaceId } },
      }).where(eq(heartbeatRuns.id, f.runId));
      const lease = { id: leaseId, providerLeaseId, companyId, issueId, heartbeatRunId: f.runId, provider: "daytona",
        status: "expired", cleanupStatus: "success", releasedAt: new Date(), leasePolicy: "ephemeral" };
      await db.insert(environmentLeases).values({ ...lease, metadata: { remoteExecutionTermination:
        remoteTerminationReceipt(lease, { providerLeaseId, state: "destroyed" }) } });
      const recoveryActionId = randomUUID();
      await db.insert(issueRecoveryActions).values({ id: recoveryActionId, companyId, sourceIssueId: issueId,
        kind: "active_run_watchdog", status: "resolved", ownerType: "system", outcome: "blocked",
        cause: "native_continuation_requires_reconciliation", fingerprint: `native-workspace:${f.runId}`,
        nextAction: "The original sandbox is retained for workspace repair.", evidence: { runId: f.runId,
          automaticRecovery: { runId: f.runId, policy: "preserve_without_replay_v1", replay: "blocked", actionOutcome: "unknown" },
          systemRecovery: { ...createSystemRecovery(f.runId), state: "complete", phase: "reconcile_effects", attempts: 1,
            preservationOperationIds: [randomUUID()] },
          workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "recovered",
            stage: "saving_receipts", attempt: 1, retryable: true, requestIds: [], attemptLimit: 6 },
          continuationDelivery: "invalidated", workspaceRestoreFailure: "restore_failed",
          workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] },
        } });
      await db.insert(workspaceOperations).values({ companyId, issueId, heartbeatRunId: f.runId,
        executionWorkspaceId: workspaceId, phase: "workspace_recovery", status: "succeeded", finishedAt: new Date(),
        metadata: { recoveryActionId, leaseId, providerLeaseId, snapshotId, generation: 1, sha256: "c".repeat(64),
          storage: "remote_workspace", epoch: 2 } });
      let sourceRunId: string = f.runId;
      if (initiator === "person_after_held_admission") {
        const [failed] = await readHeartbeatRunsById(f.runId);
        const [held] = await db.insert(heartbeatRuns).values({ companyId, agentId: f.fixture.assignedAgentId,
          status: "cancelled", errorCode: "execution_reconciliation_required", runtimeMode: "legacy", issueId,
          wakeupRequestId: failed.wakeupRequestId, contextSnapshot: failed.contextSnapshot, finishedAt: new Date(),
          createdAt: new Date(failed.createdAt.getTime() + 1_000),
          resultJson: { stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
            executionWait: { issueId, recoveryActionId } } }).returning();
        await db.update(agentWakeupRequests).set({ runId: held.id }).where(eq(agentWakeupRequests.id, failed.wakeupRequestId!));
        await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
        sourceRunId = held.id;
      }
      const { getExecutionBlocker } = await import("../../services/execution-blocker.js");
      const blocker = await getExecutionBlocker(db, companyId, issueId);
      const interruption = await taskInterruptionPresentation(db, f.issue);
      expect(interruption).toMatchObject({ state: "failed", canRetry: true });
      expect(blocker).toMatchObject({ recoveryActionId, canRetry: true,
        nextAction: "Saved work recovered. Retry continues from it.",
        workspaceRecovery: { status: "recovered", message: "Saved work recovered. Retry continues from it." } });
      expect(JSON.stringify(blocker)).not.toContain("Send a message");
      await db.update(heartbeatRuns).set({ status: "timed_out" }).where(eq(heartbeatRuns.id, f.runId));
      expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ canRetry: true,
        nextAction: "Saved work recovered. Retry continues from it.",
        workspaceRecovery: { message: "Saved work recovered. Retry continues from it." } });
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "native_session_cleanup_quarantined" })
        .where(eq(heartbeatRuns.id, f.runId));
      const quarantined = await getExecutionBlocker(db, companyId, issueId);
      expect(quarantined).toMatchObject({ canRetry: false, nextAction: "Saved work recovered.",
        workspaceRecovery: { message: "Saved work recovered." } });
      await db.update(heartbeatRuns).set({ errorCode: "native_continuation_requires_reconciliation" })
        .where(eq(heartbeatRuns.id, f.runId));

      const identityLock = `chat-identity:${companyId}:${f.action.principalId}`;
      const holdLock = async (lock: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>) => {
        let release = () => {}, locked = () => {};
        const held = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { locked = resolve; });
        const holder = db.transaction(async tx => { await lock(tx); locked(); await held; });
        await ready;
        return async () => { release(); await holder; };
      };
      const releaseIdentity = await holdLock(tx => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identityLock}, 0))`));
      let request: Awaited<ReturnType<typeof requestTaskRetry>>;
      try {
        request = await requestTaskRetry({ db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
          observedRunId: sourceRunId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry,
          ...(initiator.startsWith("person") ? {} : { initiatedBy: "restart_recovery" as const }) });
      } finally { await releaseIdentity(); }
      if (initiator === "restart_recovery_joined_by_person") {
        const joined = await requestTaskRetry({ db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
          observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry });
        expect(joined).toMatchObject({ accepted: true, requestId: request.requestId, chatActionId: request.chatActionId });
      }
      expect(request).toMatchObject({ accepted: true, stale: false, chatActionId: expect.any(String) });
      if (initiator === "person_with_superseded_continuation") await db.insert(heartbeatRuns).values({ companyId,
        agentId: f.fixture.assignedAgentId, status: "cancelled", errorCode: "issue_execution_lock_changed", runtimeMode: "legacy",
        issueId, retryOfRunId: sourceRunId, finishedAt: new Date(), contextSnapshot: { issueId } });
      const chatAction = async () => (await db.select().from(chatActions).where(eq(chatActions.id, request.chatActionId!)))[0];
      expect((await chatAction()).payload.sourceAuthorizationPending).toBe(true);

      const [{ status: agentStatus }] = await db.select({ status: agents.status }).from(agents)
        .where(eq(agents.id, f.fixture.assignedAgentId));
      if (initiator === "person_paused_after_accept") await db.update(agents).set({ status: "paused" })
        .where(eq(agents.id, f.fixture.assignedAgentId));
      const releaseAgent = initiator === "person_paused_after_accept" ? async () => {}
        : await holdLock(tx => tx.select().from(agents).where(eq(agents.id, f.fixture.assignedAgentId)).for("update"));
      try {
        await vi.waitFor(async () => {
          await f.service.processFailedChatRunRetry(request.chatActionId!);
          expect((await chatAction()).status).toBe("failed");
        }, { timeout: 30_000, interval: 250 });
      } finally { await releaseAgent(); }
      expect(await readAgentWakeupRequestsById(request.chatActionId!)).toHaveLength(0);

      await reconcileTaskChatRetryReceipts(db, { companyId, settleOnly: true });
      if (initiator === "restart_recovery") {
        expect((await readAgentWakeupRequestsById(request.requestId!))[0]).toMatchObject({ status: "failed", runId: null });
        expect((await readHeartbeatRunsByCompanyId(companyId))
          .filter(candidate => candidate.contextSnapshot?.taskRetryRequestId === request.requestId)).toHaveLength(0);
        return;
      }
      const [continued] = await readAgentWakeupRequestsById(request.requestId!);
      expect(continued).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(taskRetryModule.readTaskRetryIntent(continued.payload)?.chatActionId).toBeUndefined();
      if (initiator === "person_paused_after_accept") {
        await expect(heartbeatService(db).resumeTaskRetry(companyId, request.requestId!)).rejects.toThrow("not invokable");
        expect((await readAgentWakeupRequestsById(request.requestId!))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
        expect((await readHeartbeatRunsByCompanyId(companyId))
          .filter(candidate => candidate.contextSnapshot?.taskRetryRequestId === request.requestId)).toHaveLength(0);
        await db.update(agents).set({ status: agentStatus }).where(eq(agents.id, f.fixture.assignedAgentId));
      }
      await heartbeatService(db).resumeTaskRetry(companyId, request.requestId!);
      const [admitted] = await readAgentWakeupRequestsById(request.requestId!);
      expect(admitted).toMatchObject({ status: "coalesced", runId: expect.any(String) });
      const [run] = await readHeartbeatRunsById(admitted.runId!);
      expect(run).toMatchObject({ status: "queued", contextSnapshot: { issueId, taskRetryRequestId: request.requestId } });
      expect(await readFreshWorkspaceReadiness(db, run)).toMatchObject({ mode: "resume_preserved_workspace" });
      expect((await readHeartbeatRunsByCompanyId(companyId))
        .filter(candidate => candidate.contextSnapshot?.taskRetryRequestId === request.requestId)).toHaveLength(1);
      const activity = await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId),
        eq(activityLog.action, "issue.retry_continued_from_saved_work")));
      expect(activity).toHaveLength(1);
      expect(activity[0].details).toMatchObject({ requestId: request.requestId, refusedChatActionId: request.chatActionId });
      if (f.pending) expect((await readAgentWakeupRequestsById(f.pending.id))[0]).toMatchObject({ status: "coalesced",
        runId: null, payload: { coalescedIntoWakeupRequestId: request.requestId } });
    } finally { await f.service.shutdown(); }
  }, 90_000);

  it.each(["unrecovered_workspace", "access_revoked", "input_after_stop"])(
    "settles a refused GitHub task Retry by its own gates: %s", async gate => {
      const f = await currentGitHubTaskRetryFixture(gate.startsWith("input_"));
      try {
        const companyId = f.fixture.companyId, issueId = f.issue.id;
        await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
          status: "resolved", ownerType: "system", outcome: "blocked", cause: "native_continuation_requires_reconciliation",
          fingerprint: `native-workspace:${f.runId}`, nextAction: "Recovered", evidence: { runId: f.runId,
            automaticRecovery: { runId: f.runId, policy: "preserve_without_replay_v1", replay: "blocked", actionOutcome: "unknown" },
            systemRecovery: { ...createSystemRecovery(f.runId), state: gate === "unrecovered_workspace" ? "running" : "complete",
              phase: gate === "unrecovered_workspace" ? "preserve_files" : "reconcile_effects", attempts: 1,
              preservationOperationIds: [randomUUID()] },
            workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId,
              status: gate === "unrecovered_workspace" ? "recovering" : "recovered",
              stage: gate === "unrecovered_workspace" ? "restoring_files" : "saving_receipts", attempt: 1, requestIds: [] } } });
        if (gate === "input_inside_user_stop") {
          const [failed] = await readHeartbeatRunsById(f.runId);
          await db.update(heartbeatRuns).set({ finishedAt: new Date(), resultJson: { cancellation: { source: "operator",
            expected: true, initiator: { type: "user", id: "owner-user" }, reason: "Stopped by the user",
            recordedAt: failed.finishedAt!.toISOString() } } }).where(eq(heartbeatRuns.id, f.runId));
        }
        const request = await requestTaskRetry({ db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
          observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry });
        const [chat] = await db.update(chatActions).set({ status: "failed",
          result: { code: "failed_chat_retry_not_authorized", attemptCount: 1 } })
          .where(eq(chatActions.id, request.chatActionId!)).returning();
        const [{ status: agentStatus }] = await db.select({ status: agents.status }).from(agents)
          .where(eq(agents.id, f.fixture.assignedAgentId));
        if (gate === "access_revoked") await db.update(companyMemberships).set({ status: "suspended", updatedAt: new Date() })
          .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "owner-user")));
        if (gate === "paused_agent") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.fixture.assignedAgentId));
        await taskRetryModule.settleRefusedTaskChatRetry(db, chat);
        const retryRuns = async () => (await readHeartbeatRunsByCompanyId(companyId))
          .filter(candidate => candidate.contextSnapshot?.taskRetryRequestId === request.requestId);
        if (gate !== "paused_agent") {
          expect((await readAgentWakeupRequestsById(request.requestId!))[0]).toMatchObject({ status: "failed", runId: null });
          expect(await retryRuns()).toHaveLength(0);
          if (f.pending) expect((await readAgentWakeupRequestsById(f.pending.id))[0])
            .toMatchObject({ status: "deferred_issue_execution", runId: null });
          return;
        }
        expect((await readAgentWakeupRequestsById(request.requestId!))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
        await expect(heartbeatService(db).resumeTaskRetry(companyId, request.requestId!)).rejects.toThrow("not invokable");
        expect(await retryRuns()).toHaveLength(0);
        await db.update(agents).set({ status: agentStatus }).where(eq(agents.id, f.fixture.assignedAgentId));
        await heartbeatService(db).resumeTaskRetry(companyId, request.requestId!);
        expect((await readAgentWakeupRequestsById(request.requestId!))[0]).toMatchObject({ status: "coalesced", runId: expect.any(String) });
        expect(await retryRuns()).toHaveLength(1);
      } finally { await f.service.shutdown(); }
    }, 60_000);

  it("keeps a refused GitHub task Retry continued when reconciliation read it before the refusal settled", async () => {
    const f = await currentGitHubTaskRetryFixture(false);
    try {
      const companyId = f.fixture.companyId, issueId = f.issue.id;
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        status: "resolved", ownerType: "system", outcome: "blocked", cause: "native_continuation_requires_reconciliation",
        fingerprint: `native-workspace:${f.runId}`, nextAction: "Recovered", evidence: { runId: f.runId,
          automaticRecovery: { runId: f.runId, policy: "preserve_without_replay_v1", replay: "blocked", actionOutcome: "unknown" },
          systemRecovery: { ...createSystemRecovery(f.runId), state: "complete", phase: "reconcile_effects", attempts: 1,
            preservationOperationIds: [randomUUID()] },
          workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "recovered",
            stage: "saving_receipts", attempt: 1, requestIds: [] } } });
      const request = await requestTaskRetry({ db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
        observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry });
      const [chat] = await db.update(chatActions).set({ status: "failed",
        result: { code: "failed_chat_retry_not_authorized", attemptCount: 8 } })
        .where(eq(chatActions.id, request.chatActionId!)).returning();
      let release = () => {}, locked = () => {};
      const held = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const settling = db.transaction(async tx => {
        await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
        locked(); await held;
        await taskRetryModule.settleRefusedTaskChatRetry(tx as unknown as Db, chat);
      });
      await ready;
      const reconciling = reconcileTaskChatRetryReceipts(db, { companyId, settleOnly: true });
      onTestFinished(() => release());
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`);
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 10_000, interval: 50 });
      release();
      await Promise.all([settling, reconciling]);
      const [wake] = await readAgentWakeupRequestsById(request.requestId!);
      expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(taskRetryModule.readTaskRetryIntent(wake.payload)?.chatActionId).toBeUndefined();
    } finally { await f.service.shutdown(); }
  }, 60_000);

  it("leaves saved GitHub input pending when a persisted Retry wait loses board authority", async () => {
    const f = await currentGitHubTaskRetryFixture(true);
    try {
      const companyId = f.fixture.companyId, issueId = f.issue.id, actorId = `retry-operator-${companyId}`;
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actorId,
        status: "active", membershipRole: "operator" });
      const intent = await requestTaskRetry({ db, companyId, issueId, actorId, actorSource: "cloud_tenant",
        observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry });
      let savedOptions: Parameters<typeof f.wakeup>[1];
      f.wakeup.mockImplementationOnce(async (_agentId, options) => {
        savedOptions = options;
        const request = options!.durableChatRequest!;
        // Persist the pre-handoff wait as a server interrupted before queue adoption would.
        await db.insert(agentWakeupRequests).values({ id: request.id, companyId, agentId: request.agentId,
          source: options!.source!, triggerDetail: options!.triggerDetail, reason: options!.reason,
          requestedByActorType: request.requestedByActorType, requestedByActorId: request.requestedByActorId,
          requestedAt: request.requestedAt, idempotencyKey: request.idempotencyKey,
          status: "deferred_issue_execution", payload: { ...options!.payload,
            taskRetryRequestId: intent.requestId, _paperclipWakeContext: options!.contextSnapshot } });
        return null;
      });
      expect(await f.service.processFailedChatRunRetry(intent.chatActionId!)).toMatchObject({ status: "deferred" });
      await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(
        eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, actorId)));
      expect(await heartbeatService(db).wakeup(f.fixture.assignedAgentId, savedOptions!)).toBeNull();
      expect((await readAgentWakeupRequestsById(f.pending!.id))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect((await readHeartbeatRunsByCompanyId(companyId))
        .filter(run => run.contextSnapshot?.taskRetryRequestId === intent.requestId)).toHaveLength(0);
      await db.update(companyMemberships).set({ membershipRole: "operator" }).where(and(
        eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, actorId)));
      await heartbeatService(db).wakeup(f.fixture.assignedAgentId, savedOptions!);
      const [parent] = await readAgentWakeupRequestsById(intent.chatActionId!);
      expect(parent.runId).toBeTruthy();
      expect((await readAgentWakeupRequestsById(f.pending!.id))[0]).toMatchObject({ status: "coalesced", runId: parent.runId });
    } finally { await f.service.shutdown(); }
  });

  it.each(["changed_bot", "revoked_sender", "edited_source", "reassigned_task"])(
    "keeps current GitHub task Retry authority gated: %s", async gate => {
      const f = await currentGitHubTaskRetryFixture(true, gate.startsWith("later_message") ? 2 : 1);
      try {
        const companyId = f.fixture.companyId, issueId = f.issue.id;
        await f.service.configure(f.endpoint.id, { action: "reconnect" }, "owner-user");
        const input = { db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
          observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry };
        if (gate === "later_message_revoked_policy") {
          const [resource] = await db.select().from(chatEndpointResources).where(eq(chatEndpointResources.id, f.conversation.resourceId!));
          await db.update(chatEndpointResources).set({ availability: "available",
            metadata: { ...resource.metadata, providerRepositoryId: "418" },
          }).where(eq(chatEndpointResources.id, resource.id));
          await db.insert(chatGitHubConfigurations).values({ companyId, endpointId: f.endpoint.id,
            updatedByUserId: "owner-user", configuration: { version: 1, toolsEnabled: true, responsibleUserId: "owner-user",
              memberAccess: "all_linked", people: [], repositories: {},
              defaults: { ...defaultGitHubReviewPolicy(), invocation: "linked_authors", events: ["opened", "synchronize"] },
            } });
          const sources = await db.select().from(chatActions).where(and(eq(chatActions.conversationId, f.conversation.id),
            eq(chatActions.kind, "inbound_wakeup"), sql`${chatActions.id} <> ${f.action.id}::uuid`))
            .orderBy(asc(chatActions.createdAt), asc(chatActions.id));
          for (const [index, source] of sources.entries()) {
            const context = { event: index === 0 ? "opened" : "synchronize", deliveryId: source.deliveryId,
              repositoryId: "418", repository: resource.providerResourceId,
              pullNumber: 7, title: "Saved review request", body: "", baseSha: "a".repeat(40), headSha: "b".repeat(40),
              baseBranch: "master", author: { id: "42", login: "octocat", isBot: false },
              sender: { id: "42", login: "octocat" }, draft: false, labels: [] };
            await db.update(chatDeliveries).set({
              normalizedEvent: sql`${chatDeliveries.normalizedEvent} || ${JSON.stringify({ githubAutomatic: { context } })}::jsonb`,
            }).where(eq(chatDeliveries.id, source.deliveryId!));
          }
        }
        const accepted = await requestTaskRetry(input);
        if (gate.startsWith("later_message")) {
          const [later] = await db.select().from(chatActions).where(and(eq(chatActions.conversationId, f.conversation.id),
            eq(chatActions.kind, "inbound_wakeup"), sql`${chatActions.id} not in (${f.action.id}::uuid, ${f.pending!.id}::uuid)`));
          if (gate === "later_message_wrong_bot") await db.update(chatDeliveries).set({
            normalizedEvent: sql`jsonb_set(${chatDeliveries.normalizedEvent}, '{githubAuthority,botExternalId}', ${JSON.stringify(randomUUID())}::jsonb)`,
          }).where(eq(chatDeliveries.id, later.deliveryId!));
          else if (gate === "later_message_deleted") await db.update(issueComments).set({ deletedAt: new Date() })
            .where(eq(issueComments.id, String(later.payload.commentId)));
          else await db.update(chatGitHubConfigurations).set({ revision: sql`${chatGitHubConfigurations.revision} + 1`,
            configuration: sql`jsonb_set(${chatGitHubConfigurations.configuration}, '{defaults,events}', '["opened"]'::jsonb)`,
          }).where(eq(chatGitHubConfigurations.endpointId, f.endpoint.id));
        }
        if (gate === "changed_bot") await db.update(chatEndpoints).set({ botExternalId: randomUUID() })
          .where(eq(chatEndpoints.id, f.endpoint.id));
        if (gate === "disabled_repository") await db.update(chatEndpointResources).set({ enabled: false })
          .where(eq(chatEndpointResources.id, f.conversation.resourceId!));
        if (gate === "retargeted_repository") await db.update(chatEndpointResources).set({ providerResourceId: "another/repository" })
          .where(eq(chatEndpointResources.id, f.conversation.resourceId!));
        if (gate === "revoked_sender") await db.update(chatIdentityLinks).set({ status: "revoked" })
          .where(and(eq(chatIdentityLinks.endpointId, f.endpoint.id), eq(chatIdentityLinks.principalId, f.pending!.principalId!)));
        if (gate === "paused_endpoint") await db.update(chatEndpoints).set({ status: "paused" })
          .where(eq(chatEndpoints.id, f.endpoint.id));
        if (gate === "edited_source") await db.update(issueComments).set({ body: "Changed after Retry", updatedAt: new Date() })
          .where(eq(issueComments.id, String(f.pending!.payload.commentId)));
        if (gate === "deleted_source") await db.update(issueComments).set({ deletedAt: new Date() })
          .where(eq(issueComments.id, String(f.pending!.payload.commentId)));
        if (gate === "reassigned_task") await db.update(issues).set({ assigneeAgentId: f.fixture.replacementAgentId })
          .where(eq(issues.id, issueId));
        if (gate === "second_reconnect") await f.service.configure(f.endpoint.id, { action: "reconnect" }, "owner-user");
        expect(await f.service.processFailedChatRunRetry(accepted.chatActionId!)).toMatchObject({ status: "failed" });
        expect((await readAgentWakeupRequestsById(f.pending!.id))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
        expect((await readHeartbeatRunsByCompanyId(companyId))
          .filter(run => run.contextSnapshot?.taskRetryRequestId === accepted.requestId)).toHaveLength(0);
        const [settled] = await db.select().from(chatActions).where(eq(chatActions.id, accepted.chatActionId!));
        expect(settled.result?.taskRetryInputReconciled).toBe(true);
        const [intentReceipt] = await readAgentWakeupRequestsById(accepted.requestId!);
        await f.service.processFailedChatRunRetry(accepted.chatActionId!);
        expect((await readAgentWakeupRequestsById(accepted.requestId!))[0].updatedAt).toEqual(intentReceipt.updatedAt);
        if (gate === "second_reconnect") {
          const next = await requestTaskRetry({ ...input, idempotencyKey: randomUUID() });
          expect(next.requestId).not.toBe(accepted.requestId);
          expect(await f.service.processFailedChatRunRetry(next.chatActionId!)).toMatchObject({ status: "queued" });
        }
      } finally { await f.service.shutdown(); }
    },
  );

  it.each(["contained", "principal_revoked"])(
    "retries an authenticated GitHub request after isolated-directory validation failed before allocation: %s", async mode => {
    const f = await failedChatRetryFixture("github", "42", true, false, true);
    const companyId = f.fixture.companyId, agentId = f.fixture.assignedAgentId, issueId = f.issue.id;
    const diagnostic = "The existing execution workspace is not this task's isolated directory.";
    try {
      await initializeRunIdentity(db, { companyId, runId: f.runId, issueId, responsibleUserId: "owner-user",
        messageIds: [String(f.action.payload.commentId)], cause: "chat_message" });
      await db.update(heartbeatRuns).set({ errorCode: "workspace_validation_failed", error: diagnostic,
        runtimeMode: "legacy", sessionIdBefore: "prior-provider-display-hint",
        usageJson: { ledgerScope: { issueId, projectId: null, billingCode: null } },
        runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "adapter_failed",
          workspaceValidation: { reason: "isolated_task_directory_binding_mismatch", issueId } } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (mode.startsWith("observability_")) {
        await db.insert(companyObservability).values({ companyId, revision: randomUUID(), enabled: true,
          destination: { provider: "otlp", endpointBaseUrl: "https://collector.example/otel" },
          capture: { userPrompts: false, assistantResponses: false, toolDetails: false, toolContent: false } });
        const [agent] = await db.update(agents).set({ adapterConfig: mode === "observability_opencode"
          ? { provider: "opencode", model: "openrouter/synthetic", homeMode: "preconfigured" }
          : { provider: "acpx", acpxAgent: "pi", model: "synthetic", homeMode: "preconfigured" } })
          .where(eq(agents.id, agentId)).returning();
        const [run] = await readHeartbeatRunsById(f.runId);
        const prepared = await prepareHeartbeatExecutionConfiguration(db, { run, agent,
          task: { issueId, context: { ...run.contextSnapshot }, responsibleUserId: "owner-user",
            acceptedPlanContinuationWake: false, acceptedPlanWakeRoutingDecision: null, taskProjectContext: null,
            routineEnvContext: { routineId: null, env: null, responsibleUserId: null } },
          config: { sourceWorkspaceConfig: agent.adapterConfig, aiBinding: undefined },
          policy: { trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
            useIsolatedTaskDirectory: false, explicitTaskDirectory: false, requestedExecutionWorkspaceMode: "shared_workspace" },
          environment: { selectedEnvironmentId: (await environmentService(db).ensureLocalEnvironment(agent.companyId)).id, selectedEnvironmentForConfig: null,
            resolvedInstanceSettings: await instanceSettingsService(db).get(), persistedNativeExecutionInput: null },
          services: { secretsSvc: secretService(db), companySkills: companySkillService(db),
            appendRunEvent: async (source, event) => { await appendHeartbeatRunEvent(db, { companyId: source.companyId,
              agentId: source.agentId, runId: source.id, ...event }); }, finalizeAiConnectionBusyDeferral: vi.fn() },
          onFailureSecretsResolved: () => {}, onManagedAiRuntimeAcquired: () => {}, onIdentityRedactorPrepared: () => {},
        });
        expect(prepared.prepared).toBe(true);
        const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
        if (mode === "observability_opencode") {
          if (!prepared.prepared) throw new Error("Configuration preparation did not finish");
          expect(prepared.observability?.kind).toBe("opencode");
          expect(prepared.observability?.environment).toMatchObject({ PAPERCLIP_OBSERVABILITY_OPENCODE: "1",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/otel/v1/traces" });
          expect(events.filter(event => event.eventType === "agent_observability.unavailable")).toHaveLength(0);
          expect(JSON.stringify(prepared.runtimeConfig)).not.toContain("collector.example");
        } else {
          expect(events).toMatchObject([{ eventType: "agent_observability.unavailable", payload: { reason: "unsupported_harness" } }]);
        }
      }
      await appendHeartbeatRunEvent(db, { companyId, agentId, runId: f.runId,
        eventType: "error", stream: "system", level: "error", message: diagnostic });
      await appendHeartbeatRunEvent(db, { companyId, agentId, runId: f.runId, eventType: "lifecycle", stream: "system", level: "info",
        message: "task.run.measured", payload: { durableSettlement: true, durationMs: 2505, outcome: "failed", phase: "task.run.measured" } });
      await db.update(agents).set({ status: "running", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, agentId));
      const [capacity] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
      const heartbeat = heartbeatService(db);
      f.wakeup.mockImplementation(heartbeat.wakeup);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
      app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
      app.use(errorHandler);
      const [failed] = await readHeartbeatRunsById(f.runId);
      if (mode === "observability_reason" || mode === "observability_revision" || mode === "observability_extra") {
        const [warning] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 1)));
        await db.update(heartbeatRunEvents).set({ payload: { ...warning.payload,
          ...(mode === "observability_reason" ? { reason: "unknown_preparation" } : mode === "observability_revision" ? { revision: null } : { providerWork: true }) } })
          .where(eq(heartbeatRunEvents.id, warning.id));
      }
      if (mode === "observability_provenance") await db.update(heartbeatRunEvents).set({ sourceEventId: "untrusted-provider-warning" })
        .where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 1)));
      const validation = failed.resultJson!.workspaceValidation as object;
      if (mode === "other_reason" || mode === "wrong_issue") await db.update(heartbeatRuns).set({ resultJson: { ...failed.resultJson,
        workspaceValidation: { ...validation, ...(mode === "other_reason" ? { reason: "plugin_workspace_strategy_unsupported" } : { issueId: randomUUID() }) } } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (mode === "provider_started" || mode === "result_extra") await db.update(heartbeatRuns).set({ resultJson: { ...failed.resultJson,
        ...(mode === "provider_started" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } : { unknownExecution: true }) } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (mode === "profile") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...failed.runnerProfileJson, nativeExecutionInput: {} } }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "usage") await db.update(heartbeatRuns).set({ usageJson: { ...failed.usageJson, tokens: 1 } }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "output") await db.update(heartbeatRuns).set({ stdoutExcerpt: "provider output" }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "process") await db.update(heartbeatRuns).set({ processPid: 999999 }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "active_control") adapterExecutionControls.set(f.runId, createAdapterExecutionControl());
      if (mode === "lease") await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId,
        provider: "daytona", providerLeaseId: "contradictory-preparation-allocation", status: "active", leasePolicy: "ephemeral" });
      if (mode === "accepted_result") {
        const contractId = randomUUID(), resultId = randomUUID();
        await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
          schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
          completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
          canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
        await db.update(heartbeatRuns).set({ nativeIssueId: issueId, completionContractId: contractId }).where(eq(heartbeatRuns.id, f.runId));
        await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: f.runId, completionContractId: contractId,
          schemaStatus: "accepted", serverFingerprint: resultId, canonicalSha256: resultId,
          resultJson: { terminal: { runTerminalState: "succeeded" } } });
      }
      if (mode === "event_source") await db.update(heartbeatRunEvents).set({ sourceEventId: "provider-event" }).where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 1)));
      if (mode === "extra_event") await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: f.runId,
        seq: 3, eventType: "lifecycle", stream: "system", level: "info", message: "unexpected provider preparation" });
      if (mode === "principal_revoked") await db.update(chatIdentityLinks).set({ status: "revoked", revokedAt: new Date() }).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
      if (mode === "contained") await expect(db.transaction(tx => f.service.prepareFailedChatRunRetry(tx, {
        companyId, issueId, agentId, failedRunId: f.runId, initiatedByUserId: "owner-user",
      }))).rejects.toMatchObject({ details: { code: "chat_failed_run_retry_not_authorized" } });
      const send = () => request(app).post(`/api/issues/${issueId}/retry`).send({ idempotencyKey: randomUUID(), observedRunId: f.runId });
      if (mode === "prior_denied_intent") {
        const prior = await send().expect(202);
        // Reproduce a terminal unadmitted authorization refusal, retaining the
        // real HTTP intent/action receipts; the next normal click sees them.
        await db.update(heartbeatRuns).set({ logBytes: 1 }).where(eq(heartbeatRuns.id, f.runId));
        await f.service.processFailedChatRunRetry(prior.body.chatActionId);
        await db.update(heartbeatRuns).set({ logBytes: null }).where(eq(heartbeatRuns.id, f.runId));
        await reconcileTaskChatRetryReceipts(db);
        expect((await readAgentWakeupRequestsById(prior.body.requestId))[0]).toMatchObject({ status: "failed", runId: null });
        expect((await db.select().from(chatActions).where(eq(chatActions.id, prior.body.chatActionId)))[0]).toMatchObject({ status: "failed" });
      }
      const response = await send();
      if (["principal_revoked", "accepted_result"].includes(mode)) {
        expect(response.status, JSON.stringify(response.body)).toBe(202);
        expect(response.body.chatActionId).toBeUndefined();
        const [intent] = await readAgentWakeupRequestsById(response.body.requestId);
        expect(intent).toMatchObject({ reason: "task_retry", requestedByActorId: "owner-user",
          payload: { issueId, taskRetry: { sourceRunId: f.runId } } });
        expect((intent.payload!.taskRetry as Record<string, unknown>).chatActionId).toBeUndefined();
      } else {
        expect(response.status).toBe(202);
        if (mode === "source_edited") await db.update(issueComments).set({ body: "Changed after Retry acceptance" }).where(eq(issueComments.id, String(f.action.payload.commentId)));
        await f.service.processFailedChatRunRetry(response.body.chatActionId);
      }
      if (!["contained", "prior_denied_intent", "observability_opencode", "observability_warning"].includes(mode)) {
        expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
        return;
      }
      const [wake] = await readAgentWakeupRequestsById(response.body.chatActionId);
      expect(wake).toMatchObject({ status: "queued", runId: expect.any(String) });
      const [successor] = await readHeartbeatRunsById(wake.runId!);
      expect(successor).toMatchObject({ retryOfRunId: f.runId, contextSnapshot: {
        source: "chat:github", wakeCommentId: f.action.payload.commentId, taskRetryRequestId: response.body.requestId } });
      const realInitialize = runIdentityModule.initializeRunIdentity;
      const initialized: string[] = [];
      const probe = vi.spyOn(runIdentityModule, "initializeRunIdentity").mockImplementation(async (database, input) => {
        const identity = await realInitialize(database, input);
        if (input.companyId !== companyId) return identity;
        expect(identity.messageId).toBe(f.action.payload.commentId);
        initialized.push(input.runId);
        throw new Error("workspace_retry_identity_probe_complete");
      });
      try {
        await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, capacity.id));
        await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        expect(initialized).toEqual([successor.id]);
        expect((await readHeartbeatRunsById(successor.id))[0]).toMatchObject({ error: "workspace_retry_identity_probe_complete" });
        expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(1);
      } finally { probe.mockRestore(); await heartbeat.drainActiveRunExecutions(); }
    } finally {
      adapterExecutionControls.get(f.runId)?.finish(); adapterExecutionControls.delete(f.runId);
      await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
      await f.service.shutdown();
    }
  });

  it("retries the saved board-message turn in a connected task after environment qualification failed before provider startup", async () => {
    const f = await failedChatRetryFixture("github", "42", true, false, true);
    try {
      const companyId = f.fixture.companyId, agentId = f.fixture.assignedAgentId, issueId = f.issue.id;
      await initializeRunIdentity(db, { companyId, runId: f.runId, issueId, responsibleUserId: "owner-user",
        messageIds: [String(f.action.payload.commentId)], cause: "chat_message" });
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
        authorUserId: "owner-user", body: "Continue from saved work and review the current head." }).returning();
      await db.update(agents).set({ status: "running", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, agentId));
      const [capacity] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
      const heartbeat = heartbeatService(db);
      const current = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system",
        reason: "issue_reopened_via_comment", requestedByActorType: "user", requestedByActorId: "owner-user",
        payload: { issueId, commentId: comment.id }, contextSnapshot: { issueId, taskKey: issueId,
          source: "issue.comment.reopen", wakeCommentId: comment.id, wakeCommentIds: [comment.id] } });
      expect(current).toMatchObject({ status: "queued" });
      await initializeRunIdentity(db, { companyId, runId: current!.id, issueId, responsibleUserId: "owner-user",
        parentRunId: f.runId, messageIds: [comment.id], cause: "issue_reopened_via_comment" });
      const diagnostic = 'Failed to acquire lease for environment "Managed computer" (sandbox): sandbox_snapshot_qualification_required: The snapshot qualification is missing or stale. Test this environment again before running Paperclip Runner.';
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), runtimeMode: "legacy",
        errorCode: "setup_failed", error: diagnostic, sessionIdBefore: "prior-provider-session-hint",
        runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        usageJson: { ledgerScope: { issueId, projectId: null } },
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "adapter_failed" } })
        .where(eq(heartbeatRuns.id, current!.id));
      await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, current!.wakeupRequestId!));
      await db.insert(heartbeatRunEvents).values([
        { companyId, agentId, runId: current!.id, seq: 1, eventType: "agent_observability.unavailable", stream: "system", level: "warn",
          message: "Company observability was not applied: this harness is not supported.", payload: { reason: "unsupported_harness", revision: randomUUID() } },
        { companyId, agentId, runId: current!.id, seq: 2, eventType: "error", stream: "system", level: "error", message: diagnostic },
        { companyId, agentId, runId: current!.id, seq: 3, eventType: "lifecycle", stream: "system", level: "info",
          message: "task.run.measured", payload: { durableSettlement: true, durationMs: 18000, outcome: "failed", phase: "task.run.measured" } },
      ]);
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, capacity.id));
      await db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, issueId));
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
      const [failed] = await readHeartbeatRunsById(current!.id);
      await expect(chatRunSourceMessageId(db, failed, { provider: "github" })).resolves.toBe(f.action.payload.commentId);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
      const actualHeartbeatService = heartbeatModule.heartbeatService;
      const routeHeartbeat = vi.spyOn(heartbeatModule, "heartbeatService").mockImplementation((database, options) =>
        ({ ...actualHeartbeatService(database, options), resumeTaskRetry: async () => undefined }));
      try {
        app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
      } finally {
        routeHeartbeat.mockRestore();
      }
      app.use(errorHandler);
      const denySource = async (apply: () => Promise<unknown>, restore: () => Promise<unknown>, stale = false) => {
        try {
          await apply();
          const denied = await request(app).post(`/api/issues/${issueId}/retry`).send({ idempotencyKey: randomUUID(), observedRunId: current!.id }).expect(stale ? 200 : 202);
          const retries = await db.select().from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "task_retry")));
          if (stale) {
            expect(denied.body).toMatchObject({ accepted: false, stale: true });
            expect(retries).toHaveLength(0);
          } else {
            expect(denied.body.chatActionId).toBeUndefined();
            expect(retries).toHaveLength(1);
            expect(retries[0]).toMatchObject({ id: denied.body.requestId, requestedByActorId: "owner-user",
              payload: { issueId, taskRetry: { sourceRunId: current!.id } } });
            const taskRetry = retries[0].payload!.taskRetry as Record<string, unknown>;
            expect(taskRetry.boardMessageOrigin).toBeUndefined();
            expect(taskRetry.chatActionId).toBeUndefined();
          }
        } finally {
          await db.delete(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.reason, "task_retry")));
          await restore();
        }
      };
      await denySource(() => db.update(issueComments).set({ body: "Edited after acceptance", updatedAt: new Date() }).where(eq(issueComments.id, comment.id)),
        () => db.update(issueComments).set({ body: comment.body, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id)));
      await denySource(() => db.update(issueComments).set({ authorUserId: "another-user" }).where(eq(issueComments.id, comment.id)),
        () => db.update(issueComments).set({ authorUserId: comment.authorUserId, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id)));
      await denySource(() => db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comment.id)),
        () => db.update(issueComments).set({ deletedAt: null, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id)));
      const [sourceWake] = await readAgentWakeupRequestsById(current!.wakeupRequestId!);
      await denySource(() => db.update(agentWakeupRequests).set({ requestedByActorId: "another-user" }).where(eq(agentWakeupRequests.id, sourceWake.id)),
        () => db.update(agentWakeupRequests).set({ requestedByActorId: sourceWake.requestedByActorId }).where(eq(agentWakeupRequests.id, sourceWake.id)));
      for (const patch of [
        { responsibleUserId: "another-user" }, { agentId: f.fixture.replacementAgentId },
        { contextSnapshot: { ...failed.contextSnapshot, issueId: randomUUID() } },
        { activeIdentityContextId: null }, { sessionIdAfter: "provider-started" }, { processPid: 999999 },
        { controllerLeaseExpiresAt: new Date(Date.now() + 60000) }, { stdoutExcerpt: "provider output" },
        { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } },
        { runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" }, unexpectedExecution: true } },
      ]) {
        const restore = Object.fromEntries(Object.keys(patch).map(key => [key, failed[key as keyof typeof failed]]));
        await denySource(() => db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, failed.id)),
          () => db.update(heartbeatRuns).set(restore).where(eq(heartbeatRuns.id, failed.id)), "agentId" in patch);
      }
      const contractId = randomUUID(), resultId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
        schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
        completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
        canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
      await denySource(async () => {
        await db.update(heartbeatRuns).set({ nativeIssueId: issueId, completionContractId: contractId }).where(eq(heartbeatRuns.id, failed.id));
        await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: failed.id,
          completionContractId: contractId, schemaStatus: "accepted", serverFingerprint: resultId, canonicalSha256: resultId,
          resultJson: { terminal: { runTerminalState: "succeeded" } } });
      }, async () => {
        await db.delete(nativeRunResults).where(eq(nativeRunResults.id, resultId));
        await db.update(heartbeatRuns).set({ nativeIssueId: null, completionContractId: null }).where(eq(heartbeatRuns.id, failed.id));
        await db.delete(completionContracts).where(eq(completionContracts.id, contractId));
      });
      const [liveLease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: failed.id,
        provider: "daytona", providerLeaseId: "contradictory-board-startup", status: "active", leasePolicy: "ephemeral" }).returning();
      await denySource(async () => {}, () => db.delete(environmentLeases).where(eq(environmentLeases.id, liveLease.id)));
      adapterExecutionControls.set(failed.id, createAdapterExecutionControl());
      await denySource(async () => {}, async () => { adapterExecutionControls.get(failed.id)?.finish(); adapterExecutionControls.delete(failed.id); });
      const idempotencyKey = randomUUID();
      const response = await request(app).post(`/api/issues/${issueId}/retry`).send({ idempotencyKey, observedRunId: current!.id }).expect(202);
      expect(response.body).toMatchObject({ accepted: true, observedRunId: current!.id });
      expect(response.body.chatActionId).toBeUndefined();
      const [retry] = await readAgentWakeupRequestsById(response.body.requestId);
      expect(retry).toMatchObject({ reason: "task_retry", requestedByActorId: "owner-user",
        payload: { issueId, taskRetry: { sourceRunId: current!.id } } });
      expect(await db.select().from(chatActions).where(and(eq(chatActions.companyId, companyId), eq(chatActions.kind, "failed_run_retry")))).toHaveLength(0);
      await db.update(agents).set({ status: "running" }).where(eq(agents.id, agentId));
      const [dispatchCapacity] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
      await db.update(issueComments).set({ body: "Changed after Retry acceptance", updatedAt: new Date() }).where(eq(issueComments.id, comment.id));
      await heartbeat.resumeExecutionWaitComments();
      expect((await readAgentWakeupRequestsById(retry.id))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
      await db.update(issueComments).set({ body: comment.body, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id));
      await heartbeat.resumeExecutionWaitComments();
      const [successor] = (await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.contextSnapshot?.taskRetryRequestId === retry.id);
      expect(successor).toMatchObject({ status: "queued", responsibleUserId: "owner-user",
        contextSnapshot: { taskRetryRequestId: retry.id, previousRunId: current!.id } });
      expect((await readAgentWakeupRequestsById(retry.id))[0]).toMatchObject({ runId: successor.id });
      const realInitialize = runIdentityModule.initializeRunIdentity;
      const initialized: string[] = [];
      const probe = vi.spyOn(runIdentityModule, "initializeRunIdentity").mockImplementation(async (database, input) => {
        if (input.runId !== successor.id) return realInitialize(database, input);
        const [canonical] = await readAgentWakeupRequestsById(retry.id);
        const [dispatch] = await readAgentWakeupRequestsById(successor.wakeupRequestId!);
        const denyIdentity = async (apply: () => Promise<unknown>, restore: () => Promise<unknown>) => {
          try { await apply(); await expect(realInitialize(database, input)).rejects.toThrow("This saved message can no longer be retried safely"); }
          finally { await restore(); }
          expect((await readHeartbeatRunsById(input.runId))[0].activeIdentityContextId).toBeNull();
        };
        await denyIdentity(() => db.update(agentWakeupRequests).set({ payload: { ...canonical.payload,
          taskRetry: { ...(canonical.payload!.taskRetry as object), boardMessageOrigin: undefined } } }).where(eq(agentWakeupRequests.id, canonical.id)),
          () => db.update(agentWakeupRequests).set({ payload: canonical.payload }).where(eq(agentWakeupRequests.id, canonical.id)));
        await denyIdentity(() => db.update(agentWakeupRequests).set({ runId: failed.id }).where(eq(agentWakeupRequests.id, canonical.id)),
          () => db.update(agentWakeupRequests).set({ runId: canonical.runId }).where(eq(agentWakeupRequests.id, canonical.id)));
        await denyIdentity(() => db.update(agentWakeupRequests).set({ requestedByActorId: "another-user" }).where(eq(agentWakeupRequests.id, canonical.id)),
          () => db.update(agentWakeupRequests).set({ requestedByActorId: canonical.requestedByActorId }).where(eq(agentWakeupRequests.id, canonical.id)));
        await denyIdentity(() => db.update(agentWakeupRequests).set({ runId: failed.id }).where(eq(agentWakeupRequests.id, dispatch.id)),
          () => db.update(agentWakeupRequests).set({ runId: dispatch.runId }).where(eq(agentWakeupRequests.id, dispatch.id)));
        await denyIdentity(() => db.update(issueComments).set({ body: "Changed before provider dispatch", updatedAt: new Date() }).where(eq(issueComments.id, comment.id)),
          () => db.update(issueComments).set({ body: comment.body, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id)));
        await denyIdentity(() => db.update(heartbeatRuns).set({ contextSnapshot: { ...successor.contextSnapshot, taskId: randomUUID() } }).where(eq(heartbeatRuns.id, successor.id)),
          () => db.update(heartbeatRuns).set({ contextSnapshot: successor.contextSnapshot }).where(eq(heartbeatRuns.id, successor.id)));
        await denyIdentity(() => db.update(issues).set({ executionRunId: failed.id }).where(eq(issues.id, issueId)),
          () => db.update(issues).set({ executionRunId: successor.id }).where(eq(issues.id, issueId)));
        const identity = await realInitialize(database, input);
        expect(identity).toMatchObject({ responsibleUserId: "owner-user", parentContextId: retry.payload!.taskRetry &&
          (retry.payload!.taskRetry as { boardMessageOrigin: { identityContextId: string } }).boardMessageOrigin.identityContextId });
        const [executing] = await readHeartbeatRunsById(input.runId);
        await expect(chatRunSourceMessageId(db, executing, { provider: "github" })).resolves.toBe(f.action.payload.commentId);
        initialized.push(input.runId);
        // This fixture tests the real dispatch and identity boundary, without
        // allocating a provider or pretending its task work has completed.
        throw new Error("board_retry_identity_probe_complete");
      });
      try {
        await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, dispatchCapacity.id));
        await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        expect(initialized).toEqual([successor.id]);
        expect((await readHeartbeatRunsById(successor.id))[0]).toMatchObject({ status: "failed", error: "board_retry_identity_probe_complete" });
        expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.contextSnapshot?.taskRetryRequestId === retry.id)).toHaveLength(1);
        expect((await readHeartbeatRunsById(current!.id))[0]).toMatchObject({ status: "failed", activeIdentityContextId: failed.activeIdentityContextId });
      } finally { probe.mockRestore(); await heartbeat.drainActiveRunExecutions(); }
      const [firstRetry] = await readHeartbeatRunsById(successor.id);
      const nextRequest = () => request(app).post(`/api/issues/${issueId}/retry`).send({
        idempotencyKey: randomUUID(), observedRunId: firstRetry.id });
      const continueWithoutReplay = async () => {
        const continued = await nextRequest().expect(202);
        expect(continued.body.chatActionId).toBeUndefined();
        const [intent] = await readAgentWakeupRequestsById(continued.body.requestId);
        expect(intent).toMatchObject({ reason: "task_retry", requestedByActorId: "owner-user",
          payload: { issueId, taskRetry: { sourceRunId: firstRetry.id } } });
        expect((intent.payload!.taskRetry as Record<string, unknown>).boardMessageOrigin).toBeUndefined();
        await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent.id));
      };
      await db.update(heartbeatRuns).set({ sessionIdAfter: "contradictory-provider-session" }).where(eq(heartbeatRuns.id, firstRetry.id));
      await continueWithoutReplay();
      await db.update(heartbeatRuns).set({ sessionIdAfter: null }).where(eq(heartbeatRuns.id, firstRetry.id));
      await db.update(issueComments).set({ body: "Changed original accepted message", updatedAt: new Date() }).where(eq(issueComments.id, comment.id));
      await continueWithoutReplay();
      await db.update(issueComments).set({ body: comment.body, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id));
      const [firstIntent] = await readAgentWakeupRequestsById(retry.id);
      await db.update(agentWakeupRequests).set({ payload: { ...firstIntent.payload,
        taskRetry: { ...(firstIntent.payload!.taskRetry as object), sourceRunId: firstRetry.id } } }).where(eq(agentWakeupRequests.id, firstIntent.id));
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...firstRetry.contextSnapshot, previousRunId: firstRetry.id } }).where(eq(heartbeatRuns.id, firstRetry.id));
      await continueWithoutReplay();
      await db.update(agentWakeupRequests).set({ payload: firstIntent.payload }).where(eq(agentWakeupRequests.id, firstIntent.id));
      await db.update(heartbeatRuns).set({ contextSnapshot: firstRetry.contextSnapshot }).where(eq(heartbeatRuns.id, firstRetry.id));
      const second = await nextRequest().expect(202);
      expect(second.body).toMatchObject({ accepted: true, observedRunId: firstRetry.id });
      expect(second.body.chatActionId).toBeUndefined();
      const [secondIntent] = await readAgentWakeupRequestsById(second.body.requestId);
      expect(secondIntent.payload).toMatchObject({ taskRetry: { sourceRunId: firstRetry.id,
        boardMessageOrigin: { commentId: comment.id, identityContextId: firstRetry.activeIdentityContextId } } });
      const secondIdentities: string[] = [];
      const secondProbe = vi.spyOn(runIdentityModule, "initializeRunIdentity").mockImplementation(async (database, input) => {
        const identity = await realInitialize(database, input);
        if (input.companyId === companyId) {
          expect(identity).toMatchObject({ responsibleUserId: "owner-user", parentContextId: firstRetry.activeIdentityContextId });
          const [executing] = await readHeartbeatRunsById(input.runId);
          await expect(chatRunSourceMessageId(db, executing, { provider: "github" })).resolves.toBe(f.action.payload.commentId);
          secondIdentities.push(input.runId);
          throw new Error("board_retry_identity_probe_complete");
        }
        return identity;
      });
      try {
        await heartbeat.resumeExecutionWaitComments();
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        const [secondRun] = (await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.contextSnapshot?.taskRetryRequestId === secondIntent.id);
        expect(secondRun).toMatchObject({ status: "failed", error: "board_retry_identity_probe_complete", responsibleUserId: "owner-user" });
        expect(secondIdentities).toEqual([secondRun.id]);
        expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.contextSnapshot?.taskRetryRequestId === secondIntent.id)).toHaveLength(1);
      } finally { secondProbe.mockRestore(); await heartbeat.drainActiveRunExecutions(); }

    } finally {
      await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() }).where(and(
        eq(agentWakeupRequests.companyId, f.fixture.companyId), eq(agentWakeupRequests.reason, "task_retry"),
        eq(agentWakeupRequests.status, "deferred_issue_execution")));
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, f.fixture.companyId), eq(heartbeatRuns.status, "queued")));
      await f.service.shutdown();
    }
  });

  it("continues an inherited GitHub task from its recorded result instead of replaying the committed provider failure", async () => {
    const f = await failedChatRetryFixture("github", "42", true, false, true);
    try {
      const companyId = f.fixture.companyId, agentId = f.fixture.assignedAgentId, issueId = f.issue.id;
      await initializeRunIdentity(db, { companyId, runId: f.runId, issueId, responsibleUserId: "owner-user",
        messageIds: [String(f.action.payload.commentId)], cause: "chat_message" });
      await db.update(agents).set({ status: "running", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, agentId));
      const [capacity] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
      const heartbeat = heartbeatService(db);
      const resumed = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual",
        reason: "issue_tree_resumed", requestedByActorType: "user", requestedByActorId: "owner-user",
        payload: { issueId }, contextSnapshot: { issueId, taskKey: f.issue.identifier, source: "issue.tree_resume" } });
      expect(resumed).toMatchObject({ status: "queued" });
      await initializeRunIdentity(db, { companyId, runId: resumed!.id, issueId, responsibleUserId: "owner-user",
        parentRunId: f.runId, cause: "issue_tree_resumed" });
      const contractId = randomUUID(), resultId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
        schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
        completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
        canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), runtimeMode: "native",
        nativeIssueId: issueId, nativePhase: "committed", errorCode: "adapter_failed", error: "Native session failed",
        completionContractId: contractId }).where(eq(heartbeatRuns.id, resumed!.id));
      await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, resumed!.wakeupRequestId!));
      await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: resumed!.id,
        completionContractId: contractId, schemaStatus: "accepted", serverFingerprint: resultId, canonicalSha256: resultId,
        resultJson: { result: { reportedWorkDisposition: "needs_review", completionClaim: { objectiveSatisfied: false } },
          terminal: { runTerminalState: "failed", turnTerminalState: "failed" } } });
      await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: resumed!.id, phase: "committed", resultId });
      const lease = { id: randomUUID(), companyId, heartbeatRunId: resumed!.id, provider: "daytona", providerLeaseId: "contained-resume-provider" };
      await db.insert(environmentLeases).values({ ...lease, issueId, status: "expired", leasePolicy: "ephemeral",
        cleanupStatus: "success", releasedAt: new Date(), metadata: { remoteExecutionTermination:
          remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } });
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, capacity.id));
      await db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, issueId));
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
      const [failedResume] = await readHeartbeatRunsById(resumed!.id);
      expect(failedResume.contextSnapshot).toMatchObject({ source: "issue.tree_resume" });
      expect(failedResume.contextSnapshot).not.toHaveProperty("wakeCommentIds");
      await expect(chatRunSourceMessageId(db, failedResume, { provider: "github" }))
        .resolves.toBe(f.action.payload.commentId);
      const input = { db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
        observedRunId: resumed!.id, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry };
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
      app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
      app.use(errorHandler);
      // The route admits a plain Retry before it answers. This test checks
      // the saved intent, not dispatch: a paused agent keeps it unstarted.
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
      const continued = await request(app).post(`/api/issues/${issueId}/retry`).send({
        idempotencyKey: input.idempotencyKey, observedRunId: input.observedRunId,
      }).expect(202);
      expect(continued.body).toMatchObject({ accepted: true, stale: false, observedRunId: resumed!.id });
      expect(continued.body.chatActionId).toBeUndefined();
      const assertBoardContinuation = async (requestId: string) => {
        const [intent] = await readAgentWakeupRequestsById(requestId);
        expect(intent).toMatchObject({ reason: "task_retry", requestedByActorType: "user", requestedByActorId: "owner-user",
          payload: { issueId, taskRetry: { sourceRunId: resumed!.id, actorId: "owner-user" } } });
        expect((intent.payload!.taskRetry as Record<string, unknown>).chatActionId).toBeUndefined();
        expect(await db.select().from(chatActions).where(and(eq(chatActions.companyId, companyId),
          eq(chatActions.kind, "failed_run_retry")))).toHaveLength(0);
        await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, requestId));
      };
      await assertBoardContinuation(continued.body.requestId);
      // The later accepted-result guard also continues from the saved result
      // instead of repeating the exact chat request.
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...failedResume.contextSnapshot,
        source: "chat:github", wakeCommentId: f.action.payload.commentId, wakeCommentIds: [f.action.payload.commentId] } })
        .where(eq(heartbeatRuns.id, failedResume.id));
      try {
        const receipt = await requestTaskRetry({ ...input, idempotencyKey: randomUUID() });
        expect(receipt).toMatchObject({ accepted: true, chatActionId: undefined });
        await assertBoardContinuation(receipt.requestId!);
      } finally { await db.update(heartbeatRuns).set({ contextSnapshot: failedResume.contextSnapshot }).where(eq(heartbeatRuns.id, failedResume.id)); }
      expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === resumed!.id)).toHaveLength(0);
    } finally { await f.service.shutdown(); }
  });

  it.each([
    ...(["real_budget_ingress", "committed_board", "still_budget_blocked"])
      .map(mode => ({ provider: "github" as "github" | "slack" | "telegram", mode })),
  ])("retries the newer saved $provider request instead of the failed request after a budget hold: $mode", async ({ provider, mode }) => {
    const queuedBoard = mode === "committed_board" || mode.startsWith("committed_board_existing");
    const legacyIngress = mode.startsWith("legacy_");
    const realBudgetIngress = mode === "real_budget_ingress" || legacyIngress;
    const executionRevalidation = mode.startsWith("legacy_execution");
    if (legacyIngress) {
      // The legacy intake producer retained requester authority but no App ID.
      // A budget refusal never reaches the acknowledgement which could bind it.
      const historical = vi.spyOn(githubTaskPreparation, "retainGitHubDeliveryAuthority").mockImplementation(
        async (tx, endpoint, deliveryId, linkedUserId, taskUserId) => {
          const guest = !linkedUserId;
          await tx.update(chatDeliveries).set({ normalizedEvent: sql`${chatDeliveries.normalizedEvent} || ${JSON.stringify({
            githubAuthority: { guest, responsibleUserId: taskUserId, sponsorUserId: guest ? endpoint.sponsorUserId : null },
          })}::jsonb` }).where(eq(chatDeliveries.id, deliveryId));
        });
      onTestFinished(() => historical.mockRestore());
    }
    const context = await failedChatRetryFixture(provider, realBudgetIngress ? "42" : undefined, true, false, realBudgetIngress);
    try {
      const companyId = context.fixture.companyId;
      const [skill] = await db.insert(companySkills).values({ companyId, key: `company/${companyId}/saved-review`,
        slug: "saved-review", name: "Saved review", markdown: "# Saved review" }).returning();
      if (provider === "github") {
        const configured = await githubChatManagementService(db).configuration(context.endpoint.id, "owner-user");
        const configuration = { ...configured.configuration, defaults: { ...configured.configuration.defaults,
          instructions: `Use [/saved-review](skill://${skill.id}).` } };
        if (realBudgetIngress) await githubChatManagementService(db).saveConfiguration(context.endpoint.id,
          { expectedRevision: configured.revision, configuration }, "owner-user");
        else await db.insert(chatGitHubConfigurations).values({ companyId, endpointId: context.endpoint.id,
          configuration, updatedByUserId: "owner-user", revision: 2 });
      }
      if (legacyIngress) {
        await githubResponseCommentService(db, context.providerFetch).tryAcknowledge(context.action.deliveryId!);
        const [prior] = await db.select().from(chatActions).where(and(
          eq(chatActions.deliveryId, context.action.deliveryId!), eq(chatActions.kind, "github_response_comment")));
        expect(prior).toMatchObject({ status: "processed", payload: {
          botExternalId: (await context.service.get(context.endpoint.id)).botExternalId, agentId: context.fixture.assignedAgentId,
        } });
      }
      if (mode === "legacy_no_prior") await db.delete(chatActions).where(and(
        eq(chatActions.deliveryId, context.action.deliveryId!), eq(chatActions.kind, "github_response_comment")));
      if (realBudgetIngress) {
        // A reached hard stop the board later lifts. Pending accounting is no
        // longer a budget hold (invariant 3).
        await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: context.fixture.assignedAgentId,
          metric: "billed_cents", windowKind: "lifetime", amount: 100, notifyEnabled: false });
        await db.insert(costEvents).values({ companyId, agentId: context.fixture.assignedAgentId, provider: "openai", model: "gpt",
          costCents: 100, occurredAt: new Date() });
        context.wakeup.mockImplementation(heartbeatService(db).wakeup);
      } else context.wakeup.mockImplementation(async (agentId, opts) => {
        const request = opts.durableChatRequest!;
        await db.transaction(async tx => {
          await request.authorize(tx as unknown as Parameters<typeof request.authorize>[0]);
          await tx.insert(agentWakeupRequests).values({ id: request.id, companyId,
            agentId, source: opts.source!, triggerDetail: opts.triggerDetail, reason: "budget.blocked",
            requestedByActorType: request.requestedByActorType, requestedByActorId: request.requestedByActorId,
            requestedAt: request.requestedAt, idempotencyKey: request.idempotencyKey,
            payload: { ...opts.payload, executionWait: { scopeType: "agent", scopeId: agentId } },
            status: "skipped", finishedAt: new Date() });
        });
        return null;
      });
      if (realBudgetIngress) {
        const endpoint = await context.service.get(context.endpoint.id);
        attachFakeGitHubIssueCommentWebhook({ botUsername: endpoint.botUsername!, callbacks: context.runtime.configurations.get(endpoint.id)!.callbacks,
          endpointId: endpoint.id, runtime: context.runtime.endpoints.get(endpoint.id)! });
        const ref = (await db.select().from(toolConnections).where(eq(toolConnections.id, endpoint.connectionId)))[0]!
          .credentialSecretRefs.find(ref => ref.configPath === "credentials.webhookSecret")!;
        const secret = await secretService(db).resolveSecretValue(companyId, ref.secretId, ref.versionSelector ?? "latest");
        const response = await context.service.handleWebhook(endpoint.publicId, "github", signedGitHubWebhookRequest({
          delivery: randomUUID(), event: "issue_comment", webhookSecret: secret,
          payload: { action: "created", installation: { id: 2468 },
            repository: { id: 97531, full_name: "paperclipai/paperclip", owner: { id: 1357, login: "paperclipai" } },
            issue: { number: 791, pull_request: { url: "https://api.github.com/repos/paperclipai/paperclip/pulls/791" } },
            sender: { id: 42, login: "octocat", type: "User" },
            comment: { id: 990092, body: `@${endpoint.botUsername} review using the selected instructions`,
              user: { id: 42, login: "octocat", type: "User" }, created_at: new Date().toISOString() } },
        }));
        expect(response.status).toBeLessThan(300);
      } else await deliverMessage({ callbacks: context.runtime.configurations.get(context.endpoint.id)!.callbacks,
        endpointId: context.endpoint.id, provider, thread: context.thread.thread,
        message: makeMessage({ id: "saved-after-budget-hold", text: "@maya review using the selected instructions",
          userId: "U-SAFE-PROGRESS", mentioned: true }),
        trigger: context.thread.thread.isDM ? "direct_message" : "mention" });
      if (mode === "multiple_saved") await deliverMessage({
        callbacks: context.runtime.configurations.get(context.endpoint.id)!.callbacks,
        endpointId: context.endpoint.id, provider, thread: context.thread.thread,
        message: makeMessage({ id: "second-saved-after-budget-hold", text: "@maya include the follow-up",
          userId: "U-SAFE-PROGRESS", mentioned: true }), trigger: "mention" });
      if (queuedBoard) for (let index = 1; index < 10; index++) await deliverMessage({
        callbacks: context.runtime.configurations.get(context.endpoint.id)!.callbacks,
        endpointId: context.endpoint.id, provider, thread: context.thread.thread,
        message: makeMessage({ id: `saved-followup-${index}`, text: `@maya review follow-up ${index}`,
          userId: "U-SAFE-PROGRESS", mentioned: true }), trigger: "mention" });
      const savedInputs = await db.select().from(chatActions).where(and(
        eq(chatActions.companyId, companyId), eq(chatActions.conversationId, context.conversation.id),
        eq(chatActions.kind, "inbound_wakeup"), sql`${chatActions.id} <> ${context.action.id}`))
        .orderBy(asc(chatActions.createdAt), asc(chatActions.id));
      const saved = savedInputs.at(-1)!;
      const expectedComments = savedInputs.map(action => action.payload.commentId as string);
      expect(saved, JSON.stringify((await db.select({ state: chatDeliveries.state, error: chatDeliveries.redactedError, event: chatDeliveries.eventKind }).from(chatDeliveries).where(eq(chatDeliveries.endpointId, context.endpoint.id))))).toMatchObject({ status: "failed", result: { receiptStatus: "skipped" } });
      expect(saved.payload.commentId).not.toBe(context.action.payload.commentId);
      if (realBudgetIngress) {
        expect((await readAgentWakeupRequestsById(saved.id))[0]).toMatchObject({ status: "skipped", reason: "budget.blocked",
          runId: null, requestedByActorType: "user", requestedByActorId: "owner-user" });
        await db.update(budgetPolicies).set({ isActive: false }).where(eq(budgetPolicies.companyId, companyId));
        await budgetService(db).getInvocationBlock(companyId, context.fixture.assignedAgentId);
        const lifecycle = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
          runPlugin: async () => "complete", runHost: async () => "complete" });
        try { await lifecycle.process(context.fixture.assignedAgentId); } finally { await lifecycle.stop(); }
        expect((await db.select().from(agents).where(eq(agents.id, context.fixture.assignedAgentId)))[0].lifecycleHolds).not.toContain("budget");
        expect((await db.select().from(agents).where(eq(agents.id, context.fixture.assignedAgentId)))[0]).toMatchObject({status: "idle"});
        expect((await readHeartbeatRunsById(context.runId))[0]).toMatchObject({status: "failed"});
      }
      const unadmitted = () => db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, context.issue.id),
        unadmittedChatWakeupCondition(issues.id, issues.companyId)));
      expect(await unadmitted()).toHaveLength(1);
      // The budget was cleared. Retry must reconsider this independent saved
      // request through chat admission, not replay the older failed turn.
      const held = mode === "unreconciled" || mode === "committed_delayed_cleanup" || queuedBoard || mode === "committed_unknown_cleanup" || mode === "committed_live_controller";
      if (mode === "unreconciled" || mode.startsWith("committed_") || executionRevalidation) {
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: context.issue.id,
          nativePhase: "terminal_failure", runnerProfileJson: {} }).where(eq(heartbeatRuns.id, context.runId));
        await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: context.issue.id,
          kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation", status: "active",
          ownerType: "board", fingerprint: randomUUID(), nextAction: "Reconcile the previous executor.",
          evidence: { runId: context.runId, automaticRecovery: { replay: "blocked" } } });
        if (mode.startsWith("committed_") || executionRevalidation) {
          const contractId = randomUUID(), resultId = randomUUID();
          await db.insert(completionContracts).values({ id: contractId, companyId, issueId: context.issue.id,
            revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
            completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
            canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
          await db.update(heartbeatRuns).set({ nativePhase: "committed", completionContractId: contractId })
            .where(eq(heartbeatRuns.id, context.runId));
          await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId: context.issue.id,
            runId: context.runId, completionContractId: contractId, serverFingerprint: resultId,
            schemaStatus: "accepted", canonicalSha256: resultId,
            resultJson: { terminal: { runTerminalState: mode.startsWith("committed_succeeded") ? "succeeded" : "failed" } } });
          await db.insert(nativeRunFinalizations).values({ companyId, issueId: context.issue.id,
            runId: context.runId, resultId, phase: "committed",
            leaseOwner: mode === "committed_live_controller" ? "active-controller" : null });
          const lease = { id: randomUUID(), companyId, heartbeatRunId: context.runId,
            provider: "daytona", providerLeaseId: "owned-saved-input-sandbox" };
          await db.insert(environmentLeases).values({ ...lease, issueId: context.issue.id,
            status: "expired", cleanupStatus: "success", releasedAt: new Date(), leasePolicy: "ephemeral",
            metadata: mode === "committed_unknown_cleanup" || mode === "committed_delayed_cleanup" || queuedBoard ? {} : {
              remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } });
        }
      }
      if (executionRevalidation || ["committed_failed_publication", "committed_unknown_publication", "committed_pending_publication", "committed_mixed_publication", "committed_consumed_publication", "committed_succeeded_publication"].includes(mode)) {
        // A failed native run materializes its summary before delivery. Keep
        // this historical output distinct from the newer user's request.
        const [resultComment] = await db.insert(issueComments).values({ companyId, issueId: context.issue.id,
          authorAgentId: context.fixture.assignedAgentId, createdByRunId: context.runId,
          body: "The OpenCode run failed before it completed." }).returning();
        await db.insert(chatPublications).values({ companyId, endpointId: context.endpoint.id,
          conversationId: context.conversation.id, issueId: context.issue.id, commentId: resultComment.id,
          idempotencyKey: `run:${context.runId}:failed-result`, payload: { text: resultComment.body },
          state: executionRevalidation || ["committed_failed_publication", "committed_mixed_publication", "committed_consumed_publication", "committed_succeeded_publication"].includes(mode) ? "failed"
            : mode === "committed_unknown_publication" ? "delivery_unknown" : "pending",
          redactedError: "GitHub failure has no request binding" });
        if (mode === "committed_mixed_publication") await db.insert(chatPublications).values({ companyId,
          endpointId: context.endpoint.id, conversationId: context.conversation.id, issueId: context.issue.id,
          commentId: resultComment.id, idempotencyKey: `run:${context.runId}:uncertain-result`,
          payload: { text: resultComment.body }, state: "delivery_unknown" });
      }
      if (mode.startsWith("committed_consumed")) await db.update(heartbeatRuns).set({ contextSnapshot: {
        ...((await readHeartbeatRunsById(context.runId))[0]).contextSnapshot,
        wakeCommentId: saved.payload.commentId, wakeCommentIds: [saved.payload.commentId],
      } }).where(eq(heartbeatRuns.id, context.runId));
      if (mode === "malformed_previous") await db.update(heartbeatRuns).set({ contextSnapshot: {
        ...((await readHeartbeatRunsById(context.runId))[0]).contextSnapshot, wakeCommentIds: ["unbound"],
      } }).where(eq(heartbeatRuns.id, context.runId));
      if (mode === "source_app_changed" || mode === "source_destination_changed") {
        const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, saved.deliveryId!));
        await db.update(chatDeliveries).set({ normalizedEvent: { ...delivery.normalizedEvent,
          ...(mode === "source_app_changed" ? { githubAuthority: { ...(delivery.normalizedEvent.githubAuthority as object), botExternalId: "different-app" } }
            : { resource: { ...(delivery.normalizedEvent.resource as object), providerResourceId: "another/repository" } }),
        } }).where(eq(chatDeliveries.id, delivery.id));
      }
      const previousPublications = await readChatPublicationsByEndpointId(context.endpoint.id);
      const request = { db, companyId, issueId: context.issue.id, actorId: "owner-user", actorSource: "cloud_tenant",
        observedRunId: context.runId, idempotencyKey: randomUUID(), prepareChatRetry: context.service.prepareFailedChatRunRetry };
      if (legacyIngress) {
        const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, saved.deliveryId!));
        expect(delivery.normalizedEvent.githubAuthority).not.toHaveProperty("botExternalId");
        expect(await db.select({ id: chatActions.id }).from(chatActions).where(and(
          eq(chatActions.deliveryId, saved.deliveryId!), eq(chatActions.kind, "github_response_comment")))).toHaveLength(0);
        const priorWhere = and(eq(chatActions.deliveryId, context.action.deliveryId!), eq(chatActions.kind, "github_response_comment"));
        if (mode === "legacy_prior_late") await db.update(chatActions).set({ createdAt: new Date(delivery.createdAt.getTime() + 1) }).where(priorWhere);
        if (mode === "legacy_prior_unprocessed") await db.update(chatActions).set({ status: "received" }).where(priorWhere);
        if (mode === "legacy_prior_delivery_unprocessed") await db.update(chatDeliveries).set({ state: "failed" })
          .where(eq(chatDeliveries.id, context.action.deliveryId!));
        if (mode === "legacy_prior_numeric_app") await db.update(chatActions).set({
          payload: sql`jsonb_set(${chatActions.payload}, '{botExternalId}', ${JSON.stringify(Number((await context.service.get(context.endpoint.id)).botExternalId))}::jsonb)`,
        }).where(priorWhere);
        if (mode === "legacy_response_conflict") await db.insert(chatActions).values({ companyId,
          endpointId: context.endpoint.id, conversationId: context.conversation.id, deliveryId: delivery.id,
          principalId: delivery.principalId, kind: "github_response_comment", providerActionId: `github_response:${delivery.id}`,
          status: "processed", payload: { botExternalId: "conflicting-app", agentId: context.fixture.assignedAgentId } });
        if (mode === "legacy_prior_wrong_app" || mode === "legacy_prior_wrong_agent") await db.update(chatActions).set({
          payload: sql`jsonb_set(${chatActions.payload}, ${mode === "legacy_prior_wrong_app" ? "{botExternalId}" : "{agentId}"}, '"another-identity"'::jsonb)`,
        }).where(priorWhere);
        if (mode === "legacy_prior_unlinked") await db.delete(chatMessageLinks).where(eq(chatMessageLinks.deliveryId, context.action.deliveryId!));
        if (mode === "legacy_prior_retargeted") await db.update(chatActions).set({ providerActionId: "github_response:unbound" }).where(priorWhere);
        if (mode.startsWith("legacy_explicit_")) await db.update(chatDeliveries).set({ normalizedEvent: {
          ...delivery.normalizedEvent, githubAuthority: { ...(delivery.normalizedEvent.githubAuthority as object),
            botExternalId: mode === "legacy_explicit_null" ? null : mode === "legacy_explicit_empty" ? ""
              : mode === "legacy_explicit_malformed" ? { appId: "untrusted" } : "another-app" },
        } }).where(eq(chatDeliveries.id, delivery.id));
        if (mode === "legacy_current_app_changed") await db.update(chatEndpoints).set({ botExternalId: randomUUID() })
          .where(eq(chatEndpoints.id, context.endpoint.id));
        if (mode !== "legacy_budget_ingress" && mode !== "legacy_prior_response" && !executionRevalidation) {
          await expect(requestTaskRetry(request)).rejects.toMatchObject({ details: {
            code: "chat_failed_run_retry_not_authorized", reason: "source_authorization", authorityReason: "app_binding",
          } });
          expect((await readAgentWakeupRequestsById(saved.id))[0]).toMatchObject({ status: "skipped", runId: null });
          expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(previousPublications);
          return;
        }
      }
      if (mode === "source_app_changed" || mode === "source_destination_changed") {
        await expect(requestTaskRetry(request)).rejects.toMatchObject({ details: {
          code: "chat_failed_run_retry_not_authorized", reason: "source_authorization",
          authorityReason: mode === "source_app_changed" ? "app_binding" : "destination_binding",
        } });
        expect((await readAgentWakeupRequestsById(saved.id))[0]).toMatchObject({ status: "skipped", runId: null });
        expect((await readHeartbeatRunsById(context.runId))[0]).toMatchObject({ status: "failed" });
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(previousPublications);
        return;
      }
      if (mode.startsWith("committed_succeeded") || mode.startsWith("committed_consumed") || mode === "malformed_previous" || mode === "committed_unknown_publication" || mode === "committed_pending_publication" || mode === "committed_mixed_publication") {
        await expect(requestTaskRetry(request)).rejects.toMatchObject({ details: {
          code: "chat_failed_run_retry_not_authorized",
          ...(mode.endsWith("publication") ? { reason: mode === "committed_consumed_publication" || mode === "committed_succeeded_publication"
            ? "accepted_result_without_new_input" : "prior_result_publication" } : {}),
        } });
        expect(await unadmitted()).toHaveLength(1);
        return;
      }
      const receipt = await requestTaskRetry(request);
      expect(receipt).toMatchObject({ accepted: true });
      const [retry] = await db.select().from(chatActions).where(eq(chatActions.id, receipt.chatActionId!));
      expect(retry.payload).toMatchObject({ commentIds: expectedComments });
      expect(await db.select({ id: chatActions.id }).from(chatActions).where(and(eq(chatActions.id, retry.id), dueChatAction("failed_run_retry")))).toHaveLength(1);
      expect((await readAgentWakeupRequestsById(saved.id))[0]).toMatchObject({ status: "skipped", runId: null });
      expect((await readHeartbeatRunsById(context.runId))[0]).toMatchObject({ status: "failed" });
      if (mode === "source_claimed") await db.update(agentWakeupRequests).set({ status: "queued", runId: context.runId })
        .where(eq(agentWakeupRequests.id, saved.id));
      if (mode === "source_edited") await db.update(issueComments).set({ body: "Edited after Retry" })
        .where(eq(issueComments.id, String(saved.payload.commentId)));
      if (mode === "endpoint_paused") await db.update(chatEndpoints).set({ status: "paused" })
        .where(eq(chatEndpoints.id, context.endpoint.id));
      if (mode === "principal_revoked") await db.update(companyMemberships).set({ status: "suspended" })
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "owner-user")));
      if (realBudgetIngress || mode === "real_queue" || mode === "unreconciled" || mode.startsWith("committed_")) {
        // Capacity prevents a real provider start while exercising production
        // admission, persisted source identity, and queue ownership.
        await db.update(agents).set({ adapterType: "paperclip_runner", status: "running",
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
          .where(eq(agents.id, context.fixture.assignedAgentId));
        await db.insert(heartbeatRuns).values({ companyId, agentId: context.fixture.assignedAgentId,
          status: "running", startedAt: new Date() });
        context.wakeup.mockImplementation(heartbeatService(db).wakeup);
      } else if (mode !== "still_budget_blocked") context.wakeup.mockImplementation(async () => ({ accepted: true }));
      if (mode === "source_edited" || mode === "source_claimed" || mode === "endpoint_paused" || mode === "principal_revoked") {
        expect(await context.service.processFailedChatRunRetry(receipt.chatActionId!)).toMatchObject({ status: "failed" });
        expect(await readAgentWakeupRequestsById(receipt.chatActionId!)).toHaveLength(0);
      } else {
        await context.service.processFailedChatRunRetry(receipt.chatActionId!);
        const [admitted] = await readAgentWakeupRequestsById(receipt.chatActionId!);
        expect(admitted, JSON.stringify({ action: (await db.select().from(chatActions).where(eq(chatActions.id, receipt.chatActionId!)))[0], calls: context.wakeup.mock.calls.length })).toMatchObject({ requestedByActorId: "owner-user",
          payload: { wakeCommentId: saved.payload.commentId },
          status: mode === "still_budget_blocked" ? "skipped" : held ? "deferred_issue_execution" : "queued" });
        expect(context.wakeup.mock.calls.at(-1)![1].contextSnapshot).toMatchObject({
          source: `chat:${provider}`, wakeCommentId: saved.payload.commentId,
        });

        if (executionRevalidation) {
          const heartbeat = heartbeatService(db);
          const originalAuthorize = durableChatWakeup.authorizeFailedChatRunRetryWake;
          const verified: string[] = [];
          const identitySources: Array<{ runId: string; messageId: string | null }> = [];
          const realInitialize = runIdentityModule.initializeRunIdentity;
          const identityProof = vi.spyOn(runIdentityModule, "initializeRunIdentity").mockImplementation(async (database, input) => {
            const identity = await realInitialize(database, input);
            if (input.companyId === companyId && mode === "legacy_execution" && verified.length > 1) {
              identitySources.push({ runId: input.runId, messageId: identity.messageId });
              // Exercise the actual initializer after the real Retry execution
              // authority, without allocating a native provider for this probe.
              throw new Error("certified_retry_identity_probe_complete");
            }
            return identity;
          });
          const executionProof = vi.spyOn(durableChatWakeup, "authorizeFailedChatRunRetryWake").mockImplementation(async (...args) => {
            const input = args[2];
            const authorized = await originalAuthorize(...args);
            if (input.companyId === companyId && input.phase === "execution") {
              expect(authorized).toBe(true);
              if (!verified.length && mode === "legacy_execution") {
                // Exercise the actual dispatch authorization transaction after
                // real admission; restore each contradiction before the next.
                const tx = args[1];
                for (const changed of [{ runId: context.runId }, { companyId: randomUUID() },
                  { agentId: randomUUID() }, { issueId: randomUUID() }]) {
                  await expect(originalAuthorize(args[0], tx, { ...input, ...changed })).rejects.toThrow();
                }
                const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId!));
                const [task] = await tx.select().from(issues).where(eq(issues.id, context.issue.id));
                const [wake] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, input.wakeupRequestId!));
                const [coordinator] = await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, context.runId));
                const [nativeResult] = await tx.select().from(nativeRunResults).where(eq(nativeRunResults.runId, context.runId));
                const [lease] = await tx.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, context.runId));
                const [sourceComment] = await tx.select().from(issueComments).where(eq(issueComments.id, saved.payload.commentId as string));
                const [endpoint] = await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, context.endpoint.id));
                const resolved = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
                  eq(issueRecoveryActions.sourceIssueId, context.issue.id), eq(issueRecoveryActions.status, "resolved")));
                const deny = async (mutate: () => Promise<unknown>, restore: () => Promise<unknown>) => {
                  await mutate();
                  try { await expect(originalAuthorize(...args)).rejects.toThrow(); }
                  finally { await restore(); }
                };
                await deny(() => tx.update(heartbeatRuns).set({ contextSnapshot: { ...current.contextSnapshot, issueId: randomUUID() } }).where(eq(heartbeatRuns.id, current.id)),
                  () => tx.update(heartbeatRuns).set({ contextSnapshot: current.contextSnapshot }).where(eq(heartbeatRuns.id, current.id)));
                await deny(() => tx.update(heartbeatRuns).set({ contextSnapshot: { ...current.contextSnapshot, explicitUserContinuation: {
                  ...current.contextSnapshot!.explicitUserContinuation as object, commentId: randomUUID() } } }).where(eq(heartbeatRuns.id, current.id)),
                  () => tx.update(heartbeatRuns).set({ contextSnapshot: current.contextSnapshot }).where(eq(heartbeatRuns.id, current.id)));
                await deny(() => tx.update(agentWakeupRequests).set({ runId: context.runId }).where(eq(agentWakeupRequests.id, wake.id)),
                  () => tx.update(agentWakeupRequests).set({ runId: wake.runId }).where(eq(agentWakeupRequests.id, wake.id)));
                await deny(() => tx.update(issues).set({ executionRunId: context.runId }).where(eq(issues.id, task.id)),
                  () => tx.update(issues).set({ executionRunId: task.executionRunId }).where(eq(issues.id, task.id)));
                await deny(() => tx.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, task.id)),
                  () => tx.update(issues).set({ assigneeAgentId: task.assigneeAgentId }).where(eq(issues.id, task.id)));
                await deny(() => tx.update(issueComments).set({ body: "Changed authorized message" }).where(eq(issueComments.id, sourceComment.id)),
                  () => tx.update(issueComments).set({ body: sourceComment.body, updatedAt: sourceComment.updatedAt }).where(eq(issueComments.id, sourceComment.id)));
                await deny(() => tx.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, endpoint.id)),
                  () => tx.update(chatEndpoints).set({ status: endpoint.status }).where(eq(chatEndpoints.id, endpoint.id)));
                await deny(() => tx.update(agents).set({ status: "paused" }).where(eq(agents.id, input.agentId)),
                  () => tx.update(agents).set({ status: "running" }).where(eq(agents.id, input.agentId)));
                await deny(() => tx.update(nativeRunFinalizations).set({ leaseOwner: "still-running" }).where(eq(nativeRunFinalizations.runId, coordinator.runId)),
                  () => tx.update(nativeRunFinalizations).set({ leaseOwner: coordinator.leaseOwner }).where(eq(nativeRunFinalizations.runId, coordinator.runId)));
                await deny(async () => { adapterExecutionControls.set(context.runId, createAdapterExecutionControl()); },
                  async () => { adapterExecutionControls.get(context.runId)?.finish(); adapterExecutionControls.delete(context.runId); });
                await deny(() => tx.update(agentWakeupRequests).set({ status: "running" }).where(eq(agentWakeupRequests.id, wake.id)),
                  () => tx.update(agentWakeupRequests).set({ status: wake.status }).where(eq(agentWakeupRequests.id, wake.id)));
                await deny(() => tx.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(heartbeatRuns.id, context.runId)),
                  () => tx.update(heartbeatRuns).set({ controllerLeaseExpiresAt: null }).where(eq(heartbeatRuns.id, context.runId)));
                await deny(() => tx.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, lease.id)),
                  () => tx.update(environmentLeases).set({ metadata: lease.metadata }).where(eq(environmentLeases.id, lease.id)));
                await deny(() => tx.update(nativeRunResults).set({ resultJson: { terminal: { runTerminalState: "succeeded" } } }).where(eq(nativeRunResults.id, nativeResult.id)),
                  () => tx.update(nativeRunResults).set({ resultJson: nativeResult.resultJson }).where(eq(nativeRunResults.id, nativeResult.id)));
                for (const action of resolved) await deny(() => tx.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id)),
                  () => tx.update(issueRecoveryActions).set({ evidence: action.evidence }).where(eq(issueRecoveryActions.id, action.id)));
              }
              verified.push(input.runId!);
              if (mode === "legacy_execution" && verified.length > 1) return authorized;
              // Stop after the real execution authority boundary. This produces
              // the exact never-started bootstrap shape without a provider call.
              throw conflict("The exact failed chat request can no longer be retried safely. Check its current connection, access, and recovery state.",
                { code: "chat_failed_run_retry_not_authorized" });
            }
            return authorized;
          });
          try {
            await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
              eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"), isNull(heartbeatRuns.wakeupRequestId)));
            await db.update(agents).set({ status: "idle" }).where(eq(agents.id, context.fixture.assignedAgentId));
            await heartbeat.resumeQueuedRuns();
            await heartbeat.drainActiveRunExecutions();
            const [firstAttempt] = await readHeartbeatRunsById(admitted.runId!);
            expect(firstAttempt).toMatchObject({ status: "failed", errorCode: "chat_failed_run_retry_not_authorized",
              resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
            expect(verified).toEqual([firstAttempt.id]);
            if (mode === "legacy_execution_log") await db.update(heartbeatRuns).set({ logBytes: 1 }).where(eq(heartbeatRuns.id, firstAttempt.id));
            if (mode === "legacy_execution_profile") await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" }, unexpectedExecution: true } }).where(eq(heartbeatRuns.id, firstAttempt.id));
            if (mode === "legacy_execution_controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(heartbeatRuns.id, firstAttempt.id));
            if (mode === "legacy_execution_event") await db.update(heartbeatRunEvents).set({ message: "different diagnostic" }).where(and(eq(heartbeatRunEvents.runId, firstAttempt.id), eq(heartbeatRunEvents.seq, 1)));
            if (mode === "legacy_execution_intent") await db.update(agentWakeupRequests).set({ runId: context.runId }).where(eq(agentWakeupRequests.id, receipt.requestId!));
            if (mode === "legacy_execution_lease") await db.insert(environmentLeases).values({ companyId, heartbeatRunId: firstAttempt.id,
              issueId: context.issue.id, provider: "daytona", providerLeaseId: "unresolved-bootstrap-lease", status: "active", leasePolicy: "ephemeral" });
            const next = await requestTaskRetry({ ...request, observedRunId: firstAttempt.id, idempotencyKey: randomUUID() });
            expect(next).toMatchObject({ accepted: true });
            await context.service.processFailedChatRunRetry(next.chatActionId!);
            await heartbeat.resumeQueuedRuns();
            await heartbeat.drainActiveRunExecutions();
            const [nextWake] = await readAgentWakeupRequestsById(next.chatActionId!);
            if (mode !== "legacy_execution") {
              expect(nextWake).toBeUndefined();
              expect(verified).toEqual([firstAttempt.id]);
              expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(previousPublications);
              return;
            }
            expect(nextWake.runId).toBeTruthy();
            expect(nextWake.runId).not.toBe(firstAttempt.id);
            const [nextRun] = await readHeartbeatRunsById(nextWake.runId!);
            expect(nextRun).toMatchObject({ retryOfRunId: firstAttempt.id, wakeupRequestId: next.chatActionId,
              contextSnapshot: { source: "chat:github", wakeCommentId: saved.payload.commentId,
                wakeCommentIds: [saved.payload.commentId] } });
            expect(verified).toEqual([firstAttempt.id, nextRun.id]);
            expect(identitySources).toEqual([{ runId: nextRun.id, messageId: saved.payload.commentId }]);
            await expect(chatRunSourceMessageId(db, nextRun, { provider: "github" })).resolves.toBe(saved.payload.commentId);
            expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.contextSnapshot?.wakeCommentId === saved.payload.commentId))
              .toHaveLength(2);
            expect((await readHeartbeatRunsById(context.runId))[0]).toMatchObject({ status: "failed" });
            expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(previousPublications);
            return;
          } finally { executionProof.mockRestore(); identityProof.mockRestore(); await heartbeat.drainActiveRunExecutions(); }
        }
        await context.service.processFailedChatRunRetry(receipt.chatActionId!);
        expect(await unadmitted()).toHaveLength(mode === "still_budget_blocked" ? 1 : 0);
        if (held) {
          expect(admitted.runId).toBeNull();
          await reconcileTaskChatRetryReceipts(db);
          await context.service.processFailedChatRunRetry(receipt.chatActionId!);
          expect((await readAgentWakeupRequestsById(receipt.chatActionId!))[0]).toMatchObject({
            status: "deferred_issue_execution", runId: null });
          expect((await db.select().from(issueRecoveryActions).where(and(
            eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, context.issue.id)))))
            .toEqual(expect.arrayContaining([expect.objectContaining({ status: "active" })]));
          if (mode === "committed_delayed_cleanup" || queuedBoard) {
            const [boardComment] = queuedBoard ? await db.insert(issueComments).values({
              companyId, issueId: context.issue.id, authorType: "user", authorUserId: "owner-user",
              body: "Keep this independent continuation for its own authorized turn.",
            }).returning() : [];
            const [boardWake] = boardComment ? await db.insert(agentWakeupRequests).values({ companyId,
              agentId: context.fixture.assignedAgentId, source: "automation", triggerDetail: "system",
              reason: "issue_commented", status: "deferred_issue_execution",
              requestedByActorType: "user", requestedByActorId: "owner-user",
              payload: { issueId: context.issue.id, commentId: boardComment.id, wakeCommentIds: [boardComment.id],
                _paperclipWakeContext: { issueId: context.issue.id, taskKey: context.issue.id,
                  source: "issue.comment.reopen", wakeReason: "issue_commented",
                  wakeCommentId: boardComment.id, wakeCommentIds: [boardComment.id] } },
            }).returning() : [];
            const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, context.runId));
            await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
              remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) },
            }).where(eq(environmentLeases.id, lease.id));
            await reconcileTaskChatRetryReceipts(db);
            await context.service.processFailedChatRunRetry(receipt.chatActionId!);
            let [resumed] = await readAgentWakeupRequestsById(receipt.chatActionId!);
            expect(resumed).toMatchObject({ id: admitted.id, status: "queued" });
            expect(resumed.runId).toBeTruthy();
            expect((await readHeartbeatRunsById(resumed.runId!))[0]).toMatchObject({ status: "queued",
              contextSnapshot: { wakeCommentId: saved.payload.commentId } });
            if (boardWake) {
              const heartbeat = heartbeatService(db);
              if (mode.startsWith("committed_board_existing")) {
                // Persist the historical producer's merged batch, then let real
                // dispatch reject it before any identity or provider starts.
                const [queued] = await readHeartbeatRunsById(resumed.runId!);
                if (mode === "committed_board_existing_coalesced") {
                  await db.update(chatActions).set({ status: "processed" }).where(inArray(chatActions.id, savedInputs.map(source => source.id)));
                  await db.update(agentWakeupRequests).set({ status: "coalesced", runId: queued.id,
                    payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ coalescedIntoWakeupRequestId: resumed.id })}::jsonb`,
                  }).where(inArray(agentWakeupRequests.id, savedInputs.map(source => source.id)));
                }
                const mixedIds = [boardComment!.id, ...expectedComments];
                // Replaying this test with the queue fix reverted uses the old
                // producer's actual persisted merge. With the fixed producer,
                // retain historical state using its shared serializers.
                if (!(queued.contextSnapshot?.wakeCommentIds as string[])?.includes(boardComment!.id)) {
                  const { withQueuedCommentIdsInRunContext, withQueuedCommentIdsInWakePayload } =
                    await import("../../services/issue-queued-comment-queue.js");
                  await db.update(heartbeatRuns).set({ contextSnapshot:
                    withQueuedCommentIdsInRunContext(queued.contextSnapshot, mixedIds, [boardWake.id]) })
                    .where(eq(heartbeatRuns.id, queued.id));
                  await db.update(agentWakeupRequests).set({ payload:
                    withQueuedCommentIdsInWakePayload(resumed.payload, mixedIds) })
                    .where(eq(agentWakeupRequests.id, resumed.id));
                  await db.update(agentWakeupRequests).set({ status: "coalesced", runId: queued.id,
                    finishedAt: new Date() }).where(eq(agentWakeupRequests.id, boardWake.id));
                }
                expect((await readHeartbeatRunsById(queued.id))[0].contextSnapshot).toMatchObject({
                  wakeCommentId: expectedComments.at(-1), wakeCommentIds: mixedIds,
                  queuedCommentSourceWakeIds: [boardWake.id],
                });
                expect((await readAgentWakeupRequestsById(boardWake.id))[0]).toMatchObject({
                  status: "coalesced", runId: queued.id, payload: { issueId: context.issue.id },
                });
                expect((await readAgentWakeupRequestsById(boardWake.id))[0].payload)
                  .not.toHaveProperty("coalescedIntoWakeupRequestId");
                await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
                  eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"), isNull(heartbeatRuns.wakeupRequestId)));
                await db.update(agents).set({ status: "idle" }).where(eq(agents.id, context.fixture.assignedAgentId));
                await heartbeat.resumeQueuedRuns();
                await heartbeat.drainActiveRunExecutions();
                const [failed] = await readHeartbeatRunsById(queued.id);
                expect(failed).toMatchObject({ status: "failed", errorCode: "chat_failed_run_retry_not_authorized",
                  resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
                await db.insert(heartbeatRuns).values({ companyId, agentId: context.fixture.assignedAgentId,
                  status: "running", startedAt: new Date() });
                await db.update(agents).set({ status: "running" }).where(eq(agents.id, context.fixture.assignedAgentId));
                const nextInput = { ...request, observedRunId: failed.id, idempotencyKey: randomUUID() };
                if (mode.endsWith("source_edited")) await db.update(issueComments).set({ body: "Changed external source" })
                  .where(eq(issueComments.id, String(saved.payload.commentId)));
                if (mode.endsWith("board_edited")) await db.update(issueComments).set({ body: "Changed board source",
                  updatedAt: new Date(boardComment!.createdAt.getTime() + 1) })
                  .where(eq(issueComments.id, boardComment!.id));
                if (mode.endsWith("controller")) await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
                  .where(eq(heartbeatRuns.id, failed.id));
                if (mode.endsWith("allocation")) await db.insert(environmentLeases).values({ companyId,
                  heartbeatRunId: failed.id, issueId: context.issue.id, provider: "daytona", providerLeaseId: "unknown-executor",
                  status: "active", leasePolicy: "ephemeral" });
                if (mode.endsWith("receipt")) await db.update(agentWakeupRequests).set({ status: "claimed" })
                  .where(eq(agentWakeupRequests.id, boardWake.id));
                if (mode.endsWith("source_owner")) await db.update(agentWakeupRequests).set({
                  status: "coalesced", runId: context.runId,
                  payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ coalescedIntoWakeupRequestId: resumed.id })}::jsonb`,
                }).where(eq(agentWakeupRequests.id, saved.id));
                if (mode.endsWith("delivered")) await db.insert(heartbeatRuns).values({ companyId,
                  agentId: context.fixture.assignedAgentId, status: "succeeded", finishedAt: new Date(),
                  createdAt: new Date(failed.createdAt.getTime() - 1),
                  contextSnapshot: { issueId: context.issue.id, wakeCommentIds:
                    [mode.endsWith("source_delivered") ? saved.payload.commentId : boardComment!.id] },
                });
                const inputIds = [boardWake.id, ...savedInputs.map(source => source.id)];
                const before = await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds)).orderBy(asc(agentWakeupRequests.id));
                if (mode === "committed_board_existing_identity_contended") {
                  const events: string[] = [];
                  const topics = [DELIVERY_QUEUES.deferredExecutionReceipts, CHAT_ACTION_QUEUES.failed_run_retry];
                  const unsubscribes = topics.map(topic => subscribeDatabaseWork(db, topic, event => events.push(event)));
                  const rollback = new Error("rollback restored Retry preparation");
                  let rolledBackActionId: string | undefined;
                  try {
                    await expect(db.transaction(async tx => {
                      events.length = 0;
                      const staged = await requestTaskRetry({ ...nextInput, db: tx as unknown as Db });
                      rolledBackActionId = staged.chatActionId ?? undefined;
                      expect(rolledBackActionId).toBeTruthy();
                      expect(events).toContain("intent");
                      expect(events).not.toContain("settled");
                      expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds))
                        .orderBy(asc(agentWakeupRequests.id))).toEqual(before);
                      expect(await tx.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                        eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toHaveLength(1);
                      throw rollback;
                    })).rejects.toBe(rollback);
                    for (const topic of topics) {
                      await reconcileDatabaseWork(db, topic);
                      expect(databaseWorkPending(db, topic)).toBe(false);
                    }
                    expect(await db.select().from(chatActions).where(eq(chatActions.id, rolledBackActionId!))).toEqual([]);
                    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                      eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toEqual([]);
                    expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds))
                      .orderBy(asc(agentWakeupRequests.id))).toEqual(before);
                  } finally { unsubscribes.forEach(unsubscribe => unsubscribe()); }
                }
                if (mode !== "committed_board_existing" && mode !== "committed_board_existing_coalesced" && mode !== "committed_board_existing_identity_contended" && mode !== "committed_board_existing_identity_expired") {
                  const continued = await requestTaskRetry(nextInput);
                  expect(continued).toMatchObject({ accepted: true, chatActionId: undefined });
                  const [intent] = await readAgentWakeupRequestsById(continued.requestId!);
                  expect(intent).toMatchObject({ reason: "task_retry", requestedByActorId: "owner-user",
                    payload: { taskRetry: { sourceRunId: failed.id } } });
                  expect((intent.payload!.taskRetry as Record<string, unknown>).chatActionId).toBeUndefined();
                  expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds)).orderBy(asc(agentWakeupRequests.id)))
                    .toEqual(before);
                  return;
                }
                const app = express();
                app.use(express.json());
                app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
                app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: context.service }));
                app.use(errorHandler);
                const httpRequest = (await import("supertest")).default;
                const retryHttp = () => httpRequest(app).post(`/api/issues/${context.issue.id}/retry`).send({
                  idempotencyKey: nextInput.idempotencyKey, observedRunId: nextInput.observedRunId,
                }).expect(202);
                const restoredRetryWake = vi.fn(heartbeat.wakeup);
                const retryWithIdentityContention = async () => {
                  if (mode !== "committed_board_existing_identity_contended" && mode !== "committed_board_existing_identity_expired") return retryHttp();
                  let release = () => {};
                  const held = new Promise<void>(resolve => { release = resolve; });
                  let acquired = () => {};
                  const locked = new Promise<void>(resolve => { acquired = resolve; });
                  const holding = db.transaction(async tx => {
                    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${companyId}:${saved.principalId}`}, 0))`);
                    acquired(); await held;
                  });
                  try {
                    await locked;
                    const response = await retryHttp();
                    if (mode === "committed_board_existing_identity_expired" || mode === "committed_board_existing_identity_contended")
                      await context.service.processFailedChatRunRetry(response.body.chatActionId);
                    if (mode === "committed_board_existing_identity_contended") context.wakeup
                      .mockImplementation(restoredRetryWake).mockRejectedValueOnce(new Error("retry_admission_unavailable_before_receipt"));
                    expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds))
                      .orderBy(asc(agentWakeupRequests.id))).toEqual(before);
                    return response;
                  } finally { release(); await holding; }
                };
                const next = (await retryWithIdentityContention()).body;
                expect(next).toMatchObject({ accepted: true });
                if (mode === "committed_board_existing_identity_expired") {
                  const [pending] = await db.select().from(chatActions).where(eq(chatActions.id, next.chatActionId!));
                  expect(pending.payload).toMatchObject({ sourceAuthorizationPending: true, restoreUnstartedInput: true });
                  const deadline = Date.now() + 5_000;
                  await db.update(chatActions).set({ result: { ...pending.result,
                    identityContentionDeadlineAt: new Date(deadline).toISOString(), retryAt: new Date(0).toISOString() } })
                    .where(eq(chatActions.id, pending.id));
                  const realPermission = taskRetryModule.taskRetryMutationAllowed;
                  const permission = vi.spyOn(taskRetryModule, "taskRetryMutationAllowed").mockImplementation(async (database, input) => {
                    const allowed = await realPermission(database, input);
                    if (input.companyId === companyId) {
                      expect(await database.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                        eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toHaveLength(1);
                      await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 1));
                    }
                    return allowed;
                  });
                  const publications = await readChatPublicationsByEndpointId(context.endpoint.id);
                  const runIds = (await readHeartbeatRunsByCompanyId(companyId)).map(run => run.id).sort();
                  context.wakeup.mockClear();
                  try {
                    await context.service.processFailedChatRunRetry(pending.id);
                    expect(permission).toHaveBeenCalled();
                    expect((await db.select().from(chatActions).where(eq(chatActions.id, pending.id)))[0])
                      .toMatchObject({ status: "failed", payload: { sourceAuthorizationPending: true },
                        result: { code: "failed_chat_retry_contention_expired" } });
                    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                      eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toEqual([]);
                    expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds))
                      .orderBy(asc(agentWakeupRequests.id))).toEqual(before);
                    expect(context.wakeup).not.toHaveBeenCalled();
                    expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(publications);
                    expect((await readAgentWakeupRequestsById(next.requestId!))[0]).toMatchObject({ status: "failed", runId: null });
                    expect((await readHeartbeatRunsByCompanyId(companyId)).map(run => run.id).sort()).toEqual(runIds);
                  } finally { permission.mockRestore(); }
                  return;
                }
                expect((await retryHttp()).body.requestId).toBe(next.requestId);
                if (mode === "committed_board_existing_identity_contended") await vi.waitFor(async () => {
                  await context.service.processFailedChatRunRetries();
                  expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                    eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toHaveLength(1);
                }, { timeout: 5_000, interval: 50 });
                expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                  eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toHaveLength(1);
                await vi.waitFor(async () => {
                  expect(await context.service.processFailedChatRunRetry(next.chatActionId!)).toMatchObject({ status: "queued" });
                  [resumed] = await readAgentWakeupRequestsById(next.chatActionId!);
                  expect(resumed).toMatchObject({ companyId, agentId: context.fixture.assignedAgentId,
                    requestedByActorType: "user", requestedByActorId: "owner-user",
                    payload: { taskRetryRequestId: next.requestId, retryOfRunId: failed.id } });
                  expect(resumed.runId).toBeTruthy();
                  await reconcileTaskChatRetryReceipts(db, { companyId, requestId: next.requestId! });
                  expect((await readAgentWakeupRequestsById(next.requestId!))[0]?.runId).toBe(resumed.runId);
                }, { timeout: 5_000, interval: 50 });
                if (mode === "committed_board_existing_identity_contended") {
                  expect(restoredRetryWake).toHaveBeenCalledOnce();
                  expect(restoredRetryWake).toHaveBeenCalledWith(context.fixture.assignedAgentId, expect.objectContaining({
                    taskRetryRequestId: next.requestId, requestedByActorType: "user", requestedByActorId: "owner-user",
                    contextSnapshot: expect.objectContaining({ taskRetryRequestId: next.requestId,
                      chatFailedRunRetry: { version: 1, actionId: next.chatActionId, failedRunId: failed.id } }),
                  }));
                  expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run =>
                    run.contextSnapshot?.taskRetryRequestId === next.requestId).map(run => run.id)).toEqual([resumed.runId]);
                  expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                    eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toHaveLength(1);
                }
                if (mode === "committed_board_existing_coalesced") {
                  const restored = await db.select().from(agentWakeupRequests)
                    .where(inArray(agentWakeupRequests.id, savedInputs.map(source => source.id)));
                  expect(restored).toHaveLength(10);
                  expect(restored.every(wake => wake.status === "coalesced" && wake.runId === resumed.runId)).toBe(true);
                }
                expect((await readHeartbeatRunsById(failed.id))[0].contextSnapshot).toEqual(failed.contextSnapshot);
              }
              const realInitialize = runIdentityModule.initializeRunIdentity;
              const initialized: Array<{ runId: string; messageId: string | null }> = [];
              expect((await readAgentWakeupRequestsById(boardWake.id))[0])
                .toMatchObject({ status: "deferred_issue_execution", runId: null });
              const probe = vi.spyOn(runIdentityModule, "initializeRunIdentity").mockImplementation(async (database, input) => {
                const identity = await realInitialize(database, input);
                if (input.companyId !== companyId) return identity;
                initialized.push({ runId: input.runId, messageId: identity.messageId });
                throw new Error("certified_batch_identity_probe_complete");
              });
              try {
                await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
                  eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"), isNull(heartbeatRuns.wakeupRequestId)));
                await db.update(agents).set({ status: "idle" }).where(eq(agents.id, context.fixture.assignedAgentId));
                await heartbeat.resumeQueuedRuns();
                await heartbeat.drainActiveRunExecutions();
                const [successor] = await readHeartbeatRunsById(resumed.runId!);
                expect(successor).toMatchObject({ error: "certified_batch_identity_probe_complete",
                  contextSnapshot: { wakeCommentIds: expectedComments } });
                expect(successor.contextSnapshot?.queuedCommentSourceWakeIds).toBeUndefined();
                const [boardReceipt] = await readAgentWakeupRequestsById(boardWake.id);
                expect(boardReceipt.runId).toBeTruthy();
                expect(boardReceipt.runId).not.toBe(resumed.runId);
                expect(initialized).toEqual([
                  { runId: resumed.runId, messageId: saved.payload.commentId },
                  { runId: boardReceipt.runId, messageId: boardComment!.id },
                ]);
                expect((await readHeartbeatRunsById(boardReceipt.runId!))[0]).toMatchObject({
                  contextSnapshot: { wakeCommentIds: [boardComment!.id] },
                });
              } finally { probe.mockRestore(); await heartbeat.drainActiveRunExecutions(); }
            }
            await context.service.processFailedChatRunRetry(receipt.chatActionId!);
            await reconcileTaskChatRetryReceipts(db);
            expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run =>
              run.contextSnapshot?.taskRetryRequestId === receipt.requestId)).toHaveLength(1);
            expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, context.runId)))[0])
              .toMatchObject({ phase: "committed" });
          }
        }
        if (mode === "real_queue" || mode === "committed_failure" || mode === "committed_failed_publication") {
          expect(admitted.runId).toBeTruthy();
          expect((await readHeartbeatRunsById(admitted.runId!))[0]).toMatchObject({ status: "queued",
            contextSnapshot: { source: `chat:${provider}`, wakeCommentId: saved.payload.commentId } });
          if (provider === "github") expect(await resolveRunScopedMentionedSkillKeys({ db, companyId,
            issueId: context.issue.id, commentIds: [String(saved.payload.commentId)] })).toEqual([skill.key]);
          await reconcileTaskChatRetryReceipts(db);
          expect((await readAgentWakeupRequestsById(receipt.requestId!))[0]).toMatchObject({
            status: "coalesced", runId: admitted.runId });
          const calls = context.wakeup.mock.calls.length;
          await db.update(chatActions).set({ status: "issued", result: null, updatedAt: new Date() })
            .where(eq(chatActions.id, receipt.chatActionId!));
          await context.service.processFailedChatRunRetry(receipt.chatActionId!);
          expect(context.wakeup.mock.calls).toHaveLength(calls);
          expect((await db.select().from(chatActions).where(eq(chatActions.id, receipt.chatActionId!)))[0])
            .toMatchObject({ status: "processed" });
          if (mode === "committed_failure") {
            expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, context.runId)))[0])
              .toMatchObject({ phase: "committed" });
            expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, context.runId)))[0])
              .toMatchObject({ schemaStatus: "accepted", resultJson: { terminal: { runTerminalState: "failed" } } });
          }
        }
      }
      expect((await readAgentWakeupRequestsById(saved.id))[0]).toMatchObject(mode === "source_claimed"
        ? { status: "queued", runId: context.runId } : mode === "committed_board_existing_coalesced"
          ? { status: "coalesced", runId: expect.any(String) } : { status: "skipped", runId: null });
      expect((await readHeartbeatRunsById(context.runId))[0]).toMatchObject({ status: "failed" });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(previousPublications);
    } finally { await context.service.shutdown(); }
  });

  it("retries an exact GitHub source denied by pre-provider reviewed attestation without rewriting its failure", async () => {
    const context = await failedReviewedGitHubRetryFixture();
    try {
      const [original] = await readHeartbeatRunsById(context.runId);
      const [originalSource] = await readChatActionsById(context.action.id);
      const stage = () =>
        db.transaction((tx) =>
          context.service.prepareFailedChatRunRetry(tx, {
            companyId: context.fixture.companyId,
            issueId: context.issue.id,
            agentId: context.fixture.assignedAgentId,
            failedRunId: context.runId,
            initiatedByUserId: "owner-user",
          }),
        );
      const first = await stage();
      expect(await stage()).toEqual(first);
      await expect(
        context.service.processFailedChatRunRetry(first.actionId),
      ).resolves.toMatchObject({ status: "queued" });
      await context.service.processFailedChatRunRetry(first.actionId);
      const receipts = await readAgentWakeupRequestsById(first.actionId);
      expect(receipts).toEqual([
        expect.objectContaining({
          companyId: context.fixture.companyId,
          agentId: context.fixture.assignedAgentId,
          requestedByActorType: context.receipt.requestedByActorType,
          requestedByActorId: context.receipt.requestedByActorId,
          payload: expect.objectContaining({
            issueId: context.issue.id,
            taskKey: context.issue.identifier,
            wakeCommentIds: [context.action.payload.commentId],
            retryOfRunId: context.runId,
          }),
        }),
      ]);
      expect(
        await readHeartbeatRunsById(context.runId),
      ).toEqual([original]);
      expect(
        await readChatActionsById(context.action.id),
      ).toEqual([originalSource]);
      expect(
        await db
          .select()
          .from(nativeRunFinalizations)
          .where(eq(nativeRunFinalizations.runId, context.runId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(nativeRunResults)
          .where(eq(nativeRunResults.runId, context.runId)),
      ).toEqual([]);
    } finally {
      await context.service.shutdown();
    }
  });

  it.each([
    "author_bot",
    "outbound_link",
    "body_claims_bot",
  ])(
    "settles GitHub self-update receipts without orphan retries for %s",
    async (mode) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, service, wakeup, webhookSecret } =
        await configuredGitHubEndpoint(fixture);
      // Recover only this fixture's ingress and delivery. A global sweep can
      // drain unrelated fixtures' retries and exceed the test's time budget.
      const processFixtureDelivery = async () => {
        const [ingress] = await db
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "github_webhook_ingress"),
              eq(
                chatActions.providerActionId,
                "github_webhook_ingress:bot-update-exact",
              ),
            ),
          );
        expect(ingress).toBeDefined();
        await service.processPendingGitHubWebhookIngress(1, ingress!.id);
        const [delivery] = await db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.eventKind, "message_updated"),
            ),
          );
        expect(delivery).toBeDefined();
        await service.processPendingDeliveries(1, delivery!.id);
      };
      const fixtureWakeups = () =>
        wakeup.mock.calls.filter((call) => call[0] === fixture.assignedAgentId);
      const thread = makeThread({
        channelId: "paperclipai/paperclip",
        id:
          mode === "outbound_review_link"
            ? "github:paperclipai/paperclip:84:rc:99080"
            : "github:paperclipai/paperclip:issue:84",
        name: "paperclipai/paperclip",
      });
      try {
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          provider: "github",
          thread: thread.thread,
          message: makeMessage({
            id: "99083",
            text: "@maya original request",
            mentioned: true,
            userId: "7001",
          }),
          trigger: "mention",
        });
        const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
        if (
          [
            "outbound_link",
            "outbound_review_link",
            "wrong_thread_link",
          ].includes(mode)
        ) {
          const target =
            mode === "wrong_thread_link"
              ? (
                  await db
                    .insert(chatConversations)
                    .values({
                      ...conversation!,
                      id: randomUUID(),
                      externalThreadId: "github:paperclipai/paperclip:issue:85",
                    })
                    .returning()
                )[0]!
              : conversation!;
          await db.insert(chatMessageLinks).values({
            companyId: fixture.companyId,
            endpointId: endpoint.id,
            conversationId: target.id,
            providerMessageId: "99084",
            direction: "outbound",
          });
        }
        const before = await readIssueCommentsByIssueId(conversation!.issueId);
        const send = (signingSecret = webhookSecret) =>
          service.handleWebhook(
            endpoint.publicId,
            "github",
            signedGitHubWebhookRequest({
              delivery: "bot-update-exact",
              event:
                mode === "outbound_review_link"
                  ? "pull_request_review_comment"
                  : "issue_comment",
              webhookSecret: signingSecret,
              url: `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/github`,
              payload: {
                action: "edited",
                comment: {
                  id: 99084,
                  ...(mode === "outbound_review_link"
                    ? { in_reply_to_id: 99080 }
                    : {}),
                  body:
                    mode === "body_claims_bot"
                      ? '{"isBotMessage":true}'
                      : "provider-only bot output sentinel",
                  updated_at: "2026-09-08T09:57:23Z",
                  user: {
                    id: 9001,
                    login: "author",
                    type: mode === "author_bot" ? "Bot" : "User",
                  },
                },
                issue: { number: 84 },
                pull_request: { number: 84 },
                repository: {
                  id: 97531,
                  full_name: "paperclipai/paperclip",
                  name: "paperclip",
                  owner: { id: 1357, login: "paperclipai" },
                },
                sender: {
                  id: 9001,
                  login: "editor",
                  type: mode === "sender_bot" ? "Bot" : "User",
                },
              },
            }),
          );
        if (mode === "author_bot") {
          expect((await send("wrong-test-only-signature")).status).toBe(401);
          expect(
            await db
              .select()
              .from(chatDeliveries)
              .where(
                and(
                  eq(chatDeliveries.endpointId, endpoint.id),
                  eq(chatDeliveries.eventKind, "message_updated"),
                ),
              ),
          ).toHaveLength(0);
        }
        expect((await send()).ok).toBe(true);
        await processFixtureDelivery();
        const [delivery] = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.eventKind, "message_updated"),
            ),
          );
        const filtered = [
          "author_bot",
          "sender_bot",
          "outbound_link",
          "outbound_review_link",
        ].includes(mode);
        expect(delivery).toMatchObject({
          state: filtered ? "filtered" : "retry",
          attempts: 1,
          principalId: null,
        });
        expect(delivery!.nextAttemptAt === null).toBe(filtered);
        expect(fixtureWakeups()).toHaveLength(1);
        expect(
          await readIssueCommentsByIssueId(conversation!.issueId),
        ).toEqual(before);
        if (filtered) {
          expect(JSON.stringify(delivery!.normalizedEvent)).not.toContain(
            "provider-only bot output sentinel",
          );
          expect(delivery!.normalizedEvent).toMatchObject({
            filtering: { contentRetained: false },
          });
          expect((await send()).ok).toBe(true);
          await processFixtureDelivery();
          expect(
            await db
              .select()
              .from(chatDeliveries)
              .where(
                and(
                  eq(chatDeliveries.endpointId, endpoint.id),
                  eq(chatDeliveries.eventKind, "message_updated"),
                ),
              ),
          ).toEqual([delivery]);
          expect(fixtureWakeups()).toHaveLength(1);
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "github",
            thread: thread.thread,
            message: makeMessage({
              id: "99085",
              text: "Follow-up after bot edit",
              userId: "7001",
            }),
            trigger: "subscribed_message",
          });
          expect(fixtureWakeups()).toHaveLength(2);
        }
      } finally {
        await service.shutdown();
      }
    },
  );

  it.each([false, true])("orders reversed GitHub edit and delete callbacks behind their durable root (root processed before replay: %s)", async (rootProcessedFirst) => {
    const fixture = await seedCompany();
    const deferred: Array<() => void | Promise<void>> = [];
    const { callbacks, endpoint, service, wakeup, webhookSecret } =
      await configuredGitHubEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    const drainDeferred = async () => {
      let processed = 0;
      while (deferred.length > 0) {
        if (processed++ >= 20)
          throw new Error("GitHub deferred test work did not quiesce");
        await deferred.shift()?.();
      }
    };
    const thread = makeThread({
      channelId: "paperclipai/chat-lifecycle-order",
      id: "github:paperclipai/chat-lifecycle-order:issue:84",
      name: "paperclipai/chat-lifecycle-order",
    });
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "repository",
      providerResourceId: "paperclipai/chat-lifecycle-order",
      label: "paperclipai/chat-lifecycle-order",
      availability: "available",
      enabled: true,
    });
    const original = {
      ...makeMessage({
        id: "99084",
        text: "@maya original ordered GitHub request",
        mentioned: true,
        userId: "7001",
      }),
      metadata: {
        dateSent: new Date("2026-09-05T11:59:59Z"),
        edited: false,
      },
    } as Message;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: original,
      trigger: "mention",
    });

    const sendLifecycle = (
      action: "edited" | "deleted",
      body: string,
      deliverySuffix: string = action,
      updatedAt = "2026-09-05T12:00:00Z",
    ) =>
      service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: `delivery-84-${deliverySuffix}`,
          event: "issue_comment",
          payload: {
            action,
            comment: {
              id: 99084,
              body,
              updated_at: updatedAt,
            },
            issue: { number: 84 },
            repository: {
              id: 98400,
              full_name: "paperclipai/chat-lifecycle-order",
              name: "chat-lifecycle-order",
              owner: { id: 1357, login: "paperclipai" },
            },
            sender: { id: 7001, login: "alex-e2e" },
          },
          webhookSecret,
          url: `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/github`,
        }),
      );

    // GitHub may deliver these as independent requests in the opposite order.
    await expect(
      sendLifecycle("deleted", "deleted payload"),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      sendLifecycle("edited", "@maya corrected ordered GitHub request"),
    ).resolves.toMatchObject({
      ok: true,
    });
    // An exact GitHub redelivery id must remain a single durable transition.
    await expect(
      sendLifecycle("edited", "@maya corrected ordered GitHub request"),
    ).resolves.toMatchObject({
      ok: true,
    });

    // One root-conversation drain plus one durable-ingress callback per HTTP
    // request is queued. The duplicate delivery callback becomes a no-op.
    expect(deferred).toHaveLength(4);
    if (rootProcessedFirst) {
      await deferred.shift()?.();
      await vi.waitFor(async () => {
        const [root] = await db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, endpoint.id));
        expect(root.state).toBe("processed");
      });
    }
    await drainDeferred();
    // The scheduler callbacks start background promises. Wait for durable
    // replay admission before draining the conversation work it schedules.
    await vi.waitFor(async () => {
      const deliveries = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(deliveries).toHaveLength(3);
    });
    await vi.waitFor(async () => {
      await drainDeferred();
      const deliveries = await db
        .select({
          eventKind: chatDeliveries.eventKind,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(deliveries).toHaveLength(3);
      expect(
        deliveries.every((delivery) => delivery.state === "processed"),
      ).toBe(true);
    });

    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(comments.map((comment) => comment.body)).toEqual([
      "@maya original ordered GitHub request",
      "An external message was edited:\n\n@maya corrected ordered GitHub request",
      "An external message in this conversation was deleted.",
    ]);
    expect(wakeup).toHaveBeenCalledTimes(1);

    await expect(
      sendLifecycle(
        "edited",
        "@maya a delayed edit must not resurrect this message",
        "edited-after-delete",
        "2026-09-05T12:01:00Z",
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(deferred).toHaveLength(1);
    await drainDeferred();
    // Awaiting each callback also drains the lifecycle work it queues.
    expect(deferred).toHaveLength(0);
    await vi.waitFor(async () => {
      await expect(
        db
          .select({
            eventKind: chatDeliveries.eventKind,
            redactedError: chatDeliveries.redactedError,
            state: chatDeliveries.state,
          })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.eventKind, "message_updated"),
              eq(chatDeliveries.state, "filtered"),
            ),
          ),
      ).resolves.toEqual([
        {
          eventKind: "message_updated",
          redactedError:
            "Message edit arrived after the provider message was deleted",
          state: "filtered",
        },
      ]);
    });
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId)),
    ).resolves.toHaveLength(3);
    expect(wakeup).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });

  it("supplements Chat SDK with verified GitHub comment edit and delete lifecycle events", async () => {
    const fixture = await seedCompany();
    const { service, wakeup, endpoint, webhookSecret, callbacks } =
      await configuredGitHubEndpoint(fixture);
    const thread = makeThread({
      channelId: "paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:42",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "77001",
        text: "@maya original GitHub request",
        mentioned: true,
        userId: "7001",
      }),
      trigger: "mention",
    });
    for (const item of [
      {
        id: "github:paperclipai/paperclip:43",
        messageId: "77002",
      },
      {
        id: "github:paperclipai/paperclip:43:rc:88001",
        messageId: "88001",
      },
    ]) {
      const nativeThread = makeThread({
        channelId: "paperclipai/paperclip",
        id: item.id,
        name: "paperclipai/paperclip",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: nativeThread.thread,
        message: makeMessage({
          id: item.messageId,
          text: "@maya original GitHub PR request",
          mentioned: true,
          userId: "7001",
        }),
        trigger: "mention",
      });
    }

    await qualifySetupRoundTrip(service, endpoint.id, "7001");
    await service.test(endpoint.id);

    const sendLifecycle = async (input: {
      action: "edited" | "deleted";
      event: "issue_comment" | "pull_request_review_comment";
      messageId: number;
      number: number;
      updatedAt: string;
      body?: string;
      inReplyToId?: number;
      issueIsPullRequest?: boolean;
    }) => {
      const response = await service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: `github-comment-${input.event}-${input.messageId}-${input.action}-${input.updatedAt}-${createHash(
            "sha256",
          )
            .update(input.body ?? "@maya corrected GitHub request")
            .digest("hex")
            .slice(0, 12)}`,
          event: input.event,
          payload: {
            action: input.action,
            comment: {
              id: input.messageId,
              in_reply_to_id: input.inReplyToId,
              body: input.body ?? "@maya corrected GitHub request",
              updated_at: input.updatedAt,
            },
            issue: {
              number: input.number,
              pull_request: input.issueIsPullRequest ? {} : undefined,
            },
            pull_request: { number: input.number },
            repository: {
              id: 97531,
              full_name: "paperclipai/paperclip",
              name: "paperclip",
              owner: { id: 1357, login: "paperclipai" },
            },
            sender: { id: 7001, login: "alex-e2e" },
          },
          webhookSecret,
          url: `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/github`,
        }),
      );
      expect(response.status).toBeLessThan(300);
    };

    for (const input of [
      {
        event: "issue_comment" as const,
        messageId: 77001,
        number: 42,
      },
      {
        event: "issue_comment" as const,
        issueIsPullRequest: true,
        messageId: 77002,
        number: 43,
      },
      {
        event: "pull_request_review_comment" as const,
        inReplyToId: 88001,
        messageId: 88001,
        number: 43,
      },
    ].entries()) {
      const [index, event] = input;
      await sendLifecycle({
        ...event,
        action: "edited",
        updatedAt: `2026-09-05T12:0${index}:00Z`,
      });
      await sendLifecycle({
        ...event,
        action: "deleted",
        updatedAt: `2026-09-05T12:1${index}:00Z`,
      });
    }
    const sameSecondEdit = {
      action: "edited" as const,
      body: "@maya corrected GitHub request again in the same second",
      event: "issue_comment" as const,
      messageId: 77001,
      number: 42,
      updatedAt: "2026-09-05T12:00:00Z",
    };
    await sendLifecycle(sameSecondEdit);
    await sendLifecycle(sameSecondEdit);
    await vi.waitFor(async () => {
      const lifecycle = await readChatDeliveriesByEndpointId(endpoint.id);
      expect(
        lifecycle.filter((row) =>
          ["message_updated", "message_deleted"].includes(row.eventKind),
        ),
      ).toHaveLength(7);
      expect(
        lifecycle.filter(
          (row) =>
            row.eventKind === "message_updated" &&
            row.providerEventId.includes("-77001-"),
        ),
      ).toHaveLength(2);
    });
    expect(wakeup).toHaveBeenCalledTimes(4);
    await service.shutdown();
  });

  it("retains content-free GitHub source invalidation after actor revocation and denies stale retry after regrant", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, webhookSecret, wakeup, runtime } =
      await configuredGitHubEndpoint(fixture);
    try {
      const thread = makeThread({
        channelId: "paperclipai/paperclip",
        id: "github:paperclipai/paperclip:issue:91",
        name: "paperclipai/paperclip",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: "99101",
          text: "@maya establish a GitHub task before access changes",
          mentioned: true,
          userId: "7001",
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id, "7001");
      await service.test(endpoint.id);
      // The retry source must be the newest admitted request, not the older
      // root preceding the setup qualification's follow-up.
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: "99102",
          text: "The exact request that fails before actor access changes",
          userId: "7001",
        }),
        trigger: "subscribed_message",
      });
      const [originalAction] = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "inbound_wakeup"),
          ),
        )
        .orderBy(desc(chatActions.createdAt))
        .limit(1);
      expect(originalAction).toBeDefined();
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected GitHub conversation");
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "failed",
        errorCode: "adapter_failed",
        finishedAt: new Date(),
        wakeupRequestId: originalAction!.id,
        contextSnapshot: {
          ...(await chatWakeContext({
            endpointId: endpoint.id,
            issueId: conversation.issueId,
            provider: "github",
            providerMessageId: "99102",
          })),
          taskKey: conversation.issueId,
        },
      });
      await db
        .update(agentWakeupRequests)
        .set({ status: "failed", runId })
        .where(eq(agentWakeupRequests.id, originalAction!.id));
      const retryInput = {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        agentId: fixture.assignedAgentId,
        failedRunId: runId,
        initiatedByUserId: "owner-user",
      };
      const rollbackProbe = new Error("rollback authorized GitHub retry probe");
      await expect(
        db.transaction(async (tx) => {
          await expect(
            service.prepareFailedChatRunRetry(tx, retryInput),
          ).resolves.toMatchObject({ issueId: conversation.issueId });
          throw rollbackProbe;
        }),
      ).rejects.toBe(rollbackProbe);
      const commentCount = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .then((rows) => rows.length);
      await service.update(
        endpoint.id,
        { allowUnlinkedPeople: false },
        "owner-user",
      );
      const wakeCount = wakeup.mock.calls.length;
      const providerRuntime = runtime.endpoints.get(endpoint.id)!;
      const postCount = providerRuntime.posts.length;
      const reactionCount = providerRuntime.reactions.length;

      const revokedEdit = "@maya do not retain this revoked GitHub edit";
      const response = await service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: "github-revoked-edit-99102",
          event: "issue_comment",
          payload: {
            action: "edited",
            comment: {
              id: 99102,
              body: revokedEdit,
              updated_at: "2026-09-05T12:20:00Z",
            },
            issue: { number: 91 },
            repository: {
              id: 97531,
              full_name: "paperclipai/paperclip",
              name: "paperclip",
              owner: { id: 1357, login: "paperclipai" },
            },
            sender: { id: 7001, login: "alex-e2e" },
          },
          webhookSecret,
        }),
      );
      expect(response.ok).toBe(true);

      await expect(
        db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.issueId, conversation.issueId)),
      ).resolves.toHaveLength(commentCount);
      const lifecycle = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "message_updated"),
          ),
        )
        .then((rows) => rows[0]);
      expect(lifecycle).toMatchObject({
        state: "processed",
        conversationId: conversation.id,
        redactedError:
          "Provider edit invalidation retained without admitting content from an unauthorized actor",
        normalizedEvent: {
          runtimeContext: {
            generation: expect.any(Number),
            credentialFingerprint: expect.any(String),
          },
          filtering: { contentRetained: false },
          message: {
            providerMessageId: "99102",
            targetProviderEventId: `${thread.thread.id}:99102`,
            providerSentAt: "2026-09-05T12:20:00.000Z",
          },
        },
      });
      expect(JSON.stringify(lifecycle?.normalizedEvent)).not.toContain(
        revokedEdit,
      );
      expect(lifecycle!.normalizedEvent.message).not.toHaveProperty("text");
      await service.update(
        endpoint.id,
        { allowUnlinkedPeople: true },
        "owner-user",
      );
      await expect(
        db.transaction((tx) =>
          service.prepareFailedChatRunRetry(tx, retryInput),
        ),
      ).rejects.toMatchObject({
        details: { code: "chat_failed_run_retry_not_authorized" },
      });
      await expect(
        db
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "failed_run_retry"),
            ),
          ),
      ).resolves.toEqual([]);
      expect(wakeup.mock.calls.length).toBe(wakeCount);
      expect(providerRuntime.posts.length).toBe(postCount);
      expect(providerRuntime.reactions.length).toBe(reactionCount);
    } finally {
      await db
        .update(chatConversations)
        .set({ state: "completed" })
        .where(
          and(
            eq(chatConversations.companyId, fixture.companyId),
            eq(chatConversations.endpointId, endpoint.id),
          ),
        );
      await retirePublicationFixture(service, endpoint.id);
    }
  });

  it.each([true, false])("keeps recovered GitHub final prose and attachment navigation internal (omission: %s)", async unavailable => {
    const context = await githubOmissionFixture(unavailable);
    try {
      await expect(context.repair()).resolves.toBe(false);
      await context.service.processPendingPublications(100);
      expect(context.providerRuntime.posts).toEqual([]);
      expect(context.providerRuntime.edits).toEqual([]);
      const publications = await db.select().from(chatPublications).where(and(
        eq(chatPublications.endpointId, context.endpoint.id), isNotNull(chatPublications.commentId),
      ));
      expect(publications.every(publication => publication.state === "cancelled")).toBe(true);
      expect(await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: context.fixture.companyId, issueId: context.issue.id, runId: context.runId,
      })).toBe("internal_agent_write");
    } finally {
      await context.cleanup();
    }
  });
});
