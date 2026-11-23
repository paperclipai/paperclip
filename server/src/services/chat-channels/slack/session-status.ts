import type { EndpointRow, DbTransaction, DbOrTransaction, LifecycleRuntimeFence } from "../../chat-channels/runtime-types.js";

import { dueChatAction } from "../../chat-action-work.js";

import { notifyChatActionWork } from "../../chat-work-notifications.js";

import { chatCredentialMutationLease } from "../../chat-credential-mutation-lease.js";

import {
  randomUUID,
} from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatPublications,
  heartbeatRuns,
} from "@paperclipai/db";

import { logger } from "../../../middleware/logger.js";

import {
  setSlackSessionStatus,
  slackSessionStatusForPublication,
} from "../../chat-slack-sessions.js";
import {
  slackSessionSyncPayload,
} from "../../chat-slack-session-outbox.js";

import { classifyChatPublicationError } from "../../chat-publication-errors.js";

import type { EndpointRecord } from "../runtime-types.js";

type SlackSessionStatusOptions = {
  endpointRecord: (id: string) => Promise<EndpointRecord | null>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: typeof chatEndpointResources.$inferSelect | null | undefined) => boolean;
  runIdFromMilestonePublication: (publication: typeof chatPublications.$inferSelect) => string | null;
  resolveCredentials: (endpoint: EndpointRow, database?: DbOrTransaction) => Promise<Record<string, string>>;
  fetchImpl: typeof globalThis.fetch;
  redactError: (error: unknown) => string;
  slackSessionSyncSelectionBarrier?: () => Promise<void>;
};

