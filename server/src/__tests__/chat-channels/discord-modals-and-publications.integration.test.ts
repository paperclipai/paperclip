import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { beforeAll, expect, it, vi } from "vitest";
import { assets, authUsers, chatActions, chatDeliveries, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatPublications, chatSdkState, companyMemberships, heartbeatRuns, issueComments, issueAttachments, issueWorkProducts, issueQuestionResponseDeliveries, issueThreadInteractions, issues, toolConnections } from "@paperclipai/db";
import type { Attachment, Message, Thread } from "chat";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { createDiscordAdapter } from "@chat-adapter/discord";
import * as discordQuestionForms from "../../services/chat-discord-question-forms.js";
import { issueService } from "../../services/issues.js";
import { PaperclipRunnerToolAuthority } from "../../services/native-runtime/paperclip-runner-tool-authority.js";
import { NativeChatAttachmentReadScope } from "../../services/native-runtime/chat-attachment-read.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { enqueueChatRunMilestones, resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { projectSafeChatPublicationText } from "../../services/chat-publication-projection.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, fakeDiscordFetch, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";

describeEmbeddedPostgres("chat channels: discord modals and publications", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const { seedCompany, readChatConversationsByEndpointId, readChatEndpointsById, readChatDeliveriesByEndpointId, readChatDeliveriesById, readHeartbeatRunsById, readChatPublicationsById, readToolConnectionsById, readChatPublicationsByCommentId, readChatActionsByProviderActionId, readChatPublicationsByIdempotencyKey, createService, createStorageService, retirePublicationFixture, chatWakeContext, addSelectedChatFinal, qualifySetupRoundTrip, configuredDiscordEndpoint, deliverMessage } = h;

  it("imports every Discord upload when text files include MIME parameters", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, service, wakeup } =
      await configuredDiscordEndpoint(fixture, { storage: storage.storage });
    const textBody = Buffer.from("multi-file Discord text", "utf8");
    const imageBody = Buffer.from("multi-file Discord image", "utf8");
    const textFetch = vi.fn(async () => textBody);
    const imageFetch = vi.fn(async () => imageBody);
    const rejectedFetch = vi.fn(async () => Buffer.from("not imported"));
    const rootMessageId = "555555555555555596";
    const channel = makeThread({
      channelId: "333333333333333329",
      id: `discord:1457808928258658549:333333333333333329:${rootMessageId}`,
      name: "discord-multi-upload",
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: makeMessage({
        attachments: [
          {
            type: "file",
            name: "native-inbound.txt",
            mimeType: "text/plain; charset=utf-8",
            size: textBody.length,
            fetchData: textFetch,
            fetchMetadata: { testRecoveryKey: "discord-multi-text" },
          } as Attachment,
          {
            type: "image",
            name: "native-inbound.png",
            mimeType: "image/png",
            size: imageBody.length,
            fetchData: imageFetch,
            fetchMetadata: { testRecoveryKey: "discord-multi-image" },
          } as Attachment,
          {
            type: "file",
            name: "unsupported.exe",
            mimeType: "application/x-msdownload",
            size: 12,
            fetchData: rejectedFetch,
          } as Attachment,
        ],
        id: rootMessageId,
        mentioned: true,
        text: "@maya inspect both files",
      }),
      trigger: "mention",
    });

    expect(textFetch).toHaveBeenCalledTimes(1);
    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(rejectedFetch).not.toHaveBeenCalled();
    expect(storage.putFile).toHaveBeenCalledTimes(2);
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery).toMatchObject({
      state: "processed",
      redactedError: "1 external attachment was omitted (unsupported type: 1)",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]?.contextSnapshot).toMatchObject({
      externalAttachmentOmissions: [
        {
          commentId: expect.any(String),
          reasons: { unsupported_type: 1 },
        },
      ],
    });
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Discord upload conversation");
    await expect(
      db
        .select({
          contentType: assets.contentType,
          originalFilename: assets.originalFilename,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
        .where(eq(issueAttachments.issueId, conversation.issueId))
        .orderBy(asc(assets.originalFilename)),
    ).resolves.toEqual([
      {
        contentType: "image/png",
        originalFilename: "native-inbound.png",
      },
      {
        contentType: "text/plain",
        originalFilename: "native-inbound.txt",
      },
    ]);
  });

  it("audits repeated Discord reaction cycles while deduplicating an exact Gateway replay", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredDiscordEndpoint(fixture);
    const rootMessageId = "555555555555555597";
    const channel = makeThread({
      channelId: "333333333333333330",
      id: `discord:1457808928258658549:333333333333333330:${rootMessageId}`,
      name: "discord-reaction-cycles",
    });
    const original = makeMessage({
      id: rootMessageId,
      mentioned: true,
      text: "@maya observe repeated reactions",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: original,
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    if (!callbacks.onReaction) {
      throw new Error("Discord reaction callback was not registered");
    }
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected Discord conversation");
    const commentCountBefore = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .then((rows) => rows.length);
    const wakeupCountBefore = wakeup.mock.calls.length;
    const emoji = {
      name: "thumbsup",
      toJSON: () => "👍",
      toString: () => "👍",
    };
    const reaction = (
      added: boolean,
      sessionFingerprint: string,
      sequence: number,
    ) => ({
      endpointId: endpoint.id,
      provider: "discord" as const,
      event: {
        adapter: {} as never,
        added,
        emoji,
        message: original,
        messageId: original.id,
        raw: {
          channel_id: "333333333333333330",
          emoji: { id: null, name: "👍" },
          gateway_dispatch: {
            eventType: added
              ? "MESSAGE_REACTION_ADD"
              : "MESSAGE_REACTION_REMOVE",
            sequence,
            sessionFingerprint,
            shardId: 0,
          },
          guild_id: "1457808928258658549",
          message_id: original.id,
          user_id: original.author.userId,
        },
        rawEmoji: "👍",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: original.author,
      },
    });
    const firstSession = "a".repeat(24);
    const nextSession = "b".repeat(24);

    await callbacks.onReaction(reaction(true, firstSession, 42));
    await callbacks.onReaction(reaction(true, firstSession, 42));
    await callbacks.onReaction(reaction(false, firstSession, 43));
    await callbacks.onReaction(reaction(true, firstSession, 44));
    await callbacks.onReaction(reaction(false, firstSession, 45));
    await callbacks.onReaction(reaction(true, nextSession, 42));

    const reactions = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.conversationId, conversation.id))
      .then((rows) =>
        rows.filter((row) => row.eventKind.startsWith("reaction_")),
      );
    expect(reactions).toHaveLength(5);
    expect(new Set(reactions.map((row) => row.providerEventId)).size).toBe(5);
    expect(reactions.map((row) => row.eventKind).sort()).toEqual([
      "reaction_added",
      "reaction_added",
      "reaction_added",
      "reaction_removed",
      "reaction_removed",
    ]);
    expect(reactions.every((row) => row.state === "processed")).toBe(true);
    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId)),
    ).resolves.toHaveLength(commentCountBefore);
    expect(wakeup.mock.calls).toHaveLength(wakeupCountBefore);
    await service.shutdown();
  });

  it("durably audits a rejected Discord Gateway action before surfacing transport rejection", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredDiscordEndpoint(fixture);
    let pinned: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
    try {
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpoint.id));
      if (!callbacks.onAction)
        throw new Error("Discord action callback was not registered");
      const configuration = runtime.configurations.get(endpoint.id)!;
      const observedErrors: string[] = [];
      const onAction = vi.fn(
        async (
          event: Parameters<NonNullable<typeof callbacks.onAction>>[0],
        ) => {
          try {
            await callbacks.onAction!(event);
          } catch (error) {
            observedErrors.push(String((error as { code?: unknown }).code));
            throw error;
          }
        },
      );
      pinned = createChatSdkEndpointRuntime({
        ...configuration,
        callbacks: { onMessage() {}, onAction },
        enableDiscordGateway: false,
        logger: "silent",
      });
      await pinned.initialize();
      const applicationId =
        configuration.providerConfig.provider === "discord"
          ? configuration.providerConfig.credentials.applicationId
          : undefined;
      const gatewayInteraction = {
        applicationId,
        channel: {
          id: "555555555555555598",
          parentId: "333333333333333333",
          type: 11,
        },
        channelId: "555555555555555598",
        componentType: 2,
        customId: "pcq:forged-discord-action\nforged-value",
        deferUpdate: vi.fn().mockResolvedValue(undefined),
        guildId: "1457808928258658549",
        id: "777777777777777710",
        isChatInputCommand: () => false,
        isMessageComponent: () => true,
        message: { id: "555555555555555597" },
        reply: vi.fn(async () => {
          const rows = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(chatDeliveries.eventKind, "action"),
              ),
            );
          expect(rows).toHaveLength(1);
          expect(rows[0]?.state).toBe("filtered");
        }),
        token: "synthetic-interaction-token",
        type: 3,
        user: {
          id: "444444444444444444",
          username: "discord-user",
          globalName: "Discord User",
          bot: false,
        },
        version: 1,
      };
      const adapter = pinned.getProviderAdapter() as unknown as {
        handleGatewayInteraction(
          event: typeof gatewayInteraction,
        ): Promise<void>;
      };
      const priorWakeups = wakeup.mock.calls.length;
      // Repeat one synthetic Gateway delivery. These are response attempts,
      // not proof that Discord accepts two replies to one interaction token.
      await adapter.handleGatewayInteraction(gatewayInteraction);
      await adapter.handleGatewayInteraction(gatewayInteraction);
      expect(onAction).toHaveBeenCalledTimes(2);
      expect(onAction.mock.calls[0]![0].event.raw).not.toHaveProperty(
        "deferUpdate",
      );
      expect(wakeup.mock.calls).toHaveLength(priorWakeups);

      const denials = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "action"),
          ),
        );
      expect(denials).toEqual([
        expect.objectContaining({
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
      expect(JSON.stringify(denials)).not.toContain(
        "pcq:forged-discord-action",
      );
      expect({
        errors: observedErrors,
        successAcknowledgements:
          gatewayInteraction.deferUpdate.mock.calls.length,
        rejectionReplies: gatewayInteraction.reply.mock.calls.length,
      }).toEqual({
        errors: [
          "chat_discord_gateway_action_rejected",
          "chat_discord_gateway_action_rejected",
        ],
        successAcknowledgements: 0,
        rejectionReplies: 2,
      });
      expect(gatewayInteraction.reply).toHaveBeenLastCalledWith({
        content:
          "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
        flags: 64,
      });
    } finally {
      await pinned?.shutdown();
      await service.shutdown();
    }
  });

  it("retires a Discord receipt after terminal failure without letting an add retry resurrect it", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredDiscordEndpoint(fixture, {
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    try {
      const guildId = "1457808928258658549";
      const channelId = "333333333333333333";
      const rootMessageId = "555555555555555609";
      const externalUserId = "444444444444444409";
      const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
      const thread = makeThread({
        channelId,
        id: threadId,
        name: "discord-terminal-receipt",
      });
      const admitRootMention = callbacks.onDiscordRootMentionAdmission;
      if (!admitRootMention) {
        throw new Error("Expected Discord root-mention admission callback");
      }
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      if (!providerRuntime) throw new Error("Expected Discord runtime");
      providerRuntime.reactionErrors.push(
        Object.assign(new Error("Discord receipt rate limited"), {
          status: 429,
          retryAfterMs: 60_000,
        }),
      );

      await expect(
        admitRootMention({
          endpointId: endpoint.id,
          guildId,
          channelId,
          messageId: rootMessageId,
          message: {
            ...makeMessage({
              id: rootMessageId,
              text: "@maya demonstrate terminal receipt cleanup",
              mentioned: true,
              userId: externalUserId,
            }),
            threadId,
          } as Message,
          threadId,
          userId: externalUserId,
        }),
      ).resolves.toBe(false);
      const [delivery] = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.providerEventId, `${threadId}:${rootMessageId}`),
          ),
        );
      if (!delivery) throw new Error("Expected Discord root delivery");
      await service.processPendingDeliveries(25, delivery.id);
      expect(providerRuntime.reactions).toHaveLength(0);
      const [addAction] = await readChatActionsByProviderActionId(`receipt_reaction:${delivery.id}`);
      expect(addAction).toMatchObject({
        status: "failed",
        result: {
          attempts: 1,
          code: "receipt_reaction_retry",
          retryable: true,
        },
      });
      deferred.length = 0;
      providerRuntime.removeReactionErrors.push(
        Object.assign(new Error("connection reset before response"), {
          code: "ECONNRESET",
          name: "NetworkError",
        }),
      );

      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected Discord conversation");
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "failed",
        errorCode: "low_trust_isolation_unavailable",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider: "discord",
          providerMessageId: rootMessageId,
        }),
      });
      await expect(
        enqueueChatRunMilestones(db, {
          publicBaseUrl: "https://paperclip.example",
        }),
      ).resolves.toBe(1);
      await service.processPendingPublications(1_000);

      const [failedPublication] = await readChatPublicationsByIdempotencyKey(`run:${runId}:failed:${endpoint.id}`);
      expect(failedPublication).toMatchObject({
        state: "published",
        payload: {
          progressState: "failed",
          text: expect.stringContaining("couldn't safely start this turn"),
        },
      });
      expect(
        providerRuntime.posts.filter((post) =>
          post.text.includes("couldn't safely start this turn"),
        ),
      ).toHaveLength(1);
      expect(wakeup).toHaveBeenCalledTimes(1);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, addAction.id)),
      ).resolves.toEqual([
        {
          status: "cancelled",
          result: {
            attempts: 1,
            code: "receipt_reaction_superseded_by_terminal_publication",
          },
        },
      ]);

      expect(deferred).toHaveLength(1);
      for (const task of deferred.splice(0)) task();
      let removal: typeof chatActions.$inferSelect | undefined;
      await vi.waitFor(async () => {
        removal = await readChatActionsByProviderActionId(`receipt_reaction_remove:${delivery.id}`)
          .then((rows) => rows[0]);
        expect(removal?.status).toBe("failed");
      });
      if (!removal) throw new Error("Expected Discord receipt removal");
      expect(removal).toMatchObject({
        payload: {
          operation: "remove",
          threadId,
          messageId: rootMessageId,
          reaction: "eyes",
        },
        result: {
          attempts: 1,
          code: "receipt_reaction_removal_delivery_unknown",
          retryable: true,
        },
      });

      // Even if a stale scheduler presents the old add as retryable after the
      // terminal marker commits, it must be cancelled before provider I/O.
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: {
            attempts: 1,
            retryable: true,
            retryAt: new Date(0).toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, addAction.id));
      await service.processPendingReceiptReactions(1, addAction.id);
      expect(providerRuntime.reactions).toHaveLength(0);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, addAction.id)),
      ).resolves.toEqual([
        {
          status: "cancelled",
          result: {
            attempts: 1,
            code: "receipt_reaction_superseded_by_terminal_publication",
          },
        },
      ]);

      await db
        .update(chatActions)
        .set({
          result: {
            ...removal.result,
            retryAt: new Date(0).toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, removal.id));
      await service.processPendingReceiptReactions(1, removal.id);
      await service.processPendingReceiptReactions(1, removal.id);
      expect(providerRuntime.removedReactions).toEqual([
        { threadId, messageId: rootMessageId, emoji: "eyes" },
      ]);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, removal.id)),
      ).resolves.toEqual([
        {
          status: "processed",
          result: { attempts: 2 },
        },
      ]);
    } finally {
      await service.shutdown();
    }
  });

  it("composes a parsed Discord question answer with one same-thread continuation publication", async () => {
    const fixture = await seedCompany();
    const continuationRunId = randomUUID();
    let continuationWakeCount = 0;
    const { callbacks, endpoint, runtime, service } =
      await configuredDiscordEndpoint(fixture, {
        wakeup: async (agentId, options) => {
          if (options.contextSnapshot?.source !== "issue.interaction.respond") {
            return { accepted: true };
          }
          continuationWakeCount += 1;
          // The runner is outside this provider/control-plane composition.
          // Seed only its synthetic result, never claim a real model turn.
          const [created] = await db
            .insert(heartbeatRuns)
            .values({
              id: continuationRunId,
              companyId: fixture.companyId,
              agentId,
              status: "succeeded",
              contextSnapshot: options.contextSnapshot,
            })
            .onConflictDoNothing()
            .returning();
          return (
            created ??
            readHeartbeatRunsById(continuationRunId)
              .then((rows) => rows[0])
          );
        },
      });
    let pinned: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
    let threadSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const guildId = "1457808928258658549";
      const channelId = "333333333333333333";
      const rootMessageId = "555555555555555610";
      const externalUserId = "444444444444444410";
      const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
      const channel = makeThread({
        channelId,
        id: threadId,
        name: "discord-native-question",
      });
      const admitRootMention = callbacks.onDiscordRootMentionAdmission;
      if (!admitRootMention || !callbacks.onAction) {
        throw new Error("Expected Discord root and action callbacks");
      }
      await expect(
        admitRootMention({
          endpointId: endpoint.id,
          guildId,
          channelId,
          messageId: rootMessageId,
          message: {
            ...makeMessage({
              id: rootMessageId,
              text: "@maya help me choose a priority",
              mentioned: true,
              userId: externalUserId,
            }),
            threadId,
          } as Message,
          threadId,
          userId: externalUserId,
        }),
      ).resolves.toBe(false);
      const [rootDelivery] = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.providerEventId, `${threadId}:${rootMessageId}`),
          ),
        );
      if (!rootDelivery) throw new Error("Expected Discord root delivery");
      await service.processPendingDeliveries(25, rootDelivery.id);
      await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
      await service.test(endpoint.id);
      const activeEndpoint = await service.get(endpoint.id);
      if (!activeEndpoint.providerAccountId) {
        throw new Error("Expected Discord provider account identity");
      }
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected Discord conversation");

      const linkedUserId = `discord-question-user-${randomUUID()}`;
      const now = new Date();
      await db.insert(authUsers).values({
        id: linkedUserId,
        name: "Discord Question User",
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
            eq(chatExternalPrincipals.provider, "discord"),
            eq(
              chatExternalPrincipals.providerAccountId,
              activeEndpoint.providerAccountId,
            ),
            eq(chatExternalPrincipals.externalId, externalUserId),
          ),
        )
        .then((rows) => rows[0]);
      if (!principal) throw new Error("Expected Discord external principal");
      const intent = await service.createLinkIntent(
        endpoint.id,
        principal.id,
        1_800,
      );
      const linkToken = new URL(intent.confirmationUrl).searchParams.get(
        "token",
      );
      if (!linkToken) throw new Error("Discord identity token was absent");
      await service.confirmIdentityLink(linkToken, linkedUserId);

      const configuration = runtime.configurations.get(endpoint.id)!;
      const onAction = vi.fn(callbacks.onAction);
      pinned = createChatSdkEndpointRuntime({
        ...configuration,
        callbacks: { onMessage() {}, onAction },
        enableDiscordGateway: false,
        logger: "silent",
      });
      await pinned.initialize();
      const parsedAdapter = pinned.getProviderAdapter() as unknown as {
        buildMessagePayload(message: unknown): {
          payload: Record<string, unknown>;
        };
        handleGatewayInteraction(event: unknown): Promise<void>;
      };
      const providerRuntime = runtime.endpoints.get(endpoint.id)!;
      const renderedPayloads: Record<string, unknown>[] = [];
      const originalThread = providerRuntime.thread.bind(providerRuntime);
      threadSpy = vi
        .spyOn(providerRuntime, "thread")
        .mockImplementation((id) => {
          const original = originalThread(id);
          return {
            ...original,
            post: async (message: Parameters<typeof original.post>[0]) => {
              renderedPayloads.push(
                parsedAdapter.buildMessagePayload(message).payload,
              );
              return original.post(message);
            },
          };
        });

      const sourceRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: sourceRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: conversation.issueId,
          taskId: conversation.issueId,
          source: "automation",
        },
      });
      const interaction = await issueThreadInteractionService(db).create(
        { id: conversation.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          sourceRunId,
          title: "Choose the priority",
          payload: {
            version: 1,
            title: "Choose the priority",
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
        { agentId: fixture.assignedAgentId, runId: sourceRunId },
      );
      await service.processPendingPublications(1_000);
      const questionPublication = await db
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
      if (!questionPublication?.providerMessageId) {
        throw new Error("Discord question publication was not delivered");
      }
      const highAction = questionPublication.payload.card?.actions?.find(
        (candidate) =>
          candidate.type === "callback" && candidate.label === "High",
      );
      if (!highAction || highAction.type !== "callback") {
        throw new Error("Discord question callback was not projected");
      }

      const findHighButton = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.flatMap(findHighButton);
        if (!value || typeof value !== "object") return [];
        const object = value as Record<string, unknown>;
        return [
          ...(object.label === "High" && typeof object.custom_id === "string"
            ? [object.custom_id]
            : []),
          ...Object.values(object).flatMap(findHighButton),
        ];
      };
      const customIds = renderedPayloads.flatMap(findHighButton);
      expect(customIds).toEqual([`${highAction.actionId}\n${interaction.id}`]);
      const applicationId =
        configuration.providerConfig.provider === "discord"
          ? configuration.providerConfig.credentials.applicationId
          : undefined;
      const click = (id: string) => ({
        applicationId,
        channel: { id: rootMessageId, parentId: channelId, type: 11 },
        channelId: rootMessageId,
        componentType: 2,
        customId: customIds[0],
        deferUpdate: vi.fn().mockResolvedValue(undefined),
        guildId,
        id,
        isChatInputCommand: () => false,
        isMessageComponent: () => true,
        message: { id: questionPublication.providerMessageId },
        reply: vi.fn().mockResolvedValue(undefined),
        token: "synthetic-interaction-token",
        type: 3,
        user: {
          id: externalUserId,
          username: "discord-user",
          globalName: "Discord User",
          bot: false,
        },
        version: 1,
      });
      const first = click("777777777777777711");
      const concurrent = click("777777777777777712");
      await Promise.all([
        parsedAdapter.handleGatewayInteraction(first),
        parsedAdapter.handleGatewayInteraction(concurrent),
      ]);
      expect(onAction).toHaveBeenCalledTimes(2);
      expect(onAction.mock.calls[0]![0]).toMatchObject({
        endpointId: endpoint.id,
        provider: "discord",
        transport: "discord_gateway",
        event: {
          actionId: highAction.actionId,
          value: interaction.id,
          threadId,
        },
      });
      expect(onAction.mock.calls[0]![0].event.raw).not.toHaveProperty(
        "deferUpdate",
      );
      expect(first.deferUpdate).toHaveBeenCalledOnce();
      expect(concurrent.deferUpdate).toHaveBeenCalledOnce();
      expect(first.reply).not.toHaveBeenCalled();
      expect(concurrent.reply).not.toHaveBeenCalled();
      await service.processPendingPublications(1_000);

      const [storedInteraction] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interaction.id));
      expect(storedInteraction).toMatchObject({
        status: "answered",
        resolvedByUserId: linkedUserId,
        result: {
          version: 1,
          answers: [{ questionId: "priority", optionIds: ["high"] }],
        },
      });
      let resolutionPublication:
        typeof chatPublications.$inferSelect | undefined;
      await vi.waitFor(async () => {
        resolutionPublication = await db
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
        expect(resolutionPublication?.state).toBe("published");
      });
      expect(resolutionPublication).toMatchObject({
        state: "published",
        providerMessageId: questionPublication.providerMessageId,
        payload: {
          interactionId: interaction.id,
          text: "Answered: High.",
          card: {
            kind: "question",
            title: "Which priority should we use?",
            body: "Answered: High.",
          },
        },
      });
      expect(resolutionPublication?.payload.card?.actions).toBeUndefined();
      expect(providerRuntime?.edits).toEqual([
        expect.objectContaining({
          threadId,
          messageId: questionPublication.providerMessageId,
        }),
      ]);
      expect(providerRuntime?.edits[0]?.text).toContain("Answered: High.");

      await vi.waitFor(async () => {
        await expect(
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, continuationRunId)),
        ).resolves.toHaveLength(1);
      });
      expect(continuationWakeCount).toBe(1);
      const presentationAuthorization =
        await resolveChatRunPresentationAuthorizationReason(db, {
          companyId: fixture.companyId,
          issueId: conversation.issueId,
          runId: continuationRunId,
        });
      expect(presentationAuthorization).toBe("allow_chat_run_presentation");
      const exactMarker = "DISCORD-PRIORITY-HIGH";
      const continuationComment = await issueService(db).addComment(
        conversation.issueId,
        exactMarker,
        { agentId: fixture.assignedAgentId, runId: continuationRunId },
        {
          authorType: "agent",
          authorizationReason: presentationAuthorization,
        },
      );
      await service.processPendingPublications(1_000);
      await expect(
        readChatPublicationsByCommentId(continuationComment.id),
      ).resolves.toEqual([
        expect.objectContaining({
          endpointId: endpoint.id,
          conversationId: conversation.id,
          state: "published",
          payload: expect.objectContaining({ text: exactMarker }),
        }),
      ]);
      expect(providerRuntime?.posts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId, text: exactMarker }),
        ]),
      );
      // A late delivery of this resolved action is idempotent at the service
      // boundary; it must not create a second continuation or final reply.
      const late = click("777777777777777713");
      await parsedAdapter.handleGatewayInteraction(late);
      await service.processPendingPublications(1_000);
      expect(late.deferUpdate).toHaveBeenCalledOnce();
      expect(late.reply).not.toHaveBeenCalled();
      expect(continuationWakeCount).toBe(1);
      expect(
        providerRuntime.posts.filter((post) => post.text === exactMarker),
      ).toHaveLength(1);
    } finally {
      threadSpy?.mockRestore();
      await pinned?.shutdown();
      await service.shutdown();
    }
  });

  it.each(["identical", "different"])(
    "opens and corrects an actual Discord modal through current service authority exactly once (%s concurrent answers)",
    async (concurrentMode) => {
      const fixture = await seedCompany();
      let holdConcurrentAnswers = false;
      let answerWaiters = 0;
      let releaseAnswers!: () => void;
      const answersReady = new Promise<void>((resolve) => {
        releaseAnswers = resolve;
      });
      const { callbacks, endpoint, runtime, service, wakeup } =
        await configuredDiscordEndpoint(fixture, {
          questionResolutionPersistBarrier: async () => {
            if (!holdConcurrentAnswers) return;
            if (++answerWaiters === 2) releaseAnswers();
            await answersReady;
          },
        });
      let pinned: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
      let cleanupSpy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const guildId = "1457808928258658549";
        const channelId = "333333333333333333";
        const rootMessageId = "555555555555555615";
        const externalUserId = "444444444444444415";
        const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
        if (
          !callbacks.onDiscordRootMentionAdmission ||
          !callbacks.onAction ||
          !callbacks.onModalSubmit
        )
          throw new Error("Discord callbacks unavailable");
        await callbacks.onDiscordRootMentionAdmission({
          endpointId: endpoint.id,
          guildId,
          channelId,
          messageId: rootMessageId,
          message: {
            ...makeMessage({
              id: rootMessageId,
              text: "@maya collect deployment details",
              mentioned: true,
              userId: externalUserId,
            }),
            threadId,
          } as Message,
          threadId,
          userId: externalUserId,
        });
        const delivery = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(
                chatDeliveries.providerEventId,
                `${threadId}:${rootMessageId}`,
              ),
            ),
          )
          .then((rows) => rows[0]);
        if (!delivery) throw new Error("Discord delivery absent");
        await service.processPendingDeliveries(25, delivery.id);
        await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
        await service.test(endpoint.id);
        const [conversation] = await service.listConversations(endpoint.id);
        const active = await service.get(endpoint.id);
        if (!conversation || !active.providerAccountId)
          throw new Error("Discord setup incomplete");
        expect(active.capabilities.modals).toBe(true);
        const linkedUserId = `discord-modal-${randomUUID()}`;
        const now = new Date();
        await db.insert(authUsers).values({
          id: linkedUserId,
          name: "Discord Modal Operator",
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
              eq(chatExternalPrincipals.provider, "discord"),
              eq(
                chatExternalPrincipals.providerAccountId,
                active.providerAccountId,
              ),
              eq(chatExternalPrincipals.externalId, externalUserId),
            ),
          )
          .then((rows) => rows[0]);
        if (!principal) throw new Error("Discord principal absent");
        const intent = await service.createLinkIntent(
          endpoint.id,
          principal.id,
          1800,
        );
        const linkToken = new URL(intent.confirmationUrl).searchParams.get(
          "token",
        )!;
        await service.confirmIdentityLink(linkToken, linkedUserId);
        const onAction = vi.fn(callbacks.onAction);
        const onModalSubmit = vi.fn(callbacks.onModalSubmit);
        const configuration = runtime.configurations.get(endpoint.id)!;
        pinned = createChatSdkEndpointRuntime({
          ...configuration,
          callbacks: { onMessage() {}, onAction, onModalSubmit },
          enableDiscordGateway: false,
          logger: "silent",
        });
        await pinned.initialize();
        const adapter = pinned.getProviderAdapter() as unknown as {
          handleGatewayInteraction(input: unknown): Promise<void>;
          fetchMessage(...args: unknown[]): Promise<unknown>;
          buildMessagePayload(input: unknown): {
            payload: Record<string, unknown>;
          };
        };
        // Provider HTTP/socket are the only transport doubles; modal source,
        // typed callback, token authorization, answers and wake ledger are real.
        adapter.fetchMessage = vi.fn().mockResolvedValue(null);
        const sourceRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: sourceRunId,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          status: "succeeded",
          contextSnapshot: {
            issueId: conversation.issueId,
            taskId: conversation.issueId,
            source: "automation",
          },
        });
        const interaction = await issueThreadInteractionService(db).create(
          { id: conversation.issueId, companyId: fixture.companyId },
          {
            kind: "ask_user_questions",
            continuationPolicy: "wake_assignee",
            sourceRunId,
            title: "Deployment details",
            payload: {
              version: 1,
              title: "Deployment details",
              questions: [
                {
                  id: "environment",
                  prompt: "Environment",
                  selectionMode: "single",
                  required: true,
                  allowOther: false,
                  options: [
                    { id: "staging", label: "Staging" },
                    { id: "production", label: "Production" },
                  ],
                },
                {
                  id: "note",
                  prompt: "Release note",
                  selectionMode: "single",
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
              questionSet: {
                schema: "paperclip.question_set.v1",
                title: "Deployment details",
                questions: [
                  {
                    id: "environment",
                    prompt: "Environment",
                    required: true,
                    answerMode: "single_select",
                    options: [
                      { id: "staging", label: "Staging" },
                      { id: "production", label: "Production" },
                    ],
                  },
                  {
                    id: "note",
                    prompt: "Release note",
                    required: true,
                    answerMode: "text",
                    textValidation: { minLength: 3, maxLength: 4000 },
                  },
                ],
              },
            },
          },
          { agentId: fixture.assignedAgentId, runId: sourceRunId },
        );
        await service.processPendingPublications(1000);
        const publication = await db
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
        if (!publication?.providerMessageId)
          throw new Error("Discord question not published");
        const open = publication.payload.card?.actions?.find(
          (action) =>
            action.type === "callback" && action.actionId.startsWith("pcf:"),
        );
        if (!open || open.type !== "callback")
          throw new Error("Native Discord form was not projected");
        type NativeModal = {
          custom_id: string;
          title: string;
          components: Array<{
            type: number;
            label: string;
            component: {
              type: number;
              custom_id: string;
              max_length?: number;
              value?: string;
              options?: Array<{
                label: string;
                value: string;
                default?: boolean;
              }>;
            };
          }>;
        };
        const click = (
          customId: string,
          id: string,
          message = publication.providerMessageId!,
        ) => ({
          applicationId: "123456789012345678",
          channel: { id: rootMessageId, parentId: channelId, type: 11 },
          channelId: rootMessageId,
          componentType: 2,
          customId,
          guildId,
          id,
          type: 3,
          version: 1,
          isChatInputCommand: () => false,
          isMessageComponent: () => true,
          isModalSubmit: () => false,
          message: { id: message },
          token: "synthetic-modal-token-never-persist",
          user: {
            id: externalUserId,
            username: "operator",
            globalName: "Operator",
            bot: false,
          },
          showModal: vi
            .fn<(modal: NativeModal) => Promise<void>>()
            .mockResolvedValue(undefined),
          deferUpdate: vi.fn().mockResolvedValue(undefined),
          reply: vi.fn().mockResolvedValue(undefined),
        });
        const first = click(
          `${open.actionId}\n${interaction.id}`,
          "777777777777777720",
        );
        wakeup.mockClear();
        await adapter.handleGatewayInteraction(first);
        expect(first.showModal).toHaveBeenCalledOnce();
        expect(first.deferUpdate).not.toHaveBeenCalled();
        const duplicateOpen = click(
          `${open.actionId}\n${interaction.id}`,
          first.id,
        );
        await adapter.handleGatewayInteraction(duplicateOpen);
        expect(duplicateOpen.showModal).not.toHaveBeenCalled();
        expect(duplicateOpen.deferUpdate).not.toHaveBeenCalled();
        expect(duplicateOpen.reply).not.toHaveBeenCalled();
        const uncertainOpen = click(
          `${open.actionId}\n${interaction.id}`,
          "777777777777777729",
        );
        uncertainOpen.showModal.mockRejectedValue(
          new Error("synthetic lost modal response"),
        );
        await adapter.handleGatewayInteraction(uncertainOpen);
        expect(uncertainOpen.showModal).toHaveBeenCalledOnce();
        expect(uncertainOpen.deferUpdate).not.toHaveBeenCalled();
        const uncertainReplay = click(
          `${open.actionId}\n${interaction.id}`,
          uncertainOpen.id,
        );
        await adapter.handleGatewayInteraction(uncertainReplay);
        expect(uncertainReplay.showModal).not.toHaveBeenCalled();
        expect(uncertainReplay.deferUpdate).not.toHaveBeenCalled();
        expect(uncertainReplay.reply).not.toHaveBeenCalled();
        const modal = first.showModal.mock.calls[0]![0];
        expect(modal.components).toHaveLength(2);
        const select = modal.components.find(
          (field) => field.component.type === 3,
        )!.component;
        const text = modal.components.find(
          (field) => field.component.type === 4,
        )!.component;
        expect(text.max_length).toBe(4000);
        const stagingValue = select.options!.find(
          (option) => option.label === "Staging",
        )!.value;
        const submission = (
          id: string,
          note: string,
          customId = modal.custom_id,
        ) => ({
          ...click(customId, id),
          type: 5,
          isMessageComponent: () => false,
          isModalSubmit: () => true,
          components: [
            {
              type: 18,
              component: {
                type: 3,
                customId: select.custom_id,
                values: [stagingValue],
              },
            },
            {
              type: 18,
              component: { type: 4, customId: text.custom_id, value: note },
            },
          ],
        });
        const invalid = submission("777777777777777721", "");
        await adapter.handleGatewayInteraction(invalid);
        expect(onModalSubmit).toHaveBeenCalledOnce();
        expect(onModalSubmit.mock.calls[0]![0].event.relatedThread?.id).toBe(
          threadId,
        );
        expect(invalid.showModal).not.toHaveBeenCalled();
        expect(invalid.reply).toHaveBeenCalledOnce();
        const correction = invalid.reply.mock.calls[0]![0] as {
          content: string;
          flags: number;
          components: Array<{ components: Array<{ custom_id: string }> }>;
        };
        expect(correction.content).toContain("Release note");
        expect(correction.content).not.toContain(text.custom_id);
        expect(correction.flags).toBe(64);
        const reopenId = correction.components[0]!.components[0]!.custom_id;
        expect(reopenId).toMatch(/^pcfr:[\w-]{43}$/);
        const readState = () =>
          db
            .select()
            .from(chatSdkState)
            .where(eq(chatSdkState.endpointId, endpoint.id));
        const invalidState = await readState();
        expect(JSON.stringify(invalidState)).not.toContain(first.token);
        expect(
          invalidState.filter((row) =>
            row.stateKey.startsWith("discord-question-correction:"),
          ),
        ).toHaveLength(1);

        // The correction button belongs to a different ephemeral message. It
        // must reauthorize the original published source and current actor.
        await db
          .update(companyMemberships)
          .set({ membershipRole: "viewer" })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );
        const denied = click(
          reopenId,
          "777777777777777722",
          "888888888888888888",
        );
        await adapter.handleGatewayInteraction(denied);
        expect(denied.showModal).not.toHaveBeenCalled();
        expect(denied.deferUpdate).not.toHaveBeenCalled();
        expect(denied.reply).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: 64,
            content: expect.stringContaining("no longer available"),
          }),
        );
        await db
          .update(companyMemberships)
          .set({ membershipRole: "operator" })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );
        const wrongThread = click(
          reopenId,
          "777777777777777730",
          "888888888888888888",
        );
        wrongThread.channelId = "555555555555555999";
        wrongThread.channel.id = wrongThread.channelId;
        await adapter.handleGatewayInteraction(wrongThread);
        expect(wrongThread.showModal).not.toHaveBeenCalled();
        expect(wrongThread.deferUpdate).not.toHaveBeenCalled();
        const wrongActor = click(
          reopenId,
          "777777777777777731",
          "888888888888888888",
        );
        wrongActor.user.id = "444444444444444999";
        await adapter.handleGatewayInteraction(wrongActor);
        expect(wrongActor.showModal).not.toHaveBeenCalled();
        await db
          .update(chatPublications)
          .set({ providerMessageId: "999999999999999999" })
          .where(eq(chatPublications.id, publication.id));
        const changedSource = click(
          reopenId,
          "777777777777777732",
          "888888888888888888",
        );
        await adapter.handleGatewayInteraction(changedSource);
        expect(changedSource.showModal).not.toHaveBeenCalled();
        expect(changedSource.deferUpdate).not.toHaveBeenCalled();
        await db
          .update(chatPublications)
          .set({ providerMessageId: publication.providerMessageId })
          .where(eq(chatPublications.id, publication.id));
        const reopened = click(
          reopenId,
          "777777777777777723",
          "888888888888888888",
        );
        await adapter.handleGatewayInteraction(reopened);
        expect(reopened.showModal).toHaveBeenCalledOnce();
        expect(reopened.deferUpdate).not.toHaveBeenCalled();
        const edited = reopened.showModal.mock.calls[0]![0];
        expect(
          edited.components[0]!.component.options?.find(
            (option) => option.default,
          )?.value,
        ).toBe(stagingValue);
        expect(edited.components[1]!.component.value).toBe("");
        expect(edited.custom_id.split(":").slice(0, 2).join(":")).toBe(
          modal.custom_id.split(":").slice(0, 2).join(":"),
        );
        const corrected = submission(
          "777777777777777724",
          "Ship safely",
          edited.custom_id,
        );
        corrected.message.id = "888888888888888888";
        const competingOpen = click(
          `${open.actionId}\n${interaction.id}`,
          "777777777777777734",
        );
        await adapter.handleGatewayInteraction(competingOpen);
        expect(competingOpen.showModal).toHaveBeenCalledOnce();
        const competingText =
          concurrentMode === "identical" ? "Ship safely" : "Ship Friday";
        const competing = submission(
          "777777777777777735",
          competingText,
          competingOpen.showModal.mock.calls[0]![0].custom_id,
        );
        cleanupSpy = vi
          .spyOn(discordQuestionForms, "deleteDiscordQuestionFormCorrection")
          .mockRejectedValueOnce(new Error("synthetic draft cleanup failure"));
        holdConcurrentAnswers = true;
        await Promise.all([
          adapter.handleGatewayInteraction(corrected),
          adapter.handleGatewayInteraction(competing),
        ]);
        expect(answerWaiters).toBe(2);
        expect(cleanupSpy).toHaveBeenCalledTimes(
          concurrentMode === "identical" ? 2 : 1,
        );
        const [answered] = await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, interaction.id));
        const winnerText = (
          answered!.result as {
            answers: Array<{ questionId: string; otherText?: string }>;
          }
        ).answers.find((answer) => answer.questionId === "note")!.otherText!;
        expect(["Ship safely", competingText]).toContain(winnerText);
        for (const [callback, submittedText] of [
          [corrected, "Ship safely"],
          [competing, competingText],
        ] as const) {
          expect(callback.reply).toHaveBeenCalledOnce();
          expect(callback.reply.mock.calls[0]![0].content).toBe(
            submittedText === winnerText
              ? "Your response was received."
              : "This response was not accepted. Open the linked Paperclip task or reopen the question to try again.",
          );
        }
        expect(answered).toMatchObject({
          status: "answered",
          resolvedByUserId: linkedUserId,
          result: {
            answers: [
              { questionId: "environment", optionIds: ["staging"] },
              { questionId: "note", optionIds: [], otherText: winnerText },
            ],
          },
        });
        await vi.waitFor(async () => {
          const [response] = await db
            .select()
            .from(issueQuestionResponseDeliveries)
            .where(
              eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
            );
          expect(response?.status).toBe("fallback_queued");
        });
        const continuationWakeCount = wakeup.mock.calls.filter(
          ([, options]) =>
            options.contextSnapshot?.source === "issue.interaction.respond",
        ).length;
        expect(continuationWakeCount).toBe(1);
        expect(
          (await readState()).filter((row) =>
            row.stateKey.startsWith("discord-question-correction:"),
          ),
        ).toHaveLength(concurrentMode === "identical" ? 0 : 1);
        const duplicate = submission(
          "777777777777777725",
          winnerText,
          edited.custom_id,
        );
        await adapter.handleGatewayInteraction(duplicate);
        expect(
          onModalSubmit.mock.calls.at(-1)![0].event.relatedThread,
        ).toBeUndefined();
        expect(duplicate.reply).toHaveBeenCalledWith(
          expect.objectContaining({ content: "Your response was received." }),
        );
        expect(
          (await readState()).filter((row) =>
            row.stateKey.startsWith("discord-question-correction:"),
          ),
        ).toHaveLength(0);
        expect(
          wakeup.mock.calls.filter(
            ([, options]) =>
              options.contextSnapshot?.source === "issue.interaction.respond",
          ),
        ).toHaveLength(1);
        const differentAnswer = submission(
          "777777777777777733",
          "Ship something else",
          edited.custom_id,
        );
        await adapter.handleGatewayInteraction(differentAnswer);
        expect(differentAnswer.reply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("not accepted"),
            flags: 64,
          }),
        );
        expect(differentAnswer.reply.mock.calls[0]![0]).not.toHaveProperty(
          "components",
        );
        expect(
          wakeup.mock.calls.filter(
            ([, options]) =>
              options.contextSnapshot?.source === "issue.interaction.respond",
          ),
        ).toHaveLength(1);
        const stale = click(
          reopenId,
          "777777777777777726",
          "888888888888888888",
        );
        await adapter.handleGatewayInteraction(stale);
        expect(stale.showModal).not.toHaveBeenCalled();
        expect(stale.deferUpdate).not.toHaveBeenCalled();
        const unknown = submission(
          "777777777777777727",
          "Ship safely",
          `pcfs:${"Z".repeat(22)}:${randomUUID()}`,
        );
        await adapter.handleGatewayInteraction(unknown);
        expect(unknown.reply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("not accepted"),
            flags: 64,
          }),
        );
        expect(unknown.reply.mock.calls[0]![0]).not.toHaveProperty(
          "components",
        );
        // Scheduler is simulated: this proves wake_fallback exactly once, not a
        // model turn or a live Discord login/modal interaction.
      } finally {
        releaseAnswers();
        cleanupSpy?.mockRestore();
        try {
          await pinned?.shutdown();
        } finally {
          await retirePublicationFixture(service, endpoint.id);
        }
      }
    },
  );

  it.each([
    "warm",
    "cold",
    "failed initialization",
    "stale generation",
    "disabled connection",
  ])(
    "automatically enables native modals for an existing Discord endpoint after %s runtime qualification",
    async (mode) => {
      const fixture = await seedCompany();
      const configured = await configuredDiscordEndpoint(fixture);
      const { endpoint } = configured;
      let { runtime, service } = configured;
      try {
        const [current] = await readChatEndpointsById(endpoint.id);
        await db
          .update(chatEndpoints)
          .set({ capabilities: { ...current!.capabilities, modals: false } })
          .where(eq(chatEndpoints.id, endpoint.id));
        const [before] = await readChatEndpointsById(endpoint.id);
        const [connectionBefore] = await readToolConnectionsById(before!.connectionId);
        const resourcesBefore = await db
          .select()
          .from(chatEndpointResources)
          .where(eq(chatEndpointResources.endpointId, endpoint.id));
        const instance = runtime.endpoints.get(endpoint.id);
        if (mode !== "warm") {
          const config = runtime.configurations.get(
            endpoint.id,
          )!.providerConfig;
          if (config.provider !== "discord")
            throw new Error("Discord configuration absent");
          await service.shutdown();
          ({ runtime, service } = createService(
            new FakeChatSdkRuntime(),
            fakeDiscordFetch(
              config.credentials.applicationId,
            ) as typeof globalThis.fetch,
          ));
        }
        let targetInitializations = 0;
        if (mode === "failed initialization")
          runtime.initializeHook = async (initializingEndpointId) => {
            if (initializingEndpointId !== endpoint.id) return;
            targetInitializations += 1;
            throw new Error("synthetic initialization failed");
          };
        if (mode === "stale generation")
          runtime.initializeHook = async (initializingEndpointId) => {
            if (initializingEndpointId !== endpoint.id) return;
            targetInitializations += 1;
            await db
              .update(chatEndpoints)
              .set({
                setup: {
                  ...before!.setup,
                  runtimeGeneration:
                    Number((before!.setup as InternalSetupState).runtimeGeneration ?? 0) + 1,
                } as InternalSetupState,
              })
              .where(eq(chatEndpoints.id, endpoint.id));
          };
        if (mode === "disabled connection")
          runtime.initializeHook = async (initializingEndpointId) => {
            if (initializingEndpointId !== endpoint.id) return;
            targetInitializations += 1;
            await db
              .update(toolConnections)
              .set({ enabled: false })
              .where(eq(toolConnections.id, before!.connectionId));
          };
        await service.reconcileProviderRuntimes();
        if (mode !== "warm" && mode !== "cold")
          expect(targetInitializations).toBe(1);
        const [after] = await readChatEndpointsById(endpoint.id);
        expect(after!.capabilities.modals).toBe(
          mode === "warm" || mode === "cold",
        );
        expect({
          ...after,
          updatedAt: before!.updatedAt,
          capabilities: before!.capabilities,
          ...(mode === "stale generation" ? { setup: before!.setup } : {}),
        }).toEqual(before);
        const [connectionAfter] = await readToolConnectionsById(before!.connectionId);
        expect({
          ...connectionAfter,
          updatedAt: connectionBefore!.updatedAt,
          ...(mode === "disabled connection"
            ? { enabled: connectionBefore!.enabled }
            : {}),
        }).toEqual(connectionBefore);
        expect(
          await db
            .select()
            .from(chatEndpointResources)
            .where(eq(chatEndpointResources.endpointId, endpoint.id)),
        ).toEqual(resourcesBefore);
        if (mode === "warm")
          expect(runtime.endpoints.get(endpoint.id)).toBe(instance);
        if (mode === "warm" || mode === "cold")
          expect(
            runtime.configurations.get(endpoint.id)!.callbacks.onModalSubmit,
          ).toBeTypeOf("function");
      } finally {
        try {
          await service.shutdown();
        } finally {
          await db
            .update(chatEndpoints)
            .set({ status: "paused" })
            .where(eq(chatEndpoints.id, endpoint.id));
        }
      }
    },
  );

  it("orders rapid Discord replies by provider time before waking one task", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, service, wakeup } =
      await configuredDiscordEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    try {
      const guildId = "1457808928258658549";
      const channelId = "333333333333333333";
      const rootMessageId = "555555555555555620";
      const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
      const channel = makeThread({
        channelId,
        id: threadId,
        name: "discord-rapid-replies",
      });
      const admitRootMention = callbacks.onDiscordRootMentionAdmission;
      if (!admitRootMention) {
        throw new Error("Expected Discord root-mention admission callback");
      }
      await expect(
        admitRootMention({
          endpointId: endpoint.id,
          guildId,
          channelId,
          messageId: rootMessageId,
          message: {
            ...makeMessage({
              id: rootMessageId,
              text: "@maya create a queued reply test",
              mentioned: true,
              userId: "444444444444444420",
            }),
            threadId,
          } as Message,
          threadId,
          userId: "444444444444444420",
        }),
      ).resolves.toBe(false);
      const [rootDelivery] = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.providerEventId, `${threadId}:${rootMessageId}`),
          ),
        );
      if (!rootDelivery) throw new Error("Expected Discord root delivery");
      await service.processPendingDeliveries(25, rootDelivery.id);
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected Discord conversation");
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpoint.id));
      wakeup.mockClear();
      deferred.length = 0;

      const providerSentAt = new Date("2026-09-06T22:30:00.000Z");
      const laterReply = makeMessage({
        id: "555555555555555622",
        text: "second rapid Discord reply",
        userId: "444444444444444420",
      });
      laterReply.metadata.dateSent = providerSentAt;
      const earlierReply = makeMessage({
        id: "555555555555555621",
        text: "first rapid Discord reply",
        userId: "444444444444444420",
      });
      earlierReply.metadata.dateSent = providerSentAt;
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "discord",
        thread: channel.thread,
        message: laterReply,
        trigger: "subscribed_message",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "discord",
        thread: channel.thread,
        message: earlierReply,
        trigger: "subscribed_message",
      });
      const rapidIds = [
        `${threadId}:${earlierReply.id}`,
        `${threadId}:${laterReply.id}`,
      ];
      const rapidDeliveries = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            inArray(chatDeliveries.providerEventId, rapidIds),
          ),
        );
      expect(rapidDeliveries).toHaveLength(2);
      expect(rapidDeliveries.every((row) => row.state === "received")).toBe(
        true,
      );
      await db
        .update(chatDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(inArray(chatDeliveries.providerEventId, rapidIds));
      await service.processPendingDeliveries(1_000);

      const comments = await db
        .select({ id: issueComments.id, body: issueComments.body })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, conversation.issueId),
            inArray(issueComments.body, [earlierReply.text, laterReply.text]),
          ),
        )
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
      expect(comments.map((comment) => comment.body)).toEqual([
        earlierReply.text,
        laterReply.text,
      ]);
      expect(wakeup).toHaveBeenCalledTimes(2);
      expect(
        wakeup.mock.calls.map((call) => call[1]?.payload?.wakeCommentId),
      ).toEqual(comments.map((comment) => comment.id));
    } finally {
      await service.shutdown();
    }
  });

  it("delivers oversized Discord Markdown losslessly as one retryable attachment", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredDiscordEndpoint(fixture);
    const guildId = "1457808928258658549";
    const channelId = "333333333333333333";
    const messageId = "555555555555555599";
    const threadId = `discord:${guildId}:${channelId}:${messageId}`;
    const message = {
      ...makeMessage({
        id: messageId,
        text: "@maya send the complete long result",
        mentioned: true,
        userId: "444444444444444444",
      }),
      threadId,
    } as Message;
    const admitRootMention = callbacks.onDiscordRootMentionAdmission;
    if (!admitRootMention)
      throw new Error("Expected Discord root-mention admission callback");

    await expect(
      admitRootMention({
        endpointId: endpoint.id,
        guildId,
        channelId,
        messageId,
        message,
        threadId,
        userId: "444444444444444444",
      }),
    ).resolves.toBe(false);
    const [delivery] = await db
      .select({ id: chatDeliveries.id })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, `${threadId}:${messageId}`),
        ),
      );
    if (!delivery) throw new Error("Expected Discord root delivery");
    await service.processPendingDeliveries(25, delivery.id);
    await qualifySetupRoundTrip(service, endpoint.id, "444444444444444444");
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Discord conversation");

    const source = [
      "## Complete result 🙂",
      "[Open the evidence](https://example.test/evidence?case=discord)",
      `\`\`\`ts\n${"const value = 1;\n".repeat(80)}\`\`\``,
      "@alice ".repeat(180).trim(),
    ].join("\n\n");
    const providerSafeSource = projectSafeChatPublicationText(source);
    const comment = await issueService(db).addComment(
      conversation.issueId,
      source,
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Discord provider runtime");
    providerRuntime.posts.length = 0;
    let transportAttempt = 0;
    providerRuntime.postHook = async () => {
      transportAttempt += 1;
      if (transportAttempt === 1) {
        throw Object.assign(new Error("Discord attachment rate limited"), {
          adapter: "discord",
          status: 429,
          retryAfterMs: 1_000,
        });
      }
    };

    const blocked = await service.publishComment(
      endpoint.id,
      conversation.id,
      comment.id,
    );
    expect(blocked).toMatchObject({ state: "retry" });
    const [afterFailure] = await readChatPublicationsByCommentId(comment.id);
    expect(afterFailure).toMatchObject({
      state: "retry",
      attempts: 1,
      payload: {
        text: providerSafeSource,
        transportPart: {
          count: 1,
          index: 0,
          mode: "discord_markdown_attachment",
        },
      },
    });
    expect(providerRuntime.posts).toHaveLength(0);

    providerRuntime.postHook = undefined;
    await db
      .update(chatPublications)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatPublications.id, afterFailure.id));
    await service.processPendingPublications();

    const [completed] = await readChatPublicationsById(afterFailure.id);
    expect(completed).toMatchObject({ state: "published", attempts: 2 });
    expect(providerRuntime.posts).toHaveLength(1);
    const delivered = providerRuntime.posts[0]!;
    expect(delivered.text).toBe(
      "Paperclip attached the complete response because it exceeds Discord’s message limit.",
    );
    expect(delivered.text).not.toContain("...");
    expect(delivered.files).toHaveLength(1);
    const uploaded = delivered.files?.[0] as {
      data: Buffer;
      filename: string;
      mimeType: string;
    };
    expect(uploaded.filename).toBe("paperclip-response.md");
    expect(uploaded.mimeType).toBe("text/markdown; charset=utf-8");
    expect(Buffer.isBuffer(uploaded.data)).toBe(true);
    // The attachment is lossless after Paperclip's mandatory provider-safety
    // projection (which strips URL query strings before any transport work).
    expect(uploaded.data.toString("utf8")).toBe(providerSafeSource);
    expect(uploaded.data.toString("utf8")).not.toContain("?case=discord");

    providerRuntime.posts.length = 0;
    providerRuntime.edits.length = 0;
    providerRuntime.editAttempts.length = 0;
    const discordLongRunId = randomUUID();
    const replacementCreatedAt = new Date();
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${discordLongRunId}:working:${endpoint.id}`,
      payload: { text: "Working…", progressState: "working" },
      state: "published",
      providerMessageId: "working-message-1",
      createdAt: replacementCreatedAt,
      updatedAt: replacementCreatedAt,
    });
    const [replacementPublication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${discordLongRunId}:completed:${endpoint.id}`,
        payload: { text: providerSafeSource, progressState: "completed" },
        state: "pending",
        createdAt: new Date(replacementCreatedAt.getTime() + 1),
        updatedAt: new Date(replacementCreatedAt.getTime() + 1),
      })
      .returning();
    await service.processPendingPublications();

    const replacementBatch = await db
      .select()
      .from(chatPublications)
      .where(
        sql`${chatPublications.payload}->'transportPart'->>'batchId' = ${replacementPublication.id}`,
      )
      .orderBy(
        sql`(${chatPublications.payload}->'transportPart'->>'index')::int`,
      );
    expect(replacementBatch).toHaveLength(2);
    expect(replacementBatch.map((row) => row.state)).toEqual([
      "published",
      "published",
    ]);
    expect(
      replacementBatch.map((row) => row.payload.transportPart?.mode),
    ).toEqual(["inline", "discord_markdown_attachment"]);
    expect(providerRuntime.editAttempts).toEqual([
      {
        threadId,
        messageId: "working-message-1",
      },
    ]);
    expect(providerRuntime.edits[0]?.text).toBe(
      "This response needs a separate attachment because it exceeds the message limit.",
    );
    expect(providerRuntime.posts).toHaveLength(1);
    expect(providerRuntime.posts[0]?.text).toBe("Complete response attached.");
    const replacementUpload = providerRuntime.posts[0]?.files?.[0] as {
      data: Buffer;
    };
    expect(replacementUpload.data.toString("utf8")).toBe(providerSafeSource);

    providerRuntime.posts.length = 0;
    providerRuntime.edits.length = 0;
    providerRuntime.editAttempts.length = 0;
    const rejectedRunId = randomUUID();
    const rejectedCreatedAt = new Date();
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${rejectedRunId}:working:${endpoint.id}`,
      payload: { text: "Working on the attachment…", progressState: "working" },
      state: "published",
      providerMessageId: "working-message-rejected-attachment",
      createdAt: rejectedCreatedAt,
      updatedAt: rejectedCreatedAt,
    });
    const [rejectedPublication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${rejectedRunId}:completed:${endpoint.id}`,
        payload: { text: providerSafeSource, progressState: "completed" },
        state: "pending",
        createdAt: new Date(rejectedCreatedAt.getTime() + 1),
        updatedAt: new Date(rejectedCreatedAt.getTime() + 1),
      })
      .returning();
    let rejectAttachmentOnce = true;
    providerRuntime.postHook = async () => {
      if (!rejectAttachmentOnce) return;
      rejectAttachmentOnce = false;
      throw Object.assign(new Error("Discord rejected the attachment"), {
        adapter: "discord",
        response: { status: 400 },
        status: 400,
      });
    };
    await service.processPendingPublications();
    providerRuntime.postHook = undefined;

    const rejectedBatch = await db
      .select()
      .from(chatPublications)
      .where(
        sql`${chatPublications.payload}->'transportPart'->>'batchId' = ${rejectedPublication.id}`,
      )
      .orderBy(
        sql`(${chatPublications.payload}->'transportPart'->>'index')::int`,
      );
    expect(rejectedBatch.map((row) => row.state)).toEqual([
      "published",
      "failed",
    ]);
    const definiteFailureNotices = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, fixture.companyId),
          like(
            chatPublications.idempotencyKey,
            `attachment-failure-notice:${rejectedBatch[1]!.id}:%`,
          ),
        ),
      );
    expect(definiteFailureNotices).toHaveLength(1);
    const rejectedAttachmentNotice =
      "Paperclip could not send the response attachment. The complete response remains on its Paperclip task for an operator to retry." +
      ` Open task: https://paperclip.example/issues/${conversation.issueId}`;
    expect(definiteFailureNotices[0]).toMatchObject({
      commentId: null,
      state: "published",
      payload: {
        text: rejectedAttachmentNotice,
      },
    });
    expect(providerRuntime.editAttempts).toEqual([
      {
        threadId,
        messageId: "working-message-rejected-attachment",
      },
    ]);
    expect(providerRuntime.edits[0]?.text).toBe(
      "This response needs a separate attachment because it exceeds the message limit.",
    );
    expect(providerRuntime.posts).toEqual([
      {
        threadId,
        text: rejectedAttachmentNotice,
      },
    ]);
    await service.processPendingPublications();
    expect(providerRuntime.posts).toHaveLength(1);

    const staleNoticeId = randomUUID();
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `attachment-failure-notice:${staleNoticeId}:999:${"a".repeat(64)}`,
      payload: { text: "stale attachment failure notice" },
      state: "pending",
    });
    await service.processPendingPublications();
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `attachment-failure-notice:${staleNoticeId}:999:${"a".repeat(64)}`,
          ),
        ),
    ).resolves.toEqual([{ state: "cancelled" }]);
    expect(providerRuntime.posts).toHaveLength(1);

    const cardKey = `discord-card-not-split:${endpoint.id}`;
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: cardKey,
      payload: {
        text: source,
        card: {
          schema: "paperclip.chat.card.v1",
          kind: "status",
          title: "Long structured card",
        },
      },
      state: "pending",
    });
    await service.processPendingPublications();
    await expect(
      db
        .select({ payload: chatPublications.payload })
        .from(chatPublications)
        .where(like(chatPublications.idempotencyKey, `${cardKey}%`)),
    ).resolves.toEqual([
      {
        payload: expect.not.objectContaining({
          transportPart: expect.anything(),
        }),
      },
    ]);
    expect(providerRuntime.posts.at(-1)?.files).toBeUndefined();

    const ambiguousRunId = randomUUID();
    const ambiguousCreatedAt = new Date();
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${ambiguousRunId}:working:${endpoint.id}`,
      payload: {
        text: "Working on another attachment…",
        progressState: "working",
      },
      state: "published",
      providerMessageId: "working-message-ambiguous-attachment",
      createdAt: ambiguousCreatedAt,
      updatedAt: ambiguousCreatedAt,
    });
    const [ambiguousPublication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${ambiguousRunId}:completed:${endpoint.id}`,
        payload: { text: providerSafeSource, progressState: "completed" },
        state: "pending",
        createdAt: new Date(ambiguousCreatedAt.getTime() + 1),
        updatedAt: new Date(ambiguousCreatedAt.getTime() + 1),
      })
      .returning();
    providerRuntime.postHook = async () => {
      throw Object.assign(new Error("Discord attachment response was lost"), {
        adapter: "discord",
        name: "NetworkError",
      });
    };
    await service.processPendingPublications();
    providerRuntime.postHook = undefined;
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(
          sql`${chatPublications.payload}->'transportPart'->>'batchId' = ${ambiguousPublication.id}`,
        )
        .orderBy(
          sql`(${chatPublications.payload}->'transportPart'->>'index')::int`,
        ),
    ).resolves.toEqual([{ state: "published" }, { state: "delivery_unknown" }]);
    await expect(
      db
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(chatPublications.state, "published"),
            like(
              chatPublications.idempotencyKey,
              "attachment-failure-notice:%",
            ),
          ),
        ),
    ).resolves.toHaveLength(1);
    await service.shutdown();
  });

  it("hands an explicitly bound same-run image to Discord's final native file response", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredDiscordEndpoint(fixture, {
        storage: storage.storage,
      });
    const rootMessageId = "555555555555555710";
    const channel = makeThread({
      channelId: "333333333333333710",
      id: `discord:1457808928258658549:333333333333333710:${rootMessageId}`,
      name: "agent-image",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: makeMessage({
        id: rootMessageId,
        text: "@maya create and show an image",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected Discord conversation");

    const insertRun = async (agentId: string, status = "succeeded") => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId,
        status,
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider: "discord",
          providerMessageId: rootMessageId,
        }),
      });
      return runId;
    };
    const createAgentAttachment = async (
      runId: string,
      agentId: string,
      filename: string,
      body: Buffer,
      contentType = "image/png",
    ) => {
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${conversation.issueId}`,
        originalFilename: filename,
        contentType,
        body,
      });
      return issueService(db).createAttachment({
        issueId: conversation.issueId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: agentId,
        createdByRunId: runId,
      });
    };
    const bindAgentAttachment = (
      runId: string,
      agentId: string,
      body: string,
      attachmentId: string,
      authorizationReason = "allow_self",
    ) =>
      db.transaction((tx) =>
        issueService(tx as unknown as TestDb).addComment(
          conversation.issueId,
          body,
          { agentId, runId },
          {
            attachmentIds: [attachmentId],
            authorType: "agent",
            authorizationReason,
          },
        ),
      );

    const runId = await insertRun(fixture.assignedAgentId, "running");
    const imageBody = Buffer.from("generated cat image", "utf8");
    const selected = await createAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "orange-tabby.png",
      imageBody,
    );
    expect(selected.originatingRunId).toBe(runId);
    const documentBody = Buffer.from("%PDF-1.7 generated report", "utf8");
    const selectedDocument = await createAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "cat-notes.pdf",
      documentBody,
      "application/pdf",
    );
    const unbound = await createAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "private-draft.png",
      Buffer.from("private unbound draft", "utf8"),
    );
    const directBody = Buffer.from("directly selected image", "utf8");
    const directSelectionComment = await issueService(db).addComment(
      conversation.issueId,
      "Recorded a direct upload before final presentation.",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason: "paperclip_runner_protocol" },
    );
    const storedDirect = await storage.storage.putFile({
      companyId: fixture.companyId,
      namespace: `issues/${conversation.issueId}`,
      originalFilename: "direct-selection.png",
      contentType: "image/png",
      body: directBody,
    });
    const directSelection = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      issueCommentId: directSelectionComment.id,
      provider: storedDirect.provider,
      objectKey: storedDirect.objectKey,
      contentType: storedDirect.contentType,
      byteSize: storedDirect.byteSize,
      sha256: storedDirect.sha256,
      originalFilename: storedDirect.originalFilename,
      createdByAgentId: fixture.assignedAgentId,
      createdByRunId: runId,
    });
    expect(directSelection.originatingRunId).toBe(runId);
    await expect(
      db
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `attachment:${directSelection.id}:${endpoint.id}`,
          ),
        ),
    ).resolves.toHaveLength(0);
    const deletedSelectionComment = await issueService(db).addComment(
      conversation.issueId,
      "This selection was withdrawn before upload.",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason: "allow_self" },
    );
    await db
      .update(issueComments)
      .set({ deletedAt: new Date() })
      .where(eq(issueComments.id, deletedSelectionComment.id));
    await expect(
      issueService(db).createAttachment({
        issueId: conversation.issueId,
        issueCommentId: deletedSelectionComment.id,
        provider: "local_disk",
        objectKey: "issues/deleted-parent.png",
        contentType: "image/png",
        byteSize: 14,
        sha256: "7".repeat(64),
        originalFilename: "deleted-parent.png",
        createdByAgentId: fixture.assignedAgentId,
        createdByRunId: runId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.objectKey, "issues/deleted-parent.png")),
    ).resolves.toHaveLength(0);
    const provisionalSelection = await issueService(db).addComment(
      conversation.issueId,
      "Selected the requested cat image for chat delivery.",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason: "internal_agent_write" },
    );
    const selectionComment = await bindAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "Selected the requested cat image for chat delivery.",
      selected.id,
    );
    expect(selectionComment.id).toBe(provisionalSelection.id);
    // A lost HTTP response may make the helper retry the same binding. The
    // retry must reuse the comment and must not fail or duplicate the file.
    const selectionRetry = await bindAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "Selected the requested cat image for chat delivery.",
      selected.id,
    );
    expect(selectionRetry.id).toBe(selectionComment.id);
    const documentSelectionComment = await bindAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "Selected the requested notes for chat delivery.",
      selectedDocument.id,
    );

    const otherRunId = await insertRun(fixture.assignedAgentId);
    const otherRunAttachment = await createAgentAttachment(
      otherRunId,
      fixture.assignedAgentId,
      "other-run.png",
      Buffer.from("other run", "utf8"),
    );
    const otherRunComment = await bindAgentAttachment(
      otherRunId,
      fixture.assignedAgentId,
      "This belongs to another run.",
      otherRunAttachment.id,
    );
    await expect(
      issueService(db).createAttachment({
        issueId: conversation.issueId,
        issueCommentId: otherRunComment.id,
        provider: "local_disk",
        objectKey: "issues/wrong-run-parent.png",
        contentType: "image/png",
        byteSize: 16,
        sha256: "9".repeat(64),
        originalFilename: "wrong-run-parent.png",
        createdByAgentId: fixture.assignedAgentId,
        createdByRunId: runId,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "issue_attachment_parent_run_mismatch" },
    });

    const remintedAttachment = await createAgentAttachment(
      otherRunId,
      fixture.assignedAgentId,
      "reminted-old-run.png",
      Buffer.from("old run provenance", "utf8"),
    );
    if (!remintedAttachment.artifactWorkProductId) {
      throw new Error("Expected upload to create an artifact work product");
    }
    await db
      .update(issueWorkProducts)
      .set({ createdByRunId: runId })
      .where(
        eq(issueWorkProducts.id, remintedAttachment.artifactWorkProductId),
      );
    await expect(
      bindAgentAttachment(
        runId,
        fixture.assignedAgentId,
        "A mutable work-product update cannot change upload provenance.",
        remintedAttachment.id,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "issue_attachment_run_origin_mismatch" },
    });
    const [mutableWorkProduct] = await db
      .select()
      .from(issueWorkProducts)
      .where(
        eq(issueWorkProducts.id, remintedAttachment.artifactWorkProductId),
      );
    if (!mutableWorkProduct) {
      throw new Error("Expected reminted attachment work product");
    }
    await db
      .delete(issueWorkProducts)
      .where(
        eq(issueWorkProducts.id, remintedAttachment.artifactWorkProductId),
      );
    await db.insert(issueWorkProducts).values({
      ...mutableWorkProduct,
      id: randomUUID(),
      createdByRunId: runId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      bindAgentAttachment(
        runId,
        fixture.assignedAgentId,
        "Deleting and recreating metadata cannot change upload provenance.",
        remintedAttachment.id,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "issue_attachment_run_origin_mismatch" },
    });

    const legacyAttachment = await createAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "legacy-without-origin.png",
      Buffer.from("legacy provenance unavailable", "utf8"),
    );
    await db
      .update(issueAttachments)
      .set({ originatingRunId: null })
      .where(eq(issueAttachments.id, legacyAttachment.id));
    await expect(
      bindAgentAttachment(
        runId,
        fixture.assignedAgentId,
        "Legacy attachment provenance fails closed.",
        legacyAttachment.id,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "issue_attachment_run_origin_mismatch" },
    });

    const otherAgentRunId = await insertRun(fixture.replacementAgentId);
    const otherAgentAttachment = await createAgentAttachment(
      otherAgentRunId,
      fixture.replacementAgentId,
      "other-agent.png",
      Buffer.from("other agent", "utf8"),
    );
    await bindAgentAttachment(
      otherAgentRunId,
      fixture.replacementAgentId,
      "This belongs to another agent.",
      otherAgentAttachment.id,
    );

    const authorizationReason =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId,
      });
    expect(authorizationReason).toBe("allow_chat_run_presentation");
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    const response = await issueService(db).addComment(
      conversation.issueId,
      "Here is the requested cat image.",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason },
    );

    await service.processPendingPublications();
    const publications = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.conversationId, conversation.id),
          inArray(chatPublications.commentId, [
            response.id,
            selectionComment.id,
            documentSelectionComment.id,
            directSelectionComment.id,
          ]),
        ),
      )
      .orderBy(asc(chatPublications.createdAt));
    expect(publications).toEqual([
      expect.objectContaining({
        commentId: response.id,
        state: "published",
        payload: { text: "Here is the requested cat image." },
      }),
      expect.objectContaining({
        commentId: directSelectionComment.id,
        state: "published",
        payload: expect.objectContaining({
          attachmentIds: [directSelection.id],
        }),
      }),
      expect.objectContaining({
        commentId: selectionComment.id,
        state: "published",
        payload: expect.objectContaining({ attachmentIds: [selected.id] }),
      }),
      expect.objectContaining({
        commentId: documentSelectionComment.id,
        state: "published",
        payload: expect.objectContaining({
          attachmentIds: [selectedDocument.id],
        }),
      }),
    ]);
    expect(JSON.stringify(publications)).not.toContain(unbound.id);
    expect(JSON.stringify(publications)).not.toContain(otherRunAttachment.id);
    expect(JSON.stringify(publications)).not.toContain(remintedAttachment.id);
    expect(JSON.stringify(publications)).not.toContain(legacyAttachment.id);
    expect(JSON.stringify(publications)).not.toContain(otherAgentAttachment.id);
    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      {
        threadId: channel.thread.id,
        text: "Here is the requested cat image.",
      },
      {
        threadId: channel.thread.id,
        text: "Shared direct-selection.png.",
        files: [
          expect.objectContaining({
            filename: "direct-selection.png",
            mimeType: "image/png",
            data: directBody,
          }),
        ],
      },
      {
        threadId: channel.thread.id,
        text: "Shared orange-tabby.png.",
        files: [
          expect.objectContaining({
            filename: "orange-tabby.png",
            mimeType: "image/png",
            data: imageBody,
          }),
        ],
      },
      {
        threadId: channel.thread.id,
        text: "Shared cat-notes.pdf.",
        files: [
          expect.objectContaining({
            filename: "cat-notes.pdf",
            mimeType: "application/pdf",
            data: documentBody,
          }),
        ],
      },
    ]);
    await expect(
      db
        .select({ issueCommentId: issueAttachments.issueCommentId })
        .from(issueAttachments)
        .where(eq(issueAttachments.id, unbound.id)),
    ).resolves.toEqual([{ issueCommentId: null }]);
  });

  it("serializes and caps an agent run's selected Discord files before final handoff", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, service } = await configuredDiscordEndpoint(
      fixture,
      { storage: storage.storage },
    );
    const rootMessageId = "555555555555555711";
    const channel = makeThread({
      channelId: "333333333333333711",
      id: `discord:1457808928258658549:333333333333333711:${rootMessageId}`,
      name: "agent-file-cap",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: makeMessage({
        id: rootMessageId,
        text: "@maya prepare the complete file set",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected Discord conversation");

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "discord",
        providerMessageId: rootMessageId,
      }),
    });
    const attachments: Array<{ id: string }> = [];
    for (let index = 0; index < 21; index += 1) {
      const body = Buffer.from(`selected file ${index + 1}`, "utf8");
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${conversation.issueId}`,
        originalFilename: `selected-${String(index + 1).padStart(2, "0")}.txt`,
        contentType: "text/plain",
        body,
      });
      attachments.push(
        await issueService(db).createAttachment({
          issueId: conversation.issueId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByAgentId: fixture.assignedAgentId,
          createdByRunId: runId,
        }),
      );
    }

    const issuesSvc = issueService(db);
    const initialSelection = await db.transaction((tx) =>
      issuesSvc.addComment(
        conversation.issueId,
        "Prepared the selected file batch.",
        { agentId: fixture.assignedAgentId, runId },
        {
          attachmentIds: attachments.slice(0, 19).map((item) => item.id),
          authorType: "agent",
          authorizationReason: "allow_self",
        },
        tx,
      ),
    );
    const contenderBodies = [
      "Prepared candidate file twenty.",
      "Prepared candidate file twenty-one.",
    ];
    const contenderResults = await Promise.allSettled(
      attachments.slice(19).map((attachment, index) =>
        db.transaction((tx) =>
          issuesSvc.addComment(
            conversation.issueId,
            contenderBodies[index]!,
            { agentId: fixture.assignedAgentId, runId },
            {
              attachmentIds: [attachment.id],
              authorType: "agent",
              authorizationReason: "allow_self",
            },
            tx,
          ),
        ),
      ),
    );
    const winnerIndex = contenderResults.findIndex(
      (result) => result.status === "fulfilled",
    );
    const loserIndex = contenderResults.findIndex(
      (result) => result.status === "rejected",
    );
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    if (winnerIndex < 0 || loserIndex < 0) {
      throw new Error("Expected exactly one capped attachment contender");
    }
    const rejected = contenderResults[loserIndex];
    if (rejected?.status !== "rejected") {
      throw new Error("Expected the twenty-first attachment to be rejected");
    }
    expect(rejected.reason).toMatchObject({
      status: 422,
      details: {
        code: "chat_attachment_selection_limit_exceeded",
        limit: 20,
        selectedCount: 21,
      },
    });
    const winningAttachment = attachments[19 + winnerIndex]!;
    const rejectedAttachment = attachments[19 + loserIndex]!;
    await expect(
      db
        .select({
          id: issueAttachments.id,
          issueCommentId: issueAttachments.issueCommentId,
        })
        .from(issueAttachments)
        .where(
          inArray(
            issueAttachments.id,
            attachments.map((item) => item.id),
          ),
        )
        .then((rows) => ({
          bound: rows.filter((row) => row.issueCommentId !== null).length,
          rejected: rows.find((row) => row.id === rejectedAttachment.id),
        })),
    ).resolves.toEqual({
      bound: 20,
      rejected: {
        id: rejectedAttachment.id,
        issueCommentId: null,
      },
    });
    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.body, contenderBodies[loserIndex]!)),
    ).resolves.toHaveLength(0);
    await expect(
      issuesSvc.createAttachment({
        issueId: conversation.issueId,
        issueCommentId: initialSelection.id,
        provider: "local_disk",
        objectKey: "issues/direct-selection-overflow.txt",
        contentType: "text/plain",
        byteSize: 25,
        sha256: "8".repeat(64),
        originalFilename: "direct-selection-overflow.txt",
        createdByAgentId: fixture.assignedAgentId,
        createdByRunId: runId,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_attachment_selection_limit_exceeded",
        limit: 20,
        selectedCount: 21,
      },
    });
    await expect(
      db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.objectKey, "issues/direct-selection-overflow.txt")),
    ).resolves.toHaveLength(0);

    const authorizationReason =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId,
      });
    expect(authorizationReason).toBe("allow_chat_run_presentation");
    // Reusing the first selected attachment on the final comment makes that
    // file appear in both the direct and carried sets. Dedupe must happen
    // before the provider cap is applied, or the later winning file is lost.
    const response = await db.transaction((tx) =>
      issuesSvc.addComment(
        conversation.issueId,
        "Prepared the selected file batch.",
        { agentId: fixture.assignedAgentId, runId },
        {
          attachmentIds: [attachments[0]!.id],
          authorType: "agent",
          authorizationReason,
        },
        tx,
      ),
    );
    expect(response.id).toBe(initialSelection.id);

    await service.processPendingPublications(1_000);
    const publications = await db
      .select({
        payload: chatPublications.payload,
        state: chatPublications.state,
      })
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, conversation.id));
    const publishedAttachmentIds = publications.flatMap((publication) => {
      const attachmentIds =
        publication.payload &&
        typeof publication.payload === "object" &&
        "attachmentIds" in publication.payload &&
        Array.isArray(publication.payload.attachmentIds)
          ? publication.payload.attachmentIds
          : [];
      return attachmentIds.filter(
        (attachmentId): attachmentId is string =>
          typeof attachmentId === "string",
      );
    });
    expect(
      publications.every((publication) => publication.state === "published"),
    ).toBe(true);
    expect(publishedAttachmentIds).toHaveLength(20);
    expect(new Set(publishedAttachmentIds).size).toBe(20);
    expect(publishedAttachmentIds).toEqual(
      expect.arrayContaining([
        ...attachments.slice(0, 19).map((item) => item.id),
        winningAttachment.id,
      ]),
    );
    expect(publishedAttachmentIds).not.toContain(rejectedAttachment.id);

    const nonChatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nonChatRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: {
        issueId: conversation.issueId,
        source: "issue.comment",
      },
    });
    const nonChatAttachments: Array<{ id: string }> = [];
    for (let index = 0; index < 21; index += 1) {
      nonChatAttachments.push(
        await issuesSvc.createAttachment({
          issueId: conversation.issueId,
          provider: "local_disk",
          objectKey: `issues/non-chat-${index + 1}.txt`,
          contentType: "text/plain",
          byteSize: 1,
          sha256: String(index).padStart(64, "0"),
          originalFilename: `non-chat-${index + 1}.txt`,
          createdByAgentId: fixture.assignedAgentId,
          createdByRunId: nonChatRunId,
        }),
      );
    }
    const firstInternalBatch = await db.transaction((tx) =>
      issuesSvc.addComment(
        conversation.issueId,
        "Internal task files one through twenty.",
        { agentId: fixture.assignedAgentId, runId: nonChatRunId },
        {
          attachmentIds: nonChatAttachments.slice(0, 20).map((item) => item.id),
          authorType: "agent",
          authorizationReason: "allow_self",
        },
        tx,
      ),
    );
    const secondInternalBatch = await db.transaction((tx) =>
      issuesSvc.addComment(
        conversation.issueId,
        "Internal task file twenty-one.",
        { agentId: fixture.assignedAgentId, runId: nonChatRunId },
        {
          attachmentIds: [nonChatAttachments[20]!.id],
          authorType: "agent",
          authorizationReason: "allow_self",
        },
        tx,
      ),
    );
    expect(firstInternalBatch.id).not.toBe(secondInternalBatch.id);
    await expect(
      db
        .select({ issueCommentId: issueAttachments.issueCommentId })
        .from(issueAttachments)
        .where(
          inArray(
            issueAttachments.id,
            nonChatAttachments.map((item) => item.id),
          ),
        )
        .then((rows) =>
          rows.filter((attachment) => attachment.issueCommentId !== null),
        ),
    ).resolves.toHaveLength(21);
  });

  it.each(["metadata_only", "file_revisions"] as const)(
    "preserves exact Discord source authority through registered Gateway %s updates",
    async (mode) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const { callbacks, endpoint, runtime, service, wakeup, cancelRun } =
        await configuredDiscordEndpoint(fixture, {
          storage: storage.storage,
          // This fixture explicitly replays the staged root below. Do not
          // race an automatic root drain against its setup endpoint mutation;
          // an unadmitted root correctly holds every later lifecycle receipt.
          scheduleDeferredWork: () => undefined,
        });
      const guildId = "1457808928258658549";
      const channelId = "333333333333333333";
      const messageId = "555555555555555688";
      const userId = "444444444444444444";
      const threadId = `discord:${guildId}:${channelId}:${messageId}`;
      const handlers = new Map<
        string,
        (...args: unknown[]) => Promise<void> | void
      >();
      const logger = {
        child: () => logger,
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const adapter = createDiscordAdapter({
        applicationId: "123456789012345678",
        botToken: "discord-fixture-token",
        webhookVerifier: async () => false,
        logger,
      });
      const providerRuntime = runtime.endpoints.get(endpoint.id)!;
      const processMessageUpdated = vi.fn(
        async (event: {
          message: Message;
          previousMessage?: Message;
          threadId: string;
        }) => {
          await callbacks.onMessageUpdated!({
            endpointId: endpoint.id,
            provider: "discord",
            thread: providerRuntime.thread(event.threadId) as unknown as Thread,
            message: event.message,
            previousMessage: event.previousMessage,
          });
        },
      );
      const processMessageDeleted = vi.fn(
        async (event: Record<string, unknown>) => {
          await callbacks.onMessageDeleted!({
            endpointId: endpoint.id,
            provider: "discord",
            event: event as never,
          });
        },
      );
      await adapter.initialize({
        processMessageUpdated,
        processMessageDeleted,
      } as never);
      const gateway = adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          closing: () => boolean,
        ): void;
        gatewayChatMessage(
          message: unknown,
          threadId: string,
          mentioned?: boolean,
        ): Message;
      };
      gateway.setupLegacyGatewayHandlers(
        {
          user: { id: "123456789012345678" },
          ws: { handlePacket: () => false },
          on(
            event: string,
            handler: (...args: unknown[]) => Promise<void> | void,
          ) {
            handlers.set(event, handler);
            return this;
          },
        },
        () => false,
      );
      const fileBody = Buffer.from("The exact original Discord source.\n");
      const sourceFile = {
        id: "original-file",
        name: "original.txt",
        contentType: "text/plain",
        size: fileBody.length,
        url: "https://cdn.discordapp.com/attachments/333333333333333333/555555555555555689/original.txt?ex=ORIGINAL_PRIVATE",
      };
      const original = {
        id: messageId,
        channelId,
        guildId,
        partial: false,
        content: "@maya keep this exact original request authoritative",
        attachments: new Map<string, Record<string, unknown>>([
          [sourceFile.id, sourceFile],
        ]),
        messageSnapshots: new Map(),
        channel: { isThread: () => false, parentId: null },
        author: { id: userId, username: "ada", displayName: "Ada", bot: false },
        createdAt: new Date(),
        editedAt: null,
      };
      let runId: string | undefined;
      const workspaceRoot = mkdtempSync(
        path.join(os.tmpdir(), "discord-source-update-"),
      );
      let reader: NativeChatAttachmentReadScope | undefined;
      try {
        const message = gateway.gatewayChatMessage(original, threadId, true);
        // Substitute only transport bytes, not normalization or admission.
        message.attachments[0]!.fetchData = vi.fn(async () => fileBody);
        await expect(
          callbacks.onDiscordRootMentionAdmission!({
            endpointId: endpoint.id,
            guildId,
            channelId,
            messageId,
            message,
            threadId,
            userId,
          }),
        ).resolves.toBe(false);
        const [delivery] = await db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.providerEventId, `${threadId}:${messageId}`),
            ),
          );
        expect(delivery).toBeDefined();
        await service.processPendingDeliveries(25, delivery.id);
        await expect(
          db
            .select({ status: chatActions.status })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                eq(chatActions.deliveryId, delivery.id),
                eq(chatActions.kind, "inbound_wakeup"),
              ),
            ),
        ).resolves.toEqual([{ status: "processed" }]);
        await qualifySetupRoundTrip(service, endpoint.id, userId);
        await service.test(endpoint.id);
        const [conversation] = await service.listConversations(endpoint.id);
        const contextSnapshot = await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider: "discord",
          providerMessageId: messageId,
        });
        runId = randomUUID();
        const binding = {
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: conversation.issueId,
          runId,
        };
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          status: "running",
          runtimeMode: "native",
          nativeIssueId: conversation.issueId,
          contextSnapshot: {
            ...contextSnapshot,
            paperclipHarnessCheckedOut: true,
            paperclipWake: {
              checkedOutByHarness: true,
              externalChatProvider: "discord",
              issue: { id: conversation.issueId, workMode: "standard" },
              commentIds: contextSnapshot.wakeCommentIds,
            },
          },
        });
        await db
          .update(issues)
          .set({ executionRunId: runId, status: "in_progress" })
          .where(eq(issues.id, conversation.issueId));
        const authority = () =>
          resolveChatRunPresentationAuthorizationReason(db, {
            companyId: fixture.companyId,
            issueId: conversation.issueId,
            runId: runId!,
          });
        await expect(authority()).resolves.toBe("allow_chat_run_presentation");
        const [attachment] = await issueService(db).listAttachments(
          conversation.issueId,
        );
        expect(attachment).toBeDefined();
        const selection = {
          sourceCommentId: attachment.issueCommentId!,
          attachmentId: attachment.id,
        };
        reader = new NativeChatAttachmentReadScope({
          db,
          binding,
          workspaceRoot,
          executionTargetKind: "local",
          storage: storage.storage,
        });
        const tools = new PaperclipRunnerToolAuthority(db, {
          ...binding,
          workspaceRoot,
          storage: storage.storage,
          chatAttachmentReadScope: reader,
        });
        await expect(
          tools.execute({
            tool: "list_chat_attachments",
            callId: "before-update",
            arguments: { sourceCommentId: selection.sourceCommentId },
          }),
        ).resolves.toMatchObject({
          attachments: [expect.objectContaining(selection)],
        });
        const commentsBefore = await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.issueId, conversation.issueId))
          .orderBy(asc(issueComments.id));
        const wakesBefore = wakeup.mock.calls.length;
        const reactionsBefore = providerRuntime.reactions.length;
        const postsBefore = providerRuntime.posts.length;
        if (mode === "metadata_only") {
          const threadCreated = {
            ...original,
            flags: 32,
            thread: { id: messageId },
            pinned: true,
            embeds: [{ title: "Link preview" }],
          };
          await handlers.get("messageUpdate")!(original, threadCreated);
          await handlers.get("messageUpdate")!(original, threadCreated);
          expect(processMessageUpdated).not.toHaveBeenCalled();
          expect(
            await db
              .select({ id: chatDeliveries.id })
              .from(chatDeliveries)
              .where(
                and(
                  eq(chatDeliveries.endpointId, endpoint.id),
                  eq(chatDeliveries.eventKind, "message_updated"),
                ),
              ),
          ).toEqual([]);
          expect(
            await db
              .select({ id: issueComments.id })
              .from(issueComments)
              .where(eq(issueComments.issueId, conversation.issueId))
              .orderBy(asc(issueComments.id)),
          ).toEqual(commentsBefore);
          expect(wakeup).toHaveBeenCalledTimes(wakesBefore);
          expect(cancelRun).not.toHaveBeenCalled();
          expect(providerRuntime.reactions).toHaveLength(reactionsBefore);
          expect(providerRuntime.posts).toHaveLength(postsBefore);
          await expect(
            tools.execute({
              tool: "list_chat_attachments",
              callId: "after-metadata",
              arguments: { sourceCommentId: selection.sourceCommentId },
            }),
          ).resolves.toMatchObject({
            attachments: [expect.objectContaining(selection)],
          });
          await expect(authority()).resolves.toBe(
            "allow_chat_run_presentation",
          );
          await db
            .update(heartbeatRuns)
            .set({ status: "succeeded", finishedAt: new Date() })
            .where(eq(heartbeatRuns.id, runId));
          const comment = await addSelectedChatFinal({
            agentId: fixture.assignedAgentId,
            body: "Exact source answer remains deliverable.",
            companyId: fixture.companyId,
            issueId: conversation.issueId,
            runId,
          });
          await service.processPendingPublications();
          await service.processPendingPublications();
          expect(
            providerRuntime.posts.filter(
              (post) =>
                post.text === "Exact source answer remains deliverable.",
            ),
          ).toHaveLength(1);
          expect(
            await db
              .select({
                state: chatPublications.state,
                attempts: chatPublications.attempts,
              })
              .from(chatPublications)
              .where(eq(chatPublications.commentId, comment.id)),
          ).toEqual([{ state: "published", attempts: 1 }]);
        } else {
          const firstFile = {
            id: "attachment-1",
            name: "source.txt",
            contentType: "text/plain",
            size: 123,
            url: "https://cdn.discordapp.com/attachments/channel/file/source.txt?ex=NEVER_PERSIST",
          };
          const secondFile = { ...firstFile, id: "attachment-2" };
          const snapshots = [
            original,
            { ...original, attachments: new Map([[firstFile.id, firstFile]]) },
            {
              ...original,
              attachments: new Map([[secondFile.id, secondFile]]),
            },
            { ...original, attachments: new Map() },
          ];
          for (let index = 1; index < snapshots.length; index += 1) {
            await handlers.get("messageUpdate")!(
              snapshots[index - 1],
              snapshots[index],
            );
            await handlers.get("messageUpdate")!(
              snapshots[index - 1],
              snapshots[index],
            );
          }
          expect(processMessageUpdated).toHaveBeenCalledTimes(6);
          const lifecycle = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(chatDeliveries.eventKind, "message_updated"),
              ),
            );
          expect(lifecycle).toHaveLength(3);
          expect(lifecycle.every((row) => row.state === "processed")).toBe(
            true,
          );
          expect(
            new Set(lifecycle.map((row) => row.providerEventId)).size,
          ).toBe(3);
          expect(JSON.stringify(lifecycle)).not.toContain("NEVER_PERSIST");
          expect(JSON.stringify(lifecycle)).not.toContain("cdn.discordapp.com");
          await expect(
            tools.execute({
              tool: "read_chat_attachment",
              callId: "edited-source-read",
              arguments: selection,
            }),
          ).rejects.toThrow("paperclip_runner_chat_attachment_source_denied");
          await expect(
            tools.execute({
              tool: "reuse_chat_attachment",
              callId: "edited-source-reuse",
              arguments: {
                ...selection,
                title: "Do not reuse",
                idempotencyKey: "edited-source-reuse",
              },
            }),
          ).rejects.toThrow("paperclip_runner_chat_attachment_source_denied");
          expect(storage.putFile).toHaveBeenCalledTimes(1);
          const textEdit = {
            ...original,
            content: "actual changed request",
            editedAt: new Date(),
          };
          await handlers.get("messageUpdate")!(original, textEdit);
          await handlers.get("messageDelete")!(textEdit);
          expect(processMessageDeleted).toHaveBeenCalledTimes(1);
          const allLifecycle = await db
            .select({
              eventKind: chatDeliveries.eventKind,
              state: chatDeliveries.state,
            })
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                inArray(chatDeliveries.eventKind, [
                  "message_updated",
                  "message_deleted",
                ]),
              ),
            );
          expect(allLifecycle).toHaveLength(5);
          expect(allLifecycle.every((row) => row.state === "processed")).toBe(
            true,
          );
        }
      } finally {
        await reader?.close();
        if (runId) {
          await db
            .update(heartbeatRuns)
            .set({ status: "succeeded", finishedAt: new Date() })
            .where(eq(heartbeatRuns.id, runId));
          await db
            .update(issues)
            .set({ executionRunId: null })
            .where(eq(issues.executionRunId, runId));
        }
        await retirePublicationFixture(service, endpoint.id);
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    },
  );

  it("replays one pre-link Discord reaction after service reconstruction without waking the task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredDiscordEndpoint(fixture);
    const guildId = "1457808928258658549";
    const channelId = "333333333333333391";
    const rootMessageId = "555555555555555691";
    const channel = makeThread({
      channelId,
      id: `discord:${guildId}:${channelId}:${rootMessageId}`,
      name: "discord-reaction-restart",
    });
    const rootMessage = makeMessage({
      id: rootMessageId,
      mentioned: true,
      text: "@maya prepare a Discord reply before service reconstruction",
      userId: "444444444444444491",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: rootMessage,
      trigger: "mention",
    });
    await qualifySetupRoundTrip(
      service,
      endpoint.id,
      rootMessage.author.userId,
    );
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Discord reaction callback was not registered");
    const [conversation] = await service.listConversations(endpoint.id);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!conversation || !providerRuntime)
      throw new Error("Expected an active Discord conversation");

    const targetMessageId = "555555555555555692";
    const targetMessage = makeMessage({
      id: targetMessageId,
      text: "",
      userId: rootMessage.author.userId,
    });
    const reaction = {
      endpointId: endpoint.id,
      provider: "discord" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji: {
          name: "thumbsup",
          toJSON: () => "👍",
          toString: () => "👍",
        },
        message: targetMessage,
        messageId: targetMessageId,
        raw: {
          channel_id: channelId,
          emoji: { id: null, name: "👍" },
          gateway_dispatch: {
            eventType: "MESSAGE_REACTION_ADD",
            sequence: 891,
            sessionFingerprint: "f".repeat(24),
            shardId: 0,
          },
          guild_id: guildId,
          message_id: targetMessageId,
          user_id: targetMessage.author.userId,
        },
        rawEmoji: "👍",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: targetMessage.author,
      },
    };
    let stagedId: string | null = null;
    providerRuntime.postResultIds.push(targetMessageId);
    providerRuntime.postHook = async () => {
      if (stagedId) return;
      await callbacks.onReaction!(reaction);
      await callbacks.onReaction!(reaction);
      const staged = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        );
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({
        conversationId: null,
        state: "received",
        attempts: 0,
        normalizedEvent: expect.objectContaining({
          conversation: { externalThreadId: channel.thread.id },
          message: { providerMessageId: targetMessageId },
          runtimeContext: {
            generation: expect.any(Number),
            credentialFingerprint: expect.any(String),
          },
        }),
      });
      stagedId = staged[0]!.id;
    };
    await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "A Discord reply whose reaction must survive reconstruction",
      "discord-reaction-before-restart",
      "owner-user",
    );
    providerRuntime.postHook = undefined;
    if (!stagedId) throw new Error("Expected a staged Discord reaction");

    const commentCount = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .then((rows) => rows.length);
    const runCount = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const wakeupCount = wakeup.mock.calls.length;
    await service.shutdown();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, stagedId));

    const restarted = createService();
    try {
      await restarted.service.processPendingDeliveries(1, stagedId);
      await expect(
        readChatDeliveriesById(stagedId),
      ).resolves.toEqual([
        expect.objectContaining({
          conversationId: conversation.id,
          state: "processed",
          attempts: 1,
          nextAttemptAt: null,
          redactedError: null,
          normalizedEvent: expect.objectContaining({
            conversation: { externalThreadId: channel.thread.id },
            message: { providerMessageId: targetMessageId },
            reaction: {
              added: true,
              emoji: "thumbsup",
              rawEmoji: "👍",
            },
          }),
        }),
      ]);
      const reactionActivity = () =>
        restarted.service
          .listActivity(endpoint.id)
          .then((items) => items.filter((item) => item.id === stagedId));
      await expect(reactionActivity()).resolves.toEqual([
        expect.objectContaining({
          kind: "delivery",
          status: "processed",
          summary: "reaction added processed",
        }),
      ]);

      await restarted.service.processPendingDeliveries(1, stagedId);
      await expect(reactionActivity()).resolves.toHaveLength(1);
      await expect(
        db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.issueId, conversation.issueId))
          .then((rows) => rows.length),
      ).resolves.toBe(commentCount);
      await expect(
        db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, fixture.companyId))
          .then((rows) => rows.length),
      ).resolves.toBe(runCount);
      expect(wakeup).toHaveBeenCalledTimes(wakeupCount);
      expect(restarted.wakeup).not.toHaveBeenCalled();
    } finally {
      await restarted.service.shutdown();
    }
  });
});
