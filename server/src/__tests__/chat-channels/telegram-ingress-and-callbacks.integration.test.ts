import * as cloudRuntimeIdentity from "../../services/cloud-runtime-identity.js";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import request from "supertest";
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, activityLog, authUsers, chatActions, chatConversations, chatDeliveries, chatEndpointLeases, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatMessageLinks, chatPublications, companySecretBindings, companySecrets, companies, companyMemberships, heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issueThreadInteractions, issues, toolConnections } from "@paperclipai/db";
import { chatChannelService, type ChatChannelServiceOptions } from "../../services/chat-channels.js";
import type { ChatSdkRuntime } from "../../services/chat-sdk-runtime.js";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { issueService } from "../../services/issues.js";
import { getExternalChannelBindingSummary } from "../../services/chat-channel-binding.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { TELEGRAM_CALLBACK_DATA_LIMIT_BYTES, telegramChatSdkCallbackData } from "../../services/chat-interaction-publications.js";
import { enqueueChatRunMilestones } from "../../services/chat-run-publications.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, fakeSlackFetch, fakeTelegramFetch, makeThread, makeMessage, routesApp } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";

describeEmbeddedPostgres("chat channels: telegram ingress and callbacks", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const { retireFixtureState, seedCompany, readChatConversationsByEndpointId, readChatEndpointsById, readChatDeliveriesByEndpointId, readChatActionsById, readChatPublicationsByEndpointId, readChatPublicationsById, readIssuesByCompanyId, readChatPublicationsByCommentId, readChatPublicationsByIdempotencyKey, receiptBackedWakeup, createService, retirePublicationFixture, chatWakeContext, addSelectedChatFinal, qualifySetupRoundTrip, configuredSlackEndpoint, configuredTelegramEndpoint, deliverMessage } = h;
  const { configuredGitHubEndpoint } = gh;

  async function telegramConfirmationRecoveryFixture(decision: "accept" | "reject" = "accept") {
    const fixture = await seedCompany();
    let injectSettlementCrash = true;
    const settlementBarrier = vi.fn(async () => {
      if (!injectSettlementCrash) return;
      injectSettlementCrash = false;
      throw new Error(
        "injected post-interaction confirmation settlement crash",
      );
    });
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture, {
        confirmationResolutionPersistBarrier: settlementBarrier,
      });
    if (!callbacks.onAction)
      throw new Error("Telegram action callback was not registered");
    const externalUserId = "771234568";
    const dm = makeThread({
      channelId: externalUserId,
      id: `telegram:${externalUserId}`,
      isDM: true,
      name: "Telegram confirmation DM",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${externalUserId}:1`,
        text: "Prepare a release confirmation",
        userId: externalUserId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation)
      throw new Error("Expected Telegram confirmation conversation");

    const linkedUserId = `telegram-confirmation-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: linkedUserId,
      name: "Telegram Confirmation User",
      email: `${linkedUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: linkedUserId,
      status: "active",
      membershipRole: "operator",
    });
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, fixture.companyId),
          eq(chatExternalPrincipals.provider, "telegram"),
          eq(chatExternalPrincipals.externalId, externalUserId),
        ),
      )
      .then((rows) => rows[0]);
    if (!principal) throw new Error("Expected Telegram confirmation principal");
    const linkIntent = await service.createLinkIntent(
      endpoint.id,
      principal.id,
      1_800,
    );
    const linkToken = new URL(linkIntent.confirmationUrl).searchParams.get(
      "token",
    );
    if (!linkToken) throw new Error("Telegram identity token was absent");
    await service.confirmIdentityLink(linkToken, linkedUserId);

    const interaction = await issueThreadInteractionService(db).create(
      {
        id: conversation.issueId,
        companyId: fixture.companyId,
      },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        title: "Release check",
        payload: {
          version: 1,
          prompt: "Proceed with Telegram production qualification?",
          acceptLabel: "Proceed",
          rejectLabel: "Stop",
        },
      },
      { agentId: fixture.assignedAgentId },
    );
    await service.processPendingPublications();
    const publication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpoint.id),
          eq(
            chatPublications.idempotencyKey,
            `interaction:${interaction.id}:${endpoint.id}`,
          ),
        ),
      )
      .then((rows) => rows[0]);
    expect(publication).toMatchObject({
      state: "published",
      payload: {
        interactionId: interaction.id,
        card: {
          kind: "confirmation",
          title: "Proceed with Telegram production qualification?",
          actions: [
            expect.objectContaining({
              type: "callback",
              label: "Proceed",
              style: "primary",
            }),
            expect.objectContaining({
              type: "callback",
              label: "Stop",
              style: "danger",
            }),
          ],
        },
      },
    });
    if (!publication.providerMessageId)
      throw new Error("Telegram confirmation was not delivered");
    const confirmationActions = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "confirmation_response"),
        ),
      );
    expect(confirmationActions).toHaveLength(2);
    expect(
      confirmationActions.every(
        (action) =>
          action.providerActionId.startsWith("pcq:") &&
          Buffer.byteLength(
            telegramChatSdkCallbackData(action.providerActionId),
            "utf8",
          ) <= TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
      ),
    ).toBe(true);
    const acceptAction = confirmationActions.find(
      (action) => action.payload.decision === decision,
    );
    if (!acceptAction)
      throw new Error("Telegram accept action was not persisted");

    wakeup.mockClear();
    const actionEvent = {
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        actionId: acceptAction.providerActionId,
        adapter: {} as never,
        messageId: publication.providerMessageId,
        openModal: async () => undefined,
        raw: {
          id: `callback-${randomUUID()}`,
          data: telegramChatSdkCallbackData(acceptAction.providerActionId),
          from: { id: Number(externalUserId), first_name: "Telegram User" },
        },
        thread: dm.thread,
        threadId: dm.thread.id,
        user: {
          userId: externalUserId,
          userName: "telegram-user",
          fullName: "Telegram User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        value: undefined,
      },
    };
    return { fixture, callbacks, onAction: callbacks.onAction, endpoint, service, wakeup, settlementBarrier, dm, conversation, linkedUserId, principal, interaction, publication, acceptAction, actionEvent };
  }

  it("corrects Telegram DM conversation links without rewriting retained provider receipts", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredTelegramEndpoint(fixture);
    let server: Server | undefined;
    try {
      const thread = makeThread({
        channelId: "77117711",
        id: "telegram:77117711",
        isDM: true,
        name: "Telegram link user",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "telegram",
        thread: thread.thread,
        message: makeMessage({
          id: "88",
          text: "Check the DM task link",
          userId: "77117711",
          raw: {
            message_id: 88,
            chat: { id: 77117711, type: "private", username: "human_user" },
          },
        }),
        trigger: "direct_message",
      });
      const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
      expect(conversation).toBeDefined();
      const configured = await service.get(endpoint.id);
      const expectedUrl = `https://t.me/${configured!.botUsername}`;
      expect(conversation!.providerUrl).toBe(expectedUrl);
      // A retained pre-fix URL must be corrected at read time, without mutating
      // historical receipts or requiring a new message from the external user.
      await db
        .update(chatConversations)
        .set({ providerUrl: "https://t.me/human_user/88" })
        .where(eq(chatConversations.id, conversation!.id));
      await expect(service.listConversations(endpoint.id)).resolves.toEqual([
        expect.objectContaining({
          id: conversation!.id,
          isDirectMessage: true,
          externalUrl: expectedUrl,
        }),
      ]);
      // The task banner uses a different route from the conversation list;
      // issue-detail responses also consume this exact company-scoped helper.
      server = createServer(routesApp(db, fixture.companyId, service));
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => {
          server!.off("error", reject);
          resolve();
        });
      });
      const binding = await service.getIssueBinding(conversation!.issueId);
      const response = await request(server)
        .get(`/api/issues/${conversation!.issueId}/chat-binding`)
        .expect(200);
      expect({
        binding: binding?.externalUrl,
        route: response.body.externalUrl,
      }).toEqual({ binding: expectedUrl, route: expectedUrl });
      await expect(
        getExternalChannelBindingSummary(db, randomUUID(), conversation!.issueId),
      ).resolves.toBeNull();
      await expect(
        db
          .select({ providerUrl: chatConversations.providerUrl })
          .from(chatConversations)
          .where(eq(chatConversations.id, conversation!.id)),
      ).resolves.toEqual([{ providerUrl: "https://t.me/human_user/88" }]);
      await db
        .update(chatEndpoints)
        .set({ botUsername: null })
        .where(eq(chatEndpoints.id, endpoint.id));
      await expect(service.listConversations(endpoint.id)).resolves.toEqual([
        expect.objectContaining({ id: conversation!.id, externalUrl: null }),
      ]);
      await expect(
        service.getIssueBinding(conversation!.issueId),
      ).resolves.toMatchObject({ externalUrl: null });
      const missingBot = await request(server)
        .get(`/api/issues/${conversation!.issueId}/chat-binding`)
        .expect(200);
      expect(missingBot.body.externalUrl).toBeNull();
      // A legitimate group message link remains a message link, not a bot DM.
      await db
        .update(chatConversations)
        .set({
          isDirectMessage: false,
          externalThreadId: "telegram:-10077117711",
          providerUrl: "https://t.me/qa_group/88",
        })
        .where(eq(chatConversations.id, conversation!.id));
      await expect(
        service.getIssueBinding(conversation!.issueId),
      ).resolves.toMatchObject({ externalUrl: "https://t.me/qa_group/88" });
    } finally {
      try {
        if (server?.listening)
          await new Promise<void>((resolve, reject) => {
            server!.close((error) => (error ? reject(error) : resolve()));
            server!.closeAllConnections();
          });
      } finally {
        await service.shutdown();
      }
    }
  });

  it("returns not found rather than revealing another company's chat endpoint", async () => {
    const viewerCompany = await seedCompany();
    const ownerCompany = await seedCompany();
    const { service } = createService();
    const endpoint = await service.create(
      ownerCompany.companyId,
      {
        provider: "telegram",
        assignedAgentId: ownerCompany.assignedAgentId,
      },
      "owner-user",
    );
    const app = routesApp(db, viewerCompany.companyId, service);

    await request(app).get(`/api/chat-endpoints/${endpoint.id}`).expect(404);
    await request(app)
      .patch(`/api/chat-endpoints/${endpoint.id}`)
      .send({ allowDirectMessages: true })
      .expect(404);
  });

  it("rejects unsupported Telegram webhook ports before provider access or secret persistence", async () => {
    const fixture = await seedCompany();
    const providerFetch = vi.fn(async () => {
      throw new Error("Telegram provider access must not start");
    }) as unknown as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch, {
      webhookPublicBaseUrl: "https://unsupported-telegram-origin.example:10000",
    });
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "telegram",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    const failure = await service
      .configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken: "123456:telegram-port-canary" },
        },
        "owner-user",
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toMatchObject({
      status: 422,
      message:
        "Telegram webhooks require PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL to use HTTPS on port 443, 80, 88, or 8443",
      details: {
        code: "chat_telegram_webhook_url_unsupported",
        provider: "telegram",
        supportedPorts: [443, 80, 88, 8443],
      },
    });
    expect(String((failure as Error | null)?.message)).not.toContain(
      "unsupported-telegram-origin",
    );
    expect(String((failure as Error | null)?.message)).not.toContain(
      "telegram-port-canary",
    );
    expect(providerFetch).not.toHaveBeenCalled();
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([{ refs: [] }]);
    await expect(
      db
        .select({ id: companySecretBindings.id })
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.companyId, fixture.companyId),
            eq(companySecretBindings.targetType, "tool_connection"),
            eq(companySecretBindings.targetId, endpoint.connectionId),
          ),
        ),
    ).resolves.toEqual([]);
    await expect(
      db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId)),
    ).resolves.toEqual([]);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "draft",
      providerAccountId: null,
      botExternalId: null,
    });
    await service.shutdown();
  });

  it("preserves stored Telegram credentials and lifecycle when reconnect uses an unsupported webhook port", async () => {
    const fixture = await seedCompany();
    const configured = await configuredTelegramEndpoint(fixture);
    await configured.service.shutdown();
    await db
      .update(chatEndpoints)
      .set({
        status: "attention",
        healthMessage: "Telegram webhook registration needs attention",
        lastError: "Telegram webhook registration failed",
        updatedAt: new Date(),
      })
      .where(eq(chatEndpoints.id, configured.endpoint.id));
    const [endpointBefore] = await readChatEndpointsById(configured.endpoint.id);
    if (!endpointBefore) throw new Error("Expected Telegram endpoint row");
    const [connectionBefore] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, configured.endpoint.connectionId));
    const secretIdsBefore = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(eq(companySecrets.companyId, fixture.companyId));
    expect(connectionBefore?.refs).toHaveLength(2);

    const providerFetch = vi.fn(async () => {
      throw new Error("Telegram provider access must not start");
    }) as unknown as typeof globalThis.fetch;
    const reconnect = createService(new FakeChatSdkRuntime(), providerFetch, {
      webhookPublicBaseUrl:
        "https://unsupported-telegram-reconnect.example:10000",
    });
    await expect(
      reconnect.service.configure(
        configured.endpoint.id,
        { action: "reconnect" },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "chat_telegram_webhook_url_unsupported" },
    });

    expect(providerFetch).not.toHaveBeenCalled();
    await expect(
      readChatEndpointsById(configured.endpoint.id),
    ).resolves.toEqual([endpointBefore]);
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, configured.endpoint.connectionId)),
    ).resolves.toEqual([connectionBefore]);
    await expect(
      db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId)),
    ).resolves.toEqual(secretIdsBefore);
    await reconnect.service.shutdown();
  });

  it.each([
    undefined,
    "https://ingress.example",
    "https://ingress.example:8443",
  ])(
    "configures Telegram and preserves queued updates with webhook origin %s",
    async (webhookPublicBaseUrl) => {
      const fixture = await seedCompany();
      const botToken = "123456:telegram-test-token";
      const botId = Number.parseInt(
        randomUUID().replaceAll("-", "").slice(0, 12),
        16,
      );
      const observedUrls: string[] = [];
      let existingWebhookUrl = "";
      let observedWebhook: Record<string, unknown> | null = null;
      let observedCommands: Record<string, unknown> | null = null;
      let observedWebhookDelete: Record<string, unknown> | null = null;
      let observedCommandsDelete: Record<string, unknown> | null = null;
      const providerFetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          observedUrls.push(url);
          if (url.endsWith("/getMe")) {
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            return new Response(
              JSON.stringify({
                ok: true,
                result: {
                  id: botId,
                  username: "maya_paperclip_bot",
                  first_name: "Maya",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.endsWith("/getWebhookInfo")) {
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            return new Response(
              JSON.stringify({ ok: true, result: { url: existingWebhookUrl } }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }
          if (url.endsWith("/setWebhook")) {
            expect(init?.method).toBe("POST");
            observedWebhook = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            existingWebhookUrl = String(observedWebhook.url ?? "");
            return new Response(JSON.stringify({ ok: true, result: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.endsWith("/setMyCommands")) {
            expect(init?.method).toBe("POST");
            observedCommands = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            return new Response(JSON.stringify({ ok: true, result: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.endsWith("/deleteWebhook")) {
            expect(init?.method).toBe("POST");
            observedWebhookDelete = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            return new Response(JSON.stringify({ ok: true, result: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.endsWith("/deleteMyCommands")) {
            expect(init?.method).toBe("POST");
            observedCommandsDelete = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            return new Response(JSON.stringify({ ok: true, result: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`Unexpected provider request: ${url}`);
        },
      ) as unknown as typeof globalThis.fetch;
      const { runtime, service } = createService(
        new FakeChatSdkRuntime(),
        providerFetch,
        { webhookPublicBaseUrl },
      );
      const endpoint = await service.create(
        fixture.companyId,
        {
          provider: "telegram",
          assignedAgentId: fixture.assignedAgentId,
        },
        "owner-user",
      );
      expect(endpoint.setup).toMatchObject({
        step: "provider_setup",
        providerUrl: "https://t.me/BotFather",
      });

      const configured = await service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken },
        },
        "owner-user",
      );

      expect(observedUrls).toEqual([
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getWebhookInfo`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setWebhook`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setMyCommands`,
      ]);
      expect(configured).toMatchObject({
        status: "verifying",
        providerAccountId: String(botId),
        botExternalId: String(botId),
        botUsername: "maya_paperclip_bot",
        capabilities: { messageEdits: true, messageDeletes: false },
        setup: {
          step: "test",
          providerUrl: "https://t.me/maya_paperclip_bot",
        },
      });
      const providerConfig = runtime.configurations.get(
        endpoint.id,
      )?.providerConfig;
      expect(providerConfig).toMatchObject({
        provider: "telegram",
        credentials: { botToken, secretToken: expect.any(String) },
      });
      if (providerConfig?.provider !== "telegram")
        throw new Error("Telegram runtime configuration was not created");
      expect(observedWebhook).toEqual({
        url: `${webhookPublicBaseUrl ?? "https://paperclip.example"}/api/chat-webhooks/${endpoint.publicId}/telegram`,
        secret_token: providerConfig.credentials.secretToken,
        allowed_updates: [
          "message",
          "edited_message",
          "callback_query",
          "stopped_message_generation",
          "message_reaction",
          "my_chat_member",
        ],
        drop_pending_updates: true,
      });
      expect(observedCommands).toEqual({
        commands: [
          {
            command: "task",
            description: "Start or continue a Paperclip task",
          },
          { command: "status", description: "Show the active Paperclip task" },
          {
            command: "new",
            description: "Start a new task after the current one",
          },
          {
            command: "close",
            description: "Close the active chat conversation",
          },
        ],
      });
      const [connection] = await db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId));
      expect(connection.refs.map((ref) => ref.configPath).sort()).toEqual([
        "credentials.botToken",
        "credentials.webhookSecret",
      ]);

      await db
        .update(chatEndpoints)
        .set({ status: "active", setup: { step: "complete" } })
        .where(eq(chatEndpoints.id, endpoint.id));
      existingWebhookUrl =
        "https://expired.example/api/chat-webhooks/old-public-id/telegram";
      observedUrls.length = 0;
      observedWebhook = null;
      observedCommands = null;

      const reconnected = await service.configure(
        endpoint.id,
        { action: "reconnect" },
        "owner-user",
      );

      expect(reconnected).toMatchObject({
        status: "verifying",
        setup: { step: "test" },
      });
      expect(observedUrls).toEqual([
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getWebhookInfo`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setWebhook`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setMyCommands`,
      ]);
      expect(observedWebhook).toMatchObject({
        url: `${webhookPublicBaseUrl ?? "https://paperclip.example"}/api/chat-webhooks/${endpoint.publicId}/telegram`,
        // Repointing an existing bot must retain updates Telegram queued while
        // the old callback URL was unavailable.
        drop_pending_updates: false,
      });

      await service.configure(endpoint.id, { action: "remove" }, "owner-user");
      expect(observedWebhookDelete).toEqual({ drop_pending_updates: false });
      expect(observedCommandsDelete).toEqual({});
      expect(observedUrls.at(-2)).toBe(
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/deleteWebhook`,
      );
      expect(observedUrls.at(-1)).toBe(
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/deleteMyCommands`,
      );
    },
  );

  it("durably recovers rate-limited Telegram menu registration and removal cleanup", async () => {
    const fixture = await seedCompany();
    const botToken = "123456:telegram-maintenance-test";
    const botId = Number.parseInt(
      randomUUID().replaceAll("-", "").slice(0, 12),
      16,
    );
    let commandRateLimits = 0;
    let deleteWebhookRateLimits = 0;
    let deleteMyCommandsCalls = 0;
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: botId,
              username: "paperclip_maintenance_bot",
              first_name: "Paperclip Maintenance",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setWebhook")) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setMyCommands")) {
        if (commandRateLimits > 0) {
          commandRateLimits -= 1;
          return new Response(
            JSON.stringify({
              ok: false,
              description: "Too Many Requests",
              parameters: { retry_after: 60 * 60 },
            }),
            {
              status: 429,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/deleteWebhook")) {
        if (deleteWebhookRateLimits > 0) {
          deleteWebhookRateLimits -= 1;
          return new Response(
            JSON.stringify({
              ok: false,
              description: "Too Many Requests",
              parameters: { retry_after: 2 * 60 * 60 },
            }),
            {
              status: 429,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/deleteMyCommands")) {
        deleteMyCommandsCalls += 1;
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const configured = await service.configure(
      endpoint.id,
      { action: "configure", credentials: { botToken } },
      "owner-user",
    );
    await db
      .update(chatEndpoints)
      .set({
        status: "active",
        setup: { ...configured.setup, step: "complete" },
      })
      .where(eq(chatEndpoints.id, endpoint.id));

    commandRateLimits = 1;
    const reconnectStartedAt = Date.now();
    await expect(
      service.configure(endpoint.id, { action: "reconnect" }, "owner-user"),
    ).resolves.toMatchObject({ status: "verifying" });
    const reconnectAction = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "telegram_maintenance"),
          sql`${chatActions.payload}->>'operation' = 'register_commands'`,
        ),
      )
      .orderBy(desc(chatActions.createdAt))
      .then((rows) => rows[0]);
    expect(reconnectAction).toMatchObject({
      status: "failed",
      result: { retryable: true, attempts: 1 },
    });
    expect(
      Date.parse(String(reconnectAction.result?.retryAt)) - reconnectStartedAt,
    ).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1_000);
    await db
      .update(chatActions)
      .set({
        result: {
          ...reconnectAction.result,
          retryAt: new Date(0).toISOString(),
        },
      })
      .where(eq(chatActions.id, reconnectAction.id));
    await service.processPendingDeliveries();
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, reconnectAction.id)),
    ).resolves.toEqual([{ status: "processed" }]);

    deleteWebhookRateLimits = 1;
    const removeStartedAt = Date.now();
    await expect(
      service.configure(endpoint.id, { action: "remove" }, "owner-user"),
    ).resolves.toMatchObject({ status: "archived" });
    const removeAction = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "telegram_maintenance"),
          sql`${chatActions.payload}->>'operation' = 'remove_endpoint'`,
        ),
      )
      .then((rows) => rows[0]);
    expect(removeAction).toMatchObject({
      status: "failed",
      result: { retryable: true, attempts: 1 },
    });
    expect(
      Date.parse(String(removeAction.result?.retryAt)) - removeStartedAt,
    ).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 1_000);
    await expect(
      db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(eq(activityLog.entityId, endpoint.connectionId)),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "chat_endpoint.telegram_register_commands_deferred",
          details: expect.objectContaining({
            endpointId: endpoint.id,
            attempt: 1,
            disposition: "retry",
          }),
        }),
        expect.objectContaining({
          action: "chat_endpoint.telegram_remove_endpoint_deferred",
          details: expect.objectContaining({
            endpointId: endpoint.id,
            attempt: 1,
            disposition: "retry",
          }),
        }),
      ]),
    );
    expect(deleteMyCommandsCalls).toBe(0);
    const [pendingCleanupConnection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(pendingCleanupConnection.refs.length).toBeGreaterThan(0);

    await db
      .update(chatActions)
      .set({
        result: { ...removeAction.result, retryAt: new Date(0).toISOString() },
      })
      .where(eq(chatActions.id, removeAction.id));
    await service.processPendingDeliveries();
    expect(deleteMyCommandsCalls).toBe(1);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, removeAction.id)),
    ).resolves.toEqual([{ status: "processed" }]);
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([{ refs: [] }]);
  });

  it("serializes recovered Telegram maintenance behind credential rotation", async () => {
    const fixture = await seedCompany();
    const oldBotToken = "123456:telegram-old-maintenance-token";
    const newBotToken = "123456:telegram-new-maintenance-token";
    const botId = Number.parseInt(
      randomUUID().replaceAll("-", "").slice(0, 12),
      16,
    );
    let blockNewCredentialCheck = false;
    let markCredentialCheckReady!: () => void;
    let releaseCredentialCheck!: () => void;
    const credentialCheckReady = new Promise<void>((resolve) => {
      markCredentialCheckReady = resolve;
    });
    const credentialCheckRelease = new Promise<void>((resolve) => {
      releaseCredentialCheck = resolve;
    });
    const commandTokens: string[] = [];
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        if (
          blockNewCredentialCheck &&
          url.includes(encodeURIComponent(newBotToken))
        ) {
          markCredentialCheckReady();
          await credentialCheckRelease;
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: botId,
              username: "paperclip_maintenance_race_bot",
              first_name: "Paperclip Maintenance Race",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setWebhook")) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setMyCommands")) {
        commandTokens.push(
          url.includes(encodeURIComponent(newBotToken))
            ? newBotToken
            : oldBotToken,
        );
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      { action: "configure", credentials: { botToken: oldBotToken } },
      "owner-user",
    );
    const staleAction = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "telegram_maintenance"),
        ),
      )
      .then((rows) => rows[0]!);
    await db
      .update(chatActions)
      .set({
        status: "failed",
        result: {
          attempts: 1,
          retryable: true,
          retryAt: new Date(0).toISOString(),
        },
      })
      .where(eq(chatActions.id, staleAction.id));
    commandTokens.length = 0;

    blockNewCredentialCheck = true;
    const reconnect = service.configure(
      endpoint.id,
      { action: "reconnect", credentials: { botToken: newBotToken } },
      "owner-user",
    );
    await credentialCheckReady;
    const recovery = service.processPendingDeliveries();
    releaseCredentialCheck();
    await reconnect;
    await recovery;

    expect(commandTokens).toEqual([newBotToken]);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, staleAction.id)),
    ).resolves.toEqual([
      {
        status: "cancelled",
        result: expect.objectContaining({
          code: "telegram_maintenance_credentials_superseded",
        }),
      },
    ]);
  });

  it("applies Teams installation and Telegram membership resource lifecycle", async () => {
    const fixture = await seedCompany();
    const teams = createService(
      new FakeChatSdkRuntime(),
      (async () =>
        new Response(JSON.stringify({ access_token: "teams-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    );
    const teamsEndpoint = await teams.service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const teamsClientId = "00000000-0000-4000-8000-000000000111";
    await teams.service.configure(
      teamsEndpoint.id,
      {
        action: "configure",
        credentials: {
          clientId: teamsClientId,
          tenantId: "00000000-0000-4000-8000-000000000222",
          clientSecret: "teams-secret",
        },
      },
      "owner-user",
    );
    const teamsTenantId = "00000000-0000-4000-8000-000000000222";
    const teamsPayload = (
      action: "add" | "remove",
      id = `teams-${action}`,
      timestamp = action === "add"
        ? "2026-09-05T14:00:00.000Z"
        : "2026-09-05T14:01:00.000Z",
    ) => ({
      id,
      type: "installationUpdate",
      action,
      timestamp,
      conversation: {
        id: "19:conversation@thread.tacv2",
        isGroup: true,
        tenantId: teamsTenantId,
      },
      channelData: {
        tenant: { id: teamsTenantId },
        team: { id: "team-1", name: "Paperclip" },
        channel: { id: "channel-1", name: "Engineering" },
      },
    });
    const deliverTeamsLifecycle = (payload: unknown) =>
      teams.service.handleWebhook(
        teamsEndpoint.publicId,
        "microsoft-teams",
        new Request("https://paperclip.example/teams", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
    const foreignTenantPayload = teamsPayload("add");
    foreignTenantPayload.id = "teams-foreign-tenant";
    foreignTenantPayload.conversation.tenantId = "foreign-tenant";
    foreignTenantPayload.channelData.tenant.id = "foreign-tenant";
    await expect(
      deliverTeamsLifecycle(foreignTenantPayload),
    ).resolves.toMatchObject({ status: 202 });
    const missingTenantPayload = teamsPayload("add") as Omit<
      ReturnType<typeof teamsPayload>,
      "conversation" | "channelData"
    > & {
      conversation: Omit<
        ReturnType<typeof teamsPayload>["conversation"],
        "tenantId"
      >;
      channelData: Omit<
        ReturnType<typeof teamsPayload>["channelData"],
        "tenant"
      >;
    };
    delete (missingTenantPayload.conversation as { tenantId?: string })
      .tenantId;
    delete (missingTenantPayload.channelData as { tenant?: { id: string } })
      .tenant;
    missingTenantPayload.id = "teams-missing-tenant";
    await expect(
      deliverTeamsLifecycle(missingTenantPayload),
    ).resolves.toMatchObject({ status: 202 });
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual([]);
    await expect(
      readChatDeliveriesByEndpointId(teamsEndpoint.id),
    ).resolves.toHaveLength(0);

    await deliverTeamsLifecycle(teamsPayload("add"));
    const [teamsResource] = await teams.service.listResources(teamsEndpoint.id);
    expect(teamsResource).toMatchObject({
      providerResourceId: "19:conversation@thread.tacv2",
      availability: "available",
      enabled: false,
    });
    await teams.service.replaceResources(teamsEndpoint.id, [
      { id: teamsResource!.id, enabled: true },
    ]);
    const teamsCallbacks = teams.runtime.configurations.get(
      teamsEndpoint.id,
    )?.callbacks;
    if (!teamsCallbacks) throw new Error("Expected Teams callbacks");
    const teamsServiceUrl = "https://smba.trafficmanager.net/amer/";
    const teamsConversationId = "19:conversation@thread.tacv2";
    const teamsChannelId = `teams:${Buffer.from(teamsConversationId).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`;
    const teamsThreadId = `teams:${Buffer.from(`${teamsConversationId};messageid=1729`).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`;
    await deliverMessage({
      callbacks: teamsCallbacks,
      endpointId: teamsEndpoint.id,
      provider: "microsoft-teams",
      thread: makeThread({
        channelId: teamsChannelId,
        id: teamsThreadId,
        name: "Engineering",
      }).thread,
      message: makeMessage({
        id: "teams-root-1729",
        text: "@Maya investigate the alert",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(
      readChatConversationsByEndpointId(teamsEndpoint.id),
    ).resolves.toHaveLength(1);
    await deliverTeamsLifecycle(teamsPayload("remove"));
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "19:conversation@thread.tacv2",
        label: "Engineering",
        availability: "removed",
      }),
    ]);
    await expect(
      db
        .select({ state: chatConversations.state })
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, teamsEndpoint.id)),
    ).resolves.toEqual([{ state: "unavailable" }]);
    await deliverTeamsLifecycle(
      teamsPayload("add", "teams-stale-add", "2026-09-05T14:00:30.000Z"),
    );
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "19:conversation@thread.tacv2",
        availability: "removed",
      }),
    ]);
    await deliverTeamsLifecycle(
      teamsPayload("add", "teams-reinstalled", "2026-09-05T14:02:00.000Z"),
    );
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        id: teamsResource!.id,
        providerResourceId: "19:conversation@thread.tacv2",
        label: "Engineering",
        availability: "available",
        enabled: true,
      }),
    ]);
    await expect(
      db
        .select({
          id: chatConversations.id,
          issueId: chatConversations.issueId,
          state: chatConversations.state,
        })
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, teamsEndpoint.id)),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        issueId: expect.any(String),
        state: "active",
      },
    ]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toHaveLength(1);

    const personalPayload = (action: "add" | "remove") => ({
      id: `teams-personal-${action}`,
      type: "installationUpdate",
      action,
      conversation: {
        id: "a:teams-personal-conversation",
        conversationType: "personal",
        tenantId: teamsTenantId,
      },
      channelData: { tenant: { id: teamsTenantId } },
    });
    await deliverTeamsLifecycle(personalPayload("add"));
    await expect(
      db
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.endpointId, teamsEndpoint.id),
            eq(
              chatEndpointResources.providerResourceId,
              "a:teams-personal-conversation",
            ),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "a:teams-personal-conversation",
        type: "direct_message",
        availability: "available",
      }),
    ]);
    await deliverTeamsLifecycle(personalPayload("remove"));
    await expect(
      db
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.endpointId, teamsEndpoint.id),
            eq(
              chatEndpointResources.providerResourceId,
              "a:teams-personal-conversation",
            ),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "a:teams-personal-conversation",
        type: "direct_message",
        availability: "removed",
      }),
    ]);

    await deliverTeamsLifecycle({
      id: "teams-group-member-added",
      type: "conversationUpdate",
      conversation: {
        id: "19:teams-group-conversation@unq.gbl.spaces",
        conversationType: "group",
        tenantId: teamsTenantId,
      },
      channelData: { tenant: { id: teamsTenantId } },
      membersAdded: [{ id: `28:${teamsClientId}` }],
    });
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerResourceId: "19:teams-group-conversation@unq.gbl.spaces",
          type: "group_chat",
          availability: "available",
        }),
      ]),
    );
    await deliverTeamsLifecycle({
      id: "teams-group-member-removed",
      type: "conversationUpdate",
      conversation: {
        id: "19:teams-group-conversation@unq.gbl.spaces",
        conversationType: "groupChat",
        tenantId: teamsTenantId,
      },
      channelData: { tenant: { id: teamsTenantId } },
      membersRemoved: [{ id: `28:${teamsClientId}` }],
    });
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerResourceId: "19:teams-group-conversation@unq.gbl.spaces",
          type: "group_chat",
          availability: "unavailable",
        }),
      ]),
    );

    const telegram = createService(
      new FakeChatSdkRuntime(),
      fakeTelegramFetch(445566) as typeof globalThis.fetch,
    );
    const telegramEndpoint = await telegram.service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.replacementAgentId },
      "owner-user",
    );
    await telegram.service.configure(
      telegramEndpoint.id,
      {
        action: "configure",
        credentials: { botToken: "445566:telegram-lifecycle" },
      },
      "owner-user",
    );
    const telegramMembership = (updateId: number, status: string) =>
      telegram.service.handleWebhook(
        telegramEndpoint.publicId,
        "telegram",
        new Request("https://paperclip.example/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            update_id: updateId,
            my_chat_member: {
              chat: { id: -100123, type: "supergroup", title: "Engineering" },
              new_chat_member: { status },
            },
          }),
        }),
      );
    await telegramMembership(1, "member");
    const [telegramResource] = await telegram.service.listResources(
      telegramEndpoint.id,
    );
    await telegram.service.replaceResources(telegramEndpoint.id, [
      { id: telegramResource!.id, enabled: true },
    ]);
    const telegramCallbacks = telegram.runtime.configurations.get(
      telegramEndpoint.id,
    )?.callbacks;
    if (!telegramCallbacks) throw new Error("Expected Telegram callbacks");
    await deliverMessage({
      callbacks: telegramCallbacks,
      endpointId: telegramEndpoint.id,
      provider: "telegram",
      thread: makeThread({
        channelId: "-100123",
        id: "telegram:-100123:77",
        // The native adapter may expose this fallback when the message and
        // my_chat_member callbacks are interleaved. It must not replace the
        // human title already learned from the membership payload.
        name: "telegram:-100123",
      }).thread,
      message: makeMessage({
        id: "telegram-root-77",
        text: "@paperclip investigate the alert",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(
      readChatConversationsByEndpointId(telegramEndpoint.id),
    ).resolves.toHaveLength(1);
    await expect(
      telegram.service.listResources(telegramEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "-100123",
        label: "Engineering",
        availability: "available",
      }),
    ]);
    await telegramMembership(2, "left");
    await expect(
      telegram.service.listResources(telegramEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "-100123",
        label: "Engineering",
        availability: "unavailable",
      }),
    ]);
    await telegramMembership(0, "administrator");
    await expect(
      telegram.service.listResources(telegramEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "-100123",
        availability: "unavailable",
      }),
    ]);
  });

  it.each([undefined, "https://ingress.example"])(
    "registers provider callbacks after a live Cloud claim (ingress: %s)",
    async (webhookPublicBaseUrl) => {
      const poolOrigin = "https://pool-fixture.staging.paperclip.app";
      const claimedOrigin = "https://claimed-fixture.staging.paperclip.app";
      const canonicalOrigin = vi.spyOn(cloudRuntimeIdentity, "runtimeCanonicalOrigin").mockReturnValue(null);
      let telegram: ReturnType<typeof createService> | undefined;
      let github: Awaited<ReturnType<typeof configuredGitHubEndpoint>> | undefined;
      try {
        const fixture = await seedCompany();
        const telegramRequests: Array<Record<string, unknown>> = [];
        const telegramFetch = fakeTelegramFetch();
        telegram = createService(new FakeChatSdkRuntime(), (async (input, init) => {
          if (String(input).endsWith("/setWebhook")) {
            telegramRequests.push(JSON.parse(String(init?.body)));
          }
          return telegramFetch(input);
        }) as typeof globalThis.fetch, { publicBaseUrl: poolOrigin, webhookPublicBaseUrl });
        const endpoint = await telegram.service.create(fixture.companyId, {
          provider: "telegram",
          assignedAgentId: fixture.assignedAgentId,
        }, "owner-user");
        github = await configuredGitHubEndpoint(fixture, { publicBaseUrl: poolOrigin, webhookPublicBaseUrl });
        expect(github.webhookSyncRequests).toHaveLength(0);

        canonicalOrigin.mockReturnValue(claimedOrigin);
        await telegram.service.configure(endpoint.id, {
          action: "configure",
          credentials: { botToken: "123456:telegram-cloud-claim-test" },
        }, "owner-user");
        expect(telegramRequests).toEqual([expect.objectContaining({
          url: `${webhookPublicBaseUrl ?? claimedOrigin}/api/chat-webhooks/${endpoint.publicId}/telegram`,
        })]);
        await github.service.configure(github.endpoint.id, { action: "reconnect" }, "owner-user");
        expect(github.webhookSyncRequests).toEqual([expect.objectContaining({
          url: `${webhookPublicBaseUrl ?? claimedOrigin}/api/chat-webhooks/${github.endpoint.publicId}/github`,
        })]);
      } finally {
        try {
          await Promise.all([telegram?.service.shutdown(), github?.service.shutdown()]);
        } finally {
          canonicalOrigin.mockRestore();
        }
      }
    },
  );

  it("separates verified webhook ingress from board identity links for every webhook provider", async () => {
    const fixture = await seedCompany();
    for (const publicBaseUrl of [
      null,
      "http://127.0.0.1:3103",
      "https://board.example",
    ]) {
      const { service } = createService(
        new FakeChatSdkRuntime(),
        fakeSlackFetch(),
        {
          publicBaseUrl,
          webhookPublicBaseUrl: "https://ingress.example",
        },
      );
      for (const provider of [
        "slack",
        "github",
        "microsoft-teams",
        "telegram",
      ] as const) {
        const endpoint = await service.create(
          fixture.companyId,
          {
            provider,
            assignedAgentId: fixture.assignedAgentId,
          },
          "owner-user",
        );
        const callback = `https://ingress.example/api/chat-webhooks/${endpoint.publicId}/${provider}`;
        expect(endpoint.setup).toMatchObject(
          provider === "microsoft-teams"
            ? { messagingEndpoint: callback }
            : { webhookUrl: callback },
        );
        const [principal] = await db
          .insert(chatExternalPrincipals)
          .values({
            companyId: fixture.companyId,
            provider,
            providerAccountId: "",
            externalId: randomUUID(),
            kind: "user",
            isBot: false,
          })
          .returning();
        const intent = await service.createLinkIntent(
          endpoint.id,
          principal.id,
          1800,
        );
        expect(intent.confirmationUrl).toMatch(
          new RegExp(
            `^${publicBaseUrl ? publicBaseUrl.replaceAll(".", "\\.") : ""}/chat-identity/confirm\\?token=`,
          ),
        );
        expect(intent.confirmationUrl).not.toContain("ingress.example");
      }
      await service.shutdown();
    }
  });

  it("reorders reverse-arrival Telegram webhooks by provider sequence before waking the agent", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const deferred: Array<() => void> = [];
    const wakeup = vi.fn<ChatChannelServiceOptions["heartbeat"]["wakeup"]>(async () => ({ accepted: true }));
    const service = chatChannelService(db, {
      deferWebhookProcessing: true,
      fetch: fakeTelegramFetch() as typeof globalThis.fetch,
      heartbeat: { wakeup: receiptBackedWakeup(wakeup) },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
      scheduleDeferredWork: (task) => deferred.push(task),
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "123456:telegram-ordering-test" },
      },
      "owner-user",
    );
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Telegram callbacks");
    const dm = makeThread({
      channelId: "77117711",
      id: "telegram:77117711",
      isDM: true,
      name: "Telegram ordered delivery",
    });
    const providerSecond = new Date("2026-09-05T19:15:20.000Z");
    // Only the raw provider date supplies retained Telegram chronology.
    const later = makeMessage({
      id: "telegram:77117711:102",
      raw: { message_id: 102, date: providerSecond.getTime() / 1_000 },
      text: "second Telegram turn",
      userId: "77117711",
    });
    later.metadata.dateSent = providerSecond;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      providerUpdateId: 7002,
      thread: dm.thread,
      message: later,
      trigger: "direct_message",
    });
    const earlier = makeMessage({
      id: "telegram:77117711:101",
      raw: { message_id: 101, date: providerSecond.getTime() / 1_000 },
      text: "first Telegram turn",
      userId: "77117711",
    });
    earlier.metadata.dateSent = providerSecond;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      providerUpdateId: 7001,
      thread: dm.thread,
      message: earlier,
      trigger: "direct_message",
    });

    const durable = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(durable).toHaveLength(2);
    expect(durable.every((delivery) => delivery.nextAttemptAt !== null)).toBe(
      true,
    );
    expect(
      new Set(
        durable.map((delivery) => delivery.nextAttemptAt?.getTime() ?? null),
      ).size,
    ).toBe(1);
    expect(durable.map((delivery) => delivery.normalizedEvent)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            providerMessageSequence: 101,
            providerUpdateId: 7001,
            providerSentAt: providerSecond.toISOString(),
            providerSentAtSource: "telegram_message_date",
          }),
        }),
        expect.objectContaining({
          message: expect.objectContaining({
            providerMessageSequence: 102,
            providerUpdateId: 7002,
            providerSentAt: providerSecond.toISOString(),
            providerSentAtSource: "telegram_message_date",
          }),
        }),
      ]),
    );
    expect(
      await readChatConversationsByEndpointId(endpoint.id),
    ).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);

    deferred.shift()?.();
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected Telegram conversation");
    const comments = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(comments.map((comment) => comment.body)).toEqual([
      "first Telegram turn",
      "second Telegram turn",
    ]);
    expect(
      wakeup.mock.calls.map((call) => call[1]?.payload?.wakeCommentId),
    ).toEqual(comments.map((comment) => comment.id));
    await service.shutdown();
  });

  it("orders a Telegram new command before the next message from the same provider second", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const deferred: Array<() => void> = [];
    const wakeup = vi.fn(async () => ({ accepted: true }));
    const service = chatChannelService(db, {
      deferWebhookProcessing: true,
      fetch: fakeTelegramFetch() as typeof globalThis.fetch,
      heartbeat: { wakeup: receiptBackedWakeup(wakeup) },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
      scheduleDeferredWork: (task) => deferred.push(task),
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "123456:telegram-command-order-test" },
      },
      "owner-user",
    );
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks?.onSlashCommand)
      throw new Error("Expected Telegram slash-command callbacks");

    const providerSecond = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const thread = makeThread({
      channelId: "D-TELEGRAM-CONTROL-ORDER",
      id: "telegram:D-TELEGRAM-CONTROL-ORDER",
      isDM: true,
      name: "Telegram command ordering",
    });
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "telegram",
      event: {
        channel: {
          id: thread.thread.id,
          name: thread.thread.channel.name,
          isDM: true,
          post: vi.fn(),
        } as never,
        command: "/new",
        text: "",
        user: {
          userId: "77117711",
          userName: "telegram-order-user",
          fullName: "Telegram Order User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 110,
          date: Math.floor(providerSecond.getTime() / 1_000),
          chat: { id: 77117711, type: "private" },
          from: { id: 77117711, is_bot: false },
          text: "/new",
          entities: [{ offset: 0, length: 4, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    const request = makeMessage({
      id: "telegram:77117711:111",
      raw: { message_id: 111, date: providerSecond.getTime() / 1_000 },
      text: "Start the task after resetting this chat",
      userId: "77117711",
    });
    request.metadata.dateSent = providerSecond;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      providerUpdateId: 8011,
      thread: thread.thread,
      message: request,
      trigger: "direct_message",
    });

    const durable = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(durable).toHaveLength(2);
    expect(durable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalizedEvent: expect.objectContaining({
            message: expect.objectContaining({
              providerMessageId: "77117711:110",
              providerMessageSequence: 110,
              providerSentAt: providerSecond.toISOString(),
              providerSentAtSource: "telegram_message_date",
              text: "/new",
            }),
          }),
        }),
        expect.objectContaining({
          normalizedEvent: expect.objectContaining({
            message: expect.objectContaining({
              providerMessageSequence: 111,
              providerSentAt: providerSecond.toISOString(),
              providerSentAtSource: "telegram_message_date",
              text: "Start the task after resetting this chat",
            }),
          }),
        }),
      ]),
    );
    expect(deferred).toHaveLength(1);

    deferred.shift()?.();
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ state: "active", sessionGeneration: 1 }),
    ]);
    expect(runtime.endpoints.get(endpoint.id)?.posts[0]?.text).toBe(
      "Send your request to start a new Paperclip task.",
    );
    // Command-only acknowledgements have no run whose final reply can retire
    // a processing reaction. The subsequent task message has its own receipt.
    expect(runtime.endpoints.get(endpoint.id)?.reactions).not.toContainEqual({
      threadId: "telegram:D-TELEGRAM-CONTROL-ORDER",
      messageId: "77117711:110",
      emoji: "eyes",
    });
    await service.shutdown();
  });

  it("atomically rejects a sponsored Telegram guest after the sponsor is suspended", async () => {
    const fixture = await seedCompany();
    let releaseAuthorizationCheck!: () => void;
    let signalAuthorizationCheck!: () => void;
    const authorizationCheckEntered = new Promise<void>((resolve) => {
      signalAuthorizationCheck = resolve;
    });
    const authorizationCheckReleased = new Promise<void>((resolve) => {
      releaseAuthorizationCheck = resolve;
    });
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture, {
        reachAuthorizationBarrier: async () => {
          signalAuthorizationCheck();
          await authorizationCheckReleased;
        },
      });
    const chatId = "77118898";
    const thread = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Suspended sponsor race",
    });
    const messageId = `${chatId}:93`;
    const secretText = "must-not-persist-suspended-sponsor";
    const send = deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: messageId,
        text: secretText,
        userId: chatId,
      }),
      trigger: "direct_message",
    });

    await authorizationCheckEntered;
    await db
      .update(companyMemberships)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, "owner-user"),
        ),
      );
    releaseAuthorizationCheck();
    await send;

    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toEqual([]);
    const [delivery] = await db
      .select({
        normalizedEvent: chatDeliveries.normalizedEvent,
        principalId: chatDeliveries.principalId,
        redactedError: chatDeliveries.redactedError,
        state: chatDeliveries.state,
      })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `${thread.thread.id}:${messageId}`,
          ),
        ),
      );
    expect(delivery).toMatchObject({
      principalId: null,
      state: "filtered",
      redactedError: "Endpoint sponsor can no longer authorize external guests",
      normalizedEvent: {
        filtering: { contentRetained: false },
        message: { providerMessageId: messageId },
      },
    });
    expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(secretText);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("atomically rejects a Telegram DM when reach is revoked at the final task-mutation boundary", async () => {
    const fixture = await seedCompany();
    let releaseReachCheck!: () => void;
    let signalReachCheck!: () => void;
    const reachCheckEntered = new Promise<void>((resolve) => {
      signalReachCheck = resolve;
    });
    const reachCheckReleased = new Promise<void>((resolve) => {
      releaseReachCheck = resolve;
    });
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture, {
        reachAuthorizationBarrier: async () => {
          signalReachCheck();
          await reachCheckReleased;
        },
      });
    const chatId = "77118899";
    const thread = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Revoked Telegram DM",
    });
    const messageId = `${chatId}:92`;
    const secretText = "must-not-persist-telegram-race";
    const send = deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: messageId,
        text: secretText,
        userId: chatId,
      }),
      trigger: "direct_message",
    });

    await reachCheckEntered;
    await service.update(
      endpoint.id,
      { allowDirectMessages: false },
      "owner-user",
    );
    releaseReachCheck();
    await send;

    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toEqual([]);
    const [delivery] = await db
      .select({
        state: chatDeliveries.state,
        normalizedEvent: chatDeliveries.normalizedEvent,
        principalId: chatDeliveries.principalId,
        redactedError: chatDeliveries.redactedError,
      })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `${thread.thread.id}:${messageId}`,
          ),
        ),
      );
    expect(delivery).toMatchObject({
      state: "filtered",
      principalId: null,
      redactedError: "Destination is not enabled in Paperclip",
      normalizedEvent: {
        filtering: { contentRetained: false },
        message: { providerMessageId: messageId },
      },
    });
    expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(secretText);
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "telegram"),
            eq(chatExternalPrincipals.externalId, chatId),
          ),
        ),
    ).resolves.toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
  });

  describe("Telegram callback-only native private responses", () => {
    async function nativePrivateFixture(linked = false, privateChat = false) {
      const fixture = await seedCompany();
      const botId = Number.parseInt(
        randomUUID().replaceAll("-", "").slice(0, 12),
        16,
      );
      const scheduled: Array<() => void> = [];
      const context = createService(
        new FakeChatSdkRuntime(),
        fakeTelegramFetch(botId) as typeof fetch,
        {
          scheduleDeferredWork: (task) => {
            scheduled.push(task);
          },
        },
      );
      const endpoint = await context.service.create(
        fixture.companyId,
        {
          provider: "telegram",
          assignedAgentId: fixture.assignedAgentId,
          name: "Native private callback fixture",
        },
        "owner-user",
      );
      await context.service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken: `${botId}:synthetic-private-token` },
        },
        "owner-user",
      );
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpoint.id));
      const chatId = privateChat ? 456 : -100123;
      await db.insert(chatEndpointResources).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "group",
        providerResourceId: String(chatId),
        label: "Private callback source",
        enabled: true,
      });
      if (linked) {
        const [stored] = await readChatEndpointsById(endpoint.id);
        const [principal] = await db
          .insert(chatExternalPrincipals)
          .values({
            companyId: fixture.companyId,
            provider: "telegram",
            providerAccountId: stored.providerAccountId!,
            externalId: "456",
            kind: "user",
            isBot: false,
          })
          .returning();
        await db.insert(chatIdentityLinks).values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          principalId: principal.id,
          status: "linked",
          paperclipUserId: "owner-user",
          confirmedAt: new Date(),
        });
      }
      const providerRequests: Array<{
        method: string;
        body: Record<string, unknown>;
      }> = [];
      let responseMode: "accepted" | "missing_receipt" | "rate_limited" =
        "accepted";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input, init) => {
        const method = new URL(String(input)).pathname.split("/").at(-1)!;
        if (method === "getMe")
          return Response.json({
            ok: true,
            result: {
              id: botId,
              is_bot: true,
              first_name: "Synthetic",
              username: `paperclip_${botId}_bot`,
            },
          });
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        providerRequests.push({ method, body });
        if (method === "answerCallbackQuery")
          return Response.json({ ok: true, result: true });
        if (method !== "sendMessage")
          throw new Error("Unexpected synthetic Telegram request");
        if (responseMode === "missing_receipt")
          return Response.json({ ok: true, result: true });
        if (responseMode === "rate_limited")
          return Response.json(
            { ok: false, error_code: 429, parameters: { retry_after: 20 } },
            { status: 429 },
          );
        if (privateChat)
          return Response.json({
            ok: true,
            result: {
              message_id: 908,
              chat: { id: Number(body.chat_id), type: "private" },
              from: { id: botId, is_bot: true },
            },
          });
        const parameters = body.ephemeral_message_parameters as {
          receiver_user_id: number;
        };
        return Response.json({
          ok: true,
          result: {
            message_id: 0,
            ephemeral_message_id: 908,
            chat: { id: Number(body.chat_id), type: "supergroup" },
            from: { id: botId, is_bot: true },
            receiver_user: { id: parameters.receiver_user_id, is_bot: false },
          },
        });
      });
      let pinned: ReturnType<typeof createChatSdkEndpointRuntime>;
      const install = (runtime: FakeChatSdkRuntime) => {
        const configuration = runtime.configurations.get(endpoint.id)!;
        pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        Object.assign(runtime.endpoints.get(endpoint.id)!, {
          handleWebhook: (...args: Parameters<typeof pinned.handleWebhook>) =>
            pinned.handleWebhook(...args),
          sendTelegramCallbackNotice: (
            ...args: Parameters<typeof pinned.sendTelegramCallbackNotice>
          ) => pinned.sendTelegramCallbackNotice(...args),
        });
      };
      install(context.runtime);
      const payload = (
        callbackId = "native-private-callback-1",
        actorId = 456,
        sourceChatId = chatId,
      ) => ({
        update_id: 901,
        callback_query: {
          id: callbackId,
          from: { id: actorId, is_bot: false, first_name: "Synthetic actor" },
          chat_instance: "synthetic-instance",
          data: "pcq:unavailable",
          message: {
            message_id: 71,
            date: Math.floor(Date.now() / 1000),
            chat: {
              id: sourceChatId,
              type: privateChat ? "private" : "supergroup",
              title: "Source",
            },
            from: { id: botId, is_bot: true, first_name: "Synthetic" },
            text: "Choose an option",
          },
        },
      });
      const deliver = async (update = payload()) => {
        const configuration = context.runtime.configurations.get(endpoint.id)!;
        if (configuration.providerConfig.provider !== "telegram")
          throw new Error("Expected Telegram configuration");
        return context.service.handleWebhook(
          endpoint.publicId,
          "telegram",
          new Request("https://paperclip.example/synthetic-telegram-webhook", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-telegram-bot-api-secret-token":
                configuration.providerConfig.credentials.secretToken,
            },
            body: JSON.stringify(update),
          }),
        );
      };
      const actions = () =>
        db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "provider_effect"),
            ),
          );
      const deliveries = () =>
        readChatDeliveriesByEndpointId(endpoint.id);
      let resumed: ReturnType<typeof createService> | undefined;
      return {
        ...context,
        fixture,
        endpoint,
        scheduled,
        providerRequests,
        payload,
        deliver,
        actions,
        deliveries,
        setResponseMode(mode: typeof responseMode) {
          responseMode = mode;
        },
        async restart() {
          await pinned.shutdown();
          await context.service.shutdown();
          const resumedRuntime = new FakeChatSdkRuntime();
          const replace = resumedRuntime.replaceEndpoint.bind(resumedRuntime);
          resumedRuntime.replaceEndpoint = async (options) => {
            const instance = await replace(options);
            install(resumedRuntime);
            return instance;
          };
          resumed = createService(
            resumedRuntime,
            fakeTelegramFetch(botId) as typeof fetch,
            {
              scheduleDeferredWork: (task) => {
                scheduled.push(task);
              },
            },
          );
          return resumed;
        },
        async close() {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await retirePublicationFixture(
                resumed?.service ?? context.service,
                endpoint.id,
              );
            } finally {
              globalThis.fetch = originalFetch;
            }
          }
        },
      };
    }

    it("records an authenticated denial before its recipient-bound send and deduplicates the exact callback", async () => {
      const context = await nativePrivateFixture();
      try {
        expect((await context.deliver()).status).toBe(200);
        expect(
          context.providerRequests.filter(
            (request) => request.method === "sendMessage",
          ),
        ).toHaveLength(0);
        const [delivery] = await context.deliveries();
        const [effect] = await context.actions();
        expect(delivery).toMatchObject({
          state: "filtered",
          normalizedEvent: {
            telegramCallback: {
              callbackId: "native-private-callback-1",
              receiverUserId: "456",
            },
          },
        });
        expect(effect).toMatchObject({
          status: "received",
          payload: {
            effect: "telegram_callback_notice",
            settleDelivery: false,
          },
        });
        expect(context.scheduled).toHaveLength(1);
        context.scheduled.shift()!();
        await expect
          .poll(async () => (await context.actions())[0]?.status)
          .toBe("processed");
        expect(await context.actions()).toEqual([
          expect.objectContaining({
            status: "processed",
            result: expect.objectContaining({
              code: "telegram_ephemeral_api_accepted",
            }),
          }),
        ]);
        expect(
          context.providerRequests.filter(
            (request) => request.method === "sendMessage",
          ),
        ).toEqual([
          {
            method: "sendMessage",
            body: {
              chat_id: "-100123",
              text: "This Paperclip action is no longer available. Open the linked task or ask an operator to link this account.",
              ephemeral_message_parameters: {
                receiver_user_id: 456,
                callback_query_id: "native-private-callback-1",
              },
            },
          },
        ]);
        const after = await context.actions();
        expect((await context.deliver()).status).toBe(200);
        expect(await context.deliveries()).toEqual([delivery]);
        expect(await context.actions()).toEqual(after);
        expect(context.scheduled).toHaveLength(0);
        expect(
          context.runtime.endpoints.get(context.endpoint.id)!.posts,
        ).toHaveLength(0);
        expect(context.wakeup).not.toHaveBeenCalled();
        expect(
          await readChatPublicationsByEndpointId(context.endpoint.id),
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });

    it.each(["actor", "chat", "data"])(
      "does not rebind a retained callback denial to another %s",
      async (changed) => {
        const context = await nativePrivateFixture();
        try {
          expect((await context.deliver()).status).toBe(200);
          const before = await context.deliveries();
          const effects = await context.actions();
          const update = context.payload();
          if (changed === "actor") update.callback_query.from.id = 457;
          if (changed === "chat")
            update.callback_query.message.chat.id = -100124;
          if (changed === "data") update.callback_query.data = "pcq:other";
          expect((await context.deliver(update)).status).toBe(200);
          expect(await context.deliveries()).toEqual(before);
          expect(await context.actions()).toEqual(effects);
          expect(context.scheduled).toHaveLength(1);
          await context.service.processPendingProviderEffects();
          expect((await context.actions())[0]).toMatchObject({
            status: "processed",
          });
          expect(
            context.providerRequests.filter(
              (entry) => entry.method === "sendMessage",
            ),
          ).toEqual([
            expect.objectContaining({
              body: expect.objectContaining({
                chat_id: "-100123",
                ephemeral_message_parameters: {
                  receiver_user_id: 456,
                  callback_query_id: "native-private-callback-1",
                },
              }),
            }),
          ]);
        } finally {
          await context.close();
        }
      },
    );

    it.each(["expired", "reach", "actor", "generation", "credentials"])(
      "cancels a queued private callback notice after %s changes without public fallback",
      async (change) => {
        const context = await nativePrivateFixture(true);
        let clock: ReturnType<typeof vi.spyOn> | undefined;
        try {
          expect((await context.deliver()).status).toBe(200);
          const [before] = await context.actions();
          expect(before.status).toBe("received");
          if (change === "expired") {
            const receipt = before.payload.telegramCallback as {
              deadlineAtMs: number;
            };
            clock = vi.spyOn(Date, "now").mockReturnValue(receipt.deadlineAtMs);
            expect((await context.deliver()).status).toBe(200);
            expect((await context.actions())[0].payload).toEqual(
              before.payload,
            );
          } else if (change === "reach") {
            await db
              .update(chatEndpointResources)
              .set({ enabled: false })
              .where(eq(chatEndpointResources.endpointId, context.endpoint.id));
          } else if (change === "actor") {
            await context.service.revokeLink(
              context.endpoint.id,
              before.principalId!,
            );
          } else if (change === "generation") {
            const [endpoint] = await readChatEndpointsById(context.endpoint.id);
            await db
              .update(chatEndpoints)
              .set({
                setup: {
                  ...endpoint.setup,
                  runtimeGeneration:
                    Number((endpoint.setup as InternalSetupState).runtimeGeneration) + 1,
                } as InternalSetupState,
              })
              .where(eq(chatEndpoints.id, context.endpoint.id));
          } else {
            await db
              .update(toolConnections)
              .set({ credentialSecretRefs: [] })
              .where(eq(toolConnections.id, context.endpoint.connectionId));
          }
          await context.service.processPendingProviderEffects();
          expect((await context.actions())[0]).toMatchObject({
            status: "cancelled",
            result: { code: "provider_effect_no_longer_authorized" },
          });
          expect(
            context.providerRequests.filter(
              (entry) => entry.method === "sendMessage",
            ),
          ).toHaveLength(0);
          expect(
            context.runtime.endpoints.get(context.endpoint.id)?.posts ?? [],
          ).toHaveLength(0);
          expect(context.wakeup).not.toHaveBeenCalled();
        } finally {
          clock?.mockRestore();
          await context.close();
        }
      },
    );

    it.each([false, true])(
      "retains the original private callback deadline across restart (expired=%s)",
      async (expired) => {
        const context = await nativePrivateFixture();
        let clock: ReturnType<typeof vi.spyOn> | undefined;
        try {
          expect((await context.deliver()).status).toBe(200);
          const [before] = await context.actions();
          const receipt = before.payload.telegramCallback as {
            deadlineAtMs: number;
          };
          const resumed = await context.restart();
          if (expired)
            clock = vi.spyOn(Date, "now").mockReturnValue(receipt.deadlineAtMs);
          await resumed.service.processPendingProviderEffects();
          expect((await context.actions())[0]).toMatchObject({
            status: expired ? "cancelled" : "processed",
            payload: before.payload,
          });
          expect(
            context.providerRequests.filter(
              (entry) => entry.method === "sendMessage",
            ),
          ).toHaveLength(expired ? 0 : 1);
          expect(resumed.wakeup).not.toHaveBeenCalled();
        } finally {
          clock?.mockRestore();
          await context.close();
        }
      },
    );

    it("quarantines missing private acceptance receipts and never retries them publicly", async () => {
      const context = await nativePrivateFixture();
      try {
        context.setResponseMode("missing_receipt");
        expect((await context.deliver()).status).toBe(200);
        await context.service.processPendingProviderEffects();
        expect((await context.actions())[0]).toMatchObject({
          status: "delivery_unknown",
        });
        await context.service.processPendingProviderEffects();
        expect((await context.deliver()).status).toBe(200);
        expect(
          context.providerRequests.filter(
            (entry) => entry.method === "sendMessage",
          ),
        ).toHaveLength(1);
        expect(
          context.runtime.endpoints.get(context.endpoint.id)!.posts,
        ).toHaveLength(0);
      } finally {
        await context.close();
      }
    });

    it("preserves an authenticated exact-actor DM denial without native ephemeral or public fallback", async () => {
      const context = await nativePrivateFixture(false, true);
      try {
        expect((await context.deliver()).status).toBe(200);
        expect(await context.actions()).toHaveLength(1);
        await context.service.processPendingProviderEffects();
        expect((await context.actions())[0]).toMatchObject({
          status: "processed",
          result: { code: "telegram_private_api_accepted" },
        });
        expect(
          context.providerRequests.filter(
            (entry) => entry.method === "sendMessage",
          ),
        ).toEqual([
          {
            method: "sendMessage",
            body: {
              chat_id: "456",
              text: "This Paperclip action is no longer available. Open the linked task or ask an operator to link this account.",
            },
          },
        ]);
        expect(
          context.runtime.endpoints.get(context.endpoint.id)!.posts,
        ).toHaveLength(0);
      } finally {
        await context.close();
      }
    });

    it("does not treat another actor's private chat as a reply destination", async () => {
      const context = await nativePrivateFixture(false, true);
      try {
        expect(
          (await context.deliver(context.payload("dm-cross-actor", 457)))
            .status,
        ).toBe(200);
        expect(await context.actions()).toEqual([]);
        expect(await context.deliveries()).toEqual([
          expect.objectContaining({ state: "filtered" }),
        ]);
        expect(
          context.providerRequests.filter(
            (entry) => entry.method === "sendMessage",
          ),
        ).toHaveLength(0);
      } finally {
        await context.close();
      }
    });

    it("does not refresh the callback deadline after service runtime-readiness waits", async () => {
      const context = await nativePrivateFixture();
      const enteredAt = Date.now();
      let now = enteredAt;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const get = context.runtime.get.bind(context.runtime);
      const readiness = vi
        .spyOn(context.runtime, "get")
        .mockImplementation((endpointId) => {
          now = enteredAt + 16_000;
          return get(endpointId);
        });
      try {
        expect((await context.deliver()).status).toBe(200);
        expect(readiness).toHaveBeenCalled();
        expect((await context.deliveries())[0]).toMatchObject({
          normalizedEvent: {
            telegramCallback: {
              receivedAtMs: enteredAt,
              deadlineAtMs: enteredAt + 15_000,
            },
          },
        });
        expect(await context.actions()).toEqual([]);
        expect(
          context.providerRequests.filter(
            (entry) => entry.method === "sendMessage",
          ),
        ).toHaveLength(0);
      } finally {
        readiness.mockRestore();
        clock.mockRestore();
        await context.close();
      }
    });

    it.each([false, true])(
      "retains an exact-actor DM proof across restart (expired=%s)",
      async (expired) => {
        const context = await nativePrivateFixture(false, true);
        let clock: ReturnType<typeof vi.spyOn> | undefined;
        try {
          expect((await context.deliver()).status).toBe(200);
          const [before] = await context.actions();
          const resumed = await context.restart();
          if (expired)
            clock = vi
              .spyOn(Date, "now")
              .mockReturnValue(
                (before.payload.telegramCallback as { deadlineAtMs: number })
                  .deadlineAtMs,
              );
          await resumed.service.processPendingProviderEffects();
          expect((await context.actions())[0]).toMatchObject({
            status: expired ? "cancelled" : "processed",
            payload: before.payload,
          });
          expect(
            context.providerRequests.filter(
              (entry) => entry.method === "sendMessage",
            ),
          ).toHaveLength(expired ? 0 : 1);
        } finally {
          clock?.mockRestore();
          await context.close();
        }
      },
    );
  });

  it("coalesces Telegram status and final output into one run-scoped provider message", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const chatId = "77118899";
    const thread = makeThread({
      channelId: chatId,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram status ordering",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: `${chatId}:901`,
        raw: { message_id: 901 },
        text: "Return one delayed answer",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    await db
      .update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, conversation.issueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "telegram",
        providerMessageId: `${chatId}:901`,
      }),
    });
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${runId}:working:${endpoint.id}`,
      payload: { text: "Maya is working…", progressState: "working" },
      state: "pending",
    });
    await service.processPendingPublications();

    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "telegram",
      event: {
        channel: {
          id: thread.thread.id,
          name: "Telegram status ordering",
          isDM: true,
          post: vi.fn(),
        } as never,
        command: "/status",
        text: "",
        user: {
          userId: chatId,
          userName: "telegram-status-user",
          fullName: "Telegram Status User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 902,
          date: Math.floor(Date.now() / 1_000),
          chat: { id: Number(chatId), type: "private" },
          from: { id: Number(chatId), is_bot: false },
          text: "/status",
          entities: [{ offset: 0, length: 7, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts.map((post) => post.text)).toEqual([
      "Maya is working…",
    ]);
    const statusPublication = (
      await readChatPublicationsByEndpointId(endpoint.id)
    ).find((publication) =>
      publication.idempotencyKey.startsWith("control:status:"),
    );
    expect(statusPublication).toMatchObject({
      conversationId: conversation.id,
      state: "pending",
      payload: { text: expect.stringMatching(/— in_progress$/) },
    });

    // Sample again at send time so a status waiting behind an older provider
    // operation cannot report a state Paperclip has already left.
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, conversation.issueId));
    await service.processPendingPublications();
    expect(providerRuntime?.posts.map((post) => post.text)).toEqual([
      "Maya is working…",
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: expect.stringMatching(/— done$/),
      },
    ]);

    await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "telegram-status-race-final",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId,
    });
    await service.processPendingPublications();

    // Both updates own the run's existing provider message. Applying the edit
    // log yields one terminal message with no stale working/status sibling.
    expect(providerRuntime?.posts.map((post) => post.text)).toEqual([
      "Maya is working…",
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: expect.stringMatching(/— done$/),
      },
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: "telegram-status-race-final",
      },
    ]);
    const renderedTelegramMessages = new Map(
      providerRuntime!.posts.map((post, index) => [
        `outbound-${index + 1}`,
        post.text,
      ]),
    );
    for (const edit of providerRuntime!.edits)
      renderedTelegramMessages.set(edit.messageId, edit.text);
    expect([...renderedTelegramMessages.values()]).toEqual([
      "telegram-status-race-final",
    ]);
    const publishedStatus = await readChatPublicationsById(statusPublication!.id)
      .then((rows) => rows[0]);
    expect(publishedStatus).toMatchObject({
      state: "published",
      payload: { text: expect.stringMatching(/— done$/) },
      providerMessageId: "outbound-1",
    });
    await service.shutdown();
  });

  it("publishes the old final before /new and suppresses later output from the completed generation", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const chatId = "77118898";
    const thread = makeThread({
      channelId: chatId,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram generation ordering",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: `${chatId}:910`,
        raw: { message_id: 910, date: 1_788_622_910 },
        text: "Finish the old generation before starting another",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [oldConversation] = await service.listConversations(endpoint.id);
    const oldRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: oldRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: oldConversation.issueId,
        provider: "telegram",
        providerMessageId: `${chatId}:910`,
      }),
    });
    await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "old-generation-final",
      companyId: fixture.companyId,
      issueId: oldConversation.issueId,
      runId: oldRunId,
    });

    const newEvent = {
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        channel: {
          id: thread.thread.id,
          name: "Telegram generation ordering",
          isDM: true,
        } as never,
        command: "/new",
        text: "",
        user: {
          userId: chatId,
          userName: "telegram-generation-user",
          fullName: "Telegram Generation User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 911,
          date: 1_788_622_911,
          chat: { id: Number(chatId), type: "private" },
          from: { id: Number(chatId), is_bot: false },
          text: "/new",
          entities: [{ offset: 0, length: 4, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    };
    await callbacks.onSlashCommand(newEvent);
    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: oldConversation.id, state: "active" }),
    ]);

    await service.processPendingPublications();
    expect(
      runtime.endpoints.get(endpoint.id)?.posts.map((post) => post.text),
    ).toEqual([
      "old-generation-final",
      "Send your request to start a new Paperclip task.",
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: oldConversation.id, state: "completed" }),
    ]);

    const lateOldFinal = await issueService(db).addComment(
      oldConversation.issueId,
      "late-old-generation-final-stays-in-paperclip",
      { agentId: fixture.assignedAgentId, runId: oldRunId },
      { authorType: "agent", authorizationReason: "paperclip_runner_protocol" },
    );
    await expect(
      db
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(eq(chatPublications.commentId, lateOldFinal.id)),
    ).resolves.toEqual([]);

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: `${chatId}:912`,
        raw: { message_id: 912, date: 1_788_622_912 },
        text: "Start the new generation",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    const conversations = await service.listConversations(endpoint.id);
    const newConversation = conversations.find(
      (conversation) => conversation.id !== oldConversation.id,
    );
    if (!newConversation) throw new Error("Expected a new chat generation");
    expect(newConversation.sessionGeneration).toBe(
      oldConversation.sessionGeneration + 1,
    );
    const newRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: newRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: newConversation.issueId,
        provider: "telegram",
        providerMessageId: `${chatId}:912`,
      }),
    });
    await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "new-generation-final",
      companyId: fixture.companyId,
      issueId: newConversation.issueId,
      runId: newRunId,
    });
    await service.processPendingPublications();

    expect(
      runtime.endpoints.get(endpoint.id)?.posts.map((post) => post.text),
    ).toEqual([
      "old-generation-final",
      "Send your request to start a new Paperclip task.",
      "new-generation-final",
    ]);
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(2);
  });

  it("keeps task-bound /close active after an ambiguous publication commit until explicit confirmation", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const chatId = "77118897";
    const thread = makeThread({
      channelId: chatId,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram close commit crash",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: `${chatId}:920`,
        raw: { message_id: 920 },
        text: "Keep this task active until close is visible",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "telegram",
      event: {
        channel: {
          id: thread.thread.id,
          name: "Telegram close commit crash",
          isDM: true,
        } as never,
        command: "/close",
        text: "",
        user: {
          userId: chatId,
          userName: "telegram-close-user",
          fullName: "Telegram Close User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 921,
          date: 1_788_622_921,
          chat: { id: Number(chatId), type: "private" },
          from: { id: Number(chatId), is_bot: false },
          text: "/close",
          entities: [{ offset: 0, length: 6, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    const closePublication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpoint.id),
          like(chatPublications.idempotencyKey, "control:close:%"),
        ),
      )
      .then((rows) => rows[0]);
    expect(closePublication).toMatchObject({ state: "pending" });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation.id, state: "active" }),
    ]);

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Telegram runtime");
    const originalTransaction = db.transaction.bind(db);
    let injectedCrash = false;
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementation((async (
        ...args: Parameters<typeof originalTransaction>
      ) => {
        if (!injectedCrash && providerRuntime.posts.length === 1) {
          injectedCrash = true;
          throw new Error("injected task-control publication commit crash");
        }
        return originalTransaction(...args);
      }) as typeof db.transaction);
    try {
      await expect(service.processPendingPublications()).resolves.toBe(1);
    } finally {
      transactionSpy.mockRestore();
    }

    expect(injectedCrash).toBe(true);
    expect(providerRuntime.posts.map((post) => post.text)).toEqual([
      "This chat conversation is closed. Send another message to start a new task.",
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation.id, state: "active" }),
    ]);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.id, closePublication!.id)),
    ).resolves.toEqual([{ state: "delivery_unknown" }]);

    await service.processPendingPublications();
    expect(providerRuntime.posts).toHaveLength(1);
    await service.resolvePublication(
      endpoint.id,
      closePublication!.id,
      "mark_delivered",
      "owner-user",
    );
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation.id, state: "completed" }),
    ]);
    expect(providerRuntime.posts).toHaveLength(1);
  });

  it("publishes a Telegram failure for an exact confirmation continuation that stops before commenting", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112235";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram failed continuation",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:61`,
        text: "Ask before the risky operation",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation)
      throw new Error("Expected Telegram continuation conversation");
    const [inboundLink] = await db
      .select({ commentId: chatMessageLinks.commentId })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.providerMessageId, `${chatId}:61`),
          eq(chatMessageLinks.direction, "inbound"),
        ),
      );
    if (!inboundLink?.commentId)
      throw new Error("Expected Telegram inbound comment binding");

    const [sourceRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "chat:telegram",
          wakeCommentId: inboundLink.commentId,
          wakeCommentIds: [inboundLink.commentId],
        },
      })
      .returning();
    if (!sourceRun) throw new Error("Expected Telegram source run");
    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        sourceRunId: sourceRun.id,
        payload: {
          version: 1,
          prompt: "Proceed with the risky operation?",
        },
      },
      { agentId: fixture.assignedAgentId, runId: sourceRun.id },
    );
    await service.processPendingPublications();
    await db
      .update(issueThreadInteractions)
      .set({
        status: "accepted",
        resolvedAt: new Date(),
        resolvedByUserId: "owner-user",
        result: { version: 1, outcome: "accepted" },
      })
      .where(eq(issueThreadInteractions.id, interaction.id));

    const [wakeRequest] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        status: "failed",
        idempotencyKey: `interaction:${interaction.id}:accepted`,
      })
      .returning();
    if (!wakeRequest) throw new Error("Expected Telegram continuation wake");
    const [continuationRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "failed",
        wakeupRequestId: wakeRequest.id,
        errorCode: "adapter_failed",
        contextSnapshot: {
          issueId: conversation.issueId,
          taskId: conversation.issueId,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: "accepted",
          sourceRunId: sourceRun.id,
          source: "external_chat.interaction.resolve",
        },
      })
      .returning();
    if (!continuationRun)
      throw new Error("Expected failed Telegram continuation run");
    await db
      .update(agentWakeupRequests)
      .set({ runId: continuationRun.id })
      .where(eq(agentWakeupRequests.id, wakeRequest.id));

    // The milestone sweep is global; assert this continuation's exact receipt
    // below rather than counting work staged for other fixture companies.
    await enqueueChatRunMilestones(db);
    await service.processPendingPublications();

    await expect(
      db
        .select({
          conversationId: chatPublications.conversationId,
          endpointId: chatPublications.endpointId,
          payload: chatPublications.payload,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `run:${continuationRun.id}:failed:${endpoint.id}`,
          ),
        ),
    ).resolves.toEqual([
      {
        conversationId: conversation.id,
        endpointId: endpoint.id,
        payload: expect.objectContaining({
          progressState: "failed",
          text: expect.stringContaining(
            "Maya stopped before completing this turn.",
          ),
        }),
        state: "published",
      },
    ]);
    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual(
      expect.arrayContaining([
        {
          threadId: dm.thread.id,
          text: expect.stringContaining(
            "Maya stopped before completing this turn.",
          ),
        },
      ]),
    );

    const forgedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: forgedRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "failed",
      contextSnapshot: {
        issueId: conversation.issueId,
        interactionId: interaction.id,
        interactionStatus: "accepted",
        sourceRunId: sourceRun.id,
        source: "external_chat.interaction.resolve",
      },
      updatedAt: new Date(Date.now() + 1_000),
    });
    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.replacementAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      status: "failed",
      idempotencyKey: `interaction:${interaction.id}:accepted`,
      runId: forgedRunId,
    });
    await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);
    await expect(
      db
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(like(chatPublications.idempotencyKey, `run:${forgedRunId}:%`)),
    ).resolves.toHaveLength(0);

    const cancelledQuestion = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        sourceRunId: sourceRun.id,
        title: "Cancellation path",
        payload: {
          version: 1,
          questions: [
            {
              id: "continue",
              prompt: "Should this work continue?",
              selectionMode: "single",
              required: true,
              allowOther: false,
              options: [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
              ],
            },
          ],
        },
      },
      { agentId: fixture.assignedAgentId, runId: sourceRun.id },
    );
    await service.processPendingPublications();
    await db
      .update(issueThreadInteractions)
      .set({
        status: "cancelled",
        resolvedAt: new Date(),
        resolvedByUserId: "owner-user",
        result: {
          version: 1,
          outcome: "skipped",
          reason: "The external requester cancelled the question.",
          answers: [],
          cancelled: true,
          cancellationReason: "The external requester cancelled the question.",
        },
      })
      .where(eq(issueThreadInteractions.id, cancelledQuestion.id));

    const [cancelledWake] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        status: "failed",
        idempotencyKey: `interaction:${cancelledQuestion.id}:cancelled`,
      })
      .returning();
    if (!cancelledWake)
      throw new Error("Expected cancelled-question continuation wake");
    const [cancelledRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "failed",
        wakeupRequestId: cancelledWake.id,
        errorCode: "adapter_failed",
        contextSnapshot: {
          issueId: conversation.issueId,
          taskId: conversation.issueId,
          interactionId: cancelledQuestion.id,
          interactionKind: cancelledQuestion.kind,
          interactionStatus: "cancelled",
          sourceRunId: sourceRun.id,
          source: "issue.interaction.cancel",
        },
      })
      .returning();
    if (!cancelledRun)
      throw new Error("Expected cancelled-question continuation run");
    await db
      .update(agentWakeupRequests)
      .set({ runId: cancelledRun.id })
      .where(eq(agentWakeupRequests.id, cancelledWake.id));

    await expect(enqueueChatRunMilestones(db)).resolves.toBe(1);
    await service.processPendingPublications();
    await expect(
      db
        .select({
          conversationId: chatPublications.conversationId,
          endpointId: chatPublications.endpointId,
          payload: chatPublications.payload,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `run:${cancelledRun.id}:failed:${endpoint.id}`,
          ),
        ),
    ).resolves.toEqual([
      {
        conversationId: conversation.id,
        endpointId: endpoint.id,
        payload: expect.objectContaining({
          progressState: "failed",
          text: expect.stringContaining(
            "Maya stopped before completing this turn.",
          ),
        }),
        state: "published",
      },
    ]);
  });

  it("quarantines Telegram maintenance success when credential-lease ownership is reclaimed", async () => {
    // Global sweeps may also reconcile a retired fixture's receipt. Keep that
    // work eligible so the fault hook proves it cannot steal another owner.
    const retiredFixture = await seedCompany();
    const retired = await configuredSlackEndpoint(retiredFixture);
    const retiredThread = makeThread({ channelId: "C-LEASE-SCOPE", id: "slack:C-LEASE-SCOPE:7002.1" });
    await deliverMessage({
      callbacks: retired.callbacks,
      endpointId: retired.endpoint.id,
      thread: retiredThread.thread,
      message: makeMessage({ id: "7002.1", text: "@maya check lease isolation", mentioned: true }),
      trigger: "mention",
    });
    await retired.service.shutdown();
    const [retiredReceipt] = await db.select().from(chatActions).where(and(
      eq(chatActions.endpointId, retired.endpoint.id),
      eq(chatActions.kind, "receipt_reaction"),
    ));
    expect(retiredReceipt).toBeDefined();
    await db.update(chatActions).set({ status: "received" })
      .where(eq(chatActions.id, retiredReceipt!.id));
    await retireFixtureState([retiredFixture.companyId]);

    const fixture = await seedCompany();
    const botToken = "123456:telegram-lease-reclaim";
    let reclaimLease = false;
    let markLeaseReclaimed!: () => void;
    const leaseReclaimed = new Promise<void>((resolve) => {
      markLeaseReclaimed = resolve;
    });
    let blockCommands = false;
    let acceptedCommandMutations = 0;
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 884422,
              username: "paperclip_lease_reclaim_bot",
              first_name: "Paperclip Lease Reclaim",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setWebhook")) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setMyCommands")) {
        if (blockCommands) {
          reclaimLease = true;
          await leaseReclaimed;
        }
        acceptedCommandMutations += 1;
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch, {
      credentialMutationLeaseRenewalIntervalMs: 5,
      renewCredentialMutationLease: async (input) => {
        // Force the unrelated receipt to reach its ownership check only
        // after the Telegram fault is armed, independent of query timing.
        if (blockCommands && input.companyId === retiredFixture.companyId) {
          await leaseReclaimed;
        }
        if (input.companyId !== fixture.companyId || !reclaimLease) return true;
        const reclaimed = await db
          .update(chatEndpointLeases)
          .set({
            token: `reclaimed-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 90_000),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatEndpointLeases.endpointId, input.endpointId),
              eq(chatEndpointLeases.leaseKey, input.leaseKey),
              eq(chatEndpointLeases.token, input.token),
            ),
          )
          .returning({ id: chatEndpointLeases.id });
        if (reclaimed.length > 0) markLeaseReclaimed();
        return false;
      },
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      { action: "configure", credentials: { botToken } },
      "owner-user",
    );
    const maintenance = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "telegram_maintenance"),
        ),
      )
      .then((rows) => rows[0]!);
    await db
      .update(chatActions)
      .set({
        status: "failed",
        result: {
          attempts: 1,
          providerConfirmed: false,
          retryable: true,
          retryAt: new Date(0).toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(chatActions.id, maintenance.id));
    acceptedCommandMutations = 0;
    blockCommands = true;

    await service.processPendingDeliveries();

    await expect(db.select({ status: chatActions.status }).from(chatActions)
      .where(eq(chatActions.id, retiredReceipt!.id)))
      .resolves.toEqual([{ status: "cancelled" }]);
    await expect(db.select().from(chatEndpointLeases)
      .where(eq(chatEndpointLeases.endpointId, retired.endpoint.id)))
      .resolves.toEqual([]);

    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, maintenance.id)),
    ).resolves.toEqual([
      {
        status: "failed",
        result: expect.objectContaining({
          code: "telegram_maintenance_delivery_unknown",
          providerConfirmed: true,
          retryable: true,
        }),
      },
    ]);
    const [reclaimedLease] = await db
      .select({ token: chatEndpointLeases.token })
      .from(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.endpointId, endpoint.id),
          eq(chatEndpointLeases.leaseKey, "credentials"),
        ),
      );
    expect(reclaimedLease?.token).toMatch(/^reclaimed-/);
    expect(acceptedCommandMutations).toBe(1);
    // The reclaimed owner is synthetic and will never release its 90-second
    // lease. Remove only this fixture's lease and retryable maintenance row so
    // later global recovery sweeps do not wait for a nonexistent process.
    await db.transaction(async (tx) => {
      await tx
        .update(chatActions)
        .set({
          status: "cancelled",
          result: { code: "test_fixture_complete" },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, maintenance.id));
      await tx
        .delete(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "credentials"),
          ),
        );
    });
    await service.shutdown();
  });

  it("does not let stale Telegram removal clear successor credentials after lease reclamation", async () => {
    const fixture = await seedCompany();
    const botToken = "123456:telegram-removal-lease-reclaim";
    let connectionId: string | null = null;
    let successorRefs: typeof toolConnections.$inferSelect.credentialSecretRefs =
      [];
    let reclaimLease = false;
    let markLeaseReclaimed!: () => void;
    const leaseReclaimed = new Promise<void>((resolve) => {
      markLeaseReclaimed = resolve;
    });
    let blockRemoval = false;
    let acceptedRemovalMutations = 0;
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 884423,
              username: "paperclip_removal_reclaim_bot",
              first_name: "Paperclip Removal Reclaim",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setWebhook") || url.endsWith("/setMyCommands")) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/deleteWebhook")) {
        acceptedRemovalMutations += 1;
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/deleteMyCommands")) {
        if (blockRemoval) {
          reclaimLease = true;
          await leaseReclaimed;
        }
        acceptedRemovalMutations += 1;
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch, {
      credentialMutationLeaseRenewalIntervalMs: 5,
      renewCredentialMutationLease: async (input) => {
        if (!reclaimLease) return true;
        const reclaimed = await db
          .update(chatEndpointLeases)
          .set({
            token: `reclaimed-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 90_000),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatEndpointLeases.endpointId, input.endpointId),
              eq(chatEndpointLeases.leaseKey, input.leaseKey),
              eq(chatEndpointLeases.token, input.token),
            ),
          )
          .returning({ id: chatEndpointLeases.id });
        if (reclaimed.length > 0) {
          if (!connectionId) throw new Error("Expected Telegram connection");
          await db
            .update(toolConnections)
            .set({ credentialSecretRefs: successorRefs, updatedAt: new Date() })
            .where(eq(toolConnections.id, connectionId));
          markLeaseReclaimed();
        }
        return false;
      },
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      { action: "configure", credentials: { botToken } },
      "owner-user",
    );
    connectionId = endpoint.connectionId;
    const currentRefs = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, connectionId))
      .then((rows) => rows[0]!.refs);
    successorRefs = currentRefs.map((ref) => ({
      ...ref,
      secretId: randomUUID(),
    }));
    blockRemoval = true;

    await expect(
      service.configure(endpoint.id, { action: "remove" }, "owner-user"),
    ).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });

    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, connectionId)),
    ).resolves.toEqual([{ refs: successorRefs }]);
    const removalAction = await db
      .select({ status: chatActions.status, result: chatActions.result })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "telegram_maintenance"),
          sql`${chatActions.payload}->>'operation' = 'remove_endpoint'`,
        ),
      )
      .then((rows) => rows[0]);
    expect(removalAction).toEqual({
      status: "failed",
      result: expect.objectContaining({
        code: "telegram_maintenance_delivery_unknown",
        providerConfirmed: true,
      }),
    });
    expect(acceptedRemovalMutations).toBe(2);
    // The simulated successor has no live worker. Retire only its synthetic
    // lease and removal retry after proving stale settlement could not clear
    // the successor refs, keeping later global recovery tests independent.
    await db.transaction(async (tx) => {
      await tx
        .update(chatActions)
        .set({
          status: "cancelled",
          result: { code: "test_fixture_complete" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "telegram_maintenance"),
            sql`${chatActions.payload}->>'operation' = 'remove_endpoint'`,
          ),
        );
      await tx
        .delete(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "credentials"),
          ),
        );
    });
    await service.shutdown();
  });

  it.each([
    {
      label: "prose",
      source: `${"The cat rests beside the window in warm light. ".repeat(55)}Done.`,
    },
    {
      label: "formatted code",
      source: `\`\`\`ts\n${"const ready = true;\n".repeat(110)}\`\`\``,
    },
  ])(
    "keeps medium Telegram $label in one native publication",
    async ({ source }) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service } =
        await configuredTelegramEndpoint(fixture);
      const chatId = "77118846";
      const dm = makeThread({
        channelId: chatId,
        id: `telegram:${chatId}`,
        isDM: true,
        name: "Telegram intact output",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "telegram",
        thread: dm.thread,
        message: makeMessage({
          id: `${chatId}:1`,
          text: "Send the complete result",
          userId: chatId,
        }),
        trigger: "direct_message",
      });
      await qualifySetupRoundTrip(service, endpoint.id, chatId);
      await service.test(endpoint.id);
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation)
        throw new Error("Expected Telegram intact conversation");
      const comment = await issueService(db).addComment(
        conversation.issueId,
        source,
        { userId: "owner-user" },
        { authorType: "user" },
      );
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      if (!providerRuntime)
        throw new Error("Expected Telegram provider runtime");
      providerRuntime.posts.length = 0;
      const publication = await service.publishComment(
        endpoint.id,
        conversation.id,
        comment.id,
      );
      expect(publication).toMatchObject({ state: "published", attempts: 1 });
      const rows = await readChatPublicationsByCommentId(comment.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.transportPart).toBeUndefined();
      expect(providerRuntime.posts).toHaveLength(1);
      expect(providerRuntime.posts[0]?.text).toBe(source);
      expect(providerRuntime.posts[0]?.attachments ?? []).toHaveLength(0);
      await service.processPendingPublications();
      expect(providerRuntime.posts).toHaveLength(1);
    },
  );

  it("uses compact single-use Telegram action tokens and filters forged, expired, and oversized callbacks", async () => {
    const fixture = await seedCompany();
    let pauseNextQuestionResolution = false;
    let releaseQuestionResolution!: () => void;
    let signalQuestionResolution!: () => void;
    const questionResolutionEntered = new Promise<void>((resolve) => {
      signalQuestionResolution = resolve;
    });
    const questionResolutionReleased = new Promise<void>((resolve) => {
      releaseQuestionResolution = resolve;
    });
    const { callbacks, endpoint, service } = await configuredTelegramEndpoint(
      fixture,
      {
        questionResolutionPersistBarrier: async () => {
          if (!pauseNextQuestionResolution) return;
          signalQuestionResolution();
          await questionResolutionReleased;
        },
      },
    );
    const externalUserId = "771234567";
    const channel = makeThread({
      channelId: externalUserId,
      id: `telegram:${externalUserId}`,
      isDM: true,
      name: "Maya direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: channel.thread,
      message: makeMessage({
        id: "tg-question-1",
        text: "Help me choose a priority",
        userId: externalUserId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);

    const linkedUserId = `telegram-question-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: linkedUserId,
      name: "Telegram Question User",
      email: `${linkedUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: linkedUserId,
      status: "active",
      membershipRole: "operator",
    });
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(eq(chatExternalPrincipals.externalId, externalUserId))
      .then((rows) => rows[0]);
    const intent = await service.createLinkIntent(
      endpoint.id,
      principal.id,
      1_800,
    );
    const identityToken = new URL(intent.confirmationUrl).searchParams.get(
      "token",
    );
    if (!identityToken) throw new Error("Telegram identity token was absent");
    await service.confirmIdentityLink(identityToken, linkedUserId);

    async function publishQuestion(title: string) {
      const interaction = await issueThreadInteractionService(db).create(
        {
          id: conversation.issueId,
          companyId: fixture.companyId,
        },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          title,
          payload: {
            version: 1,
            title,
            questions: [
              {
                id: "priority",
                prompt: "Which priority should we use?",
                selectionMode: "single",
                required: true,
                allowOther: false,
                options: [
                  { id: "high", label: "High" },
                  { id: "normal", label: "Normal" },
                ],
              },
            ],
          },
        },
        { agentId: fixture.assignedAgentId },
      );
      // This suite intentionally leaves some retryable fixtures behind. Drain
      // a bounded full-page backlog so this helper does not assume its question
      // is among the global oldest 25. A delivery scheduled by the preceding
      // answer may concurrently claim this exact row, so await its durable
      // published state instead of treating that in-flight claim as failure.
      await service.processPendingPublications(1_000);
      let publication: typeof chatPublications.$inferSelect | undefined;
      await vi.waitFor(async () => {
        publication = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              eq(chatPublications.issueId, conversation.issueId),
            ),
          )
          .then((rows) =>
            rows.find((row) => row.payload.interactionId === interaction.id),
          );
        expect(publication).toMatchObject({
          state: "published",
          providerMessageId: expect.any(String),
        });
      });
      if (!publication?.providerMessageId)
        throw new Error("Telegram question publication was not delivered");
      const action = publication.payload.card?.actions?.find(
        (candidate) =>
          candidate.type === "callback" && candidate.label === "High",
      );
      if (!action || action.type !== "callback")
        throw new Error("Telegram callback action was not projected");
      const token = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.providerActionId, action.actionId),
          ),
        )
        .then((rows) => rows[0]);
      if (!token) throw new Error("Telegram action token was not persisted");
      return { interaction, publication, action, token };
    }

    const first = await publishQuestion("Choose the initial priority");
    const callbackData = telegramChatSdkCallbackData(first.action.actionId);
    expect(Buffer.byteLength(callbackData, "utf8")).toBe(39);
    expect(Buffer.byteLength(callbackData, "utf8")).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
    );
    expect(first.token).toMatchObject({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      principalId: null,
      kind: "question_answer",
      providerActionId: first.action.actionId,
      status: "issued",
      payload: {
        version: 1,
        publicationId: first.publication.id,
        interactionId: first.interaction.id,
        questionId: "priority",
        optionId: "high",
        expiresAt: expect.any(String),
      },
    });

    const actionEvent = (input: {
      actionId: string;
      callbackData: string;
      messageId?: string;
    }) => ({
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        actionId: input.actionId,
        adapter: {} as never,
        messageId: input.messageId ?? first.publication.providerMessageId!,
        openModal: async () => undefined,
        raw: {
          id: `callback-${randomUUID()}`,
          data: input.callbackData,
          from: { id: Number(externalUserId), first_name: "Telegram User" },
        },
        thread: channel.thread,
        threadId: channel.thread.id,
        user: {
          userId: externalUserId,
          userName: "telegram-user",
          fullName: "Telegram User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        value: undefined,
      },
    });

    const forgedActionId = "pcq:AAAAAAAAAAAAAAAAAAAAAA";
    const forgedTelegramAction = actionEvent({
      actionId: forgedActionId,
      callbackData: telegramChatSdkCallbackData(forgedActionId),
    });
    await callbacks.onAction!(forgedTelegramAction);
    // These hand-built events prove action authorization, not authenticated
    // Telegram response provenance. Their denials must not publish a fallback.
    await service.processPendingProviderEffects();
    expect(channel.post).not.toHaveBeenCalled();
    expect(JSON.stringify(channel.post.mock.calls)).not.toContain(
      forgedActionId,
    );
    expect(JSON.stringify(channel.post.mock.calls)).not.toContain(
      telegramChatSdkCallbackData(forgedActionId),
    );
    channel.post.mockClear();
    await callbacks.onAction!(forgedTelegramAction);
    expect(channel.post).not.toHaveBeenCalled();
    const deniedTelegramActions = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "action"),
        ),
      );
    expect(deniedTelegramActions).toEqual([
      expect.objectContaining({
        conversationId: null,
        principalId: principal.id,
        state: "filtered",
        attempts: 1,
        redactedError: "External action denied by Paperclip authorization",
        normalizedEvent: {
          providerEventId: expect.stringMatching(
            /^action-denied:[a-f0-9]{64}$/,
          ),
          kind: "action",
          authorization: { outcome: "denied" },
        },
      }),
    ]);
    expect(JSON.stringify(deniedTelegramActions[0])).not.toContain(
      forgedActionId,
    );
    expect(JSON.stringify(deniedTelegramActions[0])).not.toContain(
      telegramChatSdkCallbackData(forgedActionId),
    );
    expect(await service.listActivity(endpoint.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: deniedTelegramActions[0]!.id,
          kind: "delivery",
          status: "filtered",
          summary: "action ignored",
          detail: "External action denied by Paperclip authorization",
          replayable: false,
        }),
      ]),
    );

    const oversizedCallbackData = "x".repeat(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES + 1,
    );
    expect(Buffer.byteLength(oversizedCallbackData, "utf8")).toBe(65);
    await callbacks.onAction!(
      actionEvent({
        actionId: first.action.actionId,
        callbackData: oversizedCallbackData,
      }),
    );

    await db
      .update(chatActions)
      .set({ payload: { ...first.token.payload, optionId: "forged-option" } })
      .where(eq(chatActions.id, first.token.id));
    await callbacks.onAction!(
      actionEvent({
        actionId: first.action.actionId,
        callbackData,
      }),
    );
    await db
      .update(chatActions)
      .set({ payload: first.token.payload })
      .where(eq(chatActions.id, first.token.id));

    await callbacks.onAction!(
      actionEvent({
        actionId: first.action.actionId,
        callbackData,
      }),
    );
    const [answered] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, first.interaction.id));
    expect(answered).toMatchObject({
      status: "answered",
      resolvedByUserId: linkedUserId,
      result: {
        version: 1,
        answers: [{ questionId: "priority", optionIds: ["high"] }],
      },
    });
    await callbacks.onAction!(
      actionEvent({
        actionId: first.action.actionId,
        callbackData,
      }),
    );
    expect(
      await db
        .select()
        .from(issueQuestionResponseDeliveries)
        .where(
          eq(
            issueQuestionResponseDeliveries.interactionId,
            first.interaction.id,
          ),
        ),
    ).toHaveLength(1);
    await service.processPendingProviderEffects();
    expect(channel.post).not.toHaveBeenCalled();
    channel.post.mockClear();

    const authorization = await publishQuestion(
      "Choose a permission-sensitive priority",
    );
    const authorizationCallbackData = telegramChatSdkCallbackData(
      authorization.action.actionId,
    );
    await db
      .update(companyMemberships)
      .set({ membershipRole: "viewer" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    await callbacks.onAction!(
      actionEvent({
        actionId: authorization.action.actionId,
        callbackData: authorizationCallbackData,
        messageId: authorization.publication.providerMessageId!,
      }),
    );
    await service.processPendingProviderEffects();
    expect(channel.post).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, authorization.token.id)),
    ).resolves.toEqual([{ status: "issued" }]);
    await expect(
      db
        .select({ status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, authorization.interaction.id)),
    ).resolves.toEqual([{ status: "pending" }]);
    await db
      .update(companyMemberships)
      .set({ membershipRole: "operator" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    channel.post.mockClear();

    const authorizationRace = await publishQuestion(
      "Choose a priority while membership changes",
    );
    const authorizationRaceCallbackData = telegramChatSdkCallbackData(
      authorizationRace.action.actionId,
    );
    pauseNextQuestionResolution = true;
    const racedCallback = callbacks.onAction!(
      actionEvent({
        actionId: authorizationRace.action.actionId,
        callbackData: authorizationRaceCallbackData,
        messageId: authorizationRace.publication.providerMessageId!,
      }),
    );
    await questionResolutionEntered;
    await db
      .update(companyMemberships)
      .set({ membershipRole: "viewer", updatedAt: new Date() })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    releaseQuestionResolution();
    await racedCallback;
    await service.processPendingProviderEffects();
    expect(channel.post).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(
          eq(issueThreadInteractions.id, authorizationRace.interaction.id),
        ),
    ).resolves.toEqual([{ status: "pending" }]);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, authorizationRace.token.id)),
    ).resolves.toEqual([{ status: "issued" }]);
    await db
      .update(companyMemberships)
      .set({ membershipRole: "operator", updatedAt: new Date() })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    channel.post.mockClear();

    const expired = await publishQuestion("Choose an expired priority");
    await db
      .update(chatActions)
      .set({
        payload: {
          ...expired.token.payload,
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        },
      })
      .where(eq(chatActions.id, expired.token.id));
    const expiredCallbackData = telegramChatSdkCallbackData(
      expired.action.actionId,
    );
    await callbacks.onAction!(
      actionEvent({
        actionId: expired.action.actionId,
        callbackData: expiredCallbackData,
        messageId: expired.publication.providerMessageId!,
      }),
    );
    await service.processPendingProviderEffects();
    expect(channel.post).not.toHaveBeenCalled();
    expect(JSON.stringify(channel.post.mock.calls)).not.toContain(
      expired.action.actionId,
    );
    expect(JSON.stringify(channel.post.mock.calls)).not.toContain(
      expiredCallbackData,
    );
    const [expiredToken] = await readChatActionsById(expired.token.id);
    expect(expiredToken).toMatchObject({
      status: "expired",
      result: { code: "question_action_token_expired" },
    });
    const [stillPending] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, expired.interaction.id));
    expect(stillPending.status).toBe("pending");
  });

  it("renders safe Telegram confirmations as opaque one-use buttons and wakes the resolved task", async () => {
    const { fixture, onAction, endpoint, service, wakeup, settlementBarrier, dm, conversation, linkedUserId, principal, interaction, publication, acceptAction, actionEvent } = await telegramConfirmationRecoveryFixture();
    await expect(onAction(actionEvent)).rejects.toThrow(
      "injected post-interaction confirmation settlement crash",
    );
    expect(settlementBarrier).toHaveBeenCalledTimes(1);
    await expect(
      db
        .select({
          status: issueThreadInteractions.status,
          resolvedByUserId: issueThreadInteractions.resolvedByUserId,
        })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interaction.id)),
    ).resolves.toEqual([
      { status: "accepted", resolvedByUserId: linkedUserId },
    ]);
    await expect(
      db
        .select({
          decision: sql<string>`${chatActions.payload}->>'decision'`,
          status: chatActions.status,
        })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "confirmation_response"),
          ),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        { decision: "accept", status: "processing" },
        { decision: "reject", status: "expired" },
      ]),
    );
    expect(wakeup).not.toHaveBeenCalled();
    const crashWindowPublication = await db
      .select({ state: chatPublications.state })
      .from(chatPublications)
      .where(
        eq(
          chatPublications.idempotencyKey,
          `interaction-resolution:${interaction.id}:${endpoint.id}`,
        ),
      )
      .then((rows) => rows[0]);
    expect(crashWindowPublication).toBeDefined();
    expect(crashWindowPublication?.state).not.toBe("published");
    expect(
      (service.runtime as unknown as FakeChatSdkRuntime).endpoints.get(
        endpoint.id,
      )?.edits,
    ).toHaveLength(0);

    const recoveryRuntime = new FakeChatSdkRuntime();
    const recovery = createService(
      recoveryRuntime,
      fakeTelegramFetch() as typeof globalThis.fetch,
      {
        wakeup: async () => {
          expect(
            recoveryRuntime.endpoints.get(endpoint.id)?.edits,
          ).toHaveLength(1);
          return { accepted: true };
        },
      },
    );
    await recovery.service.processPendingPublications();
    await vi.waitFor(async () => {
      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              eq(
                chatPublications.idempotencyKey,
                `interaction-resolution:${interaction.id}:${endpoint.id}`,
              ),
            ),
          ),
      ).resolves.toEqual([{ state: "published" }]);
    });
    const resolutionPublication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpoint.id),
          eq(
            chatPublications.idempotencyKey,
            `interaction-resolution:${interaction.id}:${endpoint.id}`,
          ),
        ),
      )
      .then((rows) => rows[0]);
    expect(resolutionPublication).toMatchObject({
      state: "published",
      providerMessageId: publication.providerMessageId,
      payload: {
        interactionId: interaction.id,
        card: {
          kind: "confirmation",
          title: "Proceed with Telegram production qualification?",
          body: "Accepted",
        },
      },
    });
    const providerRuntime = recovery.runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.edits).toHaveLength(1);
    expect(providerRuntime?.edits[0]).toMatchObject({
      messageId: publication.providerMessageId,
    });
    expect(providerRuntime?.edits[0]?.text).toContain("Accepted");
    expect(providerRuntime?.edits[0]?.text).not.toContain(
      acceptAction.providerActionId,
    );

    await expect(
      db
        .select({
          decision: sql<string>`${chatActions.payload}->>'decision'`,
          status: chatActions.status,
        })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "confirmation_response"),
          ),
        )
        .orderBy(asc(chatActions.createdAt), asc(chatActions.id)),
    ).resolves.toEqual(
      expect.arrayContaining([
        { decision: "accept", status: "processed" },
        { decision: "reject", status: "expired" },
      ]),
    );
    expect(recovery.wakeup).toHaveBeenCalledTimes(1);
    expect(recovery.wakeup).toHaveBeenCalledWith(
      fixture.assignedAgentId,
      expect.objectContaining({
        allowRunCoalescing: false,
        idempotencyKey: `interaction:${interaction.id}:accepted`,
        reason: "issue_commented",
        payload: expect.objectContaining({
          interactionId: interaction.id,
          interactionStatus: "accepted",
        }),
      }),
    );
    await expect(
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.action, "issue.thread_interaction_accepted"),
            eq(
              sql<string>`${activityLog.details}->>'interactionId'`,
              interaction.id,
            ),
            eq(sql<string>`${activityLog.details}->>'source'`, "external_chat"),
          ),
        ),
    ).resolves.toHaveLength(1);

    const providerPostCountBeforeRedelivery = dm.post.mock.calls.length;
    const providerEffectCountBeforeRedelivery = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.conversationId, conversation.id),
          eq(chatActions.kind, "provider_effect"),
        ),
      )
      .then((rows) => rows.length);
    await onAction(actionEvent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dm.post).toHaveBeenCalledTimes(providerPostCountBeforeRedelivery);
    await expect(
      db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.conversationId, conversation.id),
            eq(chatActions.kind, "provider_effect"),
          ),
        )
        .then((rows) => rows.length),
    ).resolves.toBe(providerEffectCountBeforeRedelivery);
    await recovery.service.processPendingPublications();
    expect(recovery.wakeup).toHaveBeenCalledTimes(1);

    const confirmationWake = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "interaction_wakeup"),
        ),
      )
      .then((rows) => rows[0]);
    if (!confirmationWake)
      throw new Error("Expected durable confirmation wake");
    await db
      .update(chatActions)
      .set({ status: "processing", updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(chatActions.id, confirmationWake.id));
    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      source: "automation",
      reason: "issue_commented",
      status: "queued",
      idempotencyKey: `interaction:${interaction.id}:accepted`,
    });
    recovery.wakeup.mockClear();
    await recovery.service.processPendingPublications();
    expect(recovery.wakeup).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, confirmationWake.id)),
    ).resolves.toEqual([
      {
        status: "processed",
        result: { code: "interaction_wakeup_already_durable" },
      },
    ]);

    const boardRace = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Let the board resolve after Telegram claims this action?",
        },
      },
      { agentId: fixture.assignedAgentId },
    );
    await service.processPendingPublications();
    const boardRaceActions = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "confirmation_response"),
          eq(
            sql<string>`${chatActions.payload}->>'interactionId'`,
            boardRace.id,
          ),
        ),
      );
    const boardRaceAccept = boardRaceActions.find(
      (action) => action.payload.decision === "accept",
    );
    if (!boardRaceAccept)
      throw new Error("Expected board-race Telegram accept action");
    await db
      .update(chatActions)
      .set({
        principalId: principal.id,
        status: "processing",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatActions.id, boardRaceAccept.id),
          eq(chatActions.status, "issued"),
        ),
      );
    const boardIssue = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, fixture.companyId),
          eq(issues.id, conversation.issueId),
        ),
      )
      .then((rows) => rows[0]);
    if (!boardIssue) throw new Error("Expected board-race issue");
    await issueThreadInteractionService(db).acceptInteraction(
      boardIssue,
      boardRace.id,
      {},
      { userId: linkedUserId },
    );
    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.replacementAgentId,
      source: "automation",
      reason: "issue_commented",
      status: "queued",
      idempotencyKey: `interaction:${boardRace.id}:accepted`,
    });
    recovery.wakeup.mockClear();
    await recovery.service.processPendingPublications();
    expect(recovery.wakeup).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.kind, "interaction_wakeup"),
            eq(
              sql<string>`${chatActions.payload}->>'interactionId'`,
              boardRace.id,
            ),
          ),
        ),
    ).resolves.toEqual([
      {
        status: "processed",
        result: {
          code: "interaction_wakeup_coalesced_after_reassignment",
        },
      },
    ]);
    await expect(
      db
        .select({
          decision: sql<string>`${chatActions.payload}->>'decision'`,
          status: chatActions.status,
        })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "confirmation_response"),
            eq(
              sql<string>`${chatActions.payload}->>'interactionId'`,
              boardRace.id,
            ),
          ),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        { decision: "accept", status: "processed" },
        { decision: "reject", status: "expired" },
      ]),
    );
    await expect(
      db
        .select({
          state: chatPublications.state,
          payload: chatPublications.payload,
        })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `interaction-resolution:${boardRace.id}:${endpoint.id}`,
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "published",
        payload: expect.objectContaining({ interactionId: boardRace.id }),
      }),
    ]);
    await expect(
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.action, "issue.thread_interaction_accepted"),
            eq(
              sql<string>`${activityLog.details}->>'interactionId'`,
              boardRace.id,
            ),
            eq(sql<string>`${activityLog.details}->>'source'`, "external_chat"),
          ),
        ),
    ).resolves.toHaveLength(0);

    const failingWakeup = vi.fn(async () => {
      throw new Error("injected permanent confirmation wake failure");
    });
    const retryingWakeService = createService(
      new FakeChatSdkRuntime(),
      fakeTelegramFetch() as typeof globalThis.fetch,
      { wakeup: failingWakeup },
    );
    // These rows exercise the recovery worker itself. Insert them directly so
    // the original endpoint service's interaction-created subscription cannot
    // race this deliberately failing worker and queue the continuation first.
    const [retryingInteraction] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        kind: "request_confirmation",
        continuationPolicy: "none",
        createdByAgentId: fixture.assignedAgentId,
        status: "accepted",
        resolvedByUserId: linkedUserId,
        resolvedAt: new Date(),
        payload: {
          version: 1,
          prompt: "Exercise interaction wake retry exhaustion",
        },
      })
      .returning();
    const retryingWakeId = randomUUID();
    await db.insert(chatActions).values({
      id: retryingWakeId,
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      principalId: principal.id,
      kind: "interaction_wakeup",
      providerActionId: `interaction_wakeup:${randomUUID()}`,
      payload: {
        version: 1,
        interactionId: retryingInteraction.id,
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        issueId: conversation.issueId,
        agentId: fixture.assignedAgentId,
        sourceCommentId: null,
        sourceRunId: null,
        requestedByUserId: linkedUserId,
      },
      status: "issued",
    });
    try {
      await retryingWakeService.service.processPendingPublications(1_000);
      expect(failingWakeup).toHaveBeenCalledTimes(1);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, retryingWakeId)),
      ).resolves.toEqual([
        {
          status: "issued",
          result: { code: "interaction_wakeup_failed", attemptCount: 1 },
        },
      ]);
      await retryingWakeService.service.processPendingPublications(1_000);
      expect(failingWakeup).toHaveBeenCalledTimes(1);
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        await db
          .update(chatActions)
          .set({ updatedAt: new Date(Date.now() - 31_000) })
          .where(eq(chatActions.id, retryingWakeId));
        await retryingWakeService.service.processPendingPublications(1_000);
      }
      expect(failingWakeup).toHaveBeenCalledTimes(5);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, retryingWakeId)),
      ).resolves.toEqual([
        {
          status: "issued",
          result: { code: "interaction_wakeup_failed", attemptCount: 5 },
        },
      ]);
      await db
        .update(chatActions)
        .set({ updatedAt: new Date(Date.now() - 31_000) })
        .where(eq(chatActions.id, retryingWakeId));
      await retryingWakeService.service.processPendingPublications(1_000);
      expect(failingWakeup).toHaveBeenCalledTimes(6);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, retryingWakeId)),
      ).resolves.toEqual([
        {
          status: "issued",
          result: { code: "interaction_wakeup_failed", attemptCount: 6 },
        },
      ]);
    } finally {
      try {
        await retryingWakeService.service.shutdown();
      } finally {
        // This intentionally retryable synthetic action must not become due
        // during a later test's global drain. Remove only this fixture row;
        // production shutdown must preserve durable retry work.
        await db
          .delete(chatActions)
          .where(
            and(
              eq(chatActions.id, retryingWakeId),
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "interaction_wakeup"),
            ),
          );
      }
    }
    await expect(
      db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(eq(chatActions.id, retryingWakeId)),
    ).resolves.toEqual([]);

    const [deferredInteraction] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        kind: "request_confirmation",
        continuationPolicy: "none",
        createdByAgentId: fixture.assignedAgentId,
        status: "accepted",
        resolvedByUserId: linkedUserId,
        resolvedAt: new Date(),
        payload: {
          version: 1,
          prompt: "Exercise a scheduler-deferred interaction wake",
        },
      })
      .returning();
    const deferredWakeId = randomUUID();
    await db.insert(chatActions).values({
      id: deferredWakeId,
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      principalId: principal.id,
      kind: "interaction_wakeup",
      providerActionId: `interaction_wakeup:${randomUUID()}`,
      payload: {
        version: 1,
        interactionId: deferredInteraction.id,
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        issueId: conversation.issueId,
        agentId: fixture.assignedAgentId,
        sourceCommentId: null,
        sourceRunId: null,
        requestedByUserId: linkedUserId,
      },
      status: "issued",
    });
    const deferredWakeup = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ accepted: true });
    const deferredWakeService = createService(
      new FakeChatSdkRuntime(),
      fakeTelegramFetch() as typeof globalThis.fetch,
      { wakeup: deferredWakeup },
    );
    await deferredWakeService.service.processPendingPublications();
    expect(deferredWakeup).toHaveBeenCalledTimes(1);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, deferredWakeId)),
    ).resolves.toEqual([
      {
        status: "issued",
        result: { code: "interaction_wakeup_deferred" },
      },
    ]);
    await deferredWakeService.service.processPendingPublications();
    expect(deferredWakeup).toHaveBeenCalledTimes(1);
    await db
      .update(chatActions)
      .set({ updatedAt: new Date(Date.now() - 31_000) })
      .where(eq(chatActions.id, deferredWakeId));
    await deferredWakeService.service.processPendingPublications();
    expect(deferredWakeup).toHaveBeenCalledTimes(2);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, deferredWakeId)),
    ).resolves.toEqual([
      {
        status: "processed",
        result: { code: "interaction_wakeup_queued" },
      },
    ]);
    await deferredWakeService.service.shutdown();

    const governed = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Explain why this should be rejected",
          rejectRequiresReason: true,
        },
      },
      { agentId: fixture.assignedAgentId },
    );
    await service.processPendingPublications();
    const guardedPublication = await readChatPublicationsByIdempotencyKey(`interaction:${governed.id}:${endpoint.id}`)
      .then((rows) => rows[0]);
    expect(
      guardedPublication.payload.card?.actions?.some(
        (action) => action.type === "callback",
      ) ?? false,
    ).toBe(false);
    expect(
      await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.kind, "confirmation_response"),
            eq(
              sql<string>`${chatActions.payload}->>'interactionId'`,
              governed.id,
            ),
          ),
        ),
    ).toHaveLength(0);
  });
});