export function createSlackSessionStatus(db: Db, options: SlackSessionStatusOptions) {
  const { endpointRecord, withCredentialMutationLease, runtimeCallbackEndpoint, nonDirectDestinationAllowed, runIdFromMilestonePublication, resolveCredentials, fetchImpl, redactError } = options;


  async function processPendingSlackSessionSyncs(
    limit = 25,
    onlyActionId?: string,
  ) {
    const now = new Date();
    const actions = await db
      .select({ action: chatActions })
      .from(chatActions)
      .leftJoin(chatEndpoints, and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
      .where(and(
        onlyActionId ? eq(chatActions.id, onlyActionId) : undefined,
        dueChatAction("slack_session_sync", now.getTime()),
      ))
      .orderBy(asc(chatActions.updatedAt))
      .limit(limit)
      .then(rows => rows.map(row => row.action));
    await options.slackSessionSyncSelectionBarrier?.();
    for (const action of actions) {
      const payload = slackSessionSyncPayload(action.payload);
      if (!payload || !action.conversationId) {
        await db.transaction(async (tx) => {
          await notifyChatActionWork(tx, "slack_session_sync");
          return tx
            .update(chatActions)
            .set({
              status: "failed",
              result: { code: "slack_session_payload_invalid" },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, action.id),
                eq(chatActions.updatedAt, action.updatedAt),
              ),
            );
        });
        continue;
      }
      const revisionWhere = and(
        eq(chatActions.id, action.id),
        sql`(${chatActions.payload}->>'revision')::bigint = ${payload.revision}`,
      );
      const selectedSnapshotWhere = and(
        revisionWhere,
        eq(chatActions.status, action.status),
        eq(chatActions.updatedAt, action.updatedAt),
      );
      const record = await endpointRecord(action.endpointId);
      if (record && ["paused", "attention"].includes(record.endpoint.status)) continue;
      if (!record || record.endpoint.provider !== "slack") {
        await db.transaction(async (tx) => {
          await notifyChatActionWork(tx, "slack_session_sync");
          return tx
            .update(chatActions)
            .set({
              status: "cancelled",
              result: { code: "slack_session_endpoint_unavailable" },
              updatedAt: new Date(),
            })
            .where(selectedSnapshotWhere);
        });
        continue;
      }
      const attempts =
        (typeof action.result?.attempts === "number"
          ? action.result.attempts
          : 0) + 1;
      const ownerToken = randomUUID();
      let ownsAttempt = false;
      try {
        await withCredentialMutationLease(record.endpoint, async (lease) => {
          const claim = await db.transaction(async (tx) => {
            await lease.assertOwned(tx);
            const endpoint = await runtimeCallbackEndpoint(
              tx,
              action.endpointId,
              {
                generation: payload.runtimeGeneration,
                credentialFingerprint: payload.credentialFingerprint,
              },
              ["active", "verifying"],
            );
            const conversation = endpoint
              ? await tx
                  .select()
                  .from(chatConversations)
                  .where(
                    and(
                      eq(chatConversations.id, action.conversationId!),
                      eq(chatConversations.endpointId, endpoint.id),
                      eq(chatConversations.companyId, endpoint.companyId),
                      inArray(chatConversations.state, [
                        "active",
                        "waiting",
                        "completed",
                      ]),
                    ),
                  )
                  .for("update")
                  .then((rows) => rows[0] ?? null)
              : null;
            const resource =
              endpoint && conversation?.resourceId
                ? await tx
                    .select()
                    .from(chatEndpointResources)
                    .where(
                      and(
                        eq(chatEndpointResources.id, conversation.resourceId),
                        eq(chatEndpointResources.companyId, endpoint.companyId),
                        eq(chatEndpointResources.endpointId, endpoint.id),
                      ),
                    )
                    .for("update")
                    .then((rows) => rows[0] ?? null)
                : null;
            const superseded = conversation
              ? await tx
                  .select({ id: chatConversations.id })
                  .from(chatConversations)
                  .where(
                    and(
                      eq(chatConversations.companyId, conversation.companyId),
                      eq(chatConversations.endpointId, conversation.endpointId),
                      eq(
                        chatConversations.externalThreadId,
                        conversation.externalThreadId,
                      ),
                      gt(
                        chatConversations.sessionGeneration,
                        conversation.sessionGeneration,
                      ),
                    ),
                  )
                  .limit(1)
                  .then((rows) => rows.length > 0)
              : false;
            if (
              !endpoint ||
              !conversation ||
              superseded ||
              !(conversation.isDirectMessage
                ? endpoint.allowDirectMessages
                : nonDirectDestinationAllowed(endpoint, resource))
            ) {
              await notifyChatActionWork(tx, "slack_session_sync");
              await tx
                .update(chatActions)
                .set({
                  status: "cancelled",
                  result: { code: "slack_session_destination_changed" },
                  updatedAt: new Date(),
                })
                .where(selectedSnapshotWhere);
              return null;
            }
            // Recompute at dispatch: a delayed processing retry must not
            // overwrite a newer final response or a later question card.
            const publication = await tx
              .select()
              .from(chatPublications)
              .where(
                and(
                  eq(chatPublications.companyId, endpoint.companyId),
                  eq(chatPublications.endpointId, endpoint.id),
                  eq(chatPublications.conversationId, conversation.id),
                  eq(chatPublications.state, "published"),
                  sql`${chatPublications.idempotencyKey} not like 'explicit%'`,
                  sql`${chatPublications.idempotencyKey} not like 'control:status:%'`,
                  sql`${chatPublications.idempotencyKey} not like 'wake:%'`,
                ),
              )
              .orderBy(
                desc(chatPublications.publishedAt),
                desc(chatPublications.createdAt),
                desc(chatPublications.id),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null);
            if (!publication) {
              await notifyChatActionWork(tx, "slack_session_sync");
              await tx
                .update(chatActions)
                .set({
                  status: "cancelled",
                  result: { code: "slack_session_no_published_state" },
                  updatedAt: new Date(),
                })
                .where(selectedSnapshotWhere);
              return null;
            }
            let status = slackSessionStatusForPublication(
              publication.payload,
              conversation.state === "completed",
            );
            const runId = runIdFromMilestonePublication(publication);
            if (status === "processing" && runId) {
              const run = await tx
                .select({ status: heartbeatRuns.status })
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.id, runId),
                    eq(heartbeatRuns.companyId, endpoint.companyId),
                    eq(heartbeatRuns.agentId, endpoint.assignedAgentId),
                  ),
                )
                .then((rows) => rows[0] ?? null);
              // Stop may finish before its confirmation publication. Never
              // resurrect processing from that run's earlier working receipt.
              if (!run || !["queued", "running"].includes(run.status))
                status = "active";
            }
            await notifyChatActionWork(tx, "slack_session_sync");
            const claimed = await tx
              .update(chatActions)
              .set({
                status: "processing",
                result: { attempts, ownerToken },
                updatedAt: new Date(),
              })
              .where(
                and(
                  selectedSnapshotWhere,
                  or(
                    and(
                      eq(chatActions.status, "received"),
                      sql`(${chatActions.result}->>'retryAt' is null or (${chatActions.result}->>'retryAt')::timestamptz <= ${new Date().toISOString()}::timestamptz)`,
                    ),
                    and(
                      eq(chatActions.status, "processing"),
                      lte(chatActions.updatedAt, new Date(Date.now() - 60_000)),
                    ),
                  ),
                ),
              )
              .returning({ id: chatActions.id });
            await lease.assertOwned(tx);
            return claimed.length ? { endpoint, conversation, status } : null;
          });
          if (!claim) return;
          ownsAttempt = true;
          const credentials = await resolveCredentials(claim.endpoint);
          await lease.assertOwned();
          const outcome = await setSlackSessionStatus({
            botToken: credentials.botToken,
            threadId: claim.conversation.externalThreadId,
            status: claim.status,
            fetch: fetchImpl,
          });
          await db.transaction(async (tx) => {
            await lease.assertOwned(tx);
            // Refresh long work before Slack's one-hour processing timeout.
            // Unsupported sessions settle until a new publication restages
            // them; completed threads must not create perpetual polling work.
            const retryMs =
              outcome === "updated" && claim.status === "processing"
                ? 30 * 60_000
                : null;
            await notifyChatActionWork(tx, "slack_session_sync");
            await tx
              .update(chatActions)
              .set({
                status: retryMs === null ? "processed" : "received",
                result: {
                  attempts,
                  outcome,
                  sessionStatus: claim.status,
                  ...(retryMs === null
                    ? {}
                    : {
                        retryAt: new Date(Date.now() + retryMs).toISOString(),
                      }),
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  revisionWhere,
                  eq(chatActions.status, "processing"),
                  sql`${chatActions.result}->>'ownerToken' = ${ownerToken}`,
                ),
              );
          });
        });
      } catch (error) {
        const disposition = classifyChatPublicationError(error, attempts);
        // Unlike posting a message, repeating setStatus cannot duplicate any
        // content. Ambiguous transport/receipt failures remain retryable, but
        // a definite scope/auth/destination rejection waits for new activity.
        const retryable =
          disposition.kind === "retry" ||
          disposition.kind === "delivery_unknown";
        const retryMs =
          disposition.kind === "retry"
            ? disposition.retryAfterMs
            : Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempts, 8));
        await db.transaction(async (tx) => {
          await notifyChatActionWork(tx, "slack_session_sync");
          return tx
            .update(chatActions)
            .set({
              status: retryable ? "received" : "failed",
              result: {
                attempts,
                code: retryable
                  ? "slack_session_sync_retry"
                  : "slack_session_sync_rejected",
                ...(retryable
                  ? { retryAt: new Date(Date.now() + retryMs).toISOString() }
                  : {}),
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                revisionWhere,
                ownsAttempt
                  ? and(
                      eq(chatActions.status, "processing"),
                      sql`${chatActions.result}->>'ownerToken' = ${ownerToken}`,
                    )
                  : and(
                      eq(chatActions.status, "received"),
                      eq(chatActions.updatedAt, action.updatedAt),
                    ),
              ),
            );
        });
        logger.warn(
          {
            endpointId: action.endpointId,
            actionId: action.id,
            retryable,
            error: redactError(error),
          },
          "Slack session status update did not complete; message delivery is unchanged",
        );
      }
    }
    return actions.length;
  }
  return { processPendingSlackSessionSyncs };
}
