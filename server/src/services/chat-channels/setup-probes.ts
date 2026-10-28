import { notifyChatConnectionHealth } from "./connection-health-notifications.js";
import type { ConnectionManagementContext } from "../connection-management.js";
import type { EndpointRow, DbOrTransaction } from "./runtime-types.js";

import { notifyChatEndpointWork } from "../chat-work-notifications.js";

import { chatCredentialMutationLease } from "../chat-credential-mutation-lease.js";

import { githubChatManagementService } from "../chat-github-management.js";

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  heartbeatRuns,
  issueComments,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpoint,
  ChatEndpointSetupState,
} from "@paperclipai/shared";

import {
  conflict,
  forbidden,
  notFound,
} from "../../errors.js";

import {
  logActivity,
} from "../activity-log.js";

import {
  githubRunReplyState,
} from "../chat-run-publications.js";

import type { EndpointRecord } from "./runtime-types.js";

type SetupProbesOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  fetchImpl: typeof fetch;
  findAuthorizedIdentityLink: (endpoint: EndpointRow, userId: string) => Promise<{ id: string } | null>;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  lockCurrentPrincipalAuthorization: (tx: DbOrTransaction, endpoint: EndpointRow, principalId: string) => Promise<{ allowed: boolean }>;
  get: (endpointId: string) => Promise<ChatEndpoint>;
  setupTestActivationBarrier?: () => Promise<void>;
};

