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

describeEmbeddedPostgres("chat channels: telegram first-seen controls", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const { seedCompany, readChatEndpointsById, readChatDeliveriesById, readHeartbeatRunsById, readChatPublicationsById, readToolConnectionsById, readChatPublicationsByCommentId, readChatActionsByProviderActionId, readChatPublicationsByIdempotencyKey, readHeartbeatRunsByCompanyId, createService, retirePublicationFixture, chatWakeContext, addSelectedChatFinal, qualifySetupRoundTrip, configuredSlackEndpoint, configuredTeamsEndpoint, configuredTelegramEndpoint, deliverMessage, waitForProcessedReceiptRemoval } = h;

  describe("first-seen messages behind completed chat controls", () => {
    async function chronologyFixture(
      provider: "slack" | "telegram",
      overrides: Parameters<typeof configuredTelegramEndpoint>[1] = {},
      sameCompany?: Awaited<ReturnType<typeof seedCompany>>,
    ) {
      const fixture = sameCompany ?? (await seedCompany());
      const configured =
        provider === "slack"
          ? await configuredSlackEndpoint(fixture, overrides)
          : await configuredTelegramEndpoint(fixture, overrides);
      const { callbacks, endpoint, service, wakeup } = configured;
      const chatId = provider === "slack" ? "D09LATECONTROL" : "77119981";
      const userId = provider === "slack" ? "U-LATE-CONTROL" : chatId;
      const thread = makeThread({
        id: provider === "slack" ? `slack:${chatId}:` : `telegram:${chatId}`,
        channelId: chatId,
        isDM: true,
        name: "Late control source",
      }).thread;
      const controlSecond = Math.floor(Date.now() / 1_000) - 10;
      const admit = async (
        sequence: number,
        second: number,
        text: string,
        destination = thread,
        trigger: ChatSdkMessageTrigger = "direct_message",
      ) => {
        const sentAt = new Date(second * 1_000);
        const providerMessageId =
          provider === "slack"
            ? `${second}.${String(sequence).padStart(6, "0")}`
            : `${chatId}:${sequence}`;
        const message = makeMessage({
          id: providerMessageId,
          text,
          userId,
          raw:
            provider === "slack"
              ? { ts: providerMessageId, user: userId, text }
              : {
                  message_id: sequence,
                  date: second,
                  chat: { id: Number(chatId), type: "private" },
                  from: { id: Number(userId), is_bot: false },
                  text,
                },
        });
        message.metadata.dateSent =
          provider === "slack"
            ? new Date(Number(providerMessageId) * 1_000)
            : sentAt;
        const currentCallbacks =
          configured.runtime.configurations.get(endpoint.id)?.callbacks ??
          callbacks;
        await deliverMessage({
          callbacks: currentCallbacks,
          endpointId: endpoint.id,
          provider,
          thread: destination,
          message,
          trigger,
        });
        const [delivery] = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${providerMessageId}`,
              sql`${chatDeliveries.normalizedEvent}->'conversation'->>'externalThreadId' = ${destination.id}`,
            ),
          );
        if (!delivery) throw new Error("Expected exact provider source receipt");
        await service.processPendingDeliveries(25, delivery.id);
        return readChatDeliveriesById(delivery.id)
          .then((rows) => rows[0]!);
      };
      await admit(100, controlSecond - 5, "Initial task before control");
      await qualifySetupRoundTrip(service, endpoint.id, userId);
      await service.test(endpoint.id);
      let commandSequence = 200;
      const control = async (command: "close" | "new", publish = true) => {
        await callbacks.onSlashCommand!({
          endpointId: endpoint.id,
          provider,
          event: {
            command:
              provider === "slack"
                ? String(endpoint.setup.command)
                : `/${command}`,
            text: provider === "slack" ? command : "",
            triggerId: randomUUID(),
            channel: {
              id: provider === "slack" ? `slack:${chatId}` : thread.id,
              isDM: true,
              name: "Late control source",
            } as never,
            user: {
              userId,
              userName: "late-control-user",
              fullName: "Late Control User",
              isBot: false,
              isMe: false,
              isSystem: false,
            },
            raw:
              provider === "slack"
                ? {
                    command: endpoint.setup.command,
                    text: command,
                    channel_id: chatId,
                    user_id: userId,
                  }
                : {
                    message_id: commandSequence++,
                    date: controlSecond,
                    chat: { id: Number(chatId), type: "private" },
                    from: { id: Number(userId), is_bot: false },
                    text: `/${command}`,
                    entities: [
                      {
                        offset: 0,
                        length: command.length + 1,
                        type: "bot_command",
                      },
                    ],
                  },
            adapter: {} as never,
            openModal: async () => undefined,
          },
        });
        if (publish) await service.processPendingPublications();
        const [publication] = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              like(chatPublications.idempotencyKey, `control:${command}:%`),
            ),
          )
          .orderBy(desc(chatPublications.createdAt));
        expect(publication).toMatchObject({
          state: publish ? "published" : "pending",
        });
        if (publish)
          expect((await service.listConversations(endpoint.id))[0]?.state).toBe(
            "completed",
          );
        return publication!;
      };
      const snapshot = async () => ({
        issues: await db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.companyId, fixture.companyId))
          .orderBy(asc(issues.id)),
        conversations: await db
          .select({
            id: chatConversations.id,
            state: chatConversations.state,
            generation: chatConversations.sessionGeneration,
          })
          .from(chatConversations)
          .where(eq(chatConversations.endpointId, endpoint.id))
          .orderBy(asc(chatConversations.id)),
        comments: await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.companyId, fixture.companyId))
          .orderBy(asc(issueComments.id)),
        actions: await db
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "inbound_wakeup"),
            ),
          )
          .orderBy(asc(chatActions.id)),
        wakeCount: wakeup.mock.calls.length,
      });
      return {
        ...configured,
        fixture,
        thread,
        userId,
        chatId,
        controlSecond,
        admit,
        control,
        snapshot,
        close: () => retirePublicationFixture(service, endpoint.id),
      };
    }

    it.each([
      ["slack", "close", false],
      ["telegram", "close", true],
      ["telegram", "new", false],
    ] as const)(
      "refuses unseen %s input before %s (same second: %s) without creating work",
      async (provider, command, sameSecond) => {
        const f = await chronologyFixture(provider);
        try {
          const control = await f.control(command);
          const before = await f.snapshot();
          const delayed = await f.admit(
            199,
            f.controlSecond - (sameSecond ? 0 : 1),
            "Delayed old input, not a fresh request",
          );
          expect(delayed.receivedAt.getTime()).toBeGreaterThan(
            control.publishedAt!.getTime(),
          );
          expect(delayed.state).toBe("filtered");
          expect(delayed.conversationId).toBeNull();
          expect(await f.snapshot()).toEqual(before);
          const freshSecond =
            provider === "telegram" && sameSecond
              ? f.controlSecond
              : Math.floor(Date.now() / 1_000) + 1;
          if (freshSecond * 1_000 > Date.now())
            await vi.waitFor(
              () =>
                expect(Date.now()).toBeGreaterThanOrEqual(freshSecond * 1_000),
              { timeout: 1_500, interval: 10 },
            );
          const fresh = await f.admit(
            201,
            freshSecond,
            "A genuinely later explicit request",
          );
          expect(fresh.state).toBe("processed");
          const afterFresh = await f.snapshot();
          expect(afterFresh.issues).toHaveLength(before.issues.length + 1);
          expect(afterFresh.wakeCount).toBe(before.wakeCount + 1);
          expect(afterFresh.conversations).toContainEqual(
            expect.objectContaining({ state: "active", generation: 2 }),
          );
          const olderIntoNewGeneration = await f.admit(
            198,
            f.controlSecond - 1,
            "Another unseen old message after the new generation",
          );
          expect(olderIntoNewGeneration.state).toBe("filtered");
          expect(await f.snapshot()).toEqual(afterFresh);
        } finally {
          await f.close();
        }
      },
    );

    it.each(["slack", "telegram"] as const)(
      "accepts delayed %s backlog without an explicit control",
      async (provider) => {
        const f = await chronologyFixture(provider);
        try {
          const before = await f.snapshot();
          const delivery = await f.admit(
            99,
            f.controlSecond - 20,
            "Legitimate delayed backlog on the same active task",
          );
          expect(delivery.state).toBe("processed");
          const after = await f.snapshot();
          expect(after.issues).toEqual(before.issues);
          expect(after.conversations).toEqual(before.conversations);
          expect(after.comments).toHaveLength(before.comments.length + 1);
          expect(after.wakeCount).toBe(before.wakeCount + 1);
        } finally {
          await f.close();
        }
      },
    );

    it("rechecks a close committed while old input waits before the endpoint transaction", async () => {
      let arm = false;
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = await chronologyFixture("telegram", {
        reachAuthorizationBarrier: async () => {
          if (arm) {
            entered();
            await gate;
          }
        },
      });
      let input: ReturnType<typeof f.admit> | undefined;
      try {
        await f.control("close", false);
        arm = true;
        input = f.admit(
          199,
          f.controlSecond - 1,
          "Old input held before current authority transaction",
        );
        await waiting;
        await f.service.processPendingPublications();
        const before = await f.snapshot();
        expect(before.conversations[0]?.state).toBe("completed");
        release();
        expect((await input).state).toBe("filtered");
        expect(await f.snapshot()).toEqual(before);
      } finally {
        release();
        await input;
        await f.close();
      }
    });

    it("honors operator-confirmed close without inventing an outbound message receipt", async () => {
      const f = await chronologyFixture("telegram");
      try {
        const publication = await f.control("close", false);
        const providerRuntime = f.runtime.endpoints.get(f.endpoint.id)!;
        providerRuntime.postError = new Error(
          "connection closed after provider acceptance became unknown",
        );
        await f.service.processPendingPublications();
        const [unknown] = await readChatPublicationsById(publication.id);
        expect(unknown).toMatchObject({
          state: "delivery_unknown",
          providerMessageId: null,
        });
        providerRuntime.postError = null;
        await f.service.resolvePublication(
          f.endpoint.id,
          publication.id,
          "mark_delivered",
          "owner-user",
        );
        const [receipt] = await readChatActionsByProviderActionId(`task-control-authorization:${publication.id}`);
        expect(receipt).toMatchObject({
          status: "processed",
          result: { code: "task_control_marked_delivered_by_operator" },
        });
        expect(
          await db
            .select()
            .from(chatMessageLinks)
            .where(eq(chatMessageLinks.publicationId, publication.id)),
        ).toEqual([]);
        const before = await f.snapshot();
        expect(
          (
            await f.admit(
              199,
              f.controlSecond - 1,
              "Old input after operator confirmation",
            )
          ).state,
        ).toBe("filtered");
        expect(await f.snapshot()).toEqual(before);
      } finally {
        await f.close();
      }
    });

    it.each(["slack", "telegram"] as const)(
      "does not promote metadata-only %s timestamps after a completed control",
      async (provider) => {
        const f = await chronologyFixture(provider);
        try {
          await f.control("close");
          const before = await f.snapshot();
          const message = makeMessage({
            id:
              provider === "slack"
                ? `${Math.floor(Date.now() / 1_000)}.000777`
                : `${f.chatId}:777`,
            raw: provider === "slack" ? {} : { message_id: 777 },
            text: "Metadata now is not provider chronology",
            userId: f.userId,
          });
          await deliverMessage({
            callbacks: f.callbacks,
            endpointId: f.endpoint.id,
            provider,
            thread: f.thread,
            message,
            trigger: "direct_message",
          });
          expect(await f.snapshot()).toEqual(before);
          const [delivery] = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, f.endpoint.id),
                sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${message.id}`,
              ),
            );
          expect(delivery).toMatchObject({
            state: "filtered",
            normalizedEvent: expect.objectContaining({
              message: expect.objectContaining({ providerSentAt: null }),
            }),
          });
          expect(delivery?.redactedError).toContain("Send a new request");
        } finally {
          await f.close();
        }
      },
    );

    it("continues to accept authenticated Slack slash close/new on a genuinely new generation", async () => {
      const f = await chronologyFixture("slack");
      try {
        await f.control("close");
        const freshSecond = Math.floor(Date.now() / 1_000) + 1;
        await vi.waitFor(
          () => expect(Date.now()).toBeGreaterThanOrEqual(freshSecond * 1_000),
          { timeout: 1_500, interval: 10 },
        );
        expect(
          (
            await f.admit(
              901,
              freshSecond,
              "A fresh task before native slash new",
            )
          ).state,
        ).toBe("processed");
        await f.control("new");
        const controls = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, f.endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'admission'->>'origin' = 'slack_slash_control'`,
            ),
          );
        expect(controls).toHaveLength(2);
        expect(controls.every((control) => control.state === "processed")).toBe(
          true,
        );
        expect(
          (await f.snapshot()).conversations.every(
            (conversation) => conversation.state === "completed",
          ),
        ).toBe(true);
      } finally {
        await f.close();
      }
    });

    it("keeps controls scoped to their endpoint, immutable thread, and company", async () => {
      const f = await chronologyFixture("slack");
      const others: Awaited<ReturnType<typeof chronologyFixture>>[] = [];
      try {
        await f.control("close");
        const otherThread = makeThread({
          id: `${f.thread.id}111.000001`,
          channelId: f.chatId,
          isDM: true,
          name: "Independent DM thread",
        }).thread;
        expect(
          (
            await f.admit(
              299,
              f.controlSecond - 1,
              "Independent thread backlog",
              otherThread,
            )
          ).state,
        ).toBe("processed");
        others.push(await chronologyFixture("slack", {}, f.fixture));
        others.push(await chronologyFixture("slack"));
        for (const independent of others) {
          expect(
            (
              await independent.admit(
                299,
                f.controlSecond - 1,
                "Independent endpoint or tenant backlog",
              )
            ).state,
          ).toBe("processed");
        }
      } finally {
        for (const independent of others) await independent.close();
        await f.close();
      }
    });

    it("does not recreate or filter a previously committed inbound link when its delivery retries after close", async () => {
      const f = await chronologyFixture("telegram");
      try {
        const accepted = await f.admit(
          101,
          f.controlSecond - 2,
          "Already accepted before the close",
        );
        await f.control("close");
        const before = await f.snapshot();
        const links = await db
          .select()
          .from(chatMessageLinks)
          .where(eq(chatMessageLinks.deliveryId, accepted.id));
        await db
          .update(chatDeliveries)
          .set({ state: "retry", nextAttemptAt: new Date(0) })
          .where(eq(chatDeliveries.id, accepted.id));
        await f.service.processPendingDeliveries(25, accepted.id);
        const [retried] = await readChatDeliveriesById(accepted.id);
        // Existing current-access recovery refuses this now-closed source. The
        // first-seen filter must not erase or recreate its already saved work.
        expect(retried).toMatchObject({
          state: "failed",
          conversationId: accepted.conversationId,
        });
        expect(retried?.redactedError).toContain("no longer authorized");
        expect(
          await db
            .select()
            .from(chatMessageLinks)
            .where(eq(chatMessageLinks.deliveryId, accepted.id)),
        ).toEqual(links);
        expect(await f.snapshot()).toEqual(before);
      } finally {
        await f.close();
      }
    });

    it.each(["close", "new"] as const)(
      "does not let an unseen old Telegram /%s close a newer generation",
      async (command) => {
        const f = await chronologyFixture("telegram");
        try {
          await f.control("close");
          expect(
            (
              await f.admit(
                201,
                f.controlSecond + 1,
                "Fresh generation after close",
              )
            ).state,
          ).toBe("processed");
          const before = await f.snapshot();
          expect(
            (await f.admit(198, f.controlSecond - 1, `/${command}`)).state,
          ).toBe("filtered");
          await f.service.processPendingPublications();
          expect(await f.snapshot()).toEqual(before);
        } finally {
          await f.close();
        }
      },
    );

    it("retains a committed control boundary through pause, redacted duplicate, and resume", async () => {
      const f = await chronologyFixture("telegram");
      try {
        const control = await f.control("close");
        const [originalAuthorization] = await readChatActionsByProviderActionId(`task-control-authorization:${control.id}`);
        await f.service.configure(
          f.endpoint.id,
          { action: "pause" },
          "owner-user",
        );
        const duplicate = await f.admit(
          200,
          f.controlSecond,
          "/close",
          f.thread,
          "mention",
        );
        expect(duplicate).toMatchObject({
          state: "processed",
          principalId: originalAuthorization!.principalId,
          normalizedEvent: expect.objectContaining({
            filtering: { contentRetained: false },
          }),
        });
        expect(duplicate.normalizedEvent.message).not.toHaveProperty("text");
        expect(duplicate.eventKind).toBe("direct_message");
        expect(duplicate.normalizedEvent.kind).toBe("mention");
        await f.service.configure(
          f.endpoint.id,
          { action: "resume" },
          "owner-user",
        );
        const before = await f.snapshot();
        expect(
          (
            await f.admit(
              199,
              f.controlSecond - 1,
              "Old source after resumed redacted control",
            )
          ).state,
        ).toBe("filtered");
        expect(await f.snapshot()).toEqual(before);
        const freshSecond = Math.floor(Date.now() / 1_000) + 1;
        await vi.waitFor(
          () => expect(Date.now()).toBeGreaterThanOrEqual(freshSecond * 1_000),
          { timeout: 1_500, interval: 10 },
        );
        expect(
          (await f.admit(201, freshSecond, "Fresh request after resumed control"))
            .state,
        ).toBe("processed");
        const [retained] = await readChatDeliveriesById(duplicate.id);
        expect(retained?.normalizedEvent).toEqual(duplicate.normalizedEvent);
        expect(control.publishedAt).not.toBeNull();
      } finally {
        await f.close();
      }
    });

    it("retains a completed trailing-newline control as a first-seen source boundary", async () => {
      const f = await chronologyFixture("telegram");
      try {
        const delivery = await f.admit(200, f.controlSecond, "/close\n");
        await f.service.processPendingPublications();
        const [control] = await readChatPublicationsByIdempotencyKey(`control:close:${delivery.id}`);
        expect(control?.state).toBe("published");
        expect((await f.service.listConversations(f.endpoint.id))[0]?.state).toBe(
          "completed",
        );
        const before = await f.snapshot();
        expect(
          (
            await f.admit(
              199,
              f.controlSecond - 1,
              "Old input after a valid newline-terminated close",
            )
          ).state,
        ).toBe("filtered");
        expect(await f.snapshot()).toEqual(before);
      } finally {
        await f.close();
      }
    });

    it.each([false, true])(
      "preserves a Teams close across regional routes (close after route change: %s)",
      async (closeAfterRouteChange) => {
        const fixture = await seedCompany();
        const f = await configuredTeamsEndpoint(fixture);
        try {
          const conversationId = "19:late-control-route@thread.v2";
          const base = `teams:${Buffer.from(conversationId).toString("base64url")}`;
          const oldId = `${base}:${Buffer.from("https://smba.trafficmanager.net/amer/").toString("base64url")}`;
          const oldThread = makeThread({
            id: oldId,
            channelId: oldId,
            isDM: true,
          }).thread;
          const currentThread = makeThread({
            id: base,
            channelId: base,
            isDM: true,
          }).thread;
          const controlTime = new Date(Date.now() - 10_000);
          const receive = async (
            thread: Thread,
            id: string,
            time: Date,
            text: string,
          ) => {
            await deliverMessage({
              callbacks: f.callbacks,
              endpointId: f.endpoint.id,
              provider: "microsoft-teams",
              thread,
              trigger: "direct_message",
              message: makeMessage({
                id,
                userId: "teams-late-user",
                text,
                raw: {
                  timestamp: time.toISOString(),
                  serviceUrl:
                    thread.id === oldId
                      ? "https://smba.trafficmanager.net/amer/"
                      : "https://smba.trafficmanager.net/emea/",
                  from: { aadObjectId: "teams-late-user" },
                },
              }),
            });
            return db
              .select()
              .from(chatDeliveries)
              .where(
                and(
                  eq(chatDeliveries.endpointId, f.endpoint.id),
                  sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${id}`,
                ),
              )
              .then((rows) => rows[0]!);
          };
          await receive(
            oldThread,
            "teams-source-1",
            new Date(controlTime.getTime() - 5_000),
            "Initial Teams task",
          );
          await qualifySetupRoundTrip(
            f.service,
            f.endpoint.id,
            "teams-late-user",
          );
          await f.service.test(f.endpoint.id);
          await receive(
            closeAfterRouteChange ? currentThread : oldThread,
            "teams-close-2",
            controlTime,
            "/close",
          );
          await f.service.processPendingPublications();
          expect(
            (await f.service.listConversations(f.endpoint.id))[0]?.state,
          ).toBe("completed");
          const before = f.wakeup.mock.calls.length;
          expect(
            (
              await receive(
                currentThread,
                "teams-delayed-3",
                new Date(controlTime.getTime() - 1_000),
                "Old Teams request after close",
              )
            ).state,
          ).toBe("filtered");
          expect(f.wakeup).toHaveBeenCalledTimes(before);
          expect(await f.service.listConversations(f.endpoint.id)).toHaveLength(
            1,
          );
          expect(
            (
              await receive(
                currentThread,
                "teams-fresh-4",
                new Date(controlTime.getTime() + 1_000),
                "Fresh Teams request",
              )
            ).state,
          ).toBe("processed");
          expect(f.wakeup).toHaveBeenCalledTimes(before + 1);
          expect(await f.service.listConversations(f.endpoint.id)).toHaveLength(
            2,
          );
        } finally {
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );

    it("does not lower a newer provider boundary when an older close is confirmed later", async () => {
      const f = await chronologyFixture("telegram");
      try {
        const older = await f.control("close", false);
        const providerRuntime = f.runtime.endpoints.get(f.endpoint.id)!;
        providerRuntime.postError = new Error(
          "older control confirmation response lost",
        );
        await f.service.processPendingPublications();
        const [unknown] = await readChatPublicationsById(older.id);
        expect(unknown?.state).toBe("delivery_unknown");
        providerRuntime.postError = null;
        // FIFO correctly blocks later publications in this old conversation.
        // A normal Board task completion lets fresh DM work start a separate
        // generation; its control can complete before the old unknown result
        // receives a delayed operator confirmation.
        if (!older.issueId) throw new Error("Expected the old control task");
        await issueService(db).update(older.issueId, {
          status: "done",
          actorUserId: "owner-user",
        });
        const replacement = await f.admit(
          275,
          f.controlSecond + 1,
          "Start independently after Board task completion",
        );
        expect(replacement.state).toBe("processed");
        expect(replacement.conversationId).not.toBe(older.conversationId);
        await f.admit(300, f.controlSecond + 5, "/close");
        await f.service.processPendingPublications();
        const controls = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, f.endpoint.id),
              like(chatPublications.idempotencyKey, "control:close:%"),
            ),
          );
        expect(controls).toHaveLength(2);
        expect(controls.find((control) => control.id !== older.id)?.state).toBe(
          "published",
        );
        await f.service.resolvePublication(
          f.endpoint.id,
          older.id,
          "mark_delivered",
          "owner-user",
        );
        const [lastConfirmed] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, f.endpoint.id),
              eq(chatActions.kind, "task_control_authorization"),
            ),
          )
          .orderBy(desc(chatActions.updatedAt));
        expect(lastConfirmed?.payload.publicationId).toBe(older.id);
        const before = await f.snapshot();
        expect(
          (
            await f.admit(
              250,
              f.controlSecond + 2,
              "Between the older and newer provider controls",
            )
          ).state,
        ).toBe("filtered");
        expect(await f.snapshot()).toEqual(before);
        expect(
          (await f.admit(301, f.controlSecond + 6, "After both provider controls"))
            .state,
        ).toBe("processed");
      } finally {
        await f.close();
      }
    });

    it.each([
      "unprocessed_authorization",
      "unprocessed_source",
      "unbound_control_key",
    ] as const)(
      "does not infer a stop from bare completed state with %s",
      async (mode) => {
        const f = await chronologyFixture("telegram");
        try {
          const control = await f.control("close");
          if (mode === "unprocessed_authorization")
            await db
              .update(chatActions)
              .set({ status: "issued" })
              .where(
                eq(
                  chatActions.providerActionId,
                  `task-control-authorization:${control.id}`,
                ),
              );
          else if (mode === "unprocessed_source")
            await db
              .update(chatDeliveries)
              .set({ state: "failed" })
              .where(
                eq(chatDeliveries.id, control.idempotencyKey.split(":")[2]!),
              );
          else
            await db
              .update(chatPublications)
              .set({ idempotencyKey: `control:close:${randomUUID()}` })
              .where(eq(chatPublications.id, control.id));
          expect(
            (
              await f.admit(
                199,
                f.controlSecond - 1,
                "A bare completed row is not an explicit control proof",
              )
            ).state,
          ).toBe("processed");
        } finally {
          await f.close();
        }
      },
    );
  });
});
