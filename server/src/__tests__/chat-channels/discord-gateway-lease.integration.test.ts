import { nativeChatProgressWork } from "../../services/chat-native-progress-work.js";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "../../middleware/auth.js";
import { cloudTenantPrimaryCompanyId } from "../../services/cloud-instance.js";
import { accessService } from "../../services/access.js";
import { subscribeDatabaseWork } from "@paperclipai/db";
import { notifyChatEndpointConfiguration, notifyChatCompanyConfiguration } from "../../services/chat-channels/configuration-work-notifications.js";
import { configureAgentLifecycle } from "../../services/agent-lifecycle.js";
import { deleteCompany } from "../../services/company-deletion.js";
import { conflict } from "../../errors.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import { chatRunMilestoneWork } from "../../services/chat-run-milestone-work.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../../services/delivery-work-notifications.js";
import { toolAccessService } from "../../services/tool-access.js";
import { createHash, randomUUID } from "node:crypto";
import { type Server } from "node:http";
import path from "node:path";
import request from "supertest";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, activityLog, authUsers, chatActions, chatConversations, chatDeliveries, chatDiscordCommandOwners, chatEndpointLeases, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatPublications, companySecrets, companyMemberships, heartbeatRunEvents, heartbeatRuns, issueComments, issues, toolConnections } from "@paperclipai/db";
import type { Message, Thread } from "chat";
import { type ChatChannelServiceOptions, type ChatChannelService } from "../../services/chat-channels.js";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { createDiscordAdapter } from "@chat-adapter/discord";
import { issueService } from "../../services/issues.js";
import { enqueueChatRunMilestones, resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, uniqueDiscordApplicationId, fakeDiscordFetch, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";

describeEmbeddedPostgres("chat channels: discord gateway lease", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const { seedCompany, readChatEndpointsById, readChatConversationsById, readChatPublicationsByCommentId, readChatActionsByProviderActionId, createService, retirePublicationFixture, chatWakeContext, addSelectedChatFinal, qualifySetupRoundTrip, configuredDiscordEndpoint, recoverDiscordCommands, deliverMessage, waitForProcessedReceiptRemoval } = h;

  it("rehydrates one Discord Gateway owner on startup and hands off cleanly across replicas", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const guildId = "1457808928258658549";
    const providerFetch = fakeDiscordFetch(
      applicationId,
      guildId,
    ) as typeof globalThis.fetch;
    const ownerRuntime = new FakeChatSdkRuntime();
    const owner = createService(ownerRuntime, providerFetch);
    const endpoint = await owner.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await owner.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId,
        },
      },
      "owner-user",
    );
    expect(
      ownerRuntime.configurations.get(endpoint.id)?.enableDiscordGateway,
    ).toBe(true);

    const standbyRuntime = new FakeChatSdkRuntime();
    const standby = createService(standbyRuntime, providerFetch);
    await expect(standby.service.reconcileProviderRuntimes()).resolves.toEqual({
      eligible: 1,
      local: 0,
      ownedElsewhere: 1,
      failed: 0,
    });
    expect(standbyRuntime.endpoints.has(endpoint.id)).toBe(false);
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
          ),
        ),
    ).resolves.toHaveLength(1);

    const firstRuntime = ownerRuntime.endpoints.get(endpoint.id);
    await owner.service.shutdown();
    expect(firstRuntime?.shutdown).toHaveBeenCalledOnce();
    const reconciled = await standby.service.reconcileProviderRuntimes();
    // Earlier integration cases intentionally leave durable active endpoints
    // behind in this shared database. A fresh standby must recover all
    // currently unowned Discord gateways, including this test's endpoint.
    expect(reconciled).toMatchObject({ ownedElsewhere: 0, failed: 0 });
    expect(reconciled.local).toBe(reconciled.eligible);
    expect(reconciled.local).toBeGreaterThanOrEqual(1);
    expect(
      standbyRuntime.configurations.get(endpoint.id)?.enableDiscordGateway,
    ).toBe(true);
    await standby.service.shutdown();
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
    ).resolves.toEqual([]);
  });

  it("recovers buffered Discord messages and reactions after an unreclaimed host-pause lease expiry", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredDiscordEndpoint(fixture, {
        discordGatewayLeaseRenewalIntervalMs: 60_000,
        discordGatewayLeaseTtlMs: 200,
      });
    const ownedRuntime = runtime.endpoints.get(endpoint.id);
    if (!ownedRuntime)
      throw new Error("Expected Discord Gateway owner runtime");
    const [leaseBeforePause] = await db
      .select({ token: chatEndpointLeases.token })
      .from(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.endpointId, endpoint.id),
          eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
        ),
      );
    if (!leaseBeforePause) throw new Error("Expected Discord Gateway lease");

    await new Promise((resolve) => setTimeout(resolve, 250));
    const messageId = "555555555555555601";
    const channel = makeThread({
      channelId: "333333333333333333",
      id: `discord:1457808928258658549:333333333333333333:${messageId}`,
      name: "discord-host-pause",
    });
    const message = makeMessage({
      id: messageId,
      mentioned: true,
      text: "@maya retain this buffered Discord turn",
      userId: "444444444444444444",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message,
      trigger: "mention",
    });

    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              `${channel.thread.id}:${messageId}`,
            ),
          ),
        ),
    ).resolves.toHaveLength(1);
    expect(runtime.endpoints.get(endpoint.id)).toBe(ownedRuntime);
    expect(ownedRuntime.shutdown).not.toHaveBeenCalled();
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
          ),
        ),
    ).resolves.toEqual([{ token: leaseBeforePause.token }]);

    await qualifySetupRoundTrip(service, endpoint.id, message.author.userId);
    await service.test(endpoint.id);
    if (!callbacks.onReaction) {
      throw new Error("Expected Discord reaction callback");
    }
    const commentCountBefore = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const wakeupCountBefore = wakeup.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const emoji = {
      name: "thumbsup",
      toJSON: () => "👍",
      toString: () => "👍",
    };
    const reaction = {
      endpointId: endpoint.id,
      provider: "discord" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji,
        message,
        messageId,
        raw: {
          channel_id: "333333333333333333",
          emoji: { id: null, name: "👍" },
          gateway_dispatch: {
            eventType: "MESSAGE_REACTION_ADD",
            sequence: 801,
            sessionFingerprint: "c".repeat(24),
            shardId: 0,
          },
          guild_id: "1457808928258658549",
          message_id: messageId,
          user_id: message.author.userId,
        },
        rawEmoji: "👍",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: message.author,
      },
    };
    await callbacks.onReaction(reaction);
    await callbacks.onReaction(reaction);

    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
            sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${messageId}`,
          ),
        ),
    ).resolves.toEqual([{ state: "processed" }]);
    expect(
      await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.companyId, fixture.companyId))
        .then((rows) => rows.length),
    ).toBe(commentCountBefore);
    expect(wakeup).toHaveBeenCalledTimes(wakeupCountBefore);
    expect(runtime.endpoints.get(endpoint.id)).toBe(ownedRuntime);
    expect(ownedRuntime.shutdown).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it("stops a Discord Gateway on lease loss and lets a standby take over", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const guildId = "1457808928258658549";
    const providerFetch = fakeDiscordFetch(
      applicationId,
      guildId,
    ) as typeof globalThis.fetch;
    const ownerRuntime = new FakeChatSdkRuntime();
    const owner = createService(ownerRuntime, providerFetch, {
      discordGatewayLeaseRenewalIntervalMs: 60_000,
      discordGatewayLeaseTtlMs: 200,
    });
    const endpoint = await owner.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await owner.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId,
        },
      },
      "owner-user",
    );
    const staleRuntime = ownerRuntime.endpoints.get(endpoint.id);
    const staleAdmission = ownerRuntime.configurations.get(endpoint.id)
      ?.callbacks.onDiscordRootMentionAdmission;
    const staleCallbacks = ownerRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!staleAdmission || !staleCallbacks)
      throw new Error("Expected Discord admission callbacks");

    const standbyRuntime = new FakeChatSdkRuntime();
    const standby = createService(standbyRuntime, providerFetch);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const reconciled = await standby.service.reconcileProviderRuntimes();
    expect(reconciled).toMatchObject({ ownedElsewhere: 0, failed: 0 });
    expect(reconciled.local).toBe(reconciled.eligible);
    expect(reconciled.local).toBeGreaterThanOrEqual(1);
    expect(
      standbyRuntime.configurations.get(endpoint.id)?.enableDiscordGateway,
    ).toBe(true);
    await expect(
      staleAdmission({
        channelId: "333333333333333333",
        endpointId: endpoint.id,
        guildId,
        messageId: "555555555555555555",
        threadId: `discord:${guildId}:333333333333333333:555555555555555555`,
        userId: "444444444444444444",
      }),
    ).resolves.toBe(false);
    expect(staleRuntime?.shutdown).toHaveBeenCalledOnce();

    const freshCallbacks = standbyRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!freshCallbacks)
      throw new Error("Expected standby Discord admission callbacks");
    const messageId = "555555555555555602";
    const channel = makeThread({
      channelId: "333333333333333333",
      id: `discord:${guildId}:333333333333333333:${messageId}`,
      name: "discord-standby-takeover",
    });
    const message = makeMessage({
      id: messageId,
      mentioned: true,
      text: "@maya accept this once after Gateway takeover",
      userId: "444444444444444444",
    });
    await deliverMessage({
      callbacks: staleCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message,
      trigger: "mention",
    });
    await deliverMessage({
      callbacks: freshCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message,
      trigger: "mention",
    });
    await expect(
      db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              `${channel.thread.id}:${messageId}`,
            ),
          ),
        ),
    ).resolves.toHaveLength(1);
    await Promise.all([owner.service.shutdown(), standby.service.shutdown()]);
  });

  it("fences message and reaction callbacks that resume after Discord Gateway takeover", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const guildId = "1457808928258658549";
    const channelId = "333333333333333334";
    let holdOldCallbacks = false;
    let releaseOldCallbacks!: () => void;
    let messageAdmissionEntered!: () => void;
    let reactionAdmissionEntered!: () => void;
    const oldCallbacksReleased = new Promise<void>((resolve) => {
      releaseOldCallbacks = resolve;
    });
    const messageAdmissionReached = new Promise<void>((resolve) => {
      messageAdmissionEntered = resolve;
    });
    const reactionAdmissionReached = new Promise<void>((resolve) => {
      reactionAdmissionEntered = resolve;
    });
    const providerFetch = fakeDiscordFetch(
      applicationId,
      guildId,
    ) as typeof globalThis.fetch;
    const ownerRuntime = new FakeChatSdkRuntime();
    const owner = createService(ownerRuntime, providerFetch, {
      discordGatewayLeaseRenewalIntervalMs: 60_000,
      discordGatewayLeaseTtlMs: 200,
      discordGatewayMessageAdmissionBarrier: async () => {
        if (!holdOldCallbacks) return;
        messageAdmissionEntered();
        await oldCallbacksReleased;
      },
      reactionLinkPreflightBarrier: async () => {
        if (!holdOldCallbacks) return;
        reactionAdmissionEntered();
        await oldCallbacksReleased;
      },
    });
    const endpoint = await owner.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await owner.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId,
        },
      },
      "owner-user",
    );
    const rootMessageId = "555555555555555603";
    const channel = makeThread({
      channelId,
      id: `discord:${guildId}:${channelId}:${rootMessageId}`,
      name: "discord-callback-takeover",
    });
    const rootMessage = makeMessage({
      id: rootMessageId,
      mentioned: true,
      text: "@maya establish the takeover fixture",
      userId: "444444444444444445",
    });
    const setupCallbacks = ownerRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!setupCallbacks) throw new Error("Expected owner Discord callbacks");
    await deliverMessage({
      callbacks: setupCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: rootMessage,
      trigger: "mention",
    });
    await qualifySetupRoundTrip(
      owner.service,
      endpoint.id,
      rootMessage.author.userId,
    );
    await owner.service.test(endpoint.id);
    const staleRuntime = ownerRuntime.endpoints.get(endpoint.id);
    const staleCallbacks = ownerRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!staleRuntime || !staleCallbacks?.onReaction) {
      throw new Error("Expected active owner Discord callbacks");
    }
    const [leaseBeforeTakeover] = await db
      .select({ token: chatEndpointLeases.token })
      .from(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.endpointId, endpoint.id),
          eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
        ),
      );
    if (!leaseBeforeTakeover) throw new Error("Expected owner Gateway lease");

    const messageId = "555555555555555604";
    const bufferedMessage = makeMessage({
      id: messageId,
      text: "continue this once after takeover",
      userId: rootMessage.author.userId,
    });
    const emoji = {
      name: "thumbsup",
      toJSON: () => "👍",
      toString: () => "👍",
    };
    const reaction = {
      endpointId: endpoint.id,
      provider: "discord" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji,
        message: rootMessage,
        messageId: rootMessageId,
        raw: {
          channel_id: channelId,
          emoji: { id: null, name: "👍" },
          gateway_dispatch: {
            eventType: "MESSAGE_REACTION_ADD",
            sequence: 802,
            sessionFingerprint: "d".repeat(24),
            shardId: 0,
          },
          guild_id: guildId,
          message_id: rootMessageId,
          user_id: rootMessage.author.userId,
        },
        rawEmoji: "👍",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: rootMessage.author,
      },
    };
    const commentCountBefore = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const wakeupCountBefore = owner.wakeup.mock.calls.length;
    holdOldCallbacks = true;
    const staleMessage = deliverMessage({
      callbacks: staleCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: bufferedMessage,
      trigger: "subscribed_message",
    });
    const staleReaction = staleCallbacks.onReaction(reaction);
    await Promise.all([messageAdmissionReached, reactionAdmissionReached]);

    const standbyRuntime = new FakeChatSdkRuntime();
    const standby = createService(standbyRuntime, providerFetch);
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const reconciled = await standby.service.reconcileProviderRuntimes();
      expect(reconciled).toMatchObject({ ownedElsewhere: 0, failed: 0 });
      const freshCallbacks = standbyRuntime.configurations.get(
        endpoint.id,
      )?.callbacks;
      if (!freshCallbacks?.onReaction) {
        throw new Error("Expected standby Discord callbacks");
      }
      const [leaseAfterTakeover] = await db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
          ),
        );
      expect(leaseAfterTakeover?.token).toBeTruthy();
      expect(leaseAfterTakeover?.token).not.toBe(leaseBeforeTakeover.token);

      releaseOldCallbacks();
      await Promise.all([staleMessage, staleReaction]);
      await expect(
        db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              or(
                eq(
                  chatDeliveries.providerEventId,
                  `${channel.thread.id}:${messageId}`,
                ),
                and(
                  eq(chatDeliveries.eventKind, "reaction_added"),
                  sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${rootMessageId}`,
                ),
              ),
            ),
          ),
      ).resolves.toEqual([]);
      await vi.waitFor(() => {
        expect(staleRuntime.shutdown).toHaveBeenCalledOnce();
      });

      await deliverMessage({
        callbacks: freshCallbacks,
        endpointId: endpoint.id,
        provider: "discord",
        thread: channel.thread,
        message: bufferedMessage,
        trigger: "subscribed_message",
      });
      await freshCallbacks.onReaction(reaction);
      await deliverMessage({
        callbacks: freshCallbacks,
        endpointId: endpoint.id,
        provider: "discord",
        thread: channel.thread,
        message: bufferedMessage,
        trigger: "subscribed_message",
      });
      await freshCallbacks.onReaction(reaction);

      await expect(
        db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(
                chatDeliveries.providerEventId,
                `${channel.thread.id}:${messageId}`,
              ),
            ),
          ),
      ).resolves.toEqual([{ state: "processed" }]);
      await expect(
        db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.eventKind, "reaction_added"),
              sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${rootMessageId}`,
            ),
          ),
      ).resolves.toEqual([{ state: "processed" }]);
      expect(
        await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.companyId, fixture.companyId))
          .then((rows) => rows.length),
      ).toBe(commentCountBefore + 1);
      expect(owner.wakeup).toHaveBeenCalledTimes(wakeupCountBefore);
      expect(standby.wakeup).toHaveBeenCalledOnce();
    } finally {
      releaseOldCallbacks();
      await Promise.allSettled([staleMessage, staleReaction]);
      await Promise.allSettled([
        owner.service.shutdown(),
        standby.service.shutdown(),
      ]);
    }
  });

  it("releases Discord ownership when runtime construction fails", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const runtime = new FakeChatSdkRuntime();
    runtime.initializeHook = async () => {
      throw new Error("constructor failed");
    };
    const { service } = createService(
      runtime,
      fakeDiscordFetch(applicationId) as typeof globalThis.fetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await expect(
      service.configure(
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
      ),
    ).rejects.toThrow("constructor failed");
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
    ).resolves.toEqual([]);
    await service.shutdown();
  });

  it("serializes Discord Gateway health events and recovers transient guild outages", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    let releaseDisconnect!: () => void;
    let disconnectEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      disconnectEntered = resolve;
    });
    const disconnectBarrier = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    const runtime = new FakeChatSdkRuntime();
    const context = createService(
      runtime,
      fakeDiscordFetch(applicationId) as typeof globalThis.fetch,
      {
        discordGatewayEventBarrier: async (callback) => {
          if (callback.event.type !== "disconnected") return;
          disconnectEntered();
          await disconnectBarrier;
        },
      },
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
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
    const setup = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id))
      .then((rows) => rows[0]!.setup);
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { ...setup, step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));
    const onGatewayEvent = runtime.configurations.get(endpoint.id)?.callbacks
      .onDiscordGatewayEvent;
    if (!onGatewayEvent) throw new Error("Expected Discord Gateway callback");

    const recovered = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.chatPublications, recovered);
    const disconnect = Promise.resolve(
      onGatewayEvent({
        endpointId: endpoint.id,
        provider: "discord",
        sequence: 1,
        event: { type: "disconnected", fatal: false, code: 1001 },
      }),
    );
    await entered;
    let recoveryFinished = false;
    const recovery = Promise.resolve(
      onGatewayEvent({
        endpointId: endpoint.id,
        provider: "discord",
        sequence: 2,
        event: { type: "ready" },
      }),
    ).then(() => {
      recoveryFinished = true;
    });
    await Promise.resolve();
    expect(recoveryFinished).toBe(false);
    releaseDisconnect();
    try {
      await Promise.all([disconnect, recovery]);
      expect(recovered).toHaveBeenCalled();
    } finally { unsubscribe(); }
    await expect(context.service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: "Connected",
    });

    await onGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 3,
      event: {
        type: "guild_unavailable",
        guildId: "1457808928258658549",
      },
    });
    await expect(context.service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: expect.stringContaining("temporarily unavailable"),
    });
    await onGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 4,
      event: {
        type: "guild_available",
        guildId: "1457808928258658549",
      },
    });
    await expect(context.service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: "Connected",
    });
    await context.service.shutdown();
  });

  it("does not let pause overtake a credential-fenced Discord root thread creation", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    let releaseTransport!: () => void;
    let transportEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      transportEntered = resolve;
    });
    const transportBarrier = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(
      runtime,
      fakeDiscordFetch(applicationId) as typeof globalThis.fetch,
      {
        discordRootThreadTransportBarrier: async () => {
          transportEntered();
          await transportBarrier;
        },
        scheduleDeferredWork: () => undefined,
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
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
    const setup = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id))
      .then((rows) => rows[0]!.setup);
    await db
      .update(chatEndpoints)
      .set({
        allowUnlinkedPeople: true,
        status: "active",
        setup: { ...setup, step: "complete" },
      })
      .where(eq(chatEndpoints.id, endpoint.id));
    await db
      .update(chatEndpointResources)
      .set({ enabled: true })
      .where(eq(chatEndpointResources.endpointId, endpoint.id));

    const admission = runtime.configurations.get(endpoint.id)?.callbacks
      .onDiscordRootMentionAdmission;
    if (!admission) throw new Error("Expected Discord admission callback");
    const ownedRuntime = runtime.endpoints.get(endpoint.id);
    if (!ownedRuntime)
      throw new Error("Expected Discord Gateway owner runtime");
    const messageId = "555555555555555590";
    const threadId = `discord:1457808928258658549:333333333333333333:${messageId}`;
    const message = {
      ...makeMessage({
        id: messageId,
        mentioned: true,
        text: "@maya serialize this root",
        userId: "444444444444444444",
      }),
      threadId,
    } as Message;
    const admitting = Promise.resolve(
      admission({
        channelId: "333333333333333333",
        endpointId: endpoint.id,
        guildId: "1457808928258658549",
        message,
        messageId,
        threadId,
        userId: "444444444444444444",
      }),
    );
    await entered;

    let pauseSettled = false;
    const pausing = service
      .configure(endpoint.id, { action: "pause" }, "owner-user")
      .then((result) => {
        pauseSettled = true;
        return result;
      });
    await Promise.resolve();
    expect(pauseSettled).toBe(false);
    releaseTransport();
    await expect(admitting).resolves.toBe(false);
    await expect(pausing).resolves.toMatchObject({ status: "paused" });
    expect(ownedRuntime.ensuredDiscordRootThreads).toEqual([
      {
        channelId: "333333333333333333",
        content: "@maya serialize this root",
        messageId,
      },
    ]);
    expect(runtime.configurations.get(endpoint.id)?.enableDiscordGateway).toBe(
      true,
    );
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await service.shutdown();
  });
});