export function createSetupProbes(db: Db, options: SetupProbesOptions) {
  const { endpointRecord, withCredentialMutationLease, fetchImpl, findAuthorizedIdentityLink, runtimeGeneration, lockCurrentPrincipalAuthorization, get } = options;


  async function setupTestStatus(endpointId: string, userId: string) {
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const startedAt = record.endpoint.setup.testStartedAt;
    if (!startedAt) return { messageReceivedAt: null };
    const links = await db.select({ principalId: chatIdentityLinks.principalId }).from(chatIdentityLinks).where(and(
      eq(chatIdentityLinks.companyId, record.endpoint.companyId), eq(chatIdentityLinks.endpointId, endpointId),
      eq(chatIdentityLinks.paperclipUserId, userId), eq(chatIdentityLinks.status, "linked"),
    ));
    if (!links.length) return { messageReceivedAt: null };
    const principalIds = links.map((link) => link.principalId);
    const [delivery, command] = await Promise.all([
      db.select({ at: chatDeliveries.createdAt }).from(chatDeliveries).where(and(
        eq(chatDeliveries.companyId, record.endpoint.companyId), eq(chatDeliveries.endpointId, endpointId),
        inArray(chatDeliveries.principalId, principalIds), gte(chatDeliveries.createdAt, new Date(startedAt)),
        inArray(chatDeliveries.eventKind, ["message", "mention"]),
      )).orderBy(asc(chatDeliveries.createdAt)).limit(1).then((rows) => rows[0]),
      db.select({ at: chatActions.createdAt }).from(chatActions).where(and(
        eq(chatActions.companyId, record.endpoint.companyId), eq(chatActions.endpointId, endpointId),
        inArray(chatActions.principalId, principalIds), eq(chatActions.kind, "slash_task_start"), gte(chatActions.createdAt, new Date(startedAt)),
      )).orderBy(asc(chatActions.createdAt)).limit(1).then((rows) => rows[0]),
    ]);
    const at = [delivery?.at, command?.at].filter((value): value is Date => Boolean(value)).sort((a, b) => a.getTime() - b.getTime())[0];
    return { messageReceivedAt: at?.toISOString() ?? null };
  }

  async function test(endpointId: string, finishOptions?: { optionalSlackTestForUser: string }, managementContext?: ConnectionManagementContext) {
    await managementContext?.reauthorize();
    const initial = await endpointRecord(endpointId);
    if (!initial) throw notFound("Chat endpoint not found");
    return withCredentialMutationLease(
      initial.endpoint,
      async (credentialLease) => {
        // Reload only after owning the same lane as reconnect, pause, removal,
        // and credential rotation. Qualification and activation must describe
        // one exact provider runtime, never a setup snapshot that a concurrent
        // reconnect has already superseded.
        const record = await endpointRecord(endpointId);
        if (!record) throw notFound("Chat endpoint not found");
        const endpoint = record.endpoint;
        if (endpoint.status !== "verifying" || endpoint.setup.step !== "test") {
          throw conflict("This connection is not waiting for a setup test", {
            code: "chat_endpoint_not_testing",
          });
        }
        if (endpoint.provider === "github" && endpoint.setup.github) {
          const verified = await githubChatManagementService(db, fetchImpl).verification(endpoint.id);
          if (!verified.ready && !(finishOptions?.optionalSlackTestForUser && verified.connectionReady)) throw conflict("Finish verifying the App, repositories, and assigned agent's tools before activating this bot", { checks: verified.checks });
        }
        const testStartedAtValue = endpoint.setup.testStartedAt;
        const testStartedAt = testStartedAtValue
          ? new Date(testStartedAtValue)
          : null;
        const optionalSlackTest = Boolean(finishOptions?.optionalSlackTestForUser);
        if (optionalSlackTest) {
          if (!["slack", "github"].includes(endpoint.provider) || !endpoint.setup.webhookVerifiedAt || !endpoint.providerAccountId) {
            throw conflict("Verify the connection before finishing setup");
          }
          const linked = await findAuthorizedIdentityLink(endpoint, finishOptions!.optionalSlackTestForUser);
          if (!linked) throw forbidden("Connect your account before finishing setup");
        }
        if (!optionalSlackTest) {
          if (
            !endpoint.lastEventAt ||
            !testStartedAtValue ||
            !testStartedAt ||
            Number.isNaN(testStartedAt.getTime()) ||
            endpoint.lastEventAt < testStartedAt
          ) {
            throw conflict(
              "Send the test message in the provider before completing setup",
              {
                code: "chat_test_message_missing",
              },
            );
          }
          const requiredTrigger =
            ["telegram", "imessage-photon"].includes(endpoint.provider)
              ? "direct_message"
              : "subscribed_message";
          const qualifyingDelivery = await db
            .select({
              id: chatDeliveries.id,
              conversationId: chatDeliveries.conversationId,
              processedAt: chatDeliveries.processedAt,
            })
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.companyId, endpoint.companyId),
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(chatDeliveries.state, "processed"),
                gte(chatDeliveries.processedAt, testStartedAt),
                sql`${chatDeliveries.normalizedEvent}->>'trigger' = ${requiredTrigger}`,
              ),
            )
            .orderBy(desc(chatDeliveries.processedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (
            !qualifyingDelivery?.conversationId ||
            !qualifyingDelivery.processedAt
          ) {
            throw conflict(
              ["telegram", "imessage-photon"].includes(endpoint.provider)
                ? "Send the test direct message before completing setup"
                : "Reply once without mentioning the agent before completing setup",
              { code: "chat_test_follow_up_missing" },
            );
          }
          const finalPublication = await db
            .select({
              commentId: chatPublications.commentId,
              payload: chatPublications.payload,
            })
            .from(chatPublications)
            .innerJoin(
              issueComments,
              and(
                eq(issueComments.id, chatPublications.commentId),
                eq(issueComments.companyId, chatPublications.companyId),
                eq(issueComments.issueId, chatPublications.issueId),
                eq(issueComments.authorType, "agent"),
                eq(issueComments.authorAgentId, endpoint.assignedAgentId),
              ),
            )
            .innerJoin(
              chatMessageLinks,
              and(
                eq(chatMessageLinks.companyId, chatPublications.companyId),
                eq(chatMessageLinks.endpointId, chatPublications.endpointId),
                eq(
                  chatMessageLinks.conversationId,
                  chatPublications.conversationId,
                ),
                eq(chatMessageLinks.deliveryId, qualifyingDelivery.id),
                eq(chatMessageLinks.direction, "inbound"),
                isNotNull(chatMessageLinks.commentId),
              ),
            )
            .innerJoin(
              heartbeatRuns,
              and(
                eq(heartbeatRuns.id, issueComments.createdByRunId),
                eq(heartbeatRuns.companyId, chatPublications.companyId),
                eq(heartbeatRuns.agentId, endpoint.assignedAgentId),
                eq(heartbeatRuns.status, "succeeded"),
                eq(
                  sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
                  sql<string>`${chatPublications.issueId}::text`,
                ),
                or(
                  sql`${chatMessageLinks.commentId}::text = ${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`,
                  sql`${chatMessageLinks.commentId}::text = ${heartbeatRuns.contextSnapshot} ->> 'commentId'`,
                  sql`coalesce(${heartbeatRuns.contextSnapshot} -> 'wakeCommentIds', '[]'::jsonb) ? ${chatMessageLinks.commentId}::text`,
                ),
              ),
            )
            .where(
              and(
                eq(chatPublications.companyId, endpoint.companyId),
                eq(chatPublications.endpointId, endpoint.id),
                eq(
                  chatPublications.conversationId,
                  qualifyingDelivery.conversationId,
                ),
                eq(chatPublications.state, "published"),
                gte(chatPublications.publishedAt, qualifyingDelivery.processedAt),
              ),
            )
            .orderBy(desc(chatPublications.publishedAt))
            .then((rows) =>
              rows.find(
                (row) =>
                  row.payload.interactionId === undefined &&
                  row.payload.progressState === undefined &&
                  row.commentId !== null,
              ),
            );
          let githubToolReply = false;
          if (!finalPublication && endpoint.provider === "github") {
            const setupRuns = await db.select({ id: heartbeatRuns.id, issueId: chatConversations.issueId })
              .from(heartbeatRuns)
              .innerJoin(chatMessageLinks, and(
                eq(chatMessageLinks.companyId, endpoint.companyId),
                eq(chatMessageLinks.endpointId, endpoint.id),
                eq(chatMessageLinks.deliveryId, qualifyingDelivery.id),
                eq(chatMessageLinks.direction, "inbound"),
                or(
                  sql`${chatMessageLinks.commentId}::text = ${heartbeatRuns.contextSnapshot}->>'wakeCommentId'`,
                  sql`coalesce(${heartbeatRuns.contextSnapshot}->'wakeCommentIds', '[]'::jsonb) ? ${chatMessageLinks.commentId}::text`,
                ),
              ))
              .innerJoin(chatConversations, and(
                eq(chatConversations.id, qualifyingDelivery.conversationId),
                eq(chatConversations.id, chatMessageLinks.conversationId),
                eq(chatConversations.companyId, endpoint.companyId),
                sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${chatConversations.issueId}::text`,
              ))
              .where(and(eq(heartbeatRuns.companyId, endpoint.companyId),
                eq(heartbeatRuns.agentId, endpoint.assignedAgentId), eq(heartbeatRuns.status, "succeeded")))
              .orderBy(desc(heartbeatRuns.createdAt)).limit(20);
            for (const run of setupRuns) {
              if (await githubRunReplyState(db, { companyId: endpoint.companyId, endpointId: endpoint.id,
                issueId: run.issueId, runId: run.id }) === "confirmed") {
                githubToolReply = true;
                break;
              }
            }
          }
          if (!finalPublication && !githubToolReply) {
            throw conflict(
              "Wait for the Paperclip agent to reply to the setup turn before completing setup",
              {
                code: "chat_test_round_trip_incomplete",
              },
            );
          }
        }
        await options.setupTestActivationBarrier?.();
        await managementContext?.reauthorize();
        const expectedGeneration = runtimeGeneration(endpoint.setup);
        await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          if (optionalSlackTest) {
            const linked = await tx.select({ principalId: chatIdentityLinks.principalId }).from(chatIdentityLinks).where(and(
              eq(chatIdentityLinks.endpointId, endpoint.id), eq(chatIdentityLinks.paperclipUserId, finishOptions!.optionalSlackTestForUser), eq(chatIdentityLinks.status, "linked"),
            )).limit(1).then((rows) => rows[0]);
            if (!linked || !(await lockCurrentPrincipalAuthorization(tx, endpoint, linked.principalId)).allowed) throw forbidden("Your connected account is no longer authorized");
          }
          await notifyChatEndpointWork(tx, endpoint.connectionId);
          const [activated] = await tx
            .update(chatEndpoints)
            .set({
              status: "active",
              setup: {
                ...endpoint.setup,
                step: "complete",
                testStartedAt: null,
                testSkipped: optionalSlackTest,
              },
              healthMessage: optionalSlackTest ? "Connected; conversation test optional" : "Connected",
              activatedAt: endpoint.activatedAt ?? new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatEndpoints.id, endpointId),
                eq(chatEndpoints.status, "verifying"),
                sql`${chatEndpoints.setup}->>'step' = 'test'`,
                sql`coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0) = ${expectedGeneration}`,
                sql`${chatEndpoints.setup}->>'testStartedAt' = ${testStartedAtValue}`,
              ),
            )
            .returning({ id: chatEndpoints.id });
          if (!activated) {
            throw conflict("This setup test was superseded by a reconnect", {
              code: "chat_endpoint_test_superseded",
            });
          }
          await notifyChatConnectionHealth(tx, endpoint);
          await tx
            .update(toolConnections)
            .set({
              status: "active",
              enabled: true,
              healthStatus: "healthy",
              healthMessage: optionalSlackTest ? "Connected; conversation test optional" : "Connected",
              lastError: null,
              healthCheckedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(toolConnections.id, endpoint.connectionId));
          if (optionalSlackTest) await logActivity(tx as unknown as Db, {
            companyId: endpoint.companyId, ...(managementContext?.audit ?? { actorType: "user" as const, actorId: finishOptions!.optionalSlackTestForUser }),
            action: "chat.setup_completed", entityType: "chat_endpoint", entityId: endpointId,
            details: { conversationTestOptional: true },
          });
          await credentialLease.assertOwned(tx);
        });
        return get(endpointId);
      },
    );
  }
  return { setupTestStatus, test };
}
