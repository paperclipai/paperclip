// Shared PostgreSQL lifecycle and endpoint seeding harness for chat-channel integration suites.
import { reconcilePersistedRuntimeServicesOnStartup, readWorkspaceRuntimeIdleWork } from "../../services/workspace-runtime.js";
import { conflict } from "../../errors.js";
import { readIdleLocalWork } from "../../services/idle-local-work.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { chatGitHubRegistrations, chatGitHubReviews } from "@paperclipai/db";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import request from "supertest";
import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, chatActions, chatConversations, chatDeliveries, chatEndpointLeases, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatMessageLinks, chatPublications, chatTeamsFileTransfers, companies, companyMemberships, createDb, applyPendingMigrations, closeCheckpointDb, closeFileStorageDb, closeLivenessDb, heartbeatRuns, issueComments, issues, principalPermissionGrants, toolConnections } from "@paperclipai/db";
import { type ChatProvider } from "@paperclipai/shared";
import type { Message, Thread } from "chat";
import { chatChannelService, type ChatChannelServiceOptions, type ChatChannelService } from "../../services/chat-channels.js";
import type { CreateChatSdkEndpointRuntimeOptions, ChatSdkMessageTrigger, ChatSdkRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { issueService } from "../../services/issues.js";
import type { StorageService } from "../../storage/types.js";
import { resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { startEmbeddedPostgresTestDatabase } from "../helpers/embedded-postgres.js";
import { type TestDb, slackProtocolCapture, slackProtocolDatabaseUrl, externalTestDatabaseUrl, FakeChatSdkRuntime, uniqueDiscordApplicationId, fakeSlackFetch, fakeDiscordFetch, fakeTelegramFetch, chatSdkProvider, makeThread, makeMessage } from "./providers.js";

export function createChatChannelHarness() {
  let db!: TestDb;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(
    os.tmpdir(),
    `paperclip-chat-channels-${randomUUID()}`,
  );

  beforeAll(async () => {
    if (slackProtocolDatabaseUrl) await applyPendingMigrations(slackProtocolDatabaseUrl);
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
      secretsTmpDir,
      "master.key",
    );
    if (!externalTestDatabaseUrl) {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-chat-channels-");
    }
    // Scheduler tests advance virtual time while PostgreSQL uses real I/O.
    // Do not expire or time out its connections on those virtual clock jumps.
    db = createDb(externalTestDatabaseUrl ?? tempDb!.connectionString, {
      idleTimeoutSeconds: 0, connectTimeoutSeconds: 0, maxLifetimeSeconds: 0,
      ...(externalTestDatabaseUrl ? { maxConnections: 4 } : {}),
    });
    // The composed local-probe inventory includes the workspace owner. Match
    // server startup on this fresh fixture; never adopt or start a leftover.
    const [runtimeState] = await db.execute<{ configured: boolean }>(sql`SELECT
      EXISTS (SELECT 1 FROM workspace_runtime_services)
      OR EXISTS (SELECT 1 FROM project_workspaces)
      OR EXISTS (SELECT 1 FROM execution_workspaces) AS configured`);
    expect(runtimeState.configured).toBe(false);
    expect(await reconcilePersistedRuntimeServicesOnStartup(db)).toEqual({
      reconciled: 0, adopted: 0, stopped: 0, backfilled: 0, restarted: 0,
      restartFailed: 0, exposureReservationDrift: [],
    });
    expect(readWorkspaceRuntimeIdleWork()).toBe("none");
  }, 90_000);

  afterAll(async () => {
    if (slackProtocolCapture && db) { await closeCheckpointDb(db, 1); await closeFileStorageDb(db, 1); await closeLivenessDb(db, 1); }
    await db?.$client.end();
    await tempDb?.cleanup();
    if (previousKeyFile === undefined)
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  // Services scan this file's shared database. Retire each case's fixtures
  // after its assertions so another case (or shard order) cannot claim them.
  const fixtureCompanies = new Set<string>();
  const fixtureServices = new Set<ChatChannelService>();
  afterEach(async () => {
    try {
      await Promise.all([...fixtureServices].map((service) => service.shutdown()));
    } finally {
      const companyIds = [...fixtureCompanies];
      await retireFixtureState(companyIds);
      if (companyIds.length > 0) {
        // Pausing an endpoint does not remove its rows from global recovery
        // selectors. After every assertion and worker shutdown, settle leftover
        // fixture work so later cases cannot claim its leases or retry its I/O.
        await db.update(chatActions).set({ status: "cancelled" })
          .where(and(inArray(chatActions.companyId, companyIds), notInArray(chatActions.status, ["processed", "cancelled"])));
        await db.update(chatDeliveries).set({ state: "failed", nextAttemptAt: null })
          .where(and(inArray(chatDeliveries.companyId, companyIds), inArray(chatDeliveries.state, ["received", "processing", "retry"])));
        await db.update(chatPublications).set({ state: "cancelled", nextAttemptAt: null })
          .where(and(inArray(chatPublications.companyId, companyIds), inArray(chatPublications.state, ["pending", "awaiting_consent", "streaming", "retry"])));
      }
      fixtureServices.clear();
      fixtureCompanies.clear();
    }
  });

  async function retireFixtureState(companyIds: string[]) {
    if (companyIds.length === 0) return;
    // Verifying endpoints can also own receipts. Once a receipt is 60s old,
    // another test's global sweep can reclaim it. Retire every live endpoint,
    // then release synthetic lease owners after their services have stopped.
    await db.update(chatEndpoints).set({ status: "paused" })
      .where(and(inArray(chatEndpoints.companyId, companyIds), notInArray(chatEndpoints.status, ["archived", "revoked"])));
    await db.delete(chatEndpointLeases)
      .where(inArray(chatEndpointLeases.companyId, companyIds));
    // The milestone scanner includes paused endpoints with active bindings.
    await db.update(chatConversations).set({ state: "completed" })
      .where(and(inArray(chatConversations.companyId, companyIds), inArray(chatConversations.state, ["active", "waiting"])));
  }

  const companyPrefixAttempts = 8;
  const freshCompanyPrefix = () => `C${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`;

  async function seedCompany(nextIssuePrefix = freshCompanyPrefix, companyId: string = randomUUID()) {
    const assignedAgentId = randomUUID();
    const replacementAgentId = randomUUID();
    let inserted = false;
    // Retired fixtures retain company rows. Retry only the short-prefix unique
    // conflict; every other database error must still fail the test immediately.
    for (let attempt = 0; attempt < companyPrefixAttempts; attempt += 1) {
      const [company] = await db.insert(companies).values({
        id: companyId,
        name: `Chat Test ${companyId.slice(0, 8)}`,
        issuePrefix: nextIssuePrefix(),
        requireBoardApprovalForNewAgents: false,
      }).onConflictDoNothing({ target: companies.issuePrefix }).returning({ id: companies.id });
      if (company) {
        inserted = true;
        fixtureCompanies.add(companyId);
        break;
      }
    }
    if (!inserted) throw new Error(`Could not allocate a chat fixture company prefix after ${companyPrefixAttempts} attempts`);
    const now = new Date();
    await db
      .insert(authUsers)
      .values({
        id: "owner-user",
        name: "Owner User",
        email: "owner-user@example.com",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "owner-user",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: "owner-user",
      permissionKey: "tools:manage_connections",
      scope: null,
      grantedByUserId: "owner-user",
    });
    await db.insert(agents).values([
      {
        id: assignedAgentId,
        companyId,
        name: "Maya",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: replacementAgentId,
        companyId,
        name: "Linus",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, assignedAgentId, replacementAgentId };
  }

  function readChatConversationsByEndpointId(value: (typeof chatConversations.$inferSelect)["endpointId"]) {
    return db.select().from(chatConversations).where(eq(chatConversations.endpointId, value));
  }

  function readChatEndpointsById(value: (typeof chatEndpoints.$inferSelect)["id"]) {
    return db.select().from(chatEndpoints).where(eq(chatEndpoints.id, value));
  }

  function readIssueCommentsByIssueId(value: (typeof issueComments.$inferSelect)["issueId"]) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, value));
  }

  function readChatDeliveriesByEndpointId(value: (typeof chatDeliveries.$inferSelect)["endpointId"]) {
    return db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, value));
  }

  function readChatDeliveriesById(value: (typeof chatDeliveries.$inferSelect)["id"]) {
    return db.select().from(chatDeliveries).where(eq(chatDeliveries.id, value));
  }

  function readHeartbeatRunsById(value: (typeof heartbeatRuns.$inferSelect)["id"]) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, value));
  }

  function readIssuesById(value: (typeof issues.$inferSelect)["id"]) {
    return db.select().from(issues).where(eq(issues.id, value));
  }

  function readChatActionsById(value: (typeof chatActions.$inferSelect)["id"]) {
    return db.select().from(chatActions).where(eq(chatActions.id, value));
  }

  function readChatGitHubReviewsByEndpointId(value: (typeof chatGitHubReviews.$inferSelect)["endpointId"]) {
    return db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.endpointId, value));
  }

  function readChatPublicationsByEndpointId(value: (typeof chatPublications.$inferSelect)["endpointId"]) {
    return db.select().from(chatPublications).where(eq(chatPublications.endpointId, value));
  }

  function readChatPublicationsById(value: (typeof chatPublications.$inferSelect)["id"]) {
    return db.select().from(chatPublications).where(eq(chatPublications.id, value));
  }

  function readChatGitHubRegistrationsByEndpointId(value: (typeof chatGitHubRegistrations.$inferSelect)["endpointId"]) {
    return db.select().from(chatGitHubRegistrations).where(eq(chatGitHubRegistrations.endpointId, value));
  }

  function readToolConnectionsById(value: (typeof toolConnections.$inferSelect)["id"]) {
    return db.select().from(toolConnections).where(eq(toolConnections.id, value));
  }

  function readChatConversationsById(value: (typeof chatConversations.$inferSelect)["id"]) {
    return db.select().from(chatConversations).where(eq(chatConversations.id, value));
  }

  function readIssuesByCompanyId(value: (typeof issues.$inferSelect)["companyId"]) {
    return db.select().from(issues).where(eq(issues.companyId, value));
  }

  function readChatPublicationsByCommentId(value: NonNullable<(typeof chatPublications.$inferSelect)["commentId"]>) {
    return db.select().from(chatPublications).where(eq(chatPublications.commentId, value));
  }

  function readChatActionsByProviderActionId(value: (typeof chatActions.$inferSelect)["providerActionId"]) {
    return db.select().from(chatActions).where(eq(chatActions.providerActionId, value));
  }

  function readChatPublicationsByIdempotencyKey(value: (typeof chatPublications.$inferSelect)["idempotencyKey"]) {
    return db.select().from(chatPublications).where(eq(chatPublications.idempotencyKey, value));
  }

  function readHeartbeatRunsByCompanyId(value: (typeof heartbeatRuns.$inferSelect)["companyId"]) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, value));
  }

  function readAgentWakeupRequestsById(value: (typeof agentWakeupRequests.$inferSelect)["id"]) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, value));
  }

  function readIssueCommentsByCompanyId(value: (typeof issueComments.$inferSelect)["companyId"]) {
    return db.select().from(issueComments).where(eq(issueComments.companyId, value));
  }

  function readChatTeamsFileTransfersById(value: (typeof chatTeamsFileTransfers.$inferSelect)["id"]) {
    return db.select().from(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.id, value));
  }

  // A truthy return is not a durable scheduler receipt. These transport tests
  // record the same exact receipt identity; real scheduling/coalescing is
  // separately exercised by durable-chat-wakeup.test.ts against heartbeat.
  function receiptBackedWakeup(
    wakeup: ChatChannelServiceOptions["heartbeat"]["wakeup"],
  ): ChatChannelServiceOptions["heartbeat"]["wakeup"] {
    return async (agentId, opts) => {
      const result = await wakeup(agentId, opts);
      const request = opts.durableChatRequest;
      if (request && result !== null && result !== undefined) {
        const [existing] = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, request.id));
        if (existing) return result;
        await db.transaction(async (tx) => {
          await request.authorize(
            tx as unknown as Parameters<typeof request.authorize>[0],
          );
          await tx
            .insert(agentWakeupRequests)
            .values({
              id: request.id,
              companyId: request.companyId,
              agentId,
              source: opts.source ?? "assignment",
              triggerDetail: opts.triggerDetail,
              reason: opts.reason,
              payload: opts.payload,
              requestedByActorType: opts.requestedByActorType,
              requestedByActorId: opts.requestedByActorId,
              idempotencyKey: request.idempotencyKey,
              requestedAt: request.requestedAt,
              status: "queued",
            })
            .onConflictDoNothing();
        });
      }
      return result;
    };
  }

  function createService(
    runtime = new FakeChatSdkRuntime(),
    providerFetch: typeof globalThis.fetch = fakeSlackFetch() as typeof globalThis.fetch,
    overrides: Partial<
      Pick<
        ChatChannelServiceOptions,
        | "credentialMutationLeaseRenewalIntervalMs"
        | "deferWebhookProcessing"
        | "discordGatewayEventBarrier"
        | "discordGatewayMessageAdmissionBarrier"
        | "discordRootThreadTransportBarrier"
        | "discordGatewayLeaseRenewalIntervalMs"
        | "discordGatewayLeaseTtlMs"
        | "discordGatewayLeaseWaitMs"
        | "githubWebhookAuthenticationBarrier"
        | "githubWebhookReplayBarrier"
        | "githubWebhookResponseBudgetMs"
        | "publicationTransportPreparationBarrier"
        | "renderSlackAvatar"
        | "slackManaged"
        | "publicBaseUrl"
        | "webhookPublicBaseUrl"
        | "nativeBotIdentityClaimBarrier"
        | "confirmationResolutionPersistBarrier"
        | "conversationLeaseRenewalIntervalMs"
        | "questionFormOpenAuthorizationBarrier"
        | "questionResolutionPersistBarrier"
        | "reactionLinkPreflightBarrier"
        | "reactionReplayConversationLockBarrier"
        | "reactionReplayEndpointLockBarrier"
        | "receiptReactionTransportBarrier"
        | "resolveNativeQuestion"
        | "renewCredentialMutationLease"
        | "renewConversationDeliveryLease"
        | "renewDiscordGatewayLease"
        | "scheduleDeferredWork"
        | "slackTaskAdmissionClaimBarrier"
        | "slackSessionSyncSelectionBarrier"
        | "setupSecretActivityLogger"
        | "setupSecretCredentialPersistBarrier"
        | "setupSecretFinalOwnershipBarrier"
        | "setupTestActivationBarrier"
        | "storage"
        | "reachAuthorizationBarrier"
      >
    > & {
      cancelRun?: NonNullable<
        ChatChannelServiceOptions["heartbeat"]["cancelRun"]
      >;
      wakeup?: ChatChannelServiceOptions["heartbeat"]["wakeup"];
    } = {},
  ) {
    const {
      cancelRun: cancelRunOverride,
      wakeup: wakeupOverride,
      ...serviceOverrides
    } = overrides;
    const wakeup = vi.fn<ChatChannelServiceOptions["heartbeat"]["wakeup"]>(wakeupOverride ?? (async () => ({ accepted: true })));
    const cancelRun = vi.fn<NonNullable<ChatChannelServiceOptions["heartbeat"]["cancelRun"]>>(
      cancelRunOverride ?? (async () => ({ status: "cancelled" })),
    );
    const service = chatChannelService(db, {
      fetch: providerFetch,
      heartbeat: { cancelRun, wakeup: receiptBackedWakeup(wakeup) },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
      ...serviceOverrides,
    });
    fixtureServices.add(service);
    return { cancelRun, runtime, service, wakeup };
  }

  function createStorageService() {
    const objects = new Map<string, Buffer>();
    const putFile = vi.fn<StorageService["putFile"]>(async (input) => {
      if (!Buffer.isBuffer(input.body)) throw new Error("Expected a buffered attachment body");
      const objectKey = `${input.namespace}/${randomUUID()}-${input.originalFilename ?? "attachment"}`;
      objects.set(objectKey, input.body);
      return {
        provider: "local_disk",
        objectKey,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"),
        originalFilename: input.originalFilename,
      };
    });
    const storage: StorageService = {
      provider: "local_disk",
      putFile,
      getObject: vi.fn(async (_companyId, objectKey) => {
        const body = objects.get(objectKey);
        if (!body) throw new Error(`Missing test object ${objectKey}`);
        return {
          stream: Readable.from([body]),
          contentLength: body.length,
        };
      }),
      headObject: vi.fn(async (_companyId, objectKey) => ({
        exists: objects.has(objectKey),
        contentLength: objects.get(objectKey)?.length,
      })),
      deleteObject: vi.fn(async (_companyId, objectKey) => {
        objects.delete(objectKey);
      }),
    };
    return { objects, putFile, storage };
  }

  async function retirePublicationFixture(
    service: ChatChannelService,
    endpointId: string,
  ) {
    try {
      await service.shutdown();
    } finally {
      // Workers scan the shared fixture database. Local shutdown alone leaves
      // future retries/receipts eligible for the next test's service. Preserve
      // their asserted audit state, but retire this endpoint after assertions.
      await db
        .update(chatEndpoints)
        .set({ status: "paused" })
        .where(
          and(
            eq(chatEndpoints.id, endpointId),
            eq(chatEndpoints.status, "active"),
          ),
        );
    }
  }

  async function recordSlackUrlVerification(
    service: ChatChannelService,
    publicId: string,
    signingSecret = "test-signing-secret",
  ) {
    const response = await service.handleWebhook(
      publicId,
      "slack",
      signedSlackWebhookRequest({
        url: `https://paperclip.example/api/chat-webhooks/${publicId}/slack`,
        contentType: "application/json",
        body: JSON.stringify({ type: "url_verification", challenge: "verified-challenge" }),
        signingSecret,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "verified-challenge" });
  }

  function signedSlackWebhookRequest(input: {
    url: string;
    body: string;
    contentType: string;
    signingSecret?: string;
    timestamp?: string;
  }) {
    const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
    const signature = createHmac(
      "sha256",
      input.signingSecret ?? "test-signing-secret",
    )
      .update(`v0:${timestamp}:${input.body}`)
      .digest("hex");
    return new Request(input.url, {
      method: "POST",
      headers: {
        "content-type": input.contentType,
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${signature}`,
      },
      body: input.body,
    });
  }

  async function chatWakeContext(input: {
    endpointId: string;
    issueId: string;
    provider: ChatProvider;
    providerMessageId: string;
  }) {
    const wakeCommentId = await db
      .select({ commentId: chatMessageLinks.commentId })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, input.endpointId),
          eq(chatMessageLinks.providerMessageId, input.providerMessageId),
          eq(chatMessageLinks.direction, "inbound"),
        ),
      )
      .then((rows) => rows[0]?.commentId ?? null);
    if (!wakeCommentId) {
      throw new Error(
        `Expected inbound comment link ${input.providerMessageId}`,
      );
    }
    return {
      issueId: input.issueId,
      source: `chat:${input.provider}`,
      wakeCommentId,
      wakeCommentIds: [wakeCommentId],
    };
  }

  async function addSelectedChatFinal(input: {
    agentId: string;
    body: string;
    companyId: string;
    issueId: string;
    runId: string;
  }) {
    const authorizationReason =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
      });
    return issueService(db).addComment(
      input.issueId,
      input.body,
      { agentId: input.agentId, runId: input.runId },
      { authorType: "agent", authorizationReason },
    );
  }

  async function qualifySetupRoundTrip(
    service: ChatChannelService,
    endpointId: string,
    userId = "U-EXTERNAL",
  ) {
    const endpoint = await service.get(endpointId);
    let conversation: typeof chatConversations.$inferSelect | undefined;
    await vi.waitFor(async () => {
      conversation = await readChatConversationsByEndpointId(endpointId)
        .then((rows) => rows.at(-1));
      expect(conversation).toBeDefined();
    });
    if (!conversation) throw new Error("Expected setup conversation");
    const fakeRuntime = service.runtime as unknown as FakeChatSdkRuntime;
    const callbacks = fakeRuntime.configurations.get(endpointId)?.callbacks;
    if (!callbacks) throw new Error("Expected setup callbacks");
    const { thread } = makeThread({
      id: conversation.externalThreadId,
      channelId: conversation.externalConversationId,
      isDM: conversation.isDirectMessage,
      name: conversation.externalLabel,
    });
    const setupFollowUpMessageId = `setup-follow-up-${randomUUID()}`;
    await callbacks.onMessage({
      endpointId,
      provider: chatSdkProvider(endpoint.provider),
      thread,
      message: makeMessage({
        id: setupFollowUpMessageId,
        text: "Setup follow-up",
        mentioned: endpoint.provider === "slack",
        userId,
      }),
      trigger:
        endpoint.provider === "telegram"
          ? "direct_message"
          : "subscribed_message",
    });
    const contextSnapshot = await chatWakeContext({
      endpointId,
      issueId: conversation.issueId,
      provider: endpoint.provider,
      providerMessageId: setupFollowUpMessageId,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: endpoint.companyId,
      agentId: endpoint.assignedAgentId,
      status: "succeeded",
      contextSnapshot,
    });
    if (endpoint.provider === "github") {
      // Generic transport fixtures supply a confirmed task-tool receipt.
      // Real tool execution and provider I/O have separate integration tests.
      await db.insert(chatActions).values({ companyId: endpoint.companyId, endpointId, conversationId: conversation.id,
        kind: "github_review_publication", providerActionId: `github_publication:setup:${runId}`,
        payload: { operation: "comment", session: { companyId: endpoint.companyId, agentId: endpoint.assignedAgentId, issueId: conversation.issueId, runId } },
        status: "processed", result: { id: "setup-tool-reply", url: "https://github.com/test/setup-tool-reply" } });
    } else {
      await addSelectedChatFinal({
        agentId: endpoint.assignedAgentId,
        body: "Setup round trip complete",
        companyId: endpoint.companyId,
        issueId: conversation.issueId,
        runId,
      });
    }
    await service.processPendingPublications();
    const providerRuntime = fakeRuntime.endpoints.get(endpointId);
    if (providerRuntime) providerRuntime.posts.length = 0;
    return setupFollowUpMessageId;
  }

  async function configuredSlackEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: { allowUnlinkedPeople?: boolean; linkedBoardUser?: boolean; requireAtMention?: boolean } & Partial<
      Pick<
        ChatChannelServiceOptions,
        | "credentialMutationLeaseRenewalIntervalMs"
        | "conversationLeaseRenewalIntervalMs"
        | "deferWebhookProcessing"
        | "fetch"
        | "questionFormOpenAuthorizationBarrier"
        | "questionResolutionPersistBarrier"
        | "reactionLinkPreflightBarrier"
        | "reactionReplayConversationLockBarrier"
        | "reactionReplayEndpointLockBarrier"
        | "receiptReactionTransportBarrier"
        | "reachAuthorizationBarrier"
        | "resolveNativeQuestion"
        | "renewCredentialMutationLease"
        | "renewConversationDeliveryLease"
        | "scheduleDeferredWork"
        | "slackTaskAdmissionClaimBarrier"
        | "storage"
      >
    > & {
        cancelRun?: NonNullable<
          ChatChannelServiceOptions["heartbeat"]["cancelRun"]
        >;
        wakeup?: ChatChannelServiceOptions["heartbeat"]["wakeup"];
      } = {},
  ) {
    const context = createService(
      new FakeChatSdkRuntime(),
      overrides.fetch ?? (fakeSlackFetch() as typeof globalThis.fetch),
      overrides,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in Slack",
      },
      "owner-user",
    );
    // Most transport fixtures exercise restricted guests explicitly. Production
    // Slack creation defaults to linked accounts only (covered separately).
    await context.service.update(endpoint.id, {
      allowUnlinkedPeople: overrides.allowUnlinkedPeople ?? true,
      // Existing transport tests explicitly exercise the optional unmentioned mode.
      requireAtMention: overrides.requireAtMention ?? false,
    }, "owner-user");
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-test-token",
          signingSecret: "test-signing-secret",
        },
      },
      "owner-user",
    );
    if (overrides.linkedBoardUser) {
      const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: fixture.companyId, provider: "slack", providerAccountId: "T-PAPERCLIP", externalId: "UBOARD" }).returning();
      await db.insert(chatIdentityLinks).values({ companyId: fixture.companyId, endpointId: endpoint.id, principalId: principal.id, paperclipUserId: "owner-user", status: "linked", confirmedAt: new Date() });
    }
    await recordSlackUrlVerification(context.service, endpoint.publicId);
    await context.service.configure(
      endpoint.id,
      { action: "verify" },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive endpoint callbacks");
    return { ...context, endpoint, callbacks };
  }

  async function configuredTeamsEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: Partial<
      Pick<
        ChatChannelServiceOptions,
        | "deferWebhookProcessing"
        | "githubWebhookAuthenticationBarrier"
        | "githubWebhookResponseBudgetMs"
        | "scheduleDeferredWork"
        | "storage"
        | "reachAuthorizationBarrier"
      >
    > = {},
  ) {
    const context = createService(
      new FakeChatSdkRuntime(),
      (async () =>
        new Response(JSON.stringify({ access_token: "teams-test-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
      overrides,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in Teams",
      },
      "owner-user",
    );
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          clientId: randomUUID(),
          tenantId: randomUUID(),
          clientSecret: "teams-test-secret",
        },
      },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive Teams callbacks");
    return { ...context, endpoint, callbacks };
  }

  async function configuredTelegramEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: Parameters<typeof createService>[2] = {},
  ) {
    const context = createService(
      new FakeChatSdkRuntime(),
      fakeTelegramFetch() as typeof globalThis.fetch,
      overrides,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "telegram",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in Telegram",
      },
      "owner-user",
    );
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "123456:telegram-interaction-test" },
      },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive Telegram callbacks");
    return { ...context, endpoint, callbacks };
  }

  async function configuredDiscordEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: Parameters<typeof createService>[2] = {},
  ) {
    const applicationId = uniqueDiscordApplicationId();
    const context = createService(
      new FakeChatSdkRuntime(),
      fakeDiscordFetch(applicationId) as typeof globalThis.fetch,
      overrides,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "discord",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in Discord",
      },
      "owner-user",
    );
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId: "1457808928258658549",
        },
      },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive Discord callbacks");
    return { ...context, endpoint, callbacks };
  }

  async function recoverDiscordCommands(service: ChatChannelService) {
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    try {
      await service.registerCommandWork(coordinator, () => true).ready;
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  }

  async function deliverMessage(input: {
    callbacks: CreateChatSdkEndpointRuntimeOptions["callbacks"];
    endpointId: string;
    message: Message;
    provider?: ChatProvider;
    providerUpdateId?: number;
    thread: Thread;
    trigger: ChatSdkMessageTrigger;
  }) {
    await input.callbacks.onMessage({
      endpointId: input.endpointId,
      provider: chatSdkProvider(input.provider ?? "slack"),
      providerUpdateId: input.providerUpdateId,
      thread: input.thread,
      message: input.message,
      trigger: input.trigger,
    });
  }

  async function waitForProcessedReceiptRemoval(
    endpointId: string,
    receipt: { threadId: string; messageId: string; emoji: string },
  ) {
    // Publication settlement only schedules this non-critical provider I/O.
    // A sweep skips an action already owned by a fresh processing worker.
    const removals = await db
      .select({
        id: chatActions.id,
        deliveryId: chatActions.deliveryId,
        providerActionId: chatActions.providerActionId,
      })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpointId),
          eq(chatActions.kind, "receipt_reaction"),
          sql`${chatActions.payload}->>'operation' = 'remove'`,
          sql`${chatActions.payload}->>'threadId' = ${receipt.threadId}`,
          sql`${chatActions.payload}->>'messageId' = ${receipt.messageId}`,
          sql`${chatActions.payload}->>'reaction' = ${receipt.emoji}`,
        ),
      );
    expect(removals).toHaveLength(1);
    const removal = removals[0]!;
    expect(removal.deliveryId).toEqual(expect.any(String));
    expect(removal.providerActionId).toBe(
      `receipt_reaction_remove:${removal.deliveryId}`,
    );
    await vi.waitFor(async () => {
      await expect(
        db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpointId),
              eq(chatActions.id, removal.id),
            ),
          ),
      ).resolves.toEqual([{ status: "processed" }]);
    });
    return removal.id;
  }

  async function registeredIdleProbeState() {
    let state: string | undefined;
    await readIdleLocalWork({ diagnostic: (reason, value) => { if (reason === "local.registered_probes") state = value; } });
    return state;
  }

  async function linkLifecycleFixtureActor(input: {
    companyId: string;
    endpointId: string;
    externalId: string;
  }) {
    const [principal] = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, input.companyId),
          eq(chatExternalPrincipals.externalId, input.externalId),
        ),
      );
    if (!principal) throw new Error("Expected original lifecycle principal");
    await db.insert(chatIdentityLinks).values({
      companyId: input.companyId,
      endpointId: input.endpointId,
      principalId: principal.id,
      paperclipUserId: "owner-user",
      status: "linked",
      confirmedAt: new Date(),
    });
    await db
      .update(chatEndpoints)
      .set({ allowUnlinkedPeople: false })
      .where(
        and(
          eq(chatEndpoints.companyId, input.companyId),
          eq(chatEndpoints.id, input.endpointId),
        ),
      );
    return principal.id;
  }

  return {
    get db(): TestDb { return db; },
    get connectionString(): string { return externalTestDatabaseUrl ?? tempDb!.connectionString; },
    fixtureCompanies, fixtureServices, retireFixtureState, companyPrefixAttempts, freshCompanyPrefix, seedCompany, readChatConversationsByEndpointId, readChatEndpointsById, readIssueCommentsByIssueId, readChatDeliveriesByEndpointId, readChatDeliveriesById, readHeartbeatRunsById, readIssuesById, readChatActionsById, readChatGitHubReviewsByEndpointId, readChatPublicationsByEndpointId, readChatPublicationsById, readChatGitHubRegistrationsByEndpointId, readToolConnectionsById, readChatConversationsById, readIssuesByCompanyId, readChatPublicationsByCommentId, readChatActionsByProviderActionId, readChatPublicationsByIdempotencyKey, readHeartbeatRunsByCompanyId, readAgentWakeupRequestsById, readIssueCommentsByCompanyId, readChatTeamsFileTransfersById, receiptBackedWakeup, createService, createStorageService, retirePublicationFixture, recordSlackUrlVerification, signedSlackWebhookRequest, chatWakeContext, addSelectedChatFinal, qualifySetupRoundTrip, configuredSlackEndpoint, configuredTeamsEndpoint, configuredTelegramEndpoint, configuredDiscordEndpoint, recoverDiscordCommands, deliverMessage, waitForProcessedReceiptRemoval, registeredIdleProbeState, linkLifecycleFixtureActor,
  };
}

export type ChatChannelHarness = ReturnType<typeof createChatChannelHarness>;
