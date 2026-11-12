import { currentControllerProcess } from "../../services/controller-process-identity.js";
import { photonCoverageFingerprint } from "../../services/chat-channels/imessage-photon/idle-coverage.js";
import { readIdleIncomingWakeProof } from "../../services/idle-incoming-wake.js";
import type { VerifiedIdleCapabilities } from "../../services/idle-incoming-wake-capability.js";
import { verifyCloudControlAssertion, CLOUD_CONTROL_AUDIENCE, CLOUD_CONTROL_JWS_TYPE, CLOUD_RUNTIME_IDENTITY_ISSUER } from "../../services/cloud-runtime-identity.js";
import express from "express";
import request from "supertest";
import { createServer, type Server } from "node:http";
import { toolAccessRoutes } from "../../routes/tool-access.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { loadPaperclipCloudConnectorIdentity } from "../../services/paperclip-cloud-connector-enrollment.js";
import { externalConversationSettlementWork } from "../../services/external-conversation-settlement-work.js";
import { nativeStatusReassessmentWork } from "../../services/native-runtime/native-status-reassessment-work.js";
import { nativeReviewResponseWork } from "../../services/native-runtime/native-review-response-work.js";
import { nativeResponsePresentationWork } from "../../services/native-runtime/native-response-presentation-work.js";
import { DELIVERY_QUEUES } from "../../services/delivery-work-notifications.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { githubConnectionEventService } from "../../services/github-connection-events.js";
import { registerGitHubConnectionEventWork } from "../../services/github-connection-work.js";
import { joinConnectionEventWakeEnrollment } from "../../services/connection-event-wake.js";
import { resolveExternalTestDatabaseUrl } from "../helpers/external-test-database.js";
import { Readable } from "node:stream";
import type { StorageService } from "../../storage/types.js";
import { createHash, createPublicKey, randomUUID, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  TypedEventStream,
  type LiveEvent,
  type GrpcAdvancedIMessage,
} from "@photon-ai/advanced-imessage";
import { and, eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  subscribeDatabaseWork,
  createDb,
  companies,
  agents,
  authUsers,
  companyMemberships,
  principalPermissionGrants,
  chatEndpointLeases,
  chatSdkState,
  chatEndpoints,
  chatConversations,
  chatDeliveries,
  chatMessageLinks,
  chatActions,
  chatPublications,
  heartbeatRuns,
  agentWakeupRequests,
  issueComments,
  issues,
  activityLog,
  issueQuestionResponseDeliveries,
  chatIdentityLinks,
  chatEndpointResources,
  issueAttachments,
  assets,
  toolConnections,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../helpers/embedded-postgres.js";
import {
  chatChannelService,
  type ChatChannelService,
} from "../../services/chat-channels.js";
import { ChatSdkRuntime } from "../../services/chat-sdk-runtime.js";
import { issueService } from "../../services/issues.js";
import { subscribeCompanyLiveEvents } from "../../services/live-events.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { resolveExternalChatQuestionResponse } from "../../services/native-runtime/external-chat-question-response.js";
import { resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { PhotonChatAdapter } from "../../services/photon/adapter.js";
import { PhotonReceiver } from "../../services/photon/receiver.js";
import { PhotonCloudClient, PhotonError } from "../../services/photon/cloud.js";
import { photonFixture, photonEvent as livePhotonEvent, photonChat, stream } from "./fixture.js";
import * as cloudConnectors from "../../services/paperclip-cloud-connector.js";
import * as photonExternalRuntime from "../../services/chat-channels/imessage-photon/external-runtime.js";
import * as photonOwnedClients from "../../services/photon/owned-client.js";
import { PHOTON_EXTERNAL_STATE, photonStateFor } from "../../services/chat-channels/imessage-photon/external-store.js";
import { photonHash, readPhotonExternalState } from "../../services/chat-channels/imessage-photon/external-contract.js";

// The fixture always builds a message event. Its declared return type is the wider LiveEvent.
const photonEvent = (...args: Parameters<typeof livePhotonEvent>) =>
  livePhotonEvent(...args) as Extract<LiveEvent, { message: unknown }>;

function idleStream<T>(): TypedEventStream<T> {
  let close!: () => void;
  const done = new Promise<void>((resolve) => {
    close = resolve;
  });
  return new TypedEventStream(
    (async function* () {
      await done;
    })(),
    async () => close(),
  );
}
describe("iMessage Photon channel control plane", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let secrets: string;
  const oldKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const services: ChatChannelService[] = [];
  const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
  const connectionEventWorkers: ReturnType<typeof registerGitHubConnectionEventWork>[] = [];
  const companyIds: string[] = [];
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_PHOTON_TEST_DATABASE_URL");
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-photon-");
    if (external) await applyPendingMigrations(external);
    db = createDb(external ?? database!.connectionString);
    secrets = await mkdtemp(path.join(tmpdir(), "photon-secrets-"));
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
      secrets,
      "master.key",
    );
  }, 30_000);
  afterEach(async () => {
    await Promise.all(connectionEventWorkers.splice(0).map(worker => worker.stop()));
    await Promise.all(coordinators.splice(0).map(coordinator => coordinator.stop()));
    await Promise.all(services.splice(0).map((service) => service.shutdown()));
    for (const id of companyIds.splice(0))
      await db
        .update(chatEndpoints)
        .set({ status: "archived" })
        .where(eq(chatEndpoints.companyId, id));
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (secrets) await rm(secrets, { recursive: true, force: true });
    if (oldKey === undefined)
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = oldKey;
  });
  async function setup(shared = false, ownershipOptions: Pick<NonNullable<Parameters<typeof chatChannelService>[1]>, "renewDiscordGatewayLease"> = {}) {
    const companyId = randomUUID(),
      agentId = randomUUID(),
      userId = randomUUID();
    companyIds.push(companyId);
    await db.insert(companies).values({
      id: companyId,
      name: "Photon test",
      issuePrefix: `P${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Photon Agent",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "Operator",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: userId,
      permissionKey: "tools:manage_connections",
      grantedByUserId: userId,
    });
    const f = photonFixture();
    const allocation = shared ? {
      inspection: { projectId: "project", projectName: "Test shared", allocation: "shared" as const, eligible: true, lines: [] },
      tokens: new Map<string, string>(), sharedToken: "shared-project-token", expiresIn: 300,
    } : await f.cloud.allocation("project", "secret");
    vi.spyOn(PhotonCloudClient.prototype, "allocation").mockResolvedValue(
      allocation,
    );
    for (const resource of [
      f.client.messages,
      f.client.chats,
      f.client.groups,
      f.client.polls,
    ])
      resource.subscribeEvents.mockImplementation(() => idleStream());
    vi.spyOn(PhotonChatAdapter.prototype, "initialize").mockImplementation(
      async function (this: PhotonChatAdapter) {
        await this.client.close();
        Object.defineProperty(this, "client", {
          value: f.client as unknown as GrpcAdvancedIMessage,
        });
        await this.authentication.token();
      },
    );
    vi.spyOn(PhotonChatAdapter.prototype, "recoveryStream").mockImplementation(
      () => stream([{ type: "catchup.complete", headSequence: 0 }]),
    );
    const chats = new Map([[f.chat.guid, f.chat]]);
    f.client.chats.get.mockImplementation(async (guid?: string) => {
      const chat = chats.get(guid ?? "");
      if (!chat) throw new Error("Missing chat");
      return chat;
    });
    let runtime = new ChatSdkRuntime();
    let replacement = vi.spyOn(runtime, "replaceEndpoint");
    const wakeup = vi.fn(async (assignedAgentId, opts) => {
      const request = opts.durableChatRequest;
      if (request)
        await db.transaction(async (tx) => {
          await request.authorize(tx);
          await tx
            .insert(agentWakeupRequests)
            .values({
              id: request.id,
              companyId: request.companyId,
              agentId: assignedAgentId,
              source: opts.source,
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
      return { accepted: true };
    });
    const objects = new Map<string, Buffer>();
    const storage: StorageService = {
      provider: "local_disk",
      putFile: async (input) => {
        const objectKey = `${input.namespace}/${randomUUID()}`;
        if (!Buffer.isBuffer(input.body)) throw new Error("Expected a buffered attachment body");
        objects.set(objectKey, input.body);
        return {
          provider: "local_disk",
          objectKey,
          contentType: input.contentType,
          byteSize: input.body.length,
          sha256: createHash("sha256").update(input.body).digest("hex"),
          originalFilename: input.originalFilename,
        };
      },
      getObject: async (_company, key) => ({
        stream: Readable.from([objects.get(key)!]),
        contentLength: objects.get(key)!.length,
      }),
      headObject: async (_company, key) => ({ exists: objects.has(key) }),
      deleteObject: async (_company, key) => {
        objects.delete(key);
      },
    };
    const inboundMessages = new Map();
    f.client.messages.get.mockImplementation(
      async (id) =>
        inboundMessages.get(id) ??
        [...f.receipts.values()].find((message) => message.guid === id),
    );
    const makeService = () => {
      const service = chatChannelService(db, {
        runtime,
        ...ownershipOptions,
        publicBaseUrl: "https://paperclip.example",
        heartbeat: { wakeup },
        storage,
        scheduleDeferredWork: () => {},
      });
      services.push(service);
      return service;
    };
    let service = makeService();
    const endpoint = await service.create(
      companyId,
      { provider: "imessage-photon", assignedAgentId: agentId },
      userId,
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        photon: shared ? { allocation: "shared", projectId: "project" } : { projectId: "project", lineId: "line" },
        credentials: { projectSecret: "secret" },
      },
      userId,
    );
    const callbacks = () => replacement.mock.calls.at(-1)![0].callbacks;
    const deliver = async (event: LiveEvent) => {
      if (event.type === "message.received")
        inboundMessages.set(event.message.guid, event.message);
      await callbacks().onPhotonEvent!(event);
      await service.processPendingDeliveries();
    };
    const link = async (address = "+15555550101", person = userId) => {
      const principal = (await service.listPrincipals(endpoint.id)).find(
        (entry) => entry.externalLabel === address,
      )!;
      expect(principal).toBeDefined();
      const intent = await service.createLinkIntent(
        endpoint.id,
        principal.principalId,
        1800,
      );
      await service.confirmIdentityLink(
        new URL(intent.confirmationUrl).searchParams.get("token")!,
        person,
      );
    };
    const start = async () => {
      await deliver(photonEvent(1));
      expect(await service.listConversations(endpoint.id)).toHaveLength(0);
      await link();
      await deliver(photonEvent(2));
      const [conversation] = await service.listConversations(endpoint.id);
      expect(conversation).toBeDefined();
      return conversation;
    };
    const qualify = async () => {
      const [conversation] = await service.listConversations(endpoint.id);
      const [source] = await db
        .select()
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.endpointId, endpoint.id),
            eq(chatMessageLinks.direction, "inbound"),
          ),
        )
        .orderBy(sql`${chatMessageLinks.createdAt} desc`)
        .limit(1);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "chat:imessage-photon",
          wakeCommentId: source.commentId,
          wakeCommentIds: [source.commentId],
        },
      });
      const authorizationReason =
        await resolveChatRunPresentationAuthorizationReason(db, {
          companyId,
          issueId: conversation.issueId,
          runId,
        });
      expect(authorizationReason).toBe("allow_chat_run_presentation");
      await issueService(db).addComment(
        conversation.issueId,
        "Agent reply through Photon",
        { agentId, runId },
        { authorType: "agent", authorizationReason },
      );
      await service.processPendingPublications();
      await service.test(endpoint.id);
      expect((await service.get(endpoint.id)).status).toBe("active");
    };
    return {
      f,
      companyId,
      agentId,
      userId,
      endpoint,
      service,
      callbacks,
      deliver,
      link,
      start,
      qualify,
      chats,
      wakeup,
      restart: async () => {
        await service.shutdown();
        runtime = new ChatSdkRuntime();
        replacement = vi.spyOn(runtime, "replaceEndpoint");
        service = makeService();
        await service.reconcileProviderRuntimes();
        return service;
      },
    };
  }
  it.each([DELIVERY_QUEUES.nativeResponsePresentation, DELIVERY_QUEUES.nativeReviewResponse, DELIVERY_QUEUES.nativeStatusReassessment, DELIVERY_QUEUES.externalConversationSettlement])(
    "keeps repeated active Photon ownership assertions out of %s reconstruction and wakes once on recovery", async queue => {
    const t = await setup();
    await t.start();
    await t.qualify();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    coordinators.push(coordinator);
    const work = queue === DELIVERY_QUEUES.externalConversationSettlement ? externalConversationSettlementWork(db)
      : queue === DELIVERY_QUEUES.nativeResponsePresentation ? nativeResponsePresentationWork(db)
      : queue === DELIVERY_QUEUES.nativeReviewResponse ? nativeReviewResponseWork(db) : nativeStatusReassessmentWork(db);
    const worker = work.register(coordinator, () => true);
    const debug = db.$client.options.debug;
    const hints: unknown[] = [];
    const queries: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, queue, (event, values) => {
      if (event === "settled") for (const value of values ?? []) {
        const scope = JSON.parse(value);
        if (scope.companyId === t.companyId) hints.push(scope);
      }
    });
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
        .toEqual({ active: 0, next: null });
      db.$client.options.debug = (_connection, query) => {
        if (query.startsWith("select") && (queue === DELIVERY_QUEUES.externalConversationSettlement
          ? query.includes("exists (select 1 from chat_conversations c") : query.includes("native_run_finalizations"))) queries.push(query);
      };
      const assertOwned = t.callbacks().onPhotonAssertOwned!;
      for (let i = 0; i < 5; i++) await assertOwned();
      expect(hints).toEqual([]);
      expect(queries).toEqual([]);
      await db.update(chatEndpoints).set({ status: "attention", healthMessage: "Recovering transport" })
        .where(eq(chatEndpoints.id, t.endpoint.id));
      await Promise.all([assertOwned(), assertOwned(), assertOwned()]);
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
        .toEqual({ active: 0, next: null });
      expect(hints).toEqual([{ companyId: t.companyId }]);
      expect(queries).toHaveLength(1);
      expect((await t.service.get(t.endpoint.id)).status).toBe("active");
      hints.length = 0;
      queries.length = 0;
      for (let i = 0; i < 5; i++) await assertOwned();
      expect(hints).toEqual([]);
      expect(queries).toEqual([]);
      expect(errors).toEqual([]);
    } finally { unsubscribe(); db.$client.options.debug = debug; if ("stop" in worker) worker.stop(); }
  });

  it("recovers local intake through normal Runtime ownership after a real failure-write rollback", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const started: PhotonReceiver[] = [], start = PhotonReceiver.prototype.start;
    vi.spyOn(PhotonReceiver.prototype, "start").mockImplementation(function(this: PhotonReceiver) { started.push(this); start.call(this); });
    const t = await setup(), source = new PhotonError("network", "controlled recoverable Photon interruption"), persistence = new Error("controlled real failure-write rollback");
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: vi.fn() });
    coordinators.push(coordinator);
    const transaction = db.transaction.bind(db);
    let armed = true, rolledBack = false, failureWrites = 0, primary: unknown;
    db.transaction = (work, ...args) => transaction(async tx => {
      const result = await work(tx);
      if (result && typeof result === "object" && "kind" in result && result.kind === "recorded") {
        const [endpoint] = await tx.select({ status: chatEndpoints.status, healthMessage: chatEndpoints.healthMessage })
          .from(chatEndpoints).where(and(eq(chatEndpoints.companyId, t.companyId), eq(chatEndpoints.id, t.endpoint.id)));
        if (endpoint?.status === "attention" && endpoint.healthMessage === source.message) {
          failureWrites++;
          if (armed) { armed = false; throw persistence; }
        }
      }
      return result;
    }, ...args).catch(error => { if (error === persistence) rolledBack = true; throw error; });
    try {
      await t.service.registerReceiverWork(coordinator, () => true).ready;
      const first = t.service.runtime.get(t.endpoint.id); expect(first).not.toBeNull();
      const remove = vi.spyOn(t.service.runtime, "removeEndpoint");
      const replay = vi.mocked(PhotonChatAdapter.prototype.recoveryStream);
      await vi.waitFor(() => expect(replay.mock.calls.length).toBeGreaterThan(0), { timeout: 5000 });
      const originalReads = replay.mock.calls.length, originalStarts = started.length;
      replay.mockImplementationOnce(() => new TypedEventStream((async function* () { throw source; })()));
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(rolledBack).toBe(true), { timeout: 5000 });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(failureWrites).toBe(1); expect(t.service.runtime.get(t.endpoint.id)).toBe(first);
      expect(remove).not.toHaveBeenCalled();
      const [beforeRecovery] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
      expect(beforeRecovery.status).not.toBe("attention");
      const incoming = photonEvent(1), getMessage = t.f.client.messages.get.getMockImplementation();
      if (!getMessage) throw new Error("normal controlled message lookup absent");
      t.f.client.messages.get.mockImplementation(async guid => guid === incoming.message.guid ? incoming.message : getMessage(guid));
      replay.mockImplementation(() => stream([incoming, { type: "catchup.complete", headSequence: 1 }]));
      // The rollback was a one-shot real SQL fault. No direct failure callback,
      // Runtime reset or manual retry schedules recovery: only its existing reader cadence.
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(failureWrites, "restored SQL must be retried by the stopped receiver's owned reader").toBe(2), { timeout: 5000 });
      await vi.waitFor(() => {
        const current = t.service.runtime.get(t.endpoint.id);
        expect(current).not.toBeNull(); expect(current).not.toBe(first);
      }, { timeout: 5000 });
      await vi.waitFor(async () => expect(await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, t.endpoint.id))).toHaveLength(1), { timeout: 5000 });
      expect(remove).toHaveBeenCalledTimes(1);
      expect(started).toHaveLength(originalStarts + 1);
      expect(replay).toHaveBeenCalledTimes(originalReads + 2);
      expect(t.wakeup).not.toHaveBeenCalled(); // First normal intake remains unlinked.
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
      expect(connection.enabled).toBe(true); expect(connection.credentialSecretRefs.length).toBeGreaterThan(0);
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 5000 });
    } catch (error) { primary = error; throw error; }
    finally {
      db.transaction = transaction;
      const cleanup: unknown[] = [];
      try { await coordinator.stop(); } catch (error) { cleanup.push(error); }
      // Baseline failure still settles its actual debt under the same current
      // callback before service shutdown fences that callback. This is cleanup,
      // not the successful recovery observation asserted above.
      for (const receiver of started) try { await receiver.close(); } catch (error) { cleanup.push(error); }
      try { await t.service.shutdown(); } catch (error) { cleanup.push(error); }
      vi.useRealTimers();
      if (cleanup.length) throw new AggregateError(primary ? [primary, ...cleanup] : cleanup, "Photon failure-write recovery fixture cleanup remains owned");
    }
  }, 30_000);

  it("settles failed local reporting through authorized pause and repeated removal without new intake", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const t = await setup(); await t.start(); await t.qualify();
    const source = new PhotonError("network", "controlled local retirement interruption");
    const persistence = new Error("controlled real local failure-write rollback"), lostClose = new Error("controlled stream-close reply lost");
    const transaction = db.transaction.bind(db), replay = vi.mocked(PhotonChatAdapter.prototype.recoveryStream);
    let armed = false, rollbacks = 0, primary: unknown;
    db.transaction = (work, ...args) => transaction(async tx => {
      const result = await work(tx);
      if (armed && result && typeof result === "object" && "kind" in result && result.kind === "recorded") {
        const [endpoint] = await tx.select({ status: chatEndpoints.status, healthMessage: chatEndpoints.healthMessage })
          .from(chatEndpoints).where(and(eq(chatEndpoints.companyId, t.companyId), eq(chatEndpoints.id, t.endpoint.id)));
        if (endpoint?.status === "attention" && endpoint.healthMessage === source.message) { armed = false; throw persistence; }
      }
      return result;
    }, ...args).catch(error => { if (error === persistence) rollbacks++; throw error; });
    const failIntake = async (expected: number) => {
      armed = true;
      replay.mockImplementationOnce(() => new TypedEventStream((async function* () { throw source; })()));
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(rollbacks).toBe(expected), { timeout: 5000 });
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    try {
      const [before] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
      const deliveries = await db.select({ id: chatDeliveries.id }).from(chatDeliveries).where(eq(chatDeliveries.endpointId, t.endpoint.id));
      const conversations = await t.service.listConversations(t.endpoint.id), reads = replay.mock.calls.length;
      await failIntake(1);
      let pauseFailure: unknown;
      try { await t.service.configure(t.endpoint.id, { action: "pause" }, t.userId); } catch (error) { pauseFailure = error; }
      expect(pauseFailure, "the exact durably paused local owner must settle its already-joined reporting debt").toBeUndefined();
      expect(t.service.runtime.hasUnsettledLifecycle()).toBe(false);
      expect(replay).toHaveBeenCalledTimes(reads + 1);
      const [paused] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
      expect(paused).toMatchObject({ enabled: false, status: "disabled", credentialSecretRefs: before.credentialSecretRefs });
      // Only ordinary authorized resume creates the next local owner.
      await t.service.configure(t.endpoint.id, { action: "resume" }, t.userId);
      await failIntake(2);
      const owned = t.f.client.messages.subscribeEvents.mock.results.at(-1)?.value;
      if (!owned) throw new Error("normal local subscription missing");
      const close = owned.close.bind(owned);
      vi.spyOn(owned, "close").mockImplementationOnce(async () => { await close(); throw lostClose; });
      await expect(t.service.configure(t.endpoint.id, { action: "remove" }, t.userId)).rejects.toThrow(/shutdown|retirement|close/i);
      const [held] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
      expect(held).toMatchObject({ status: "archived", enabled: false, credentialSecretRefs: before.credentialSecretRefs });
      expect((await t.service.get(t.endpoint.id)).status).toBe("archived");
      expect(t.service.runtime.hasUnsettledLifecycle()).toBe(true);
      const readsBeforeRetry = replay.mock.calls.length;
      await t.service.configure(t.endpoint.id, { action: "remove" }, t.userId);
      expect(t.service.runtime.hasUnsettledLifecycle()).toBe(false);
      const [removed] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
      expect(removed.credentialSecretRefs).toEqual([]);
      expect(replay).toHaveBeenCalledTimes(readsBeforeRetry);
      expect(await db.select({ id: chatDeliveries.id }).from(chatDeliveries).where(eq(chatDeliveries.endpointId, t.endpoint.id))).toEqual(deliveries);
      expect((await t.service.listConversations(t.endpoint.id)).map(row => row.id)).toEqual(conversations.map(row => row.id));
    } catch (error) { primary = error; throw error; }
    finally {
      db.transaction = transaction; vi.useRealTimers();
      try { await t.service.shutdown(); }
      catch (cleanup) {
        // Old product retains this same real lifecycle debt after physical
        // joins. Preserve normal teardown rejection; never fake a receipt or
        // reset the registry, active status, credentials, or generation.
        throw new AggregateError([...(primary ? [primary] : []), cleanup], "Photon local retirement causal failure with retained normal cleanup debt");
      }
    }
  }, 30_000);

  it("recovers a Photon transport loss through the receiver worker and cancels fatal recovery", async () => {
    const t = await setup();
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    coordinators.push(coordinator);
    await t.service.registerReceiverWork(coordinator, () => true).ready;
    const first = t.service.runtime.get(t.endpoint.id);
    expect(first).not.toBeNull();
    await t.callbacks().onPhotonFailure!(new Error("transport interrupted"));
    await vi.waitFor(() => {
      const current = t.service.runtime.get(t.endpoint.id);
      expect(current).not.toBeNull(); expect(current).not.toBe(first);
    }, { timeout: 5000 });
    await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 5000 });
    await t.callbacks().onPhotonFailure!(new PhotonError("credentials", "Rejected credentials"));
    await vi.waitFor(() => expect(t.service.runtime.get(t.endpoint.id)).toBeNull(), { timeout: 5000 });
    await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 5000 });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId)))
      .toEqual([expect.objectContaining({ enabled: false })]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps publication authentication failures stopped across receiver reconciliation and restart", async () => {
    const t = await setup();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    coordinators.push(coordinator);
    await t.service.registerReceiverWork(coordinator, () => true).ready;
    const conversation = await t.start();
    await t.qualify();
    const callbacks = t.callbacks();
    vi.spyOn(PhotonChatAdapter.prototype, "publish").mockRejectedValueOnce(new PhotonError("credentials", "Rejected credentials"));
    const comment = await issueService(db).addComment(conversation.issueId!, "Response with rejected credentials", { userId: t.userId }, { authorType: "user" });
    await t.service.publishComment(t.endpoint.id, conversation.id, comment.id);
    expect(await db.select().from(chatPublications).where(eq(chatPublications.commentId, comment.id))).toEqual([
      expect.objectContaining({ state: "failed", attempts: 1, nextAttemptAt: null }),
    ]);
    expect(await t.service.get(t.endpoint.id)).toMatchObject({ status: "attention" });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId))).toEqual([
      expect.objectContaining({ status: "active", enabled: true, healthStatus: "failed" }),
    ]);
    await expect(callbacks.onPhotonAssertOwned!()).rejects.toThrow();
    await vi.waitFor(() => expect(t.service.runtime.get(t.endpoint.id)).toBeFalsy(), { timeout: 5000 });
    await coordinator.stop();
    const restarted = await t.restart();
    expect(restarted.runtime.get(t.endpoint.id)).toBeFalsy();
    expect(await restarted.get(t.endpoint.id)).toMatchObject({ status: "attention" });
  });

  it("supports shared project DMs while rejecting groups, duplicate ownership and allocation changes", async () => {
    const t = await setup(true);
    const snapshot = await t.service.get(t.endpoint.id);
    expect(snapshot).toMatchObject({ photonAllocation: "shared", botExternalId: "photon-project:project", botUsername: null, allowGroupChats: false });
    await expect(t.service.update(t.endpoint.id, { allowGroupChats: true }, t.userId)).rejects.toThrow(/direct messages only/);
    const group = photonChat("iMessage;+;shared-group", true);
    t.chats.set(group.guid, group);
    await t.deliver(photonEvent(10, group));
    expect(await t.service.listResources(t.endpoint.id)).toHaveLength(0);
    expect(t.wakeup).not.toHaveBeenCalled();
    const conversation = await t.start();
    expect(conversation.externalThreadId).toContain("shared-");
    await t.qualify();
    expect(t.f.client.groups.subscribeEvents).not.toHaveBeenCalled();
    const duplicate = await t.service.create(t.companyId, { provider: "imessage-photon", assignedAgentId: t.agentId }, t.userId);
    expect(await t.service.inspectPhoton(duplicate.id, {projectId: "project", projectSecret: "secret"})).toMatchObject({ allocation: "shared", eligible: false });
    await expect(t.service.configure(duplicate.id, { action: "configure", photon: { allocation: "shared", projectId: "project" }, credentials: { projectSecret: "secret" } }, t.userId)).rejects.toThrow(/already/);
    const restarted = await t.restart();
    expect((await restarted.listConversations(t.endpoint.id))[0].id).toBe(conversation.id);
    await expect(restarted.configure(t.endpoint.id, { action: "reconnect", photon: { projectId: "project", lineId: "line" }, credentials: { projectSecret: "secret" } }, t.userId)).rejects.toThrow(/allocation|identity|different/);
  });
  it("distinguishes setup validation from provider outages without replacing credentials", async () => {
    const t = await setup();
    const allocation = vi.spyOn(PhotonCloudClient.prototype, "allocation");
    for (const [code, status] of [
      ["credentials", 422],
      ["line_unavailable", 422],
      ["quota", 429],
      ["network", 503],
      ["invalid_response", 502],
    ] as const) {
      allocation.mockRejectedValueOnce(new PhotonError(code, `Safe Photon ${code} message`));
      await expect(t.service.inspectPhoton(t.endpoint.id, {
        projectId: "project", projectSecret: "replacement",
      })).rejects.toMatchObject({ status, details: { code: `photon_${code}` } });
      allocation.mockRejectedValueOnce(new PhotonError(code, `Safe Photon ${code} message`));
      await expect(t.service.configure(t.endpoint.id, {
        action: "reconnect", credentials: { projectSecret: "replacement" },
      }, t.userId)).rejects.toMatchObject({ status, details: { code: `photon_${code}` } });
    }
    await t.start();
    await t.qualify();
  });
  it("requires a fresh linked message and an agent reply before setup completes", async () => {
    const t = await setup();
    await expect(t.service.test(t.endpoint.id)).rejects.toThrow("test message");
    await t.start();
    await expect(t.service.test(t.endpoint.id)).rejects.toThrow();
    expect(t.wakeup).toHaveBeenCalledTimes(1);
    await t.qualify();
    expect(
      t.f.client.messages.sendText.mock.calls.find((call) =>
        call[1].includes("Agent reply"),
      )?.[2],
    ).toMatchObject({ replyTo: "message-2" });
    const secretSafe = JSON.stringify(await t.service.get(t.endpoint.id));
    expect(secretSafe).not.toContain("private-line-token");
    expect(secretSafe).not.toContain('"projectSecret"');
  }, 30_000);
  async function onlinePhotonEnrollment(activityFails = false) {
    const home = await mkdtemp(path.join(tmpdir(), "photon-online-enrollment-"));
    const keys = ["PAPERCLIP_HOME", "PAPERCLIP_CONFIG", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_PUBLIC_URL",
      "PAPERCLIP_AUTH_PUBLIC_BASE_URL", "BETTER_AUTH_URL", "BETTER_AUTH_BASE_URL",
      "PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", "PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",
      "PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY", "PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", "PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT",
      "PAPERCLIP_ID_CONNECTOR_INSTANCE_ID", "PAPERCLIP_ID_CONNECTOR_SIGN_PRIVATE_KEY", "PAPERCLIP_ID_CONNECTOR_SEAL_PRIVATE_KEY",
      "PAPERCLIP_ID_CONNECTOR_BASE_URL", "PAPERCLIP_ID_CONNECTOR_ENVIRONMENT"];
    const previous = new Map(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_CONFIG = path.join(home, "config.json");
    process.env.PAPERCLIP_INSTANCE_ID = "online-enrollment";
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example";
    process.env.PAPERCLIP_CLOUD_CONNECTOR_BASE_URL = "https://cloud.example";
    process.env.PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT = "test";
    let t: Awaited<ReturnType<typeof setup>> | undefined;
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let eventWorker: ReturnType<typeof registerGitHubConnectionEventWork> | undefined;
    let server: Server | undefined;
    const trigger = `photon_enrollment_activity_${randomUUID().replaceAll("-", "")}`;
    let installedTrigger = false;
    let primary: { error: unknown } | undefined;
    try {
      expect(loadPaperclipCloudConnectorIdentity()).toBeNull();
      expect(cloudConnectors.paperclipCloudConnectorConfigFromEnv()).toBeNull();
      const brokerOperations: Record<string, unknown>[] = [];
      const negotiations: { subject: string; companyId: string }[] = [];
      const transport: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        expect(url.origin).toBe("https://cloud.example");
        if (url.pathname === "/v1/connector/enrollments") {
          const body = JSON.parse(String(init?.body));
          expect(body.origin).toBe("https://paperclip.example");
          expect(body.returnUri).toBe("https://paperclip.example/api/tools/oauth/cloud-connector/enrollment-callback");
          return Response.json({ enrollmentId: "online-case", verificationUrl: "https://cloud.example/connections/enroll?id=online-case",
            expiresAt: new Date(Date.now() + 60_000).toISOString() }, { status: 201 });
        }
        const identity = loadPaperclipCloudConnectorIdentity();
        if (!identity) throw new Error("Normal enrollment identity absent at controlled Cloud boundary");
        const body = JSON.parse(String(init?.body));
        const [header, payload, signature] = String(body.request).split(".");
        const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: identity.signPublicKey }, format: "jwk" });
        expect(verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        expect(claims).toMatchObject({ iss: identity.instanceId, env: "test", aud: url.toString() });
        if (url.pathname === "/v1/connector/enrollment-claims") {
          expect(claims.op).toBe("enroll");
          expect(body).toMatchObject({ enrollmentId: "online-case", approvalCode: "controlled-approval" });
          return Response.json({ id: identity.instanceId, environment: "test", origins: ["https://paperclip.example"] });
        }
        if (url.pathname === "/v1/connector/events/lease") {
          expect(claims.ewv).toBe(1);
          expect(typeof claims.sub).toBe("string"); expect(typeof claims.cid).toBe("string");
          negotiations.push({ subject: claims.sub, companyId: claims.cid });
          return Response.json({ events: [], eventWakeVersion: 1 });
        }
        if (url.pathname === "/v1/connector/instance-status")
          return Response.json({ active: true, status: "active", profiles: [], photonReceiver: { version: 1 } });
        throw new Error("Unexpected controlled normal Cloud request");
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(transport);
      let retirementRequested = false;
      const createConnector = cloudConnectors.createPaperclipCloudConnector;
      vi.spyOn(cloudConnectors, "createPaperclipCloudConnector").mockImplementation(input => {
        const connector = createConnector({ ...input, request: transport });
        vi.spyOn(connector, "photonReceiverOperation").mockImplementation(async ({ operation }) => {
          if (!t) throw new Error("Unexpected normal broker operation");
          const saved = readPhotonExternalState(await photonStateFor(db, { companyId: t.companyId, endpointId: t.endpoint.id }).read(PHOTON_EXTERNAL_STATE));
          if (!saved) throw new Error("Normal handoff intent absent before broker invocation");
          expect(saved.identity.subject).toBe(t.userId);
          expect(input.config.instanceId).toBe(loadPaperclipCloudConnectorIdentity()?.instanceId);
          brokerOperations.push(structuredClone(operation));
          if (operation.kind === "enroll") return { binding: saved.binding };
          expect(operation.binding).toEqual(saved.binding);
          if (operation.kind === "retire") { retirementRequested = true; return { binding: saved.binding }; }
          if (operation.kind === "status") return { binding: saved.binding, handoffId: saved.handoffId,
            phase: retirementRequested ? "retired" : "active" };
          throw new Error("Unexpected controlled exact-owner retirement operation");
        });
        return connector;
      });
      t = await setup(); await t.start(); await t.qualify();
      const localRuntime = t.service.runtime.get(t.endpoint.id);
      expect(localRuntime).not.toBeNull();
      const [originalLease] = await db.select().from(chatEndpointLeases).where(and(
        eq(chatEndpointLeases.endpointId, t.endpoint.id), eq(chatEndpointLeases.leaseKey, "photon_receiver_runtime")));
      if (!originalLease) throw new Error("Normal existing local Runtime lease is absent");
      const [before] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
      expect(before.status).toBe("active");
      expect(Reflect.get(before.setup, "photonExternalSubject"), "normal configuration retains its authorized subject without Cloud").toBe(t.userId);
      const state = photonStateFor(db, { companyId: t.companyId, endpointId: t.endpoint.id });
      expect(readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE))).toBeNull();
      const errors: unknown[] = [];
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      coordinators.push(coordinator);
      const eventService = githubConnectionEventService(db);
      eventWorker = registerGitHubConnectionEventWork(db, coordinator, eventService, () => true);
      connectionEventWorkers.push(eventWorker);
      const receiverWorker = t.service.registerReceiverWork(coordinator, () => true);
      await Promise.all([eventWorker.ready, receiverWorker.ready]);
      await vi.waitFor(() => expect(coordinator?.nextWakeAt()).toBeNull(), { timeout: 5000 });
      expect(t.service.runtime.get(t.endpoint.id)).toBe(localRuntime);
      expect(errors).toEqual([]); expect(negotiations).toEqual([]); expect(brokerOperations).toEqual([]);
      const app = express(); app.use(express.json());
      const userId = t.userId, companyId = t.companyId;
      app.use((req, _res, next) => {
        req.actor = { type: "board", source: "session", userId, companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "operator", status: "active" }], isInstanceAdmin: true };
        next();
      });
      app.use("/api", toolAccessRoutes(db, { deploymentMode: "local_trusted", deploymentExposure: "private",
        authPublicBaseUrl: "https://paperclip.example", paperclipCloudConnector: null }));
      app.use(errorHandler);
      const listener = createServer(app); server = listener;
      await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
      await request(listener).post("/api/tools/oauth/cloud-connector/enrollment").set("Connection", "close")
        .send({ companyId }).expect(201);
      const pending = loadPaperclipCloudConnectorIdentity();
      if (!pending?.pending) throw new Error("Normal public enrollment did not save its pending owner");
      expect(pending.status).toBe("pending");
      expect(pending.pending).toMatchObject({ companyId, initiatedBy: `user:${userId}` });
      await request(listener).get("/api/tools/oauth/cloud-connector/enrollment-callback").set("Connection", "close")
        .query({ enrollment_id: "online-case", approval_code: "controlled-approval", state: "wrong-state" }).expect(400);
      expect(cloudConnectors.paperclipCloudConnectorConfigFromEnv()).toBeNull();
      expect(brokerOperations).toEqual([]);
      if (activityFails) {
        // Actual SQL write rollback after successful file enrollment. The fault
        // is scoped to this company/action; no other lifecycle write is changed.
        await db.execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.company_id = '${companyId}'::uuid AND NEW.action = 'paperclip_cloud_connector.enrollment_completed'
          THEN RAISE EXCEPTION 'controlled enrollment activity rollback'; END IF; RETURN NEW; END $$`));
        await db.execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION ${trigger}()`));
        installedTrigger = true;
      }
      await request(listener).get("/api/tools/oauth/cloud-connector/enrollment-callback").set("Connection", "close")
        .query({ enrollment_id: "online-case", approval_code: "controlled-approval", state: pending.pending.returnState })
        .expect(activityFails ? 500 : 303);
      expect(loadPaperclipCloudConnectorIdentity()).toMatchObject({ status: "active", instanceId: pending.instanceId });
      expect(cloudConnectors.paperclipCloudConnectorConfigFromEnv()).toMatchObject({ instanceId: pending.instanceId, environment: "test" });
      // Only the public callback may wake the already-settled owner. No manual
      // changed(), forced discovery, connector replacement or service restart.
      await vi.waitFor(async () => {
        const recovered = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
        expect(recovered?.phase, "online enrollment must hand off the existing settled local receiver without restart").toBe("external");
      }, { timeout: 10_000 });
      const recovered = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
      expect(recovered).toMatchObject({ identity: { companyId, endpointId: t.endpoint.id, connectionId: t.endpoint.connectionId,
        runtimeGeneration: Reflect.get(before.setup, "runtimeGeneration"), subject: userId }, localClosureConfirmed: true,
        binding: { instanceId: pending.instanceId, environment: "test" } });
      expect(t.service.runtime.get(t.endpoint.id)).toBeNull();
      expect(t.f.client.close).toHaveBeenCalled();
      expect(brokerOperations).toHaveLength(1);
      expect(negotiations.some(row => row.subject === userId && row.companyId === companyId)).toBe(true);
      const [after] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
      const [afterConnection] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
      expect(after.connectionId).toBe(before.connectionId);
      expect(Reflect.get(after.setup, "runtimeGeneration")).toBe(Reflect.get(before.setup, "runtimeGeneration"));
      expect(Reflect.get(after.setup, "photonExternalSubject")).toBe(userId);
      expect(afterConnection.credentialSecretRefs).toEqual(connection.credentialSecretRefs);
      await vi.waitFor(() => expect(coordinator?.nextWakeAt()).toBeNull(), { timeout: 5000 });
      expect(errors).toEqual([]);
      expect(await db.select().from(chatEndpointLeases).where(and(eq(chatEndpointLeases.endpointId, t.endpoint.id),
        eq(chatEndpointLeases.leaseKey, "photon_receiver_runtime")))).toEqual([]);
      if (!recovered) throw new Error("Normal online handoff state is absent");
      const ownerId = randomUUID(), generation = photonHash([ownerId, recovered.handoffId]);
      const incomingWake = { version: 1, ownerId, generation, routes: ["photon-broker-events-v1"],
        photonBroker: { version: 1, instanceId: pending.instanceId, generation, count: 1,
          bindingsFingerprint: photonCoverageFingerprint([{ binding: recovered.binding, handoffId: recovered.handoffId,
            subject: recovered.identity.subject, deliveredThrough: recovered.acceptedSequence }]) } };
      // Controlled Cloud signing authority, verified by the normal production
      // verifier; not a cast of parsed/unverified coverage or Cloud SDK readiness.
      const pair = generateKeyPairSync("ed25519"), kid = randomUUID(), issued = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const header = encode({ alg: "EdDSA", typ: CLOUD_CONTROL_JWS_TYPE, kid });
      const payload = encode({ v: 1, iss: CLOUD_RUNTIME_IDENTITY_ISSUER, aud: CLOUD_CONTROL_AUDIENCE,
        sub: pending.instanceId, action: "task-drain:read", requestId: randomUUID(), iat: issued, exp: issued + 60,
        idleCapabilities: { incomingWake } });
      const compactJws = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), pair.privateKey).toString("base64url")}`;
      const verified = verifyCloudControlAssertion({ compactJws, expectedAction: "task-drain:read", env: {
        PAPERCLIP_CLOUD_STACK_ID: pending.instanceId,
        PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "EdDSA" }] }),
      } }).idleCapabilities;
      if (!verified) throw new Error("Normal signed Cloud coverage verification produced no capability");
      const allocations = vi.spyOn(photonOwnedClients, "createOwnedPhotonClient");
      const closeCalls = vi.mocked(t.f.client.close).mock.calls.length;
      const retainedBeforeProof = await state.read(PHOTON_EXTERNAL_STATE);
      await expect(db.transaction(tx => readIdleIncomingWakeProof(tx, { capabilities: verified as VerifiedIdleCapabilities,
        ownerId, receiverOwner: db })), "normal online handoff must certify incoming wake after its exact local close")
        .resolves.toMatchObject({ endpointIds: [t.endpoint.id], connectionIds: [connection.id] });
      expect(recovered.localResource?.id).toBe(recovered.localResourceId);
      expect(recovered.localResource?.closed).toBe(true);
      expect(recovered.localResource?.leaseDigest).toBe(photonHash(originalLease.token));
      expect(recovered.localResource?.controller).toEqual(await currentControllerProcess());
      expect(await state.read(PHOTON_EXTERNAL_STATE)).toEqual(retainedBeforeProof);
      expect(allocations).not.toHaveBeenCalled();
      expect(t.f.client.close).toHaveBeenCalledTimes(closeCalls);
    } catch (error) { primary = { error }; }
    finally {
      const cleanup: unknown[] = [];
      try { if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); } catch (error) { cleanup.push(error); }
      try { await eventWorker?.stop(); } catch (error) { cleanup.push(error); }
      try { await coordinator?.stop(); } catch (error) { cleanup.push(error); }
      // Retire only this test's exact owned Cloud/local history through the
      // normal authorized remove path, before restoring its identity context.
      try { if (t) await t.service.configure(t.endpoint.id, { action: "remove" }, t.userId); } catch (error) { cleanup.push(error); }
      try { await t?.service.shutdown(); } catch (error) { cleanup.push(error); }
      if (installedTrigger) {
        try { await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON activity_log`)); } catch (error) { cleanup.push(error); }
        try { await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${trigger}()`)); } catch (error) { cleanup.push(error); }
      }
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      try { await rm(home, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
      if (cleanup.length) throw new AggregateError([...(primary ? [primary.error] : []), ...cleanup], "Online Photon fixture cleanup remains owned");
    }
    if (primary) throw primary.error;
  }
  it("hands a settled local Photon receiver to Cloud after normal online enrollment without restart",
    () => onlinePhotonEnrollment(), 30_000);
  it("keeps the normal online Photon handoff hint after its activity write rolls back",
    () => onlinePhotonEnrollment(true), 30_000);
  async function resumeOriginalHandoff(phase: "enrolling" | "joining", observeIdleRenewal = false) {
    const renew = vi.fn(async () => true);
    const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519");
    const connectorConfig = { baseUrl: "https://cloud.example", instanceId: "instance", environment: "test" as const,
      signPrivateKey: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      sealPrivateKey: sealing.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const eventEnrollments: { subject: string; companyId: string }[] = [];
    const connector = cloudConnectors.createPaperclipCloudConnector({ config: connectorConfig,
      request: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        expect(url.origin).toBe(connectorConfig.baseUrl);
        if (url.pathname === "/v1/connector/events/lease") {
          if (typeof init?.body !== "string") throw new Error("Missing normal signed event enrollment");
          const body = JSON.parse(init.body);
          const [header, payload, signature] = body.request.split(".");
          expect(verify(null, Buffer.from(`${header}.${payload}`), signing.publicKey,
            Buffer.from(signature, "base64url"))).toBe(true);
          const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
          expect(claims).toMatchObject({ iss: connectorConfig.instanceId, env: connectorConfig.environment, aud: url.toString(), ewv: 1 });
          expect(claims.sub).toEqual(expect.any(String));
          expect(claims.cid).toEqual(expect.any(String));
          eventEnrollments.push({ subject: claims.sub, companyId: claims.cid });
          // Normal connector.leaseEvents parses this controlled protocol reply;
          // no fixture writes the connector's negotiated state or join promise.
          return Response.json({ events: [], eventWakeVersion: 1 });
        }
        return Response.json({ active: true, status: "active", profiles: [], photonReceiver: { version: 1 } });
      } });
    vi.spyOn(cloudConnectors, "paperclipCloudConnectorConfigFromEnv").mockReturnValue(connectorConfig);
    vi.spyOn(cloudConnectors, "createPaperclipCloudConnector").mockReturnValue(connector);
    const createOwner = photonExternalRuntime.createPhotonExternalRuntimeOwner;
    let observedOwner: ReturnType<typeof createOwner> | undefined;
    vi.spyOn(photonExternalRuntime, "createPhotonExternalRuntimeOwner").mockImplementation((...args) => {
      observedOwner = createOwner(...args);
      return observedOwner;
    });
    const requests: Record<string, unknown>[] = [];
    let endpointId: string | undefined, companyId: string | undefined;
    vi.spyOn(connector, "photonReceiverOperation").mockImplementation(async ({ operation }) => {
      requests.push(structuredClone(operation));
      if (!endpointId || !companyId || operation.kind !== "enroll") throw new Error("Unexpected controlled broker operation");
      const retained = readPhotonExternalState(await photonStateFor(db, { companyId, endpointId }).read(PHOTON_EXTERNAL_STATE));
      if (!retained) throw new Error("Normal staged enrollment absent");
      return { binding: retained.binding };
    });
    const t = await setup(false, { renewDiscordGatewayLease: renew }); endpointId = t.endpoint.id; companyId = t.companyId;
    await t.start(); await t.qualify();
    const enrollmentErrors: unknown[] = [];
    const eventCoordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      onError: error => enrollmentErrors.push(error) });
    coordinators.push(eventCoordinator);
    const eventService = githubConnectionEventService(db, { connector });
    const eventWorker = registerGitHubConnectionEventWork(db, eventCoordinator, eventService, () => true);
    connectionEventWorkers.push(eventWorker);
    // Match normal startup registration and join its actual first signed lease
    // negotiation. No event drain, handwritten version or successful join stub.
    await Promise.all([eventWorker.ready, joinConnectionEventWakeEnrollment(db)]);
    expect(eventEnrollments.length).toBeGreaterThan(0);
    expect(connector.eventWakeVersion()).toBe(1);
    expect(enrollmentErrors).toEqual([]);
    const owner = observedOwner;
    if (!owner) throw new Error("Normal external Runtime owner absent");
    const state = photonStateFor(db, { companyId: t.companyId, endpointId: t.endpoint.id });
    if (phase === "joining") {
      const local = t.service.runtime.get(t.endpoint.id);
      if (!local) throw new Error("Normal local receiver absent");
      vi.spyOn(local, "shutdown").mockRejectedValueOnce(new Error("Controlled original local join pending"));
      await expect(owner.reconcile(t.endpoint.id)).rejects.toThrow("Controlled original local join pending");
    }
    const original = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
    expect(original?.phase).toBe(phase);
    if (!original) throw new Error("Normal unfinished handoff absent");
    const [before] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
    const [connectionBefore] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
    expect(before.status).toBe("active");
    await t.service.configure(t.endpoint.id, { action: "pause" }, t.userId);
    const [paused] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
    expect(paused.status).toBe("paused");
    expect(Reflect.get(paused.setup, "runtimeGeneration")).toBe(Reflect.get(before.setup, "runtimeGeneration"));
    expect(readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE)))
      .toMatchObject({ phase, binding: original.binding, handoffId: original.handoffId, identity: original.identity });
    const outcome = await t.service.configure(t.endpoint.id, { action: "resume" }, t.userId)
      .then(snapshot => ({ snapshot, error: null }), error => ({ snapshot: null, error }));
    const [resumed] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
    const [connectionResumed] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
    const recovered = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
    expect(Reflect.get(resumed.setup, "runtimeGeneration")).toBe(Reflect.get(before.setup, "runtimeGeneration"));
    expect(resumed.connectionId).toBe(before.connectionId);
    expect(connectionResumed.credentialSecretRefs).toEqual(connectionBefore.credentialSecretRefs);
    const cutoff = Date.parse(String(Reflect.get(resumed.setup, "photonIntakeAfter")));
    expect(Number.isFinite(cutoff)).toBe(true);
    expect(cutoff).toBeGreaterThan(Date.parse(original.binding.intakeAfter));
    expect(outcome.error, "normal resume must finish original custody under unchanged authority").toBeNull();
    expect(outcome.snapshot).toMatchObject({ status: "active" });
    expect(recovered).toMatchObject({ phase: "external", identity: original.identity, binding: original.binding, handoffId: original.handoffId });
    expect(requests).toHaveLength(1);
    expect(requests[0].enrollment).toMatchObject({ intakeAfter: original.binding.intakeAfter, handoffId: original.handoffId });
    if (!recovered) throw new Error("Normal recovered custody absent");
    const receiverLeases = () => db.select().from(chatEndpointLeases).where(and(
      eq(chatEndpointLeases.companyId, t.companyId), eq(chatEndpointLeases.endpointId, t.endpoint.id),
      eq(chatEndpointLeases.leaseKey, "photon_receiver_runtime")));
    if (observeIdleRenewal) {
      const renewalsAfterResume = renew.mock.calls.length;
      const idleLeaseBefore = await receiverLeases();
      // The unchanged normal 15-second TTL renews every 5 seconds. Real DB and
      // timer ownership remain active; no manually invoked callback or fake time.
      await new Promise(resolve => setTimeout(resolve, 5_100));
      const idleLeaseAfter = await receiverLeases();
      expect(renew.mock.calls.length - renewalsAfterResume,
        "settled Cloud resume must stop the normal renewable receiver owner").toBe(0);
      expect(idleLeaseBefore).toEqual([]);
      expect(idleLeaseAfter).toEqual([]);
    }
    // Match the existing managed external fixture: each useful allocation owns
    // its distinct controlled client; provider receipts stay on the same port.
    const usefulClients: { client: GrpcAdvancedIMessage; joined: boolean; methods: string[];
      close: ReturnType<typeof photonFixture>["client"]["close"] }[] = [];
    vi.spyOn(photonOwnedClients, "createOwnedPhotonClient").mockImplementation(() => {
      const owned = photonFixture();
      const row = { client: owned.adapter.client, joined: false, methods: new Array<string>(), close: owned.client.close };
      const close = async () => {
        if (row.joined) return;
        await owned.client.close();
        row.joined = true;
      };
      const channel = (name: "chats" | "messages" | "attachments" | "groups" | "polls" | "events") => new Proxy(owned.adapter.client[name], {
        get(target, key, receiver) {
          const method = Reflect.get(target, key, receiver);
          if (typeof method !== "function") return method;
          return (...args: unknown[]) => {
            if (row.joined) throw new Error("Controlled useful client used after its own close");
            row.methods.push(`${name}.${String(key)}`);
            const providerMethod = Reflect.get(t.f.adapter.client[name], key);
            if (typeof providerMethod !== "function") throw new Error("Unexpected controlled useful method");
            return Reflect.apply(providerMethod, t.f.adapter.client[name], args);
          };
        },
      });
      row.client = new Proxy(owned.adapter.client, { get(target, key, receiver) {
        if (key === "close") return close;
        if (key === "chats" || key === "messages" || key === "attachments" || key === "groups" || key === "polls" || key === "events") return channel(key);
        return Reflect.get(target, key, receiver);
      } });
      usefulClients.push(row);
      return row.client;
    });
    // Same pinned protobuf framing pattern as external-owner.test.ts, decoded
    // by the real SDK. Enter the registered Cloud ingress, not onPhotonEvent:
    // its ordinary runtimeFor/lease acquisition and finally release stay real.
    const varint = (input: number): Buffer => {
      let value = BigInt(input); const bytes: number[] = [];
      do { const byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value);
      return Buffer.from(bytes);
    };
    const integer = (field: number, value: number) => Buffer.concat([varint(field * 8), varint(value)]);
    const field = (number: number, value: Buffer | string) => {
      const bytes = typeof value === "string" ? Buffer.from(value) : value;
      return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
    };
    const timestamp = (at: number) => Buffer.concat([integer(1, Math.floor(at / 1000)), integer(2, (at % 1000) * 1_000_000)]);
    const packet = (sequence: number, previousSequence: number | null, occurredAt: number) => {
      const sender = Buffer.concat([field(1, "+15555550101"), integer(2, 1)]);
      const message = Buffer.concat([field(1, `idle-lease-message-${sequence}`), field(2, field(1, "Fresh normal Cloud admission")),
        field(10, timestamp(occurredAt)), field(20, sender), field(92, t.f.chat.guid)]);
      const change = Buffer.concat([field(1, t.f.chat.guid), field(2, timestamp(occurredAt)), field(10, field(1, message))]);
      const rawFrame = Buffer.concat([integer(1, sequence), field(10, change)]).toString("base64");
      const acceptedAt = new Date().toISOString();
      return { id: `photon_${photonHash([recovered.binding.bindingId, sequence])}`, event: "message.received", createdAt: acceptedAt,
        installationId: recovered.binding.bindingId, bindingIds: [recovered.binding.bindingId], payload: { photonEvent: {
          version: 1, binding: recovered.binding, sequence, previousSequence, acceptedAt, rawFrame } } };
    };
    const wakeups = t.wakeup.mock.calls.length;
    const previous = recovered.acceptedSequence;
    const oldInput = packet((previous ?? 0) + 1, previous, cutoff - 1);
    await photonExternalRuntime.dispatchPhotonCloudEvent(db, oldInput);
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups);
    expect(usefulClients).toHaveLength(0);
    expect(await receiverLeases()).toEqual([]);
    const freshInput = packet((previous ?? 0) + 2, (previous ?? 0) + 1, cutoff);
    const getChat = t.f.client.chats.get.getMockImplementation();
    if (!getChat) throw new Error("Existing controlled provider lookup absent");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let usefulEntered = false;
    t.f.client.chats.get.mockImplementation(async (...args) => {
      expect(await receiverLeases()).toHaveLength(1);
      usefulEntered = true;
      await held;
      return getChat(...args);
    });
    const admitted = photonExternalRuntime.dispatchPhotonCloudEvent(db, freshInput);
    const observed = admitted.then(() => ({ error: null }), error => ({ error }));
    try {
      await vi.waitFor(() => expect(usefulEntered).toBe(true));
      if (observeIdleRenewal) {
        const renewalsDuringUseful = renew.mock.calls.length;
        await new Promise(resolve => setTimeout(resolve, 5_100));
        expect(renew.mock.calls.length).toBeGreaterThan(renewalsDuringUseful);
        expect(await receiverLeases()).toHaveLength(1);
      }
    } finally { release(); }
    expect((await observed).error).toBeNull();
    await t.service.processPendingDeliveries();
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups + 1);
    expect(await receiverLeases()).toEqual([]);
    await photonExternalRuntime.dispatchPhotonCloudEvent(db, freshInput);
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups + 1);
    expect(await receiverLeases()).toEqual([]);
    const afterAdmission = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
    expect(afterAdmission).toMatchObject({ acceptedSequence: (previous ?? 0) + 2, pending: null, binding: original.binding });
    if (observeIdleRenewal) {
      const renewalsAfterDelivery = renew.mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 5_100));
      expect(renew.mock.calls.length).toBe(renewalsAfterDelivery);
    }
    const currentAdapter = t.service.runtime.get(t.endpoint.id)?.getProviderAdapter();
    if (!(currentAdapter instanceof PhotonChatAdapter)) throw new Error("Current normal Photon adapter absent");
    await currentAdapter.drainUsefulClient();
    expect(usefulClients.length).toBeGreaterThan(0);
    expect(new Set(usefulClients.map(row => row.client)).size).toBe(usefulClients.length);
    expect(usefulClients.some(row => row.methods.includes("chats.get"))).toBe(true);
    for (const row of usefulClients) {
      expect(row.joined).toBe(true);
      expect(row.close).toHaveBeenCalledTimes(1);
    }
  }
  it.each(["enrolling", "joining"] as const)("resumes normal Photon configuration with its original %s custody and the new admission cutoff",
    phase => resumeOriginalHandoff(phase), 30_000);
  it("releases idle Cloud-resume ownership and reacquires it for normal authorized delivery",
    () => resumeOriginalHandoff("enrolling", true), 30_000);
  it("restores group membership queued during pause before admitting fresh messages after resume", async () => {
    const t = await setup();
    await t.start();
    await t.qualify();
    const group = photonChat("iMessage;+;pause-membership", true);
    t.chats.set(group.guid, group);
    await t.deliver(photonEvent(3, group));
    const resource = (await t.service.listResources(t.endpoint.id)).find(row => row.type === "group_chat")!;
    expect(resource).toBeDefined();
    await t.service.replaceResources(t.endpoint.id, [{ id: resource.id, enabled: true }], t.userId);
    await t.deliver(photonEvent(4, group));
    const membership = (sequence: number, type: "participantRemoved" | "participantAdded", occurredAt = new Date()): LiveEvent => ({
      type: "group.changed", chatGuid: group.guid, sequence, occurredAt, isFromMe: false,
      change: { type, participant: { address: "+15555550100", service: "iMessage" } },
    });
    await t.deliver(membership(5, "participantRemoved"));
    const removed = (await t.service.listResources(t.endpoint.id)).find(row => row.id === resource.id)!;
    expect(removed).toMatchObject({ enabled: true, availability: "unavailable", metadata: { photonRemoved: true } });
    const [before] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
    const [connectionBefore] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
    await t.service.configure(t.endpoint.id, { action: "pause" }, t.userId);
    const [paused] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
    const readded = membership(6, "participantAdded", paused.updatedAt);
    await t.service.configure(t.endpoint.id, { action: "resume" }, t.userId);
    const [resumed] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
    const [connectionResumed] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
    const cutoffValue = Reflect.get(resumed.setup, "photonIntakeAfter");
    if (typeof cutoffValue !== "string") throw new Error("Missing normal resume cutoff");
    const cutoff = Date.parse(cutoffValue);
    expect(Number.isFinite(cutoff)).toBe(true);
    expect(readded.occurredAt.getTime()).toBeLessThan(cutoff);
    expect(Reflect.get(resumed.setup, "runtimeGeneration")).toBe(Reflect.get(before.setup, "runtimeGeneration"));
    expect(resumed.connectionId).toBe(before.connectionId);
    expect(connectionResumed.credentialSecretRefs).toEqual(connectionBefore.credentialSecretRefs);
    const wakeups = t.wakeup.mock.calls.length;
    const deliveries = await db.select({ id: chatDeliveries.id }).from(chatDeliveries).where(eq(chatDeliveries.endpointId, t.endpoint.id));
    await t.deliver(readded);
    const restored = (await t.service.listResources(t.endpoint.id)).find(row => row.id === resource.id)!;
    expect(restored, "pause-window membership must clear the removed tombstone").toMatchObject({ enabled: true, availability: "available", metadata: { photonRemoved: false } });
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups);
    expect(await db.select({ id: chatDeliveries.id }).from(chatDeliveries).where(eq(chatDeliveries.endpointId, t.endpoint.id))).toEqual(deliveries);
    await t.deliver(readded);
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups);
    await t.deliver({ ...photonEvent(7, group, "Fresh after membership restoration"), occurredAt: new Date(cutoff) });
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups + 1);
    await t.deliver({ ...photonEvent(7, group, "Fresh after membership restoration"), occurredAt: new Date(cutoff) });
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups + 1);
    await expect(t.callbacks().onPhotonEvent!(membership(8, "participantAdded", new Date(NaN))))
      .rejects.toMatchObject({ code: "invalid_response" });
    await t.service.configure(t.endpoint.id, { action: "pause" }, t.userId);
    await expect(t.callbacks().onPhotonEvent!(membership(9, "participantAdded")))
      .rejects.toThrow("Photon receiver no longer owns this endpoint");
  }, 30_000);
  it("filters pause-window events through current Photon admission after a same-generation resume", async () => {
    const t = await setup();
    await t.start();
    await t.qualify();
    const [before] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
    const [connectionBefore] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
    if (!before || !connectionBefore) throw new Error("Missing configured Photon endpoint");
    const wakeups = t.wakeup.mock.calls.length;
    const deliveredBefore = await db.select({ id: chatDeliveries.id }).from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, t.endpoint.id));
    await t.service.configure(t.endpoint.id, { action: "pause" }, t.userId);
    const [paused] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
    if (!paused) throw new Error("Missing paused Photon endpoint");
    const duringPause = { ...photonEvent(3, t.f.chat, "Queued while paused"), occurredAt: paused.updatedAt };
    await t.service.configure(t.endpoint.id, { action: "resume" }, t.userId);
    const [resumed] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpoint.id));
    const [connectionResumed] = await db.select().from(toolConnections).where(eq(toolConnections.id, t.endpoint.connectionId));
    if (!resumed || !connectionResumed) throw new Error("Missing resumed Photon endpoint");
    const cutoffValue = Reflect.get(resumed.setup, "photonIntakeAfter");
    if (typeof cutoffValue !== "string") throw new Error("Missing normal Photon resume cutoff");
    const cutoff = Date.parse(cutoffValue);
    expect(Number.isFinite(cutoff)).toBe(true);
    expect(duringPause.occurredAt.getTime()).toBeLessThan(cutoff);
    const generation = Reflect.get(before.setup, "runtimeGeneration");
    expect(Number.isSafeInteger(generation)).toBe(true);
    expect(Reflect.get(resumed.setup, "runtimeGeneration")).toBe(generation);
    expect(resumed.connectionId).toBe(before.connectionId);
    expect(connectionResumed.credentialSecretRefs).toEqual(connectionBefore.credentialSecretRefs);
    const providerReads = t.f.client.chats.get.mock.calls.length;
    // This is the actual normal callback used by external-owner.dispatch. The
    // local receiver's catch-up cutoff is deliberately not the tested boundary.
    await t.deliver(duringPause);
    expect(t.wakeup.mock.calls.length, "pause-window input must not create useful work after resume").toBe(wakeups);
    expect(await db.select({ id: chatDeliveries.id }).from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, t.endpoint.id))).toEqual(deliveredBefore);
    expect(t.f.client.chats.get).toHaveBeenCalledTimes(providerReads);
    const boundary = { ...photonEvent(4, t.f.chat, "Exactly at the resumed boundary"), occurredAt: new Date(cutoff) };
    await t.deliver(boundary);
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups + 1);
    await t.deliver(boundary);
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups + 1);
    await t.deliver({ ...photonEvent(5, t.f.chat, "Fresh after resume"), occurredAt: new Date(cutoff + 1) });
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups + 2);
    await expect(t.callbacks().onPhotonEvent!({ ...photonEvent(6), occurredAt: new Date(NaN) }))
      .rejects.toMatchObject({ code: "invalid_response" });
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups + 2);
    await t.service.configure(t.endpoint.id, { action: "pause" }, t.userId);
    // Authority still wins before timestamp validation while inactive.
    await expect(t.callbacks().onPhotonEvent!({ ...photonEvent(7), occurredAt: new Date(NaN) }))
      .rejects.toThrow("Photon receiver no longer owns this endpoint");
    expect(t.wakeup).toHaveBeenCalledTimes(wakeups + 2);
  }, 30_000);
  it("preserves DM identity across restart, ignores echoes, and reserves a paused number", async () => {
    const t = await setup();
    const first = await t.start();
    await t.qualify();
    let service = await t.restart();
    await t.deliver(photonEvent(3));
    expect((await service.listConversations(t.endpoint.id))[0].issueId).toBe(
      first.issueId,
    );
    const echo = photonEvent(4);
    await t.deliver({ ...echo, isFromMe: true } as LiveEvent);
    expect(t.wakeup).toHaveBeenCalledTimes(2);
    await service.configure(t.endpoint.id, { action: "pause" }, t.userId);
    const duplicate = await service.create(
      t.companyId,
      { provider: "imessage-photon", assignedAgentId: t.agentId },
      t.userId,
    );
    await expect(
      service.configure(
        duplicate.id,
        {
          action: "configure",
          photon: { projectId: "project", lineId: "line" },
          credentials: { projectSecret: "secret" },
        },
        t.userId,
      ),
    ).rejects.toThrow(/already|another/);
    await service.configure(t.endpoint.id, { action: "resume" }, t.userId);
    expect((await service.get(t.endpoint.id)).status).toBe("active");
    await service.configure(t.endpoint.id, { action: "remove" }, t.userId);
    expect((await service.get(t.endpoint.id)).status).toBe("archived");
  }, 30_000);
  it("discovers groups disabled and admits only fresh messages after enablement", async () => {
    const t = await setup();
    await t.start();
    await t.qualify();
    const group = photonChat("iMessage;+;group", true);
    t.chats.set(group.guid, group);
    await t.deliver(photonEvent(3, group, "Old disabled request"));
    expect(await t.service.listConversations(t.endpoint.id)).toHaveLength(1);
    const resources = await t.service.listResources(t.endpoint.id);
    const resource = resources.find((row) => row.type === "group_chat")!;
    expect(resource.enabled).toBe(false);
    await t.service.replaceResources(
      t.endpoint.id,
      resources.map((row) => ({
        id: row.id,
        enabled: row.id === resource.id || row.enabled,
      })),
      t.userId,
    );
    await t.service.processPendingDeliveries();
    expect(await t.service.listConversations(t.endpoint.id)).toHaveLength(1);
    await t.deliver(photonEvent(4, group, "Fresh group request"));
    expect(await t.service.listConversations(t.endpoint.id)).toHaveLength(2);
    const conversation = (await t.service.listConversations(t.endpoint.id)).find((row) => !row.isDirectMessage)!;
    await issueService(db).update(conversation.issueId, { status: "done", actorUserId: t.userId });
    await t.deliver(photonEvent(5, group, "A group follow-up after completion"));
    const conversations = await t.service.listConversations(t.endpoint.id);
    expect(conversations).toHaveLength(2);
    expect(conversations.find((row) => !row.isDirectMessage)).toMatchObject({ id: conversation.id, issueId: conversation.issueId, state: "active" });
  }, 30_000);
  it.each([true, false])("resolves an authorized exact poll vote once, including setup (qualified=%s)", async (qualified) => {
    const t = await setup();
    const conversation = await t.start();
    if (qualified) await t.qualify();
    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: t.companyId },
      {
        kind: "ask_user_questions",
        continuationPolicy: "none",
        payload: {
          version: 1,
          questions: [
            {
              id: "q",
              prompt: "Choose",
              selectionMode: "single",
              required: true,
              allowOther: false,
              options: [
                { id: "one", label: "Same" },
                { id: "two", label: "Same" },
              ],
            },
          ],
        },
      },
      { agentId: t.agentId },
    );
    await t.service.processPendingPublications();
    expect(t.f.polls.size).toBe(1);
    const poll = [...t.f.polls.values()][0];
    const vote = {
      type: "poll.changed",
      sequence: 5,
      chatGuid: t.f.chat.guid,
      occurredAt: new Date(),
      isFromMe: false,
      actor: { address: "+15555550199", service: "iMessage" },
      pollMessageGuid: poll.pollMessageGuid,
      delta: {
        type: "voted",
        optionIdentifier: poll.options[1].optionIdentifier,
      },
    } as LiveEvent;
    await t.deliver(vote);
    expect(
      (
        await issueThreadInteractionService(db).listForIssue(
          conversation.issueId,
        )
      )[0].status,
    ).toBe("pending");
    await t.deliver({
      ...vote,
      sequence: 6,
      actor: { address: "+15555550101", service: "iMessage" },
    } as LiveEvent);
    const resolved = (
      await issueThreadInteractionService(db).listForIssue(conversation.issueId)
    )[0];
    expect(resolved.status).toBe("answered");
    expect(resolved.result).toMatchObject({
      answers: [{ questionId: "q", optionIds: ["two"] }],
    });
    await t.deliver({
      ...vote,
      sequence: 7,
      actor: { address: "+15555550101", service: "iMessage" },
    } as LiveEvent);
    expect(
      await db
        .select()
        .from(issueQuestionResponseDeliveries)
        .where(
          eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
        ),
    ).toHaveLength(1);
  }, 30_000);
  it("keeps multi-question drafts separate for two linked group participants", async () => {
    const t = await setup();
    await t.start();
    await t.qualify();
    const group = photonChat("iMessage;+;draft-group", true);
    (group.participants as Array<(typeof group.participants)[number]>).push({ address: "+15555550102", service: "iMessage" });
    t.chats.set(group.guid, group);
    await t.deliver(photonEvent(3, group));
    const resource = (await t.service.listResources(t.endpoint.id)).find(
      (row) => row.type === "group_chat",
    )!;
    await t.service.replaceResources(
      t.endpoint.id,
      [{ id: resource.id, enabled: true }],
      t.userId,
    );
    await t.deliver(photonEvent(4, group));
    const conversation = (
      await t.service.listConversations(t.endpoint.id)
    ).find((row) => !row.isDirectMessage)!;
    const second = randomUUID();
    await db.insert(authUsers).values({
      id: second,
      name: "Second",
      email: `${second}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId: t.companyId,
      principalType: "user",
      principalId: second,
      status: "active",
      membershipRole: "operator",
    });
    const fromSecond = (sequence: number, text: string) => {
      const event = photonEvent(sequence, group, text);
      return {
        ...event,
        message: {
          ...event.message,
          sender: { address: "+15555550102", service: "iMessage" },
        },
      } as LiveEvent;
    };
    await t.deliver(fromSecond(5, "Discover second participant"));
    await t.link("+15555550102", second);
    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: t.companyId },
      {
        kind: "ask_user_questions",
        continuationPolicy: "none",
        payload: {
          version: 1,
          questions: ["a", "b"].map((id) => ({
            id,
            prompt: "Duplicate title",
            selectionMode: "single" as const,
            required: true,
            allowOther: true,
            options: [{ id: "text", label: "Type an answer", freeText: true }],
          })),
        },
      },
      { agentId: t.agentId },
    );
    await t.service.processPendingPublications();
    const [binding] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, t.endpoint.id),
          eq(chatActions.kind, "photon_interaction"),
          eq(
            sql<string>`${chatActions.payload}->>'interactionId'`,
            interaction.id,
          ),
        ),
      );
    const ref = binding.payload.reference;
    await t.deliver(photonEvent(6, group, `/answer ${ref}.1 Alice A`));
    await t.service.processPendingPublications();
    await t.deliver(fromSecond(7, `/answer ${ref}.2 Bob B`));
    await t.deliver(photonEvent(8, group, `/submit ${ref}`));
    expect(
      (
        await issueThreadInteractionService(db).listForIssue(
          conversation.issueId,
        )
      )[0].status,
    ).toBe("pending");
    await t.service.processPendingPublications();
    expect(t.f.client.messages.sendText.mock.calls.some((call) =>
      call[1].includes(`Send /answer ${ref}.2 <answer> to correct it.`))).toBe(true);
    await t.deliver(photonEvent(9, group, `/answer ${ref}.2 Alice B`));
    await t.deliver(photonEvent(10, group, `/submit ${ref}`));
    const resolved = (
      await issueThreadInteractionService(db).listForIssue(conversation.issueId)
    )[0];
    expect(resolved.result).toMatchObject({
      answers: [
        { questionId: "a", otherText: "Alice A" },
        { questionId: "b", otherText: "Alice B" },
      ],
    });
    expect(resolved.resolvedByUserId).toBe(t.userId);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId));
    expect(
      comments.some(
        (row) => row.body.includes("/answer") || row.body.includes("/submit"),
      ),
    ).toBe(false);
  }, 30_000);
  it("requires a correlated rejection reason and emits only one canonical continuation", async () => {
    const t = await setup();
    const conversation = await t.start();
    await t.qualify();
    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: t.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Publish approved summary?",
          rejectRequiresReason: true,
        },
      },
      { agentId: t.agentId },
    );
    await t.service.processPendingPublications();
    const [binding] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, t.endpoint.id),
          eq(chatActions.kind, "photon_interaction"),
          eq(
            sql<string>`${chatActions.payload}->>'interactionId'`,
            interaction.id,
          ),
        ),
      );
    const ref = binding.payload.reference;
    await t.deliver(photonEvent(3, t.f.chat, `/answer ${ref} Reject`));
    expect(
      (
        await issueThreadInteractionService(db).listForIssue(
          conversation.issueId,
        )
      )[0].status,
    ).toBe("pending");
    await t.service.processPendingPublications();
    await t.deliver(
      photonEvent(4, t.f.chat, `/answer ${ref} Reject Needs another review`),
    );
    await t.service.processPendingPublications();
    expect(
      (
        await issueThreadInteractionService(db).listForIssue(
          conversation.issueId,
        )
      )[0],
    ).toMatchObject({
      status: "rejected",
      result: { reason: "Needs another review" },
    });
    await t.deliver(photonEvent(5, t.f.chat, `/answer ${ref} Accept`));
    expect(
      await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, t.endpoint.id),
            eq(chatActions.kind, "interaction_wakeup"),
            eq(
              sql<string>`${chatActions.payload}->>'interactionId'`,
              interaction.id,
            ),
          ),
        ),
    ).toHaveLength(1);
  }, 30_000);
  it("retries a delayed HEIC after restart without another comment or a premature wake", async () => {
    const t = await setup();
    const conversation = await t.start();
    await t.qualify();
    const body = await readFile(
      new URL("./fixtures/synthetic.heic", import.meta.url),
    );
    const event = photonEvent(3, t.f.chat, "");
    (event.message.content.attachments as Array<(typeof event.message.content.attachments)[number]>).push({
      guid: "photo-guid",
      fileName: "photo.heic",
      mimeType: "image/heic",
      totalBytes: body.length,
      isHidden: false,
      isSticker: false,
    } as any);
    t.f.client.attachments.downloadStream.mockImplementationOnce(() =>
      stream([]),
    );
    await t.deliver(event);
    expect(t.wakeup).toHaveBeenCalledTimes(1);
    const [delivery] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, t.endpoint.id),
          eq(
            sql<string>`${chatDeliveries.normalizedEvent}#>>'{message,providerMessageId}'`,
            event.message.guid,
          ),
        ),
      );
    expect(delivery.state).toBe("retry");
    expect(
      (delivery.normalizedEvent.message as { attachments: Array<{ recovery: { locator: unknown } }> }).attachments[0]!.recovery.locator,
    ).toMatchObject({
      kind: "photon_attachment",
      messageGuid: event.message.guid,
      attachmentGuid: "photo-guid",
    });
    const service = await t.restart();
    t.f.client.attachments.downloadStream.mockImplementation(() =>
      stream([
        {
          type: "header",
          info: { guid: "photo-guid", totalBytes: body.length },
          companionInfo: {
            kind: "live-photo-video",
            mimeType: "video/quicktime",
            fileName: "photo.mov",
            totalBytes: 9,
          },
        },
        { type: "primaryChunk", data: body },
        { type: "companionChunk", data: Buffer.from("companion") },
      ]),
    );
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, delivery.id));
    await service.processPendingDeliveries();
    expect(t.wakeup).toHaveBeenCalledTimes(2);
    const links = await db
      .select()
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, t.endpoint.id),
          eq(chatMessageLinks.providerMessageId, event.message.guid),
        ),
      );
    expect(links).toHaveLength(1);
    const files = await db
      .select({ contentType: assets.contentType })
      .from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
      .where(eq(issueAttachments.issueCommentId, links[0].commentId!));
    expect(files.map((file) => file.contentType).sort()).toEqual([
      "image/heic",
      "image/jpeg",
      "video/quicktime",
    ]);
    expect(
      await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, t.endpoint.id),
            eq(chatActions.kind, "attachment_derivative"),
          ),
        ),
    ).toHaveLength(1);
  }, 30_000);

  it.each([false, true])("keeps completed DM replies on one task through restart and publishes committed comments live (shared=%s)", async (shared) => {
    const t = await setup(shared);
    const original = await t.start();
    await t.qualify();
    await issueService(db).update(original.issueId, { status: "done", actorUserId: t.userId });
    // Recover rows that the previous implementation marked completed without
    // an explicit control. A restart must not require an SDK chat cache.
    await db.update(chatConversations).set({ state: "completed" }).where(eq(chatConversations.id, original.id));
    const service = await t.restart();
    const visibleComments: Promise<unknown>[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(t.companyId, (event) => {
      if (event.type === "activity.logged" && event.payload.action === "issue.comment_added") {
        expect(event.payload.entityId).toBe(original.issueId);
        const details = event.payload.details as { commentId: string };
        visibleComments.push(db.select().from(issueComments).where(eq(issueComments.id, details.commentId)));
      }
    });
    try {
      const followUp = photonEvent(3, t.f.chat, "Continue our conversation");
      await t.deliver(followUp);
      await t.deliver(followUp);
      expect(await service.listConversations(t.endpoint.id)).toMatchObject([{ id: original.id, issueId: original.issueId, state: "active" }]);
      expect((await db.select().from(issues).where(eq(issues.id, original.issueId)))[0].status).toBe("todo");
      expect(t.wakeup).toHaveBeenCalledTimes(2);
      expect(visibleComments).toHaveLength(1);
      expect(await visibleComments[0]).toMatchObject([{ issueId: original.issueId, body: "Continue our conversation", metadata: { sourceChannel: "imessage-photon" } }]);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, original.issueId), eq(activityLog.action, "issue.comment_added")))).toHaveLength(2);
    } finally {
      unsubscribe();
    }
    await issueService(db).update(original.issueId, { status: "done", actorUserId: t.userId });
    await t.deliver(photonEvent(4, t.f.chat, "/status"));
    await service.processPendingPublications();
    expect(t.f.client.messages.sendText.mock.calls.some((call) => call[1].includes(original.issueIdentifier!))).toBe(true);
    await t.deliver(photonEvent(5, t.f.chat, "/new"));
    await service.processPendingPublications();
    await t.deliver(photonEvent(6, t.f.chat, "An explicitly new task"));
    const conversations = await service.listConversations(t.endpoint.id);
    expect(conversations).toHaveLength(2);
    expect(conversations.find((row) => row.id !== original.id)?.issueId).not.toBe(original.issueId);
  }, 30_000);

  it("preserves reply context, rejects old quoted controls, and starts a new generation after close", async () => {
    const t = await setup();
    const original = await t.start();
    await t.qualify();
    const quoted = photonEvent(3, t.f.chat, "Follow up to that message");
    Object.assign(quoted.message, {
      replyTargetGuid: "message-2",
      threadOriginatorPart: "0",
    });
    await t.deliver(quoted);
    const [link] = await db
      .select()
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, t.endpoint.id),
          eq(chatMessageLinks.providerMessageId, "message-3"),
        ),
      );
    const [comment] = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, link.commentId!));
    expect(JSON.stringify(comment.metadata)).toContain("Reply to message");
    expect(JSON.stringify(comment.metadata)).toContain("message-2");
    await t.deliver(photonEvent(4, t.f.chat, "/close"));
    await t.service.processPendingPublications();
    await t.deliver(photonEvent(5, t.f.chat, "Start the next task"));
    const conversations = await t.service.listConversations(t.endpoint.id);
    expect(conversations).toHaveLength(2);
    const current = conversations.find((row) => row.id !== original.id)!;
    const stale = photonEvent(6, t.f.chat, "/close");
    Object.assign(stale.message, { replyTargetGuid: "message-2" });
    await t.deliver(stale);
    await t.service.processPendingPublications();
    expect(
      (await t.service.listConversations(t.endpoint.id)).find(
        (row) => row.id === current.id,
      )?.state,
    ).toBe("active");
    await t.deliver(photonEvent(7, t.f.chat, "/status"));
    await t.service.processPendingPublications();
    expect(
      t.f.client.messages.sendText.mock.calls.some((call) =>
        call[1].includes("Start the next task"),
      ),
    ).toBe(true);
  }, 30_000);
  it("retains accepted pending input through pause and blocks publication after group removal", async () => {
    const t = await setup();
    await t.start();
    await t.qualify();
    await t.callbacks().onPhotonEvent!(
      photonEvent(3, t.f.chat, "Accepted before pause"),
    );
    await t.service.configure(t.endpoint.id, { action: "pause" }, t.userId);
    await t.service.processPendingDeliveries();
    expect(t.wakeup).toHaveBeenCalledTimes(1);
    await t.service.configure(t.endpoint.id, { action: "resume" }, t.userId);
    await t.service.processPendingDeliveries();
    expect(t.wakeup).toHaveBeenCalledTimes(2);
    const group = photonChat("iMessage;+;remove-group", true);
    t.chats.set(group.guid, group);
    await t.deliver(photonEvent(4, group));
    const resource = (await t.service.listResources(t.endpoint.id)).find(
      (row) => row.type === "group_chat",
    )!;
    await t.service.replaceResources(
      t.endpoint.id,
      [{ id: resource.id, enabled: true }],
      t.userId,
    );
    await t.deliver(photonEvent(5, group));
    const get = t.f.client.chats.get;
    get.mockRejectedValueOnce(new Error("Chat inaccessible after removal"));
    await t.deliver({
      type: "group.changed",
      chatGuid: group.guid,
      sequence: 6,
      occurredAt: new Date(),
      isFromMe: false,
      change: {
        type: "participantRemoved",
        participant: { address: "+15555550100", service: "iMessage" },
      },
    } as LiveEvent);
    expect(
      (await t.service.listResources(t.endpoint.id)).find(
        (row) => row.id === resource.id,
      )?.availability,
    ).toBe("unavailable");
    // Removal and late events need no now-inaccessible chat lookup.
    const calls = get.mock.calls.length;
    await t.deliver(photonEvent(7, group, "Late event after removal"));
    expect(get).toHaveBeenCalledTimes(calls);
    const undiscovered = photonChat("iMessage;+;undiscovered-removed-group", true);
    await t.deliver({
      type: "group.changed",
      chatGuid: undiscovered.guid,
      sequence: 8,
      occurredAt: new Date(),
      isFromMe: false,
      change: {
        type: "participantLeft",
        participant: { address: "+15555550100", service: "iMessage" },
      },
    } as LiveEvent);
    await t.deliver(photonEvent(9, undiscovered, "Late undiscovered event"));
    expect(get).toHaveBeenCalledTimes(calls);
    expect((await t.service.listResources(t.endpoint.id)).filter(
      (row) => row.type === "group_chat" && row.availability === "unavailable",
    )).toHaveLength(2);
  }, 30_000);
  it.each(["active", "verifying"] as const)("reconstructs native continuation authority for a linked group responder (%s)", async (endpointStatus) => {
    const t = await setup();
    await t.start();
    await t.qualify();
    const group = photonChat("iMessage;+;native-group", true);
    (group.participants as Array<(typeof group.participants)[number]>).push({ address: "+15555550102", service: "iMessage" });
    t.chats.set(group.guid, group);
    await t.deliver(photonEvent(3, group));
    const resource = (await t.service.listResources(t.endpoint.id)).find(
      (row) => row.type === "group_chat",
    )!;
    await t.service.replaceResources(
      t.endpoint.id,
      [{ id: resource.id, enabled: true }],
      t.userId,
    );
    await t.deliver(photonEvent(4, group));
    const conversation = (
      await t.service.listConversations(t.endpoint.id)
    ).find((row) => !row.isDirectMessage)!;
    const second = randomUUID();
    await db.insert(authUsers).values({
      id: second,
      name: "Responder",
      email: `${second}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId: t.companyId,
      principalType: "user",
      principalId: second,
      status: "active",
      membershipRole: "operator",
    });
    const discover = photonEvent(5, group);
    Object.assign(discover.message, {
      sender: { address: "+15555550102", service: "iMessage" },
    });
    await t.deliver(discover);
    await t.link("+15555550102", second);
    const [sourceLink] = await db
      .select()
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, t.endpoint.id),
          eq(chatMessageLinks.providerMessageId, "message-4"),
        ),
      );
    const sourceRunId = randomUUID();
    const sourceCommentId = sourceLink.commentId!;
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId: t.companyId,
      agentId: t.agentId,
      status: "succeeded",
      runtimeMode: "native",
      nativeIssueId: conversation.issueId,
      contextSnapshot: {
        source: "chat:imessage-photon",
        issueId: conversation.issueId,
        wakeCommentId: sourceCommentId,
        wakeCommentIds: [sourceCommentId],
        paperclipExternalChatExecutionBound: true,
        paperclipWake: {
          externalChatProvider: "imessage-photon",
          externalChatExecutionBound: true,
        },
      },
    });
    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: t.companyId },
      {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        sourceRunId,
        sourceCommentId,
        payload: {
          version: 1,
          questions: [
            {
              id: "priority",
              prompt: "Priority?",
              selectionMode: "single",
              required: true,
              allowOther: false,
              options: [
                { id: "one", label: "One" },
                { id: "two", label: "Two" },
              ],
            },
          ],
        },
      },
      { agentId: t.agentId, runId: sourceRunId },
    );
    await t.service.processPendingPublications();
    if (endpointStatus === "verifying") {
      await db.update(chatEndpoints).set({status: "verifying", setup: sql`jsonb_set(${chatEndpoints.setup}, '{step}', '"test"')`}).where(eq(chatEndpoints.id, t.endpoint.id));
    }
    const [action] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, t.endpoint.id),
          eq(chatActions.kind, "photon_interaction"),
          eq(
            sql<string>`${chatActions.payload}->>'interactionId'`,
            interaction.id,
          ),
        ),
      );
    const reply = photonEvent(
      6,
      group,
      `/answer ${action.payload.reference} 2`,
    );
    Object.assign(reply.message, {
      sender: { address: "+15555550102", service: "iMessage" },
    });
    await t.deliver(reply);
    expect(
      (
        await issueThreadInteractionService(db).listForIssue(
          conversation.issueId,
        )
      )[0].resolvedByUserId,
    ).toBe(second);
    const runId = randomUUID(),
      wakeId = randomUUID();
    const context = {
      source: "issue.interaction.respond",
      issueId: conversation.issueId,
      wakeReason: "issue_commented",
      interactionId: interaction.id,
      interactionKind: "ask_user_questions",
      interactionStatus: "answered",
      sourceRunId,
      sourceCommentId,
      wakeCommentId: sourceCommentId,
      wakeCommentIds: [sourceCommentId],
      externalChatContinuation: true,
    };
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId: t.companyId,
      agentId: t.agentId,
      source: "automation",
      status: "running",
      runId,
      requestedByActorType: "user",
      requestedByActorId: second,
      idempotencyKey: `question-response:${interaction.id}`,
      payload: context,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: t.companyId,
      agentId: t.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: conversation.issueId,
      wakeupRequestId: wakeId,
      contextSnapshot: context,
    });
    await db
      .update(issueQuestionResponseDeliveries)
      .set({
        status: "fallback_queued",
        deliveryMode: "wake_fallback",
        targetRunId: runId,
      })
      .where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id));
    const proof = await resolveExternalChatQuestionResponse(
      db,
      {
        companyId: t.companyId,
        agentId: t.agentId,
        issueId: conversation.issueId,
        runId,
      },
      context,
      "read",
      true,
    );
    expect(proof).toMatchObject({
      provider: "imessage-photon",
      marker: { sourceCommentId, conversationId: conversation.id },
    });
    await db
      .update(chatIdentityLinks)
      .set({ status: "revoked" })
      .where(
        and(
          eq(chatIdentityLinks.endpointId, t.endpoint.id),
          eq(chatIdentityLinks.paperclipUserId, second),
        ),
      );
    expect(
      await resolveExternalChatQuestionResponse(
        db,
        {
          companyId: t.companyId,
          agentId: t.agentId,
          issueId: conversation.issueId,
          runId,
        },
        context,
        "read",
        true,
      ),
    ).toBeNull();
  }, 30_000);
  it("fences checkpoint writes in the transaction that verifies receiver ownership", async () => {
    const t = await setup();
    await t.start();
    await t.qualify();
    const callback = t.callbacks().onPhotonCheckpoint!;
    const key = `photon:${createHash("sha256").update("checkpoint").digest("hex")}`;
    const before = await db
      .select()
      .from(chatSdkState)
      .where(
        and(
          eq(chatSdkState.endpointId, t.endpoint.id),
          eq(chatSdkState.stateKey, key),
        ),
      );
    await db
      .update(chatEndpointLeases)
      .set({ token: randomUUID() })
      .where(
        and(
          eq(chatEndpointLeases.endpointId, t.endpoint.id),
          eq(chatEndpointLeases.leaseKey, "photon_receiver_runtime"),
        ),
      );
    await expect(callback(100)).rejects.toThrow();
    const after = await db
      .select()
      .from(chatSdkState)
      .where(
        and(
          eq(chatSdkState.endpointId, t.endpoint.id),
          eq(chatSdkState.stateKey, key),
        ),
      );
    expect(after.map((row) => row.value)).toEqual(
      before.map((row) => row.value),
    );
  }, 30_000);
  it("answers status without creating a task after a conversation closes", async () => {
    const t = await setup();
    await t.start();
    await t.qualify();
    await t.deliver(photonEvent(3, t.f.chat, "/close"));
    await t.service.processPendingPublications();
    const wakes = t.wakeup.mock.calls.length;
    await t.deliver(photonEvent(4, t.f.chat, "/status"));
    await t.service.processPendingPublications();
    expect(t.wakeup).toHaveBeenCalledTimes(wakes);
    expect(await t.service.listConversations(t.endpoint.id)).toHaveLength(1);
    expect(t.f.client.messages.sendText.mock.calls.at(-1)?.[1]).toContain(
      "No task is active",
    );
  }, 30_000);
});
