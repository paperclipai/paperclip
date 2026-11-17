import { notifyChatResponseAvailability } from "../../chat-response-availability.js";
import { notifyChatPublicationWork } from "../../chat-work-notifications.js";

import { unresolvedSlackPublicationCondition } from "../../connectors/slack-publication.js";

import { settleExternalConversation } from "../../slack-conversation-lifecycle.js";

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatEndpointLeases,
  chatEndpoints,
  chatPublications,
  chatTeamsFileTransfers,
} from "@paperclipai/db";

import { logger } from "../../../middleware/logger.js";

import { publicationTransportOrderKey, publicationPrecedes } from "./order.js";
import type { createChatPublicationWorker } from "./worker.js";
type PublicationQueueOptions = {
  PUBLICATION_ENDPOINT_CONCURRENCY: number;
  enqueueInboundWakeupPublications: () => Promise<unknown>;
  processPendingInteractionWakeups: (limit?: number) => Promise<number>;
  reconcileTerminalConfirmationActions: (limit?: number) => Promise<number>;
  processSelectedPublication: ReturnType<typeof createChatPublicationWorker>["processSelectedPublication"];
  publicationEndpointTasks: Map<string, Promise<void>>;
  teamsFileRetryAfter: Map<string, number>;
  redactError: (error: unknown) => string;
  isShuttingDown: () => boolean;
  wakePublications: () => void;
};
export function createChatPublicationQueue(db: Db, options: PublicationQueueOptions) {
  const { PUBLICATION_ENDPOINT_CONCURRENCY, enqueueInboundWakeupPublications, processPendingInteractionWakeups, reconcileTerminalConfirmationActions, processSelectedPublication, publicationEndpointTasks, teamsFileRetryAfter, redactError, wakePublications, isShuttingDown } = options;


  function publicationEligibility({ now, busyEndpointIds = [], coolingTeamsPublicationIds = [], attemptedIds = [] }: { now?: Date; busyEndpointIds?: string[]; coolingTeamsPublicationIds?: string[]; attemptedIds?: string[] } = {}) {
    const earlierPublication = alias(chatPublications, "earlier_chat_publications");
    return and(
      sql`not (${unresolvedSlackPublicationCondition()})`,
      // An explicit Board send promises both delivery and work. Keep
      // its text/files pending until the durable wake has been accepted.
      sql`not exists (select 1 from chat_actions a where a.company_id = ${chatPublications.companyId} and a.endpoint_id = ${chatPublications.endpointId} and a.conversation_id = ${chatPublications.conversationId} and a.kind = 'slack_board_message' and a.status = 'received' and a.payload->>'commentId' = ${chatPublications.commentId}::text)`,
      or(
        and(
          sql`not exists (select 1 from chat_endpoints e where e.id = ${chatPublications.endpointId} and e.publication_mode = 'explicit')`,
          inArray(chatPublications.state, ["pending", "retry"]),
          notExists(
            db
              .select({ id: chatTeamsFileTransfers.id })
              .from(chatTeamsFileTransfers)
              .where(
                and(
                  eq(
                    chatTeamsFileTransfers.companyId,
                    chatPublications.companyId,
                  ),
                  eq(
                    chatTeamsFileTransfers.publicationId,
                    chatPublications.id,
                  ),
                ),
              ),
          ),
        ),
        // Dedicated protocol work shares the endpoint concurrency cap,
        // never the ordinary publication claim or resend implementation.
        sql`exists (${db
          .select({ id: chatTeamsFileTransfers.id })
          .from(chatTeamsFileTransfers)
          .where(
            and(
              eq(
                chatTeamsFileTransfers.companyId,
                chatPublications.companyId,
              ),
              eq(
                chatTeamsFileTransfers.endpointId,
                chatPublications.endpointId,
              ),
              eq(
                chatTeamsFileTransfers.conversationId,
                chatPublications.conversationId,
              ),
              eq(
                chatTeamsFileTransfers.publicationId,
                chatPublications.id,
              ),
              sql`exists (${db
                .select({ id: chatEndpoints.id })
                .from(chatEndpoints)
                .where(
                  and(
                    eq(chatEndpoints.id, chatPublications.endpointId),
                    eq(
                      chatEndpoints.companyId,
                      chatPublications.companyId,
                    ),
                    eq(chatEndpoints.provider, "microsoft-teams"),
                    eq(chatEndpoints.status, "active"),
                  ),
                )})`,
              or(
                inArray(chatTeamsFileTransfers.phase, [
                  "consent_pending",
                  "upload_pending",
                  "file_info_pending",
                ]),
                and(
                  eq(chatTeamsFileTransfers.phase, "consent_unknown"),
                  isNotNull(chatTeamsFileTransfers.responseActivityId),
                  sql`${chatTeamsFileTransfers.privateState}->'response' is not null`,
                ),
              ),
            ),
          )})`,
      ),
      busyEndpointIds.length > 0
        ? notInArray(chatPublications.endpointId, busyEndpointIds)
        : undefined,
      coolingTeamsPublicationIds.length > 0
        ? notInArray(chatPublications.id, coolingTeamsPublicationIds)
        : undefined,
      // Inactive endpoints must not consume the eligibility page or
      // acquire an artificial retry deadline. When an operator resumes
      // them, due work is immediately eligible; genuine provider retry
      // deadlines below remain unchanged.
      notExists(
        db
          .select({ id: chatEndpoints.id })
          .from(chatEndpoints)
          .where(
            and(
              eq(chatEndpoints.id, chatPublications.endpointId),
              inArray(chatEndpoints.status, ["paused", "attention"]),
            ),
          ),
      ),
      now ? or(isNull(chatPublications.nextAttemptAt), lte(chatPublications.nextAttemptAt, now)) : undefined,
      attemptedIds.length > 0
        ? notInArray(chatPublications.id, attemptedIds)
        : undefined,
      notExists(
        db
          .select({ id: earlierPublication.id })
          .from(earlierPublication)
          .where(
            and(
              eq(
                earlierPublication.conversationId,
                chatPublications.conversationId,
              ),
              publicationPrecedes(earlierPublication, chatPublications),
              inArray(earlierPublication.state, [
                "pending",
                "retry",
                "streaming",
                "delivery_unknown",
              ]),
            ),
          ),
      ),
    );
  }

  async function processPendingPublications(
    limit = 25,
    { waitForCompletion = true, maintenance = true, scope, canContinue = () => true }: {
      waitForCompletion?: boolean; maintenance?: boolean; canContinue?: () => boolean;
      scope?: { companyId: string; endpointId: string; conversationId: string };
    } = {},
  ) {
    if (isShuttingDown() || !canContinue()) return 0;
    if (maintenance) {
      await enqueueInboundWakeupPublications();
      await reconcileTerminalConfirmationActions(limit);
    }
    if (isShuttingDown() || !canContinue()) return 0;
    const scopeCondition = scope ? and(eq(chatPublications.companyId, scope.companyId),
      eq(chatPublications.endpointId, scope.endpointId), eq(chatPublications.conversationId, scope.conversationId)) : undefined;
    const pendingTasks = () => scope
      ? [publicationEndpointTasks.get(scope.endpointId)].filter((task): task is Promise<void> => Boolean(task))
      : [...publicationEndpointTasks.values()];
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 60_000);
    // A process that disappears after the provider accepted a post but before
    // Paperclip persisted its message id leaves an ambiguous delivery. Never
    // resend it automatically; an operator can explicitly replay after
    // checking the provider conversation.
    const quarantinedPublications = await db.transaction(async tx => {
      const condition = and(
        scopeCondition,
        sql`not exists (select 1 from chat_endpoints e where e.id = ${chatPublications.endpointId} and e.publication_mode = 'explicit')`,
        eq(chatPublications.state, "streaming"),
        lte(chatPublications.updatedAt, staleBefore),
        // Teams owns separate staged I/O intents and a longer attempt lease.
        // Only that protocol may recover/quarantine its in-flight stages.
        notExists(
          db
            .select({ id: chatTeamsFileTransfers.id })
            .from(chatTeamsFileTransfers)
            .where(
              and(
                eq(
                  chatTeamsFileTransfers.companyId,
                  chatPublications.companyId,
                ),
                eq(chatTeamsFileTransfers.publicationId, chatPublications.id),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: chatEndpointLeases.id })
            .from(chatEndpointLeases)
            .where(
              and(
                eq(chatEndpointLeases.companyId, chatPublications.companyId),
                eq(
                  chatEndpointLeases.endpointId,
                  chatPublications.endpointId,
                ),
                sql`${chatEndpointLeases.leaseKey} = 'publication:' || ${chatPublications.id}::text || ':' || ${chatPublications.attempts}::text`,
                gt(chatEndpointLeases.expiresAt, now),
              ),
            ),
        ),
      );
      const candidates = await tx.select({ id: chatPublications.id, companyId: chatPublications.companyId, issueId: chatPublications.issueId })
        .from(chatPublications).where(condition).for("update", { skipLocked: true });
      if (!candidates.length) return [];
      await notifyChatPublicationWork(tx);
      for (const candidate of candidates) await notifyChatResponseAvailability(tx, candidate);
      return tx
        .update(chatPublications)
        .set({
          state: "delivery_unknown",
          nextAttemptAt: null,
          redactedError:
            "Provider delivery could not be confirmed after the worker stopped. Check the external conversation before replaying.",
          updatedAt: now,
        })
        .where(
          and(condition, inArray(chatPublications.id, candidates.map(row => row.id))),
        )
        .returning({ id: chatPublications.id });
    });
    if (quarantinedPublications.length > 0) {
      await db
        .update(chatActions)
        .set({
          status: "delivery_unknown",
          result: {
            code: "task_control_delivery_unknown",
            retryable: false,
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(chatActions.kind, "task_control_authorization"),
            eq(chatActions.status, "processing"),
            inArray(
              chatActions.providerActionId,
              quarantinedPublications.map(
                (publication) => `task-control-authorization:${publication.id}`,
              ),
            ),
          ),
        );
    }
    const attemptedIds: string[] = [];
    const ownedTasks = new Set<Promise<void>>();
    let failed = false;
    let firstError: unknown;
    try {
      while (attemptedIds.length < limit && !failed && !isShuttingDown() && canContinue()) {
        if (publicationEndpointTasks.size >= PUBLICATION_ENDPOINT_CONCURRENCY) {
          if (!waitForCompletion) break;
          await Promise.race(publicationEndpointTasks.values());
          continue;
        }
        const busyEndpointIds = [...publicationEndpointTasks.keys()];
        for (const [id, retryAfter] of teamsFileRetryAfter)
          if (retryAfter <= Date.now()) teamsFileRetryAfter.delete(id);
        const coolingTeamsPublicationIds = [...teamsFileRetryAfter.keys()];
        // Select only each conversation's current head before applying the
        // global limit. Re-query after every batch so one invocation can still
        // drain a conversation's newly unblocked milestones in FIFO order.
        const rows = await db
          .select()
          .from(chatPublications)
          .where(
            and(scopeCondition, publicationEligibility({ now, busyEndpointIds, coolingTeamsPublicationIds, attemptedIds })),
          )
          .orderBy(
            asc(chatPublications.createdAt),
            asc(publicationTransportOrderKey(chatPublications)),
          )
          .limit(limit - attemptedIds.length);
        if (rows.length === 0) {
          // The query excluded the busy-endpoint snapshot above. A worker
          // may have completed while PostgreSQL selected this empty page,
          // exposing a new head that must be queried before declaring idle.
          if (busyEndpointIds.some((id) => !publicationEndpointTasks.has(id)))
            continue;
          const pending = pendingTasks();
          if (!waitForCompletion || pending.length === 0) break;
          await Promise.race(pending);
          continue;
        }
        let started = false;
        for (const selectedPublication of rows) {
          if (
            publicationEndpointTasks.size >= PUBLICATION_ENDPOINT_CONCURRENCY ||
            attemptedIds.length >= limit ||
            failed ||
            (isShuttingDown() || !canContinue())
          )
            break;
          if (publicationEndpointTasks.has(selectedPublication.endpointId))
            continue;
          attemptedIds.push(selectedPublication.id);
          started = true;
          // Reserve synchronously before provider work; overlapping drains share
          // this cap. Different conversations for one bot keep the existing
          // endpoint-exclusive credential fence instead of timing out behind it.
          const task = Promise.resolve()
            .then(async () => {
              if (isShuttingDown() || !canContinue()) return;
              await processSelectedPublication(selectedPublication);
              await settleExternalConversation(db, selectedPublication.companyId, selectedPublication.issueId).catch((err) => {
                logger.warn({ err, publicationId: selectedPublication.id }, "Slack conversation settlement deferred to reconciliation");
              });
            })
            .catch((error: unknown) => {
              if (!failed) {
                failed = true;
                firstError = error;
              }
              if (!waitForCompletion) {
                logger.error(
                  {
                    endpointId: selectedPublication.endpointId,
                    publicationId: selectedPublication.id,
                    error: redactError(error),
                  },
                  "scheduled chat publication worker failed",
                );
              }
            })
            .finally(() => {
              if (
                publicationEndpointTasks.get(selectedPublication.endpointId) ===
                task
              ) {
                publicationEndpointTasks.delete(selectedPublication.endpointId);
              }
              ownedTasks.delete(task);
              wakePublications();
            });
          publicationEndpointTasks.set(selectedPublication.endpointId, task);
          ownedTasks.add(task);
        }
        // Re-query while slots remain: one busy endpoint must not fill the
        // candidate page and hide later eligible endpoints behind its backlog.
        if (!started && publicationEndpointTasks.size > 0) {
          if (!waitForCompletion) break;
          await Promise.race(publicationEndpointTasks.values());
        }
      }
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    } finally {
      // Observe rejection immediately above and join every started worker
      // before this invocation returns or propagates its original failure.
      if (waitForCompletion) await Promise.all(ownedTasks);
    }
    if (failed) throw firstError;
    if (maintenance) await processPendingInteractionWakeups(limit);
    return attemptedIds.length;
  }
  return { processPendingPublications, publicationEligibility };
}
