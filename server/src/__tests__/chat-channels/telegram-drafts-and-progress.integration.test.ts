import { idleWorkSnapshot } from "../../services/task-admission.js";
import type { Db } from "@paperclipai/db";
import * as connectionCredentialBindings from "../../services/connection-credential-bindings.js";
import { registerChatActionWork } from "../../services/chat-action-work.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { toolAccessService } from "../../services/tool-access.js";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, chatActions, chatConversations, chatDeliveries, chatEndpoints, chatMessageLinks, chatPublications, companySecretBindings, heartbeatRuns, issueComments, issues, toolConnections } from "@paperclipai/db";
import type { Thread } from "chat";
import type { ChatSdkMessageTrigger } from "../../services/chat-sdk-runtime.js";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { issueService } from "../../services/issues.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, fakeTelegramFetch, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";

describeEmbeddedPostgres("chat channels: telegram drafts and progress", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const { seedCompany, readChatEndpointsById, readChatDeliveriesById, readHeartbeatRunsById, readChatPublicationsById, readToolConnectionsById, readChatPublicationsByCommentId, readChatActionsByProviderActionId, readChatPublicationsByIdempotencyKey, readHeartbeatRunsByCompanyId, createService, retirePublicationFixture, chatWakeContext, addSelectedChatFinal, qualifySetupRoundTrip, configuredSlackEndpoint, configuredTeamsEndpoint, configuredTelegramEndpoint, deliverMessage, waitForProcessedReceiptRemoval } = h;

  describe("Telegram close-owned progress retirement", () => {
    async function closeProgressFixture(
      provider: "telegram" | "slack" | "microsoft-teams" = "telegram",
    ) {
      const fixture = await seedCompany();
      const context =
        provider === "telegram"
          ? await configuredTelegramEndpoint(fixture)
          : provider === "slack"
            ? await configuredSlackEndpoint(fixture)
            : await configuredTeamsEndpoint(fixture);
      const { callbacks, endpoint, runtime, service } = context;
      const chatId =
        provider === "telegram"
          ? "77118896"
          : provider === "slack"
            ? "D09CLOSEPROGRESS"
            : `teams:${Buffer.from("a:close-progress-personal").toString("base64url")}`;
      const userId = provider === "telegram" ? chatId : "U-CLOSE-PROGRESS";
      const sourceMessageId =
        provider === "telegram" ? `${chatId}:930` : "1788969999.000930";
      const thread = makeThread({
        channelId: chatId,
        id:
          provider === "telegram"
            ? `telegram:${chatId}`
            : provider === "slack"
              ? `slack:${chatId}:`
              : chatId,
        isDM: true,
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider,
        thread: thread.thread,
        message: makeMessage({
          id: sourceMessageId,
          raw:
            provider === "telegram"
              ? { message_id: 930 }
              : { ts: sourceMessageId },
          text: "Work until I close this conversation",
          userId,
        }),
        trigger: "direct_message",
      });
      const setupMessageId = await qualifySetupRoundTrip(service, endpoint.id, userId);
      await service.test(endpoint.id);
      if (provider === "telegram") {
        // Setup dispatches receipt cleanup asynchronously. Finish it before
        // measuring reaction removals owned by this fixture's working run.
        await service.processPendingReceiptReactions();
        await waitForProcessedReceiptRemoval(endpoint.id, {
          threadId: thread.thread.id,
          messageId: setupMessageId,
          emoji: "eyes",
        });
      }
      const [conversation] = await service.listConversations(endpoint.id);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "running",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider,
          providerMessageId: sourceMessageId,
        }),
      });
      const [progress] = await db
        .insert(chatPublications)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          idempotencyKey: `run:${runId}:working:${endpoint.id}`,
          payload: { text: "Maya is working…", progressState: "working" },
          state: "pending",
        })
        .returning();
      await service.processPendingPublications();
      const providerRuntime = runtime.endpoints.get(endpoint.id)!;
      const closeEvent = {
        endpointId: endpoint.id,
        provider: "telegram" as const,
        event: {
          channel: {
            id: thread.thread.id,
            name: "Telegram close retirement",
            isDM: true,
          } as never,
          command: "/close",
          text: "",
          user: {
            userId: chatId,
            userName: "close-user",
            fullName: "Close User",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: {
            message_id: 931,
            date: Math.floor(Date.now() / 1000),
            chat: { id: Number(chatId), type: "private" },
            from: { id: Number(chatId), is_bot: false },
            text: "/close",
            entities: [{ offset: 0, length: 6, type: "bot_command" }],
          },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      };
      const stageClose = async () => {
        if (provider === "microsoft-teams")
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider,
            thread: thread.thread,
            message: makeMessage({
              id: "teams-close-progress-control",
              text: "/close",
              userId,
            }),
            trigger: "direct_message",
          });
        else
          await callbacks.onSlashCommand!(
            provider === "telegram"
              ? closeEvent
              : {
                  endpointId: endpoint.id,
                  provider: "slack",
                  event: {
                    channel: {
                      id: `slack:${chatId}`,
                      name: "Close progress DM",
                      isDM: true,
                    } as never,
                    command: endpoint.setup.command!,
                    text: "close",
                    triggerId: `close-progress-${randomUUID()}`,
                    user: { ...closeEvent.event.user, userId },
                    raw: { command: endpoint.setup.command!, text: "close" },
                    adapter: {} as never,
                    openModal: async () => undefined,
                  },
                },
          );
        return db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              like(chatPublications.idempotencyKey, "control:close:%"),
            ),
          )
          .then((rows) => rows[0]!);
      };
      const progressMessageId = await db
        .select({ id: chatPublications.providerMessageId })
        .from(chatPublications)
        .where(eq(chatPublications.id, progress!.id))
        .then((rows) => rows[0]!.id!);
      return {
        ...context,
        ...fixture,
        conversation,
        runId,
        progress: progress!,
        progressMessageId,
        providerRuntime,
        stageClose,
        closeEvent,
        sourceMessageId,
      };
    }

    it("retires one working lane on close without cancelling the run or publishing its late final", async () => {
      const f = await closeProgressFixture();
      let releaseRemoval!: () => void;
      let removalStarted = false;
      const removalRelease = new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });
      const originalThread = f.providerRuntime.thread.bind(f.providerRuntime);
      const threadSpy = vi
        .spyOn(f.providerRuntime, "thread")
        .mockImplementation((threadId) => {
          const thread = originalThread(threadId);
          const removeReaction = thread.adapter.removeReaction;
          thread.adapter.removeReaction = async (
            reactionThreadId,
            messageId,
            emoji,
          ) => {
            if (
              reactionThreadId === "telegram:77118896" &&
              messageId === f.sourceMessageId &&
              emoji === "eyes"
            ) {
              removalStarted = true;
              await removalRelease;
            }
            await removeReaction(reactionThreadId, messageId, emoji);
          };
          return thread;
        });
      try {
        const close = await f.stageClose();
        await f.service.processPendingPublications();
        await vi.waitFor(() => expect(removalStarted).toBe(true));
        const removals = await db
          .select({ id: chatActions.id, status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, f.endpoint.id),
              eq(chatActions.kind, "receipt_reaction"),
              sql`${chatActions.payload}->>'operation' = 'remove'`,
              sql`${chatActions.payload}->>'messageId' = ${f.sourceMessageId}`,
            ),
          );
        expect(removals).toEqual([
          { id: expect.any(String), status: "processing" },
        ]);
        await expect(
          db
            .select({ state: chatPublications.state })
            .from(chatPublications)
            .where(eq(chatPublications.id, close.id)),
        ).resolves.toEqual([{ state: "published" }]);
        await expect(
          f.service.processPendingReceiptReactions(25, removals[0]!.id),
        ).resolves.toBe(0);
        expect(f.providerRuntime.removedReactions).not.toContainEqual({
          threadId: "telegram:77118896",
          messageId: f.sourceMessageId,
          emoji: "eyes",
        });
        releaseRemoval();
        expect(
          await waitForProcessedReceiptRemoval(f.endpoint.id, {
            threadId: "telegram:77118896",
            messageId: f.sourceMessageId,
            emoji: "eyes",
          }),
        ).toBe(removals[0]!.id);
        expect(f.providerRuntime.posts.map((post) => post.text)).toEqual([
          "Maya is working…",
        ]);
        expect(f.providerRuntime.edits).toEqual([
          {
            threadId: `telegram:77118896`,
            messageId: f.progressMessageId,
            text: "This chat conversation is closed. Send another message to start a new task.",
          },
        ]);
        expect(f.providerRuntime.removedReactions).toContainEqual({
          threadId: "telegram:77118896",
          messageId: "77118896:930",
          emoji: "eyes",
        });
        await expect(
          db
            .select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, f.runId)),
        ).resolves.toEqual([{ status: "running" }]);
        await expect(
          db
            .select({ state: chatConversations.state })
            .from(chatConversations)
            .where(eq(chatConversations.id, f.conversation.id)),
        ).resolves.toEqual([{ state: "completed" }]);
        await db
          .update(heartbeatRuns)
          .set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, f.runId));
        const late = await issueService(db).addComment(
          f.conversation.issueId,
          "Late output remains on the task",
          { agentId: f.assignedAgentId, runId: f.runId },
          {
            authorType: "agent",
            authorizationReason: "paperclip_runner_protocol",
          },
        );
        await expect(
          db
            .select({ id: chatPublications.id })
            .from(chatPublications)
            .where(eq(chatPublications.commentId, late.id)),
        ).resolves.toEqual([]);
        await f.service.processPendingPublications();
        await f.callbacks.onSlashCommand!(f.closeEvent);
        await f.service.processPendingPublications();
        expect(f.providerRuntime.posts).toHaveLength(1);
        expect(f.providerRuntime.edits).toHaveLength(1);
        await expect(
          db
            .select({
              state: chatPublications.state,
              attempts: chatPublications.attempts,
              providerMessageId: chatPublications.providerMessageId,
            })
            .from(chatPublications)
            .where(eq(chatPublications.id, close.id)),
        ).resolves.toEqual([
          {
            state: "published",
            attempts: 1,
            providerMessageId: f.progressMessageId,
          },
        ]);
      } finally {
        releaseRemoval();
        threadSpy.mockRestore();
        await retirePublicationFixture(f.service, f.endpoint.id);
      }
    });

    it.each([
      "missing_link",
      "different_run_owner",
      "unknown_final",
    ])("does not guess a close edit for %s", async (mode) => {
      const f = await closeProgressFixture();
      try {
        if (mode === "missing_link")
          await db
            .delete(chatMessageLinks)
            .where(
              and(
                eq(chatMessageLinks.endpointId, f.endpoint.id),
                eq(chatMessageLinks.direction, "outbound"),
                eq(chatMessageLinks.providerMessageId, f.progressMessageId),
              ),
            );
        if (mode === "different_run_owner")
          await db
            .update(heartbeatRuns)
            .set({ agentId: f.replacementAgentId })
            .where(eq(heartbeatRuns.id, f.runId));
        if (mode === "multiple_lanes") {
          const anotherRun = randomUUID();
          await db
            .insert(heartbeatRuns)
            .values({
              id: anotherRun,
              companyId: f.companyId,
              agentId: f.assignedAgentId,
              status: "running",
              contextSnapshot: await chatWakeContext({
                endpointId: f.endpoint.id,
                issueId: f.conversation.issueId,
                provider: "telegram",
                providerMessageId: "77118896:930",
              }),
            });
          await db
            .insert(chatPublications)
            .values({
              companyId: f.companyId,
              endpointId: f.endpoint.id,
              conversationId: f.conversation.id,
              issueId: f.conversation.issueId,
              idempotencyKey: `run:${anotherRun}:working:${f.endpoint.id}`,
              payload: {
                text: "Another owned run is working…",
                progressState: "working",
              },
              state: "pending",
            });
          await f.service.processPendingPublications();
          expect(f.providerRuntime.posts).toHaveLength(2);
        }
        const close = await f.stageClose();
        if (
          mode === "pending_final" ||
          mode === "unknown_final" ||
          mode === "consumed_link"
        ) {
          const final = await addSelectedChatFinal({
            agentId: f.assignedAgentId,
            body: "An authored answer must never be overwritten",
            companyId: f.companyId,
            issueId: f.conversation.issueId,
            runId: f.runId,
          });
          const [publication] = await readChatPublicationsByCommentId(final.id);
          // A later final can be unconfirmed while the earlier close is the
          // FIFO head. The old progress link is not proof of remote absence.
          await db
            .update(chatPublications)
            .set({
              state:
                mode === "pending_final"
                  ? "pending"
                  : mode === "unknown_final"
                    ? "delivery_unknown"
                    : "published",
              createdAt: new Date(close.createdAt.getTime() + 1000),
              ...(mode === "consumed_link"
                ? {
                    providerMessageId: f.progressMessageId,
                    publishedAt: new Date(),
                  }
                : {}),
            })
            .where(eq(chatPublications.id, publication.id));
          if (mode === "consumed_link")
            await db
              .update(chatMessageLinks)
              .set({ publicationId: publication.id, commentId: final.id })
              .where(
                and(
                  eq(chatMessageLinks.endpointId, f.endpoint.id),
                  eq(chatMessageLinks.direction, "outbound"),
                  eq(chatMessageLinks.providerMessageId, f.progressMessageId),
                ),
              );
        }
        const before = f.providerRuntime.posts.length;
        await f.service.processPendingPublications();
        expect(f.providerRuntime.edits).toEqual([]);
        expect(f.providerRuntime.posts).toHaveLength(before + 1);
        expect(f.providerRuntime.posts.at(-1)?.text).toBe(
          "This chat conversation is closed. Send another message to start a new task.",
        );
        await expect(
          db
            .select({ state: chatPublications.state })
            .from(chatPublications)
            .where(eq(chatPublications.id, close.id)),
        ).resolves.toEqual([{ state: "published" }]);
      } finally {
        await retirePublicationFixture(f.service, f.endpoint.id);
      }
    });

    it.each([
      { kind: "ask_user_questions" as const, state: "pending" as const },
      { kind: "request_confirmation" as const, state: "delivery_unknown" as const },
    ])(
      "does not reclaim a progress lane consumed by a $state $kind prompt",
      async ({ kind, state }) => {
        const f = await closeProgressFixture();
        try {
          const close = await f.stageClose();
          const interaction = await issueThreadInteractionService(db).create(
            { id: f.conversation.issueId, companyId: f.companyId },
                kind === "request_confirmation"
                  ? { kind, continuationPolicy: "wake_assignee", sourceRunId: f.runId, payload: { version: 1, prompt: "Proceed with the operation?" } }
                  : { kind, continuationPolicy: "wake_assignee", sourceRunId: f.runId, payload: {
                      version: 1,
                      questions: [
                        {
                          id: "choice",
                          prompt: "Which option?",
                          selectionMode: "single",
                          required: true,
                          allowOther: false,
                          options: [
                            { id: "yes", label: "Yes" },
                            { id: "no", label: "No" },
                          ],
                        },
                      ],
                    } },
            { agentId: f.assignedAgentId, runId: f.runId },
          );
          const [prompt] = await readChatPublicationsByIdempotencyKey(`interaction:${interaction.id}:${f.endpoint.id}`);
          expect(prompt).toMatchObject({
            commentId: null,
            payload: { interactionId: interaction.id },
          });
          // Retained ordering fixture, like the unknown-final control above:
          // a close with an earlier transaction timestamp does not prove a later
          // prompt's remote edit was absent. This is not a live HTTP/crash proof.
          await db
            .update(chatPublications)
            .set({ state, createdAt: new Date(close.createdAt.getTime() + 1000) })
            .where(eq(chatPublications.id, prompt.id));
          const beforePosts = f.providerRuntime.posts.length;
          const beforeRemovals = f.providerRuntime.removedReactions.length;
          await f.service.processPendingPublications();
          await f.service.processPendingReceiptReactions();
          expect(f.providerRuntime.edits).toEqual([]);
          expect(f.providerRuntime.posts).toHaveLength(beforePosts + 1);
          expect(f.providerRuntime.posts.at(-1)?.text).toBe(close.payload.text);
          expect(f.providerRuntime.removedReactions).toHaveLength(beforeRemovals);
          expect(
            (
              await readChatPublicationsById(close.id)
            )[0],
          ).toMatchObject({ state: "published" });
          expect(
            (
              await readChatPublicationsById(prompt.id)
            )[0]?.state,
          ).toBe(state === "delivery_unknown" ? "delivery_unknown" : "cancelled");
          expect(
            (
              await readHeartbeatRunsById(f.runId)
            )[0]?.status,
          ).toBe("running");
        } finally {
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );

    it("does not borrow an unrelated run's interaction as progress-consumer evidence", async () => {
      const f = await closeProgressFixture();
      try {
        const close = await f.stageClose();
        const otherRunId = randomUUID();
        await db
          .insert(heartbeatRuns)
          .values({
            id: otherRunId,
            companyId: f.companyId,
            agentId: f.assignedAgentId,
            status: "running",
            contextSnapshot: { issueId: f.conversation.issueId },
          });
        const interaction = await issueThreadInteractionService(db).create(
          { id: f.conversation.issueId, companyId: f.companyId },
          {
            kind: "request_confirmation",
            continuationPolicy: "wake_assignee",
            sourceRunId: otherRunId,
            payload: { version: 1, prompt: "Another run's confirmation" },
          },
          { agentId: f.assignedAgentId, runId: otherRunId },
        );
        const [prompt] = await readChatPublicationsByIdempotencyKey(`interaction:${interaction.id}:${f.endpoint.id}`);
        expect(prompt).toBeDefined();
        await db
          .update(chatPublications)
          .set({
            state: "delivery_unknown",
            createdAt: new Date(close.createdAt.getTime() + 1000),
          })
          .where(eq(chatPublications.id, prompt.id));
        await f.service.processPendingPublications();
        expect(f.providerRuntime.edits).toEqual([
          {
            threadId: "telegram:77118896",
            messageId: f.progressMessageId,
            text: close.payload.text,
          },
        ]);
        expect(
          (
            await readChatPublicationsById(prompt.id)
          )[0]?.state,
        ).toBe("delivery_unknown");
      } finally {
        await retirePublicationFixture(f.service, f.endpoint.id);
      }
    });

    it.each(["final", "confirmation"] as const)(
      "preserves an attempted unknown %s after public operator cancellation",
      async (kind) => {
        const f = await closeProgressFixture();
        let lostReceipt = false;
        const originalThread = f.providerRuntime.thread.bind(f.providerRuntime);
        const threadSpy = vi
          .spyOn(f.providerRuntime, "thread")
          .mockImplementation((threadId) => {
            const thread = originalThread(threadId);
            const edit = thread.adapter.editMessage.bind(thread.adapter);
            thread.adapter.editMessage = async (...args) => {
              const receipt = await edit(...args);
              if (!lostReceipt) {
                lostReceipt = true;
                throw Object.assign(new Error("Consumer edit receipt lost"), {
                  name: "NetworkError",
                  code: "NETWORK_ERROR",
                });
              }
              return receipt;
            };
            return thread;
          });
        try {
          let consumerId: string;
          if (kind === "final") {
            const comment = await addSelectedChatFinal({
              agentId: f.assignedAgentId,
              body: "Preserve this possibly delivered final",
              companyId: f.companyId,
              issueId: f.conversation.issueId,
              runId: f.runId,
            });
            consumerId = await db
              .select({ id: chatPublications.id })
              .from(chatPublications)
              .where(eq(chatPublications.commentId, comment.id))
              .then((rows) => rows[0]!.id);
          } else {
            const interaction = await issueThreadInteractionService(db).create(
              { id: f.conversation.issueId, companyId: f.companyId },
              {
                kind: "request_confirmation",
                continuationPolicy: "wake_assignee",
                sourceRunId: f.runId,
                payload: { version: 1, prompt: "Preserve this confirmation?" },
              },
              { agentId: f.assignedAgentId, runId: f.runId },
            );
            consumerId = await db
              .select({ id: chatPublications.id })
              .from(chatPublications)
              .where(
                eq(
                  chatPublications.idempotencyKey,
                  `interaction:${interaction.id}:${f.endpoint.id}`,
                ),
              )
              .then((rows) => rows[0]!.id);
          }
          await f.service.processPendingPublications();
          threadSpy.mockRestore();
          expect(lostReceipt).toBe(true);
          expect(f.providerRuntime.edits).toHaveLength(1);
          expect(f.providerRuntime.edits[0]?.messageId).toBe(f.progressMessageId);
          expect(
            await readChatPublicationsById(consumerId),
          ).toEqual([
            expect.objectContaining({ state: "delivery_unknown", attempts: 1 }),
          ]);
          const close = await f.stageClose();
          const beforePosts = f.providerRuntime.posts.length;
          // This public resolution stops retries, then drains the pending close.
          // The mocked provider edit above happened; its receipt was unconfirmed.
          await f.service.resolvePublication(
            f.endpoint.id,
            consumerId,
            "cancel",
            "owner-user",
          );
          expect(
            await readChatPublicationsById(consumerId),
          ).toEqual([
            expect.objectContaining({
              state: "cancelled",
              attempts: 1,
              redactedError:
                "Cancelled by an operator after an unconfirmed provider delivery",
            }),
          ]);
          expect(
            await db
              .select()
              .from(activityLog)
              .where(
                and(
                  eq(activityLog.entityId, consumerId),
                  eq(activityLog.action, "chat.publication_cancel"),
                ),
              ),
          ).toEqual([
            expect.objectContaining({
              details: expect.objectContaining({
                previousState: "delivery_unknown",
              }),
            }),
          ]);
          expect(f.providerRuntime.edits).toHaveLength(1);
          expect(f.providerRuntime.posts).toHaveLength(beforePosts + 1);
          expect(f.providerRuntime.posts.at(-1)?.text).toBe(close.payload.text);
          expect(
            await readChatPublicationsById(close.id),
          ).toEqual([expect.objectContaining({ state: "published" })]);
          expect(
            await readHeartbeatRunsById(f.runId),
          ).toEqual([expect.objectContaining({ status: "running" })]);
        } finally {
          threadSpy.mockRestore();
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );

    it.each([
      { state: "cancelled" as const, attempts: 0, mayEdit: true },
      { state: "failed" as const, attempts: 1, mayEdit: false },
    ])(
      "treats a $state consumer with $attempts attempts conservatively",
      async ({ state, attempts, mayEdit }) => {
        const f = await closeProgressFixture();
        try {
          const comment = await addSelectedChatFinal({
            agentId: f.assignedAgentId,
            body: "Retained terminal consumer",
            companyId: f.companyId,
            issueId: f.conversation.issueId,
            runId: f.runId,
          });
          // Retained terminal-state controls: no provider-call claim for this fixture.
          await db
            .update(chatPublications)
            .set({ state, attempts })
            .where(eq(chatPublications.commentId, comment.id));
          const close = await f.stageClose();
          const beforePosts = f.providerRuntime.posts.length;
          await f.service.processPendingPublications();
          expect(f.providerRuntime.edits).toHaveLength(mayEdit ? 1 : 0);
          expect(f.providerRuntime.posts).toHaveLength(
            beforePosts + (mayEdit ? 0 : 1),
          );
          expect(
            await readChatPublicationsById(close.id),
          ).toEqual([expect.objectContaining({ state: "published" })]);
        } finally {
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );

    it("preserves an authored final that wins while close is admitted", async () => {
      const f = await closeProgressFixture();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const originalThread = f.providerRuntime.thread.bind(f.providerRuntime);
      const threadSpy = vi
        .spyOn(f.providerRuntime, "thread")
        .mockImplementation((threadId) => {
          const thread = originalThread(threadId);
          const edit = thread.adapter.editMessage.bind(thread.adapter);
          thread.adapter.editMessage = async (...args) => {
            if ((args[2] as { markdown?: string }).markdown === "The final won") {
              entered();
              await held;
            }
            return edit(...args);
          };
          return thread;
        });
      let drain: Promise<number> | undefined;
      try {
        await addSelectedChatFinal({
          agentId: f.assignedAgentId,
          body: "The final won",
          companyId: f.companyId,
          issueId: f.conversation.issueId,
          runId: f.runId,
        });
        drain = f.service.processPendingPublications();
        await entering;
        await f.stageClose();
        expect(f.providerRuntime.edits).toEqual([]);
        release();
        await drain;
        await f.service.processPendingPublications();
        expect(f.providerRuntime.edits).toEqual([
          {
            threadId: "telegram:77118896",
            messageId: f.progressMessageId,
            text: "The final won",
          },
        ]);
        expect(f.providerRuntime.posts.map((post) => post.text)).toEqual([
          "Maya is working…",
          "This chat conversation is closed. Send another message to start a new task.",
        ]);
      } finally {
        release();
        await drain;
        threadSpy.mockRestore();
        await retirePublicationFixture(f.service, f.endpoint.id);
      }
    });

    it("retires a status-interleaved working lane", async () => {
      const f = await closeProgressFixture();
      try {
        const event = f.closeEvent;
        await f.callbacks.onSlashCommand!({
          ...event,
          event: {
            ...event.event,
            command: "/status",
            raw: {
              ...event.event.raw,
              message_id: 932,
              text: "/status",
              entities: [{ offset: 0, length: 7, type: "bot_command" }],
            },
          },
        });
        await f.service.processPendingPublications();
        expect(f.providerRuntime.edits).toHaveLength(1);
        await f.stageClose();
        await f.service.processPendingPublications();
        expect(f.providerRuntime.posts).toHaveLength(1);
        expect(f.providerRuntime.edits.at(-1)).toMatchObject({
          messageId: f.progressMessageId,
          text: "This chat conversation is closed. Send another message to start a new task.",
        });
      } finally {
        await retirePublicationFixture(f.service, f.endpoint.id);
      }
    });

    it.each(["rejected", "unknown_commit"] as const)(
      "keeps close uncommitted after %s of its retirement edit",
      async (mode) => {
        const f = await closeProgressFixture();
        let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
        try {
          const close = await f.stageClose();
          if (mode === "rejected")
            f.providerRuntime.editError = Object.assign(
              new Error("Rejected close edit"),
              { name: "ValidationError", code: "VALIDATION_ERROR" },
            );
          else {
            const originalTransaction = db.transaction.bind(db);
            let injected = false;
            transactionSpy = vi
              .spyOn(db, "transaction")
              .mockImplementation((async (
                ...args: Parameters<typeof originalTransaction>
              ) => {
                if (!injected && f.providerRuntime.edits.length === 1) {
                  injected = true;
                  throw new Error(
                    "Close edit committed remotely without durable receipt",
                  );
                }
                return originalTransaction(...args);
              }) as typeof db.transaction);
          }
          await f.service.processPendingPublications();
          transactionSpy?.mockRestore();
          transactionSpy = undefined;
          await expect(
            db
              .select({ state: chatPublications.state })
              .from(chatPublications)
              .where(eq(chatPublications.id, close.id)),
          ).resolves.toEqual([
            { state: mode === "rejected" ? "failed" : "delivery_unknown" },
          ]);
          await expect(
            db
              .select({ state: chatConversations.state })
              .from(chatConversations)
              .where(eq(chatConversations.id, f.conversation.id)),
          ).resolves.toEqual([{ state: "active" }]);
          await f.service.processPendingPublications();
          expect(f.providerRuntime.posts).toHaveLength(1);
          expect(f.providerRuntime.editAttempts).toHaveLength(1);
          await expect(
            db
              .select({ status: heartbeatRuns.status })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, f.runId)),
          ).resolves.toEqual([{ status: "running" }]);
        } finally {
          transactionSpy?.mockRestore();
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );

    it.each([
      { provider: "slack" as const, mode: "working" as const },
      { provider: "slack" as const, mode: "unknown_final" as const },
      { provider: "microsoft-teams" as const, mode: "final" as const },
      { provider: "microsoft-teams" as const, mode: "card" as const },
    ])(
      "qualifies $provider close-owned progress retirement ($mode)",
      async ({ provider, mode }) => {
        const f = await closeProgressFixture(provider);
        try {
          if (mode === "final") {
            await addSelectedChatFinal({
              agentId: f.assignedAgentId,
              body: "The Slack final must remain",
              companyId: f.companyId,
              issueId: f.conversation.issueId,
              runId: f.runId,
            });
            await f.service.processPendingPublications();
          }
          if (mode === "card")
            await db
              .update(chatPublications)
              .set({
                payload: {
                  ...f.progress.payload,
                  card: { schema: "paperclip.chat.card.v1", kind: "status", title: "Not a plain progress lane" },
                },
              })
              .where(eq(chatPublications.id, f.progress.id));
          const close = await f.stageClose();
          if (mode === "unknown_final") {
            const final = await addSelectedChatFinal({
              agentId: f.assignedAgentId,
              body: "Possibly delivered Slack final",
              companyId: f.companyId,
              issueId: f.conversation.issueId,
              runId: f.runId,
            });
            await db
              .update(chatPublications)
              .set({
                state: "delivery_unknown",
                createdAt: new Date(close.createdAt.getTime() + 1000),
              })
              .where(eq(chatPublications.commentId, final.id));
          }
          const editCount = f.providerRuntime.edits.length,
            postCount = f.providerRuntime.posts.length;
          await f.service.processPendingPublications();
          await f.service.processPendingReceiptReactions();
          expect(f.providerRuntime.edits).toHaveLength(
            editCount + (mode === "working" ? 1 : 0),
          );
          expect(f.providerRuntime.posts).toHaveLength(
            postCount + (mode === "working" ? 0 : 1),
          );
          if (mode === "working") {
            expect(f.providerRuntime.edits.at(-1)).toMatchObject({
              messageId: f.progressMessageId,
              text: close.payload.text,
            });
            if (provider === "slack") {
              await waitForProcessedReceiptRemoval(f.endpoint.id, {
                threadId: f.conversation.externalThreadId,
                messageId: f.sourceMessageId,
                emoji: "eyes",
              });
              expect(f.providerRuntime.removedReactions).toContainEqual({
                threadId: f.conversation.externalThreadId,
                messageId: f.sourceMessageId,
                emoji: "eyes",
              });
            }
          }
          await expect(
            db
              .select({ status: heartbeatRuns.status })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, f.runId)),
          ).resolves.toEqual([{ status: "running" }]);
          await f.service.processPendingPublications();
          expect(f.providerRuntime.edits).toHaveLength(
            editCount + (mode === "working" ? 1 : 0),
          );
        } finally {
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );
  });

  describe("Telegram durable private draft Stop", () => {
    async function draftFixture(
      reusedBotId?: number,
      webhookOk: unknown = true,
    ) {
      const fixture = await seedCompany();
      const providerFetch = fakeTelegramFetch(reusedBotId);
      const botToken = `123456:telegram-draft-${randomUUID().replaceAll("-", "")}`;
      let configuredWebhook: Record<string, unknown> | null = null;
      let subscriptionInfo: Record<string, unknown> | null = null;
      const maintenanceRequests: Array<{
        method: string;
        body: Record<string, unknown>;
      }> = [];
      let maintenanceHook:
        | ((
            method: string,
            body: Record<string, unknown>,
          ) => Promise<Response | undefined>)
        | undefined;
      const administrativeFetch = (async (input, init) => {
        const method = new URL(String(input)).pathname.split("/").at(-1)!;
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (
          subscriptionInfo &&
          new URL(String(input)).pathname.startsWith(
            `/bot${encodeURIComponent(botToken)}/`,
          ) &&
          ["getMe", "getWebhookInfo", "setWebhook"].includes(method)
        ) {
          maintenanceRequests.push({ method, body });
          const override = await maintenanceHook?.(method, body);
          if (override) return override;
          if (method === "getWebhookInfo")
            return Response.json({ ok: true, result: subscriptionInfo });
          if (method === "setWebhook") {
            subscriptionInfo = {
              ...subscriptionInfo,
              url: body.url,
              allowed_updates: body.allowed_updates,
              max_connections: body.max_connections,
            };
            return Response.json({ ok: true, result: true });
          }
          const result = await (await providerFetch(input)).json();
          return Response.json({
            ...result,
            result: { ...result.result, is_bot: true },
          });
        }
        if (method === "setWebhook") {
          configuredWebhook = body;
          return Response.json({ ok: webhookOk, result: true });
        }
        return providerFetch(input);
      }) as typeof fetch;
      const initial = createService(
        new FakeChatSdkRuntime(),
        administrativeFetch,
      );
      const created = await initial.service.create(
        fixture.companyId,
        {
          provider: "telegram",
          assignedAgentId: fixture.assignedAgentId,
          name: "Private draft fixture",
        },
        "owner-user",
      );
      await initial.service.configure(
        created.id,
        {
          action: "configure",
          credentials: {
            botToken,
          },
        },
        "owner-user",
      );
      let context = {
        ...initial,
        endpoint: created,
        callbacks: initial.runtime.configurations.get(created.id)!.callbacks,
      };
      const { endpoint, callbacks } = context;
      const chatId = "77118878";
      const threadId = `telegram:${chatId}:42`;
      const thread = makeThread({
        channelId: chatId,
        id: threadId,
        isDM: true,
        name: "Telegram private draft",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "telegram",
        thread: thread.thread,
        message: makeMessage({
          id: `${chatId}:71`,
          text: "Return the complete approved answer",
          userId: chatId,
        }),
        trigger: "direct_message",
      });
      await qualifySetupRoundTrip(context.service, endpoint.id, chatId);
      await context.service.test(endpoint.id);
      const [conversation] = await db
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.endpointId, endpoint.id),
            eq(chatConversations.externalThreadId, threadId),
          ),
        );
      if (!conversation)
        throw new Error("Expected exact private topic conversation");
      const [currentEndpoint] = await readChatEndpointsById(endpoint.id);
      const botId = Number(currentEndpoint!.botExternalId);
      const requests: Array<{ method: string; body: Record<string, unknown> }> =
        [];
      let hook:
        | ((method: string, body: Record<string, unknown>) => Promise<void>)
        | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input, init) => {
        const method = new URL(String(input)).pathname.split("/").at(-1)!;
        if (method === "getMe")
          return Response.json({
            ok: true,
            result: {
              id: botId,
              is_bot: true,
              first_name: "Fixture",
              username: "fixture_bot",
            },
          });
        const body = JSON.parse(String(init?.body ?? "{}"));
        requests.push({ method, body });
        await hook?.(method, body);
        if (method.endsWith("Draft"))
          return Response.json({ ok: true, result: true });
        if (!["sendMessage", "sendRichMessage"].includes(method))
          throw new Error("Unexpected draft fixture provider I/O");
        return Response.json({
          ok: true,
          result: {
            message_id: 900 + requests.length,
            date: 1,
            chat: { id: Number(chatId), type: "private" },
            from: { id: botId, is_bot: true, first_name: "Fixture" },
            text: "approved",
          },
        });
      });
      let pinned: ReturnType<typeof createChatSdkEndpointRuntime>;
      const install = async () => {
        const configuration = context.runtime.configurations.get(endpoint.id)!;
        pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        await pinned.initialize();
        Object.assign(context.runtime.endpoints.get(endpoint.id)!, {
          thread: (threadId: string) => pinned.thread(threadId),
          handleWebhook: (...args: Parameters<typeof pinned.handleWebhook>) =>
            pinned.handleWebhook(...args),
          streamTelegramDraft: (
            ...args: Parameters<typeof pinned.streamTelegramDraft>
          ) => pinned.streamTelegramDraft(...args),
        });
      };
      await install();
      let updateId = 900;
      const deliver = async (
        draftId: number,
        patch: Record<string, unknown> = {},
        validSecret = true,
        exactUpdateId?: number,
        retainedRuntime = false,
      ) => {
        const configuration = context.runtime.configurations.get(endpoint.id)!;
        if (configuration.providerConfig.provider !== "telegram")
          throw new Error("Expected Telegram");
        const request = new Request("https://paperclip.example/fixture", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": validSecret
              ? configuration.providerConfig.credentials.secretToken
              : "wrong",
          },
          body: JSON.stringify({
            update_id: exactUpdateId ?? ++updateId,
            stopped_message_generation: {
              chat: { id: Number(chatId), type: "private" },
              message_thread_id: 42,
              draft_id: draftId,
              ...patch,
            },
          }),
        });
        return retainedRuntime
          ? pinned.handleWebhook(request)
          : context.service.handleWebhook(
              endpoint.publicId,
              "telegram",
              request,
            );
      };
      return {
        fixture,
        endpoint,
        conversation,
        requests,
        maintenanceRequests,
        get configuredWebhook() {
          return configuredWebhook!;
        },
        setSubscriptionInfo(patch: Record<string, unknown>) {
          subscriptionInfo = {
            url: configuredWebhook!.url,
            has_custom_certificate: false,
            pending_update_count: 23,
            max_connections: 37,
            ip_address: "203.0.113.4",
            allowed_updates: ["message", "message_reaction", "future_update"],
            ...patch,
          };
        },
        setMaintenanceHook(value: typeof maintenanceHook) {
          maintenanceHook = value;
        },
        async processSubscriptionAttempt() {
          const previousRequests = maintenanceRequests.length;
          const candidates = await db
            .select({ id: chatEndpoints.id })
            .from(chatEndpoints)
            .where(
              and(
                eq(chatEndpoints.provider, "telegram"),
                eq(chatEndpoints.status, "active"),
              ),
            );
          const queued = await db
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.kind, "telegram_maintenance"),
                inArray(chatActions.status, [
                  "received",
                  "processing",
                  "failed",
                ]),
              ),
            );
          // The worker deliberately scans finite pages. Older fixtures may
          // precede this endpoint; wait for its first attempt, not a UUID's
          // chance placement in the first page. Stop before retrying its RPC.
          for (
            let remaining = candidates.length + queued.length + 2;
            remaining > 0 && maintenanceRequests.length === previousRequests;
            remaining--
          ) {
            await context.service.processPendingDeliveries();
          }
          expect(maintenanceRequests.length).toBeGreaterThan(previousRequests);
        },
        deliver,
        botId,
        get context() {
          return context;
        },
        setHook(value: typeof hook) {
          hook = value;
        },
        async send(key: string) {
          return context.service.publishBoardMessage(
            endpoint.id,
            conversation.id,
            `Approved output ${"complete safe answer. ".repeat(60)}END-${key}`,
            key,
            "owner-user",
          );
        },
        actions: () =>
          db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                eq(chatActions.kind, "telegram_publication_draft"),
              ),
            )
            .orderBy(asc(chatActions.createdAt)),
        async restart() {
          const configuration = context.runtime.configurations.get(
            endpoint.id,
          )!;
          if (configuration.providerConfig.provider !== "telegram")
            throw new Error("Expected Telegram");
          await pinned.shutdown();
          await context.service.shutdown();
          const resumed = createService(
            new FakeChatSdkRuntime(),
            administrativeFetch,
          );
          context = { ...context, ...resumed };
          // Telegram is lazy, not a Gateway runtime. A verified inert update
          // initializes the new service's actual callback binding; the next
          // Stop below then traverses the pinned verifier/parser again.
          await context.service.handleWebhook(
            endpoint.publicId,
            "telegram",
            new Request("https://paperclip.example/fixture", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-telegram-bot-api-secret-token":
                  configuration.providerConfig.credentials.secretToken,
              },
              body: "{}",
            }),
          );
          await install();
        },
        async close() {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await retirePublicationFixture(context.service, endpoint.id);
            } finally {
              globalThis.fetch = originalFetch;
            }
          }
        },
      };
    }

    it.each(["startup", "retry"])(
      "recovers Telegram maintenance from committed work and becomes SQL quiet: %s",
      async mode => {
        const lane = await draftFixture();
        const onError = vi.fn();
        const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
        const maintenance = () => db.select().from(chatActions).where(and(
          eq(chatActions.endpointId, lane.endpoint.id), eq(chatActions.kind, "telegram_maintenance"),
          sql`${chatActions.payload}->>'operation' = 'stop_subscription'`,
        ));
        try {
          await db.delete(chatActions).where(and(eq(chatActions.endpointId, lane.endpoint.id),
            eq(chatActions.kind, "telegram_stop_subscription")));
          lane.setSubscriptionInfo({});
          if (mode === "connection_commit" || mode === "rollback") {
            await toolAccessService(db).updateConnection(lane.endpoint.connectionId, { enabled: false });
          }
          if (mode === "stale_claim") {
            // Leave committed legacy work behind before starting the workers.
            await lane.context.service.processTelegramSubscriptionDiscovery();
            const [action] = await maintenance();
            expect(action).toBeDefined();
            await db.update(chatActions).set({ status: "processing", updatedAt: new Date(Date.now() - 120_000) })
              .where(eq(chatActions.id, action!.id));
          }
          let failedAt = 0;
          let sends = 0;
          if (mode === "retry") lane.setMaintenanceHook(async method => {
            if (method === "setWebhook" && sends++ === 0) {
              failedAt = Date.now();
              throw new Error("temporary subscription transport outage");
            }
            if (method === "setWebhook") expect(Date.now() - failedAt).toBeGreaterThanOrEqual(1000);
            return undefined;
          });
          await registerChatActionWork(coordinator, lane.context.service, () => true).ready;
          if (mode === "connection_commit" || mode === "rollback") {
            expect(lane.maintenanceRequests).toEqual([]);
            if (mode === "rollback") {
              await expect(db.transaction(async tx => {
                await toolAccessService(tx as unknown as Db).updateConnection(lane.endpoint.connectionId, { enabled: true });
                await new Promise(resolve => setTimeout(resolve, 25));
                expect(lane.maintenanceRequests).toEqual([]);
                throw new Error("rollback connection wake");
              })).rejects.toThrow("rollback connection wake");
              await vi.waitFor(() => {
                expect(coordinator.nextWakeAt()).toBeNull();
                expect(idleWorkSnapshot().active).toBe(0);
              }, { timeout: 10_000 });
              expect(lane.maintenanceRequests).toEqual([]);
              expect(await maintenance()).toEqual([]);
            }
            await db.transaction(async tx => {
              await toolAccessService(tx as unknown as Db).updateConnection(lane.endpoint.connectionId, { enabled: true });
              await new Promise(resolve => setTimeout(resolve, 25));
              expect(lane.maintenanceRequests).toEqual([]);
            });
          }
          await vi.waitFor(async () => {
            const actions = await maintenance();
            expect(actions).toHaveLength(1);
            expect(actions[0]?.status).toBe("processed");
            expect(actions[0]?.result?.attempts).toBe(mode === "retry" ? 2 : 1);
            expect(coordinator.nextWakeAt()).toBeNull();
            expect(idleWorkSnapshot().active).toBe(0);
          }, { timeout: 10_000 });
          expect(lane.maintenanceRequests.filter(x => x.method === "setWebhook")).toHaveLength(mode === "retry" ? 2 : 1);
          expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, lane.endpoint.id),
            eq(chatActions.kind, "telegram_stop_subscription"), eq(chatActions.status, "processed")))).toHaveLength(1);
          const scans = vi.spyOn(db, "select");
          try {
            await new Promise(resolve => setTimeout(resolve, 250));
            expect(scans).not.toHaveBeenCalled();
          } finally { scans.mockRestore(); }
          expect(onError).not.toHaveBeenCalled();
        } finally { await coordinator.stop(); await lane.close(); }
      },
    );

    it("commits chat connection credentials atomically before waking maintenance", async () => {
      const lane = await draftFixture();
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      const bindings = () => db.select({ secretId: companySecretBindings.secretId, configPath: companySecretBindings.configPath })
        .from(companySecretBindings).where(and(eq(companySecretBindings.companyId, lane.fixture.companyId),
          eq(companySecretBindings.targetType, "tool_connection"), eq(companySecretBindings.targetId, lane.endpoint.connectionId)))
        .orderBy(asc(companySecretBindings.configPath));
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const rebuilding = new Promise<void>(resolve => { entered = resolve; });
      let update: Promise<unknown> | undefined;
      const original = connectionCredentialBindings.syncConnectionCredentialBindings;
      const spy = vi.spyOn(connectionCredentialBindings, "syncConnectionCredentialBindings");
      try {
        await db.delete(chatActions).where(and(eq(chatActions.endpointId, lane.endpoint.id),
          eq(chatActions.kind, "telegram_stop_subscription")));
        lane.setSubscriptionInfo({});
        await lane.context.service.processTelegramSubscriptionDiscovery();
        await toolAccessService(db).updateConnection(lane.endpoint.connectionId, { enabled: false });
        await registerChatActionWork(coordinator, lane.context.service, () => true).ready;
        const before = await bindings();
        expect(before.length).toBeGreaterThan(0);
        spy.mockImplementation(async (database, connection, refs, client = database) => {
          if (connection.id === lane.endpoint.connectionId) {
            // Hold the real binding rebuild after its delete boundary. Another
            // connection must still see the old bindings until outer commit.
            await client.delete(companySecretBindings).where(and(eq(companySecretBindings.companyId, connection.companyId),
              eq(companySecretBindings.targetType, "tool_connection"), eq(companySecretBindings.targetId, connection.id)));
            entered();
            await held;
          }
          return original(database, connection, refs, client);
        });
        update = toolAccessService(db).updateConnection(lane.endpoint.connectionId, { name: "Renamed fixture", enabled: true });
        await rebuilding;
        expect(await bindings()).toEqual(before);
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(lane.maintenanceRequests).toEqual([]);
        release();
        await update;
        await vi.waitFor(async () => {
          expect(await db.select({ status: chatActions.status }).from(chatActions).where(and(
            eq(chatActions.endpointId, lane.endpoint.id), eq(chatActions.kind, "telegram_maintenance"),
            sql`${chatActions.payload}->>'operation' = 'stop_subscription'`,
          ))).toEqual([{ status: "processed" }]);
          expect(coordinator.nextWakeAt()).toBeNull();
        }, { timeout: 10_000 });
        expect(await bindings()).toEqual(before);
        expect(lane.maintenanceRequests.filter(x => x.method === "setWebhook")).toHaveLength(1);
        expect(onError).not.toHaveBeenCalled();
      } finally { release(); await update; spy.mockRestore(); await coordinator.stop(); await lane.close(); }
    });

    it.each(["endpoint", "connection"] as const)("parks pending Telegram subscription repair while its %s is inactive", async inactive => {
      const lane = await draftFixture();
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      const actions = () => db.select().from(chatActions).where(and(
        eq(chatActions.endpointId, lane.endpoint.id), eq(chatActions.kind, "telegram_maintenance"),
        sql`${chatActions.payload}->>'operation' = 'stop_subscription'`,
      ));
      try {
        await db.delete(chatActions).where(and(eq(chatActions.endpointId, lane.endpoint.id),
          eq(chatActions.kind, "telegram_stop_subscription")));
        lane.setSubscriptionInfo({});
        await lane.context.service.processTelegramSubscriptionDiscovery();
        expect(await actions()).toEqual([expect.objectContaining({ status: "received" })]);
        if (inactive === "endpoint") {
          await lane.context.service.configure(lane.endpoint.id, { action: "pause" }, "owner-user");
        } else {
          await toolAccessService(db).updateConnection(lane.endpoint.connectionId, { enabled: false });
        }
        await registerChatActionWork(coordinator, lane.context.service, () => true).ready;
        await vi.waitFor(() => {
          expect(coordinator.nextWakeAt()).toBeNull();
          expect(idleWorkSnapshot().active).toBe(0);
        }, { timeout: 10_000 });
        expect(await lane.context.service.nextChatActionAt("telegram_maintenance")).toBeNull();
        expect(lane.maintenanceRequests).toEqual([]);
        expect(await actions()).toEqual([expect.objectContaining({ status: "received" })]);
        const scans = vi.spyOn(db, "select");
        try {
          await new Promise(resolve => setTimeout(resolve, 250));
          expect(scans).not.toHaveBeenCalled();
        } finally { scans.mockRestore(); }
        if (inactive === "endpoint") {
          await lane.context.service.configure(lane.endpoint.id, { action: "resume" }, "owner-user");
        } else {
          await toolAccessService(db).updateConnection(lane.endpoint.connectionId, { enabled: true });
        }
        await vi.waitFor(async () => {
          const rows = await actions();
          expect(rows.filter(row => row.status === "processed")).toEqual([
            expect.objectContaining({ result: expect.objectContaining({ attempts: 1 }) }),
          ]);
          // Endpoint pause/resume advances its ownership generation. The old
          // obligation must settle without touching the provider again.
          expect(rows.filter(row => row.status !== "processed")).toEqual(inactive === "endpoint" ? [
            expect.objectContaining({ status: "cancelled", result: expect.objectContaining({ code: "telegram_maintenance_credentials_superseded" }) }),
          ] : []);
          expect(coordinator.nextWakeAt()).toBeNull();
          expect(idleWorkSnapshot().active).toBe(0);
        }, { timeout: 10_000 });
        expect(lane.maintenanceRequests.filter(x => x.method === "setWebhook")).toHaveLength(1);
        expect(onError).not.toHaveBeenCalled();
      } finally { await coordinator.stop(); await lane.close(); }
    });

    it("durably stops during the first draft RPC without cancelling a run, and never reuses its ID after restart", async () => {
      const lane = await draftFixture();
      try {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: lane.fixture.companyId,
          agentId: lane.fixture.assignedAgentId,
          status: "running",
          contextSnapshot: {},
        });
        const runsBefore = (await readHeartbeatRunsByCompanyId(lane.fixture.companyId))
          .toSorted((a, b) => a.id.localeCompare(b.id));
        let stoppedId = 0;
        lane.setHook(async (method, body) => {
          if (method.endsWith("Draft") && !stoppedId) {
            stoppedId = Number(body.draft_id);
            expect((await lane.deliver(stoppedId)).status).toBe(200);
          }
        });
        const publication = await lane.send("first-stopped");
        expect(publication).toMatchObject({
          state: "cancelled",
          providerMessageId: null,
          publishedAt: null,
          redactedError:
            "Telegram draft presentation was stopped. The saved answer and task are unchanged.",
        });
        expect(lane.requests.map((request) => request.method)).toEqual([
          "sendRichMessageDraft",
        ]);
        expect((await lane.actions())[0]).toMatchObject({
          status: "cancelled",
          result: { phase: "stopped" },
        });
        const [comment] = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.id, publication!.commentId!));
        expect(comment!.body).toContain("END-first-stopped");
        expect(
          (await readHeartbeatRunsByCompanyId(lane.fixture.companyId))
            .toSorted((a, b) => a.id.localeCompare(b.id)),
        ).toEqual(runsBefore);
        expect(lane.context.cancelRun).not.toHaveBeenCalled();
        expect(
          await lane.context.service.getPublicationBatchStatus(
            lane.endpoint.id,
            lane.conversation.id,
            publication!.id,
          ),
        ).toMatchObject({
          published: 0,
          total: 1,
          cancelled: 1,
          settled: 1,
          canDismiss: true,
        });
        await expect(
          lane.context.service.replayPublication(
            lane.endpoint.id,
            publication!.id,
          ),
        ).rejects.toThrow();
        expect((await lane.deliver(stoppedId)).status).toBe(200);
        await lane.restart();
        await lane.context.service.processPendingPublications();
        expect(lane.requests).toHaveLength(1);
        lane.setHook(async (method) => {
          if (method.endsWith("Draft"))
            expect((await lane.deliver(stoppedId)).status).toBe(200);
        });
        const next = await lane.send("successor");
        expect(next?.state).toBe("published");
        const actions = await lane.actions();
        expect(actions).toHaveLength(2);
        expect(actions[1]!.payload.draftId).not.toBe(stoppedId);
        expect(actions[1]).toMatchObject({
          status: "processed",
          result: {
            phase: "published",
            providerMessageId: next!.providerMessageId,
          },
        });
        expect(
          lane.requests.filter((request) => !request.method.endsWith("Draft")),
        ).toHaveLength(1);
      } finally {
        await lane.close();
      }
    });

    it("does not reuse an old draft ID after endpoint cascade deletion and same-bot re-binding", async () => {
      const original = await draftFixture();
      let originalClosed = false;
      let successor: Awaited<ReturnType<typeof draftFixture>> | undefined;
      try {
        let oldDraftId = 0;
        original.setHook(async (method, body) => {
          if (method.endsWith("Draft")) {
            oldDraftId = Number(body.draft_id);
            expect((await original.deliver(oldDraftId)).status).toBe(200);
          }
        });
        expect((await original.send("before-delete"))?.state).toBe("cancelled");
        await original.close();
        originalClosed = true;
        await db
          .delete(chatEndpoints)
          .where(eq(chatEndpoints.id, original.endpoint.id));
        expect(await original.actions()).toEqual([]);
        successor = await draftFixture(original.botId);
        successor.setHook(async (method) => {
          if (method.endsWith("Draft"))
            expect((await successor!.deliver(oldDraftId)).status).toBe(200);
        });
        expect((await successor.send("after-rebind"))?.state).toBe("published");
        const [newDraft] = await successor.actions();
        expect(Number(newDraft!.payload.draftId)).toBeGreaterThan(oldDraftId);
        expect(newDraft).toMatchObject({ result: { phase: "published" } });
        expect(
          successor.requests.filter(
            (request) => !request.method.endsWith("Draft"),
          ),
        ).toHaveLength(1);
      } finally {
        try {
          if (successor) await successor.close();
        } finally {
          if (!originalClosed) await original.close();
        }
      }
    });

    it.each(["missing", "generation"])(
      "sends ordinary complete output without Stop when subscription proof is %s",
      async (changed) => {
        const lane = await draftFixture();
        try {
          const [receipt] = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, lane.endpoint.id),
                eq(chatActions.kind, "telegram_stop_subscription"),
              ),
            );
          expect(receipt?.status).toBe("processed");
          if (changed === "missing")
            await db.delete(chatActions).where(eq(chatActions.id, receipt!.id));
          else
            await db
              .update(chatActions)
              .set({
                payload: {
                  ...receipt!.payload,
                  ...(changed === "bot"
                    ? { botUserId: String(lane.botId + 1) }
                    : changed === "generation"
                      ? {
                          runtimeGeneration:
                            Number(receipt!.payload.runtimeGeneration) + 1,
                        }
                      : changed === "fingerprint"
                        ? { credentialFingerprint: "stale" }
                        : { webhookUrlSha256: "0".repeat(64) }),
                },
              })
              .where(eq(chatActions.id, receipt!.id));
          const publication = await lane.send(`subscription-${changed}`);
          expect(publication?.state).toBe("published");
          expect(lane.requests).toHaveLength(1);
          expect(lane.requests[0]!.method.endsWith("Draft")).toBe(false);
          expect(JSON.stringify(lane.requests[0]!.body)).toContain(
            `END-subscription-${changed}`,
          );
          expect(lane.requests[0]!.body.can_stop).toBeUndefined();
          expect(await lane.actions()).toEqual([]);
          expect(lane.context.cancelRun).not.toHaveBeenCalled();
        } finally {
          await lane.close();
        }
      },
    );

    it.each(["false", 1])(
      "does not confirm a subscription from non-boolean ok=%s",
      async (ok) => {
        const lane = await draftFixture(undefined, ok);
        try {
          expect(
            await db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, lane.endpoint.id),
                  eq(chatActions.kind, "telegram_stop_subscription"),
                ),
              ),
          ).toEqual([]);
          const publication = await lane.send("malformed-subscription");
          expect(publication?.state).toBe("published");
          expect(lane.requests).toHaveLength(1);
          expect(lane.requests[0]!.method.endsWith("Draft")).toBe(false);
          expect(JSON.stringify(lane.requests[0]!.body)).toContain(
            "END-malformed-subscription",
          );
          expect(lane.requests[0]!.body.can_stop).toBeUndefined();
          expect(await lane.actions()).toEqual([]);
        } finally {
          await lane.close();
        }
      },
    );

    it.each(["explicit", "worker"] as const)(
      "automatically repairs an existing %s subscription after restart without dropping updates",
      async (mode) => {
        const shape = mode === "worker" ? "explicit" : mode;
        const lane = await draftFixture();
        const prefixIds: string[] = [];
        const onError = vi.fn();
        const coordinator = mode === "worker" ? createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError }) : null;
        try {
          // Scheduler-only fixtures model a full already-confirmed first page.
          // They have no credentials; no provider qualification is claimed for
          // these rows. The target still uses actual configure/runtime/Stop.
          const [templateEndpoint] = await readChatEndpointsById(lane.endpoint.id);
          const [templateConnection] = await readToolConnectionsById(lane.endpoint.connectionId);
          const fingerprint = createHash("sha256").update("[]").digest("hex");
          for (let index = 0; index < (mode === "worker" ? 105 : 25); index++) {
            const id = `00000000-${randomUUID().slice(9)}`;
            expect(id < lane.endpoint.id).toBe(true);
            const connectionId = randomUUID();
            const publicId = randomUUID();
            const botUserId = String(
              Number.parseInt(
                randomUUID().replaceAll("-", "").slice(0, 12),
                16,
              ),
            );
            const webhookUrlSha256 = createHash("sha256")
              .update(
                `https://paperclip.example/api/chat-webhooks/${publicId}/telegram`,
              )
              .digest("hex");
            await db.transaction(async (tx) => {
              await tx.insert(toolConnections).values({
                ...templateConnection!,
                id: connectionId,
                uid: `prefix-${connectionId}`,
                credentialRefs: [],
                credentialSecretRefs: [],
                config: {},
                transportConfig: {},
                status: "active",
                enabled: true,
              });
              await tx.insert(chatEndpoints).values({
                ...templateEndpoint!,
                id,
                connectionId,
                publicId,
                botExternalId: botUserId,
                botUsername: `prefix_${publicId}`,
                status: "active",
                setup: { ...templateEndpoint!.setup, runtimeGeneration: 1 } as InternalSetupState,
              });
              await tx.insert(chatActions).values({
                companyId: lane.fixture.companyId,
                endpointId: id,
                kind: "telegram_stop_subscription",
                providerActionId: `telegram-stop-subscription:1:${fingerprint}:${webhookUrlSha256}`,
                payload: {
                  version: 1,
                  botUserId,
                  runtimeGeneration: 1,
                  credentialFingerprint: fingerprint,
                  webhookUrlSha256,
                },
                status: "processed",
                result: { code: "telegram_stop_subscription_confirmed" },
              });
            });
            prefixIds.push(id);
          }
          await db
            .delete(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, lane.endpoint.id),
                eq(chatActions.kind, "telegram_stop_subscription"),
              ),
            );
          lane.setSubscriptionInfo(
            shape === "explicit"
              ? {}
              : { allowed_updates: shape === "empty" ? [] : undefined },
          );
          await lane.restart();
          const prefixReceipts = await db
            .select()
            .from(chatActions)
            .where(inArray(chatActions.endpointId, prefixIds))
            .orderBy(asc(chatActions.id));
          const eligible = await db
            .select({ id: chatEndpoints.id })
            .from(chatEndpoints)
            .innerJoin(
              toolConnections,
              and(
                eq(toolConnections.id, chatEndpoints.connectionId),
                eq(toolConnections.companyId, chatEndpoints.companyId),
              ),
            )
            .where(
              and(
                eq(chatEndpoints.provider, "telegram"),
                eq(chatEndpoints.status, "active"),
                eq(toolConnections.status, "active"),
                eq(toolConnections.enabled, true),
              ),
            )
            .orderBy(asc(chatEndpoints.id));
          const targetIndex = eligible.findIndex(
            ({ id }) => id === lane.endpoint.id,
          );
          expect(targetIndex).toBeGreaterThanOrEqual(mode === "worker" ? 105 : 25);
          const discoveryPasses = Math.floor(targetIndex / 25) + 1;
          const targetActions = () =>
            db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, lane.endpoint.id),
                  eq(chatActions.kind, "telegram_maintenance"),
                  sql`${chatActions.payload}->>'operation' = 'stop_subscription'`,
                ),
              );
          if (coordinator) {
            await registerChatActionWork(coordinator, lane.context.service, () => true).ready;
            // Startup recovery uses successive bounded pages. The target is
            // beyond a complete 100-row confirmed prefix and is not in page one.
            expect(await targetActions()).toEqual([]);
            await vi.waitFor(async () => {
              expect((await targetActions())[0]?.status).toBe("processed");
              expect(coordinator.nextWakeAt()).toBeNull();
            }, { timeout: 30_000 });
            expect(onError).not.toHaveBeenCalled();
          } else for (let page = 1; page <= discoveryPasses; page++) {
            await lane.context.service.processPendingDeliveries();
            if (page < discoveryPasses) {
              expect(await targetActions()).toEqual([]);
              expect(lane.maintenanceRequests).toEqual([]);
            }
          }
          const [discovered] = await targetActions();
          expect(discovered).toBeDefined();
          // Discovery and action execution have independent 25-row budgets.
          // Include every older unsettled action, even future retries, so the
          // finite bound does not assume this global outbox is otherwise empty.
          const olderActions = await db
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.kind, "telegram_maintenance"),
                sql`${chatActions.createdAt} <= ${new Date(discovered!.createdAt.getTime() + 1).toISOString()}::timestamptz`,
                inArray(chatActions.status, [
                  "received",
                  "processing",
                  "failed",
                ]),
              ),
            );
          for (
            let remaining = olderActions.length + 1;
            remaining > 0 &&
            !(await targetActions()).some(
              (action) => action.status === "processed",
            );
            remaining--
          )
            await lane.context.service.processPendingDeliveries();
          expect((await targetActions())[0]?.status).toBe("processed");
          expect(lane.maintenanceRequests.map(({ method }) => method)).toEqual([
            "getMe",
            "getWebhookInfo",
            "setWebhook",
            "getWebhookInfo",
          ]);
          expect(
            await db
              .select()
              .from(chatActions)
              .where(inArray(chatActions.endpointId, prefixIds))
              .orderBy(asc(chatActions.id)),
          ).toEqual(prefixReceipts);
          const mutations = lane.maintenanceRequests.filter(
            ({ method }) => method === "setWebhook",
          );
          expect(mutations).toHaveLength(1);
          if (coordinator) {
            // A committed edit must not rediscover another connection, even
            // when its durable proof is absent. Startup covers that inventory.
            const foreignEndpoint = prefixIds[0]!;
            await db.delete(chatActions).where(and(eq(chatActions.endpointId, foreignEndpoint),
              eq(chatActions.kind, "telegram_stop_subscription")));
            await toolAccessService(db).updateConnection(lane.endpoint.connectionId, { name: "Scoped Telegram edit" });
            await vi.waitFor(() => {
              expect(coordinator.nextWakeAt()).toBeNull();
              expect(idleWorkSnapshot().active).toBe(0);
            }, { timeout: 10_000 });
            expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, foreignEndpoint),
              eq(chatActions.kind, "telegram_maintenance")))).toEqual([]);
            expect(lane.maintenanceRequests.filter(({ method }) => method === "setWebhook")).toHaveLength(1);
          }
          expect(mutations[0]!.body).toEqual({
            url: lane.configuredWebhook.url,
            secret_token: lane.configuredWebhook.secret_token,
            max_connections: 37,
            drop_pending_updates: false,
            allowed_updates:
              shape === "explicit"
                ? [
                    "message",
                    "message_reaction",
                    "future_update",
                    "stopped_message_generation",
                  ]
                : [],
          });
          expect(
            await db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, lane.endpoint.id),
                  eq(chatActions.kind, "telegram_stop_subscription"),
                ),
              ),
          ).toHaveLength(1);
          lane.setHook(async (method, body) => {
            if (method.endsWith("Draft"))
              expect((await lane.deliver(Number(body.draft_id))).status).toBe(
                200,
              );
          });
          expect((await lane.send(`upgraded-${shape}`))?.state).toBe(
            "cancelled",
          );
          expect(lane.requests.map(({ method }) => method)).toEqual([
            "sendRichMessageDraft",
          ]);
          await lane.context.service.processPendingDeliveries();
          expect(
            lane.maintenanceRequests.filter(
              ({ method }) => method === "setWebhook",
            ),
          ).toHaveLength(1);
        } finally {
          try {
            await coordinator?.stop();
            if (prefixIds.length)
              await db
                .update(chatEndpoints)
                .set({ status: "archived", archivedAt: new Date() })
                .where(
                  and(
                    eq(chatEndpoints.companyId, lane.fixture.companyId),
                    inArray(chatEndpoints.id, prefixIds),
                  ),
                );
          } finally {
            await lane.close();
          }
        }
      },
    );

    it.each([
      "foreign_url",
      "wrong_bot",
      "changed_generation",
      "disabled_connection",
    ])(
      "keeps ordinary output when automatic subscription repair is unsafe: %s",
      async (mode) => {
        const lane = await draftFixture();
        try {
          await db
            .delete(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, lane.endpoint.id),
                eq(chatActions.kind, "telegram_stop_subscription"),
              ),
            );
          lane.setSubscriptionInfo(
            mode === "foreign_url"
              ? { url: "https://elsewhere.example/callback" }
              : mode === "certificate"
                ? { has_custom_certificate: true }
                : mode === "malformed_updates"
                  ? { allowed_updates: null }
                  : mode === "malformed_max"
                    ? { max_connections: 101 }
                    : {},
          );
          let getCount = 0;
          lane.setMaintenanceHook(async (method) => {
            if (method === "getMe" && mode === "wrong_bot")
              return Response.json({
                ok: true,
                result: { id: lane.botId + 1, is_bot: true },
              });
            if (method === "setWebhook" && mode === "nonboolean_ok")
              return Response.json({ ok: "false", result: true });
            if (method === "setWebhook" && mode === "missing_result")
              return Response.json({ ok: true });
            if (method === "getWebhookInfo") {
              getCount++;
              if (mode === "contradictory_get" && getCount === 2)
                return Response.json({
                  ok: true,
                  result: {
                    url: lane.configuredWebhook.url,
                    has_custom_certificate: false,
                    max_connections: 37,
                    allowed_updates: [
                      "message",
                      "message_reaction",
                      "future_update",
                    ],
                  },
                });
              if (mode === "changed_generation") {
                const [current] = await readChatEndpointsById(lane.endpoint.id);
                await db
                  .update(chatEndpoints)
                  .set({
                    setup: {
                      ...current!.setup,
                      runtimeGeneration:
                        Number((current!.setup as InternalSetupState).runtimeGeneration) + 1,
                    } as InternalSetupState,
                  })
                  .where(eq(chatEndpoints.id, lane.endpoint.id));
              }
              if (mode === "disabled_connection")
                await db
                  .update(toolConnections)
                  .set({ enabled: false })
                  .where(eq(toolConnections.id, lane.endpoint.connectionId));
            }
            return undefined;
          });
          await lane.processSubscriptionAttempt();
          expect(
            await db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, lane.endpoint.id),
                  eq(chatActions.kind, "telegram_stop_subscription"),
                ),
              ),
          ).toEqual([]);
          expect(
            lane.maintenanceRequests.filter(
              ({ method }) => method === "setWebhook",
            ),
          ).toHaveLength(
            ["nonboolean_ok", "missing_result", "contradictory_get"].includes(
              mode,
            )
              ? 1
              : 0,
          );
          if (mode !== "changed_generation" && mode !== "disabled_connection") {
            expect((await lane.send(`unconfirmed-${mode}`))?.state).toBe(
              "published",
            );
            expect(lane.requests).toHaveLength(1);
            expect(lane.requests[0]!.method.endsWith("Draft")).toBe(false);
            expect(JSON.stringify(lane.requests[0]!.body)).toContain(
              `END-unconfirmed-${mode}`,
            );
          }
          expect(await lane.actions()).toEqual([]);
          expect(lane.context.cancelRun).not.toHaveBeenCalled();
        } finally {
          await lane.close();
        }
      },
    );

    it("retries an unknown subscription mutation after restart using freshly observed options, not a recovered confirmation flag", async ({ onTestFailed }) => {
      let phase = "create fixture";
      onTestFailed(() => {
        console.error(`Telegram subscription recovery failed during: ${phase}`);
      });
      const lane = await draftFixture();
      try {
        await db
          .delete(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, lane.endpoint.id),
              eq(chatActions.kind, "telegram_stop_subscription"),
            ),
          );
        lane.setSubscriptionInfo({});
        lane.setMaintenanceHook(async (method) => {
          if (method === "setWebhook")
            throw new Error("Synthetic unknown subscription response");
          return undefined;
        });
        phase = "first subscription attempt";
        await lane.processSubscriptionAttempt();
        const [action] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, lane.endpoint.id),
              eq(chatActions.kind, "telegram_maintenance"),
              sql`${chatActions.payload}->>'operation' = 'stop_subscription'`,
            ),
          );
        expect(action).toMatchObject({
          status: "failed",
          result: { retryable: true, providerConfirmed: false },
        });
        // Keep the retry pending until the explicit post-restart transition below.
        // A busy runner can otherwise exhaust the real one-second backoff here.
        await db
          .update(chatActions)
          .set({
            result: { ...action!.result, retryAt: "2099-01-01T00:00:00.000Z" },
          })
          .where(eq(chatActions.id, action!.id));
        phase = "ordinary publication before restart";
        expect((await lane.send("unknown-subscription"))?.state).toBe(
          "published",
        );
        expect(lane.requests).toHaveLength(1);
        expect(lane.requests[0]!.method.endsWith("Draft")).toBe(false);
        phase = "pending recovery before restart";
        await lane.context.service.processPendingDeliveries();
        expect(
          lane.maintenanceRequests.filter(
            ({ method }) => method === "setWebhook",
          ),
        ).toHaveLength(1);
        phase = "restart";
        await lane.restart();
        lane.setSubscriptionInfo({
          allowed_updates: ["message", "chat_member"],
        });
        lane.setMaintenanceHook(undefined);
        await db
          .update(chatActions)
          .set({
            result: {
              ...action!.result,
              providerConfirmed: true,
              retryAt: new Date(0).toISOString(),
            },
          })
          .where(eq(chatActions.id, action!.id));
        phase = "concurrent recovery after restart";
        await Promise.all([
          lane.context.service.processPendingDeliveries(),
          lane.context.service.processPendingDeliveries(),
        ]);
        phase = "verify recovered subscription";
        const mutations = lane.maintenanceRequests.filter(
          ({ method }) => method === "setWebhook",
        );
        expect(mutations).toHaveLength(2);
        expect(mutations[1]!.body.allowed_updates).toEqual([
          "message",
          "chat_member",
          "stopped_message_generation",
        ]);
        const [receipt] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, lane.endpoint.id),
              eq(chatActions.kind, "telegram_stop_subscription"),
            ),
          );
        expect(receipt?.status).toBe("processed");
        const serialized = JSON.stringify(receipt);
        expect(serialized).not.toContain(lane.configuredWebhook.url);
        expect(serialized).not.toContain(lane.configuredWebhook.secret_token);
        lane.requests.length = 0;
        lane.setHook(async (method, body) => {
          if (method.endsWith("Draft"))
            expect((await lane.deliver(Number(body.draft_id))).status).toBe(
              200,
            );
        });
        phase = "publication after subscription recovery";
        expect((await lane.send("repaired-after-unknown"))?.state).toBe(
          "cancelled",
        );
        phase = "close fixture";
      } finally {
        await lane.close();
      }
    });

    it("returns 503 on failed Stop commit and accepts the exact verified retry before final send", async () => {
      const lane = await draftFixture();
      const suffix = randomUUID().replaceAll("-", "");
      const functionName = `stop_fail_${suffix}`;
      const triggerName = `stop_trigger_${suffix}`;
      let created = false;
      try {
        let checked = false;
        lane.setHook(async (method, body) => {
          if (!method.endsWith("Draft") || checked) return;
          checked = true;
          const [action] = await lane.actions();
          await db.execute(
            sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
              IF NEW.id = '${action!.id}'::uuid AND NEW.result->>'phase' = 'stopped' THEN RAISE EXCEPTION 'synthetic stop commit fault'; END IF;
              RETURN NEW; END $$`),
          );
          await db.execute(
            sql.raw(
              `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON chat_actions FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
            ),
          );
          created = true;
          expect(
            (await lane.deliver(Number(body.draft_id), {}, true, 1777)).status,
          ).toBe(503);
          expect((await lane.actions())[0]).toMatchObject({
            status: "processing",
            result: { phase: "drafting" },
          });
          await db.execute(
            sql.raw(`DROP TRIGGER ${triggerName} ON chat_actions`),
          );
          await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
          created = false;
          expect(
            (await lane.deliver(Number(body.draft_id), {}, true, 1777)).status,
          ).toBe(200);
        });
        expect((await lane.send("commit-retry"))?.state).toBe("cancelled");
        expect(checked).toBe(true);
        expect(lane.requests.map((request) => request.method)).toEqual([
          "sendRichMessageDraft",
        ]);
        expect((await lane.actions())[0]).toMatchObject({
          result: { phase: "stopped", updateId: 1777 },
        });
      } finally {
        try {
          if (created) {
            await db.execute(
              sql.raw(`DROP TRIGGER ${triggerName} ON chat_actions`),
            );
            await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
          }
        } finally {
          await lane.close();
        }
      }
    });

    it("preserves an uncertain final after restart and a late Stop without automatic replay", async () => {
      const lane = await draftFixture();
      try {
        let draftId = 0;
        lane.setHook(async (method, body) => {
          if (method.endsWith("Draft")) draftId = Number(body.draft_id);
          else throw new TypeError("fetch failed");
        });
        const publication = await lane.send("unknown-final");
        expect(publication).toMatchObject({
          state: "delivery_unknown",
          providerMessageId: null,
          publishedAt: null,
        });
        expect((await lane.actions())[0]).toMatchObject({
          status: "processing",
          result: { phase: "final_sending" },
        });
        const before = lane.requests.length;
        lane.setHook(undefined);
        await lane.restart();
        expect((await lane.deliver(draftId)).status).toBe(200);
        await lane.context.service.processPendingPublications();
        expect(lane.requests).toHaveLength(before);
        const [current] = await readChatPublicationsById(publication!.id);
        expect(current!.state).toBe("delivery_unknown");
        await expect(
          lane.context.service.replayPublication(
            lane.endpoint.id,
            publication!.id,
          ),
        ).rejects.toThrow();
        expect(lane.context.cancelRun).not.toHaveBeenCalled();
      } finally {
        await lane.close();
      }
    });

    it.each(["bot", "connection"])(
      "refuses a retained Stop and later final after current %s authority changes",
      async (changed) => {
        const lane = await draftFixture();
        try {
          let checked = false;
          lane.setHook(async (method, body) => {
            if (!method.endsWith("Draft") || checked) return;
            checked = true;
            const [action] = await lane.actions();
            const [endpoint] = await readChatEndpointsById(lane.endpoint.id);
            if (changed === "bot")
              await db
                .update(chatEndpoints)
                .set({ botExternalId: String(lane.botId + 1) })
                .where(eq(chatEndpoints.id, lane.endpoint.id));
            if (changed === "generation")
              await db
                .update(chatEndpoints)
                .set({
                  setup: {
                    ...endpoint!.setup,
                    runtimeGeneration:
                      Number((endpoint!.setup as InternalSetupState).runtimeGeneration ?? 0) + 1,
                  } as InternalSetupState,
                })
                .where(eq(chatEndpoints.id, lane.endpoint.id));
            if (changed === "connection")
              await db
                .update(toolConnections)
                .set({ enabled: false })
                .where(eq(toolConnections.id, endpoint!.connectionId));
            if (changed === "source")
              await db
                .update(chatPublications)
                .set({ payload: { text: "Changed current source" } })
                .where(
                  eq(
                    chatPublications.id,
                    String(action!.payload.publicationId),
                  ),
                );
            expect(
              (
                await lane.deliver(
                  Number(body.draft_id),
                  {},
                  true,
                  undefined,
                  true,
                )
              ).status,
            ).toBe(200);
            expect((await lane.actions())[0]).toMatchObject({
              status: "processing",
              result: { phase: "drafting" },
            });
          });
          const publication = await lane.send(`changed-${changed}`);
          expect(checked).toBe(true);
          expect(publication!.state).not.toBe("published");
          expect(publication!.state).not.toBe("cancelled");
          expect(
            lane.requests.every((request) => request.method.endsWith("Draft")),
          ).toBe(true);
          expect(lane.context.cancelRun).not.toHaveBeenCalled();
        } finally {
          await lane.close();
        }
      },
    );

    it.each([
      "wrong_chat",
      "late_final",
    ])(
      "does not withdraw an unowned or already-claimed final (%s)",
      async (mode) => {
        const lane = await draftFixture();
        try {
          let draftId = 0;
          lane.setHook(async (method, body) => {
            if (method.endsWith("Draft")) draftId = Number(body.draft_id);
            if ((mode === "late_final") === !method.endsWith("Draft")) {
              const patch =
                mode === "wrong_chat"
                  ? { chat: { id: 444, type: "private" } }
                  : mode === "wrong_topic"
                    ? { message_thread_id: 43 }
                    : {};
              const result = await lane.deliver(
                mode === "wrong_draft"
                  ? (draftId % 2_147_483_647) + 1
                  : draftId,
                patch,
                mode !== "wrong_secret",
              );
              expect(result.status).toBe(mode === "wrong_secret" ? 403 : 200);
            }
          });
          const publication = await lane.send(mode);
          expect(publication?.state).toBe("published");
          expect(
            lane.requests.filter(
              (request) => !request.method.endsWith("Draft"),
            ),
          ).toHaveLength(1);
          expect((await lane.actions())[0]).toMatchObject({
            status: "processed",
            result: { phase: "published" },
          });
          expect(lane.context.cancelRun).not.toHaveBeenCalled();
        } finally {
          await lane.close();
        }
      },
    );
  });
});
