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

describeEmbeddedPostgres("chat channels: github lifecycle and revocation", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const rf = createRetryFixtures(h, gh);
  const { seedCompany, readChatConversationsByEndpointId, readChatEndpointsById, readIssueCommentsByIssueId, readChatDeliveriesByEndpointId, readHeartbeatRunsById, readChatActionsById, readChatPublicationsByEndpointId, readChatActionsByProviderActionId, readHeartbeatRunsByCompanyId, readAgentWakeupRequestsById, createService, createStorageService, retirePublicationFixture, chatWakeContext, addSelectedChatFinal, qualifySetupRoundTrip, deliverMessage } = h;
  const { signedGitHubWebhookRequest, configuredGitHubEndpoint, deliverLegacyGitHubReceipt, attachFakeGitHubIssueCommentWebhook } = gh;
  const { failedChatRetryFixture, currentGitHubTaskRetryFixture, successfulGitHubQueuedInputFixture, failedReviewedGitHubRetryFixture, githubOmissionFixture } = rf;

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
