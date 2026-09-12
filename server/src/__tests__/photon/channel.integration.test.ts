import { Readable } from "node:stream";
import type { StorageService } from "../../storage/types.js";
import { createHash, randomUUID } from "node:crypto";
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
import { PhotonCloudClient, PhotonError } from "../../services/photon/cloud.js";
import { photonFixture, photonEvent, photonChat, stream } from "./fixture.js";

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
describe.sequential("iMessage Photon channel control plane", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let secrets: string;
  const oldKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const services: ChatChannelService[] = [];
  const companyIds: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-photon-");
    db = createDb(database.connectionString);
    secrets = await mkdtemp(path.join(tmpdir(), "photon-secrets-"));
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
      secrets,
      "master.key",
    );
  }, 30_000);
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.shutdown()));
    for (const id of companyIds.splice(0))
      await db
        .update(chatEndpoints)
        .set({ status: "archived" })
        .where(eq(chatEndpoints.companyId, id));
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await database?.cleanup();
    if (secrets) await rm(secrets, { recursive: true, force: true });
    if (oldKey === undefined)
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = oldKey;
  });
  async function setup(shared = false) {
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
    group.participants.push({ address: "+15555550102", service: "iMessage" });
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
    event.message.content.attachments.push({
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
      delivery.normalizedEvent.message.attachments[0].recovery.locator,
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
    group.participants.push({ address: "+15555550102", service: "iMessage" });
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
