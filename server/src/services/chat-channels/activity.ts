import { providerEffectPayload } from "./provider-effects.js";

import { slackSlashTaskRecoveryPayload } from "./slack/task-start.js";
import { GITHUB_RECOVERY_STATE_KEY } from "./github/webhook-ingress.js";

import {
  and,
  desc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatDeliveries,
  chatPublications,
  chatSdkState,
  chatTeamsFileTransfers,
  issues,
} from "@paperclipai/db";
import type {
  ChatPublicationSummary,
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

import {
  teamsFileTransferService,
} from "../chat-teams-file-transfers.js";

import {
  chatFileTransferResolutionActions,
  projectChatFileTransfer,
} from "../chat-publication-batches.js";

import {
  badRequest,
  notFound,
} from "../../errors.js";

import { chatProviderConversationUrl } from "../chat-provider-links.js";

import type { EndpointRecord } from "./runtime-types.js";
import { slackTaskStartActivityStatus } from "./slack/task-start.js";
import { fileTransferProjectionColumns } from "./microsoft-teams/file-transfer-projection.js";

function publicationSummary(
  row: typeof chatPublications.$inferSelect,
): ChatPublicationSummary {
  return {
    id: row.id,
    state: row.state,
    providerUrl: row.providerUrl,
    attempts: row.attempts,
    redactedError: row.redactedError,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}
export { publicationSummary };

type ChatActivityOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  teamsTransferProtocol: () => Pick<ReturnType<typeof teamsFileTransferService>, "canCancelConflict">;
};

export function createChatActivity(db: Db, options: ChatActivityOptions) {
  const { endpointRecord, teamsTransferProtocol } = options;


  async function listConversations(endpointId: string) {
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const conversations = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpointId))
      .orderBy(
        desc(chatConversations.lastActivityAt),
        desc(chatConversations.createdAt),
      );
    if (!conversations.length) return [];
    const issueRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        inArray(
          issues.id,
          conversations.map((row) => row.issueId),
        ),
      );
    const publications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.endpointId, endpointId))
      .orderBy(desc(chatPublications.createdAt));
    const issueById = new Map(issueRows.map((row) => [row.id, row]));
    const lastPublication = new Map<
      string,
      typeof chatPublications.$inferSelect
    >();
    for (const publication of publications)
      if (!lastPublication.has(publication.conversationId))
        lastPublication.set(publication.conversationId, publication);
    return conversations.map((conversation) => {
      const issue = issueById.get(conversation.issueId);
      const externalUrl =
        record.endpoint.provider === "telegram" && conversation.isDirectMessage
          ? chatProviderConversationUrl({
              provider: "telegram",
              botUsername: record.endpoint.botUsername,
              threadId: conversation.externalThreadId,
              providerMessageId: "",
              raw: { chat: { type: "private" } },
            })
          : (conversation.providerUrl ??
            (record.endpoint.provider === "slack"
              ? chatProviderConversationUrl({
                  provider: "slack",
                  providerAccountId: record.endpoint.providerAccountId,
                  threadId: conversation.externalThreadId,
                  providerMessageId: "",
                })
              : null));
      return {
        id: conversation.id,
        companyId: conversation.companyId,
        endpointId: conversation.endpointId,
        resourceId: conversation.resourceId,
        externalLabel: conversation.externalLabel,
        externalUrl,
        externalConversationId: conversation.externalConversationId,
        externalThreadId: conversation.externalThreadId,
        sessionGeneration: conversation.sessionGeneration,
        issueId: conversation.issueId,
        issueIdentifier: issue?.identifier ?? null,
        issueTitle: issue?.title ?? null,
        isDirectMessage: conversation.isDirectMessage,
        state:
          record.endpoint.provider !== "imessage-photon" &&
          (issue?.status === "done" || issue?.status === "cancelled")
            ? "completed"
            : conversation.state,
        lastActivityAt: conversation.lastActivityAt?.toISOString() ?? null,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: (
          conversation.lastActivityAt ?? conversation.updatedAt
        ).toISOString(),
        lastPublicationStatus:
          lastPublication.get(conversation.id)?.state ?? null,
      };
    });
  }

  async function listActivity(endpointId: string, page?: { limit: number; before?: { createdAt: string; id: string } }) {
    const limit = page ? page.limit + 1 : 100;
    // Match the millisecond precision of the public timestamp and use a UUID
    // tie-breaker so equal timestamps never skip records between pages.
    const before = (date: AnyPgColumn, id: AnyPgColumn) => page?.before
      ? sql`(date_trunc('milliseconds', ${date}), ${id}) < (${page.before.createdAt}::timestamptz, ${page.before.id}::uuid)`
      : undefined;
    const recoveryIngress = alias(chatActions, "github_recovery_ingress");
    const [
      deliveries,
      publications,
      slashActions,
      providerEffects,
      githubIngressFailures,
      slackSessionActions,
      githubRecoveries,
      githubRecoveryScans,
    ] = await Promise.all([
      db
        .select()
        .from(chatDeliveries)
        .where(and(eq(chatDeliveries.endpointId, endpointId), before(chatDeliveries.createdAt, chatDeliveries.id)))
        .orderBy(desc(sql`date_trunc('milliseconds', ${chatDeliveries.createdAt})`), desc(chatDeliveries.id))
        .limit(limit),
      db
        .select()
        .from(chatPublications)
        .where(and(eq(chatPublications.endpointId, endpointId), before(chatPublications.createdAt, chatPublications.id)))
        .orderBy(desc(sql`date_trunc('milliseconds', ${chatPublications.createdAt})`), desc(chatPublications.id))
        .limit(limit),
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpointId),
            before(chatActions.createdAt, chatActions.id),
            eq(chatActions.kind, "slash_task_start"),
          ),
        )
        .orderBy(desc(sql`date_trunc('milliseconds', ${chatActions.createdAt})`), desc(chatActions.id))
        .limit(limit),
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpointId),
            before(chatActions.createdAt, chatActions.id),
            eq(chatActions.kind, "provider_effect"),
            eq(chatActions.status, "delivery_unknown"),
          ),
        )
        .orderBy(desc(sql`date_trunc('milliseconds', ${chatActions.createdAt})`), desc(chatActions.id))
        .limit(limit),
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpointId),
            before(chatActions.createdAt, chatActions.id),
            eq(chatActions.kind, "github_webhook_ingress"),
            eq(chatActions.status, "failed"),
            sql`coalesce(${chatActions.result}->>'retryable', 'false') = 'false'`,
          ),
        )
        .orderBy(desc(sql`date_trunc('milliseconds', ${chatActions.createdAt})`), desc(chatActions.id))
        .limit(limit),
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpointId),
            before(chatActions.updatedAt, chatActions.id),
            inArray(chatActions.kind, [
              "slack_session_sync",
              "slack_session_stop",
            ]),
          ),
        )
        .orderBy(desc(sql`date_trunc('milliseconds', ${chatActions.updatedAt})`), desc(chatActions.id))
        .limit(limit),
      db
        .select({
          action: chatActions,
          ingressStatus: recoveryIngress.status,
        })
        .from(chatActions)
        .leftJoin(
          recoveryIngress,
          and(
            eq(recoveryIngress.companyId, chatActions.companyId),
            eq(recoveryIngress.endpointId, chatActions.endpointId),
            eq(recoveryIngress.kind, "github_webhook_ingress"),
            sql`${recoveryIngress.providerActionId} = 'github_webhook_ingress:' || (${chatActions.payload}#>>'{original,guid}')`,
          ),
        )
        .where(
          and(
            eq(chatActions.endpointId, endpointId),
            before(chatActions.updatedAt, chatActions.id),
            eq(chatActions.kind, "github_webhook_recovery"),
          ),
        )
        .orderBy(desc(sql`date_trunc('milliseconds', ${chatActions.updatedAt})`), desc(chatActions.id))
        .limit(limit),
      db
        .select()
        .from(chatSdkState)
        .where(
          and(
            eq(chatSdkState.endpointId, endpointId),
            before(chatSdkState.updatedAt, chatSdkState.id),
            eq(chatSdkState.stateKey, GITHUB_RECOVERY_STATE_KEY),
          ),
        )
        .limit(1),
    ]);
    // A provider effect can be on another page. Replay safety must still
    // consider every unresolved effect associated with these deliveries.
    const ambiguousEffects = deliveries.length ? await db.select({ deliveryId: chatActions.deliveryId })
      .from(chatActions).where(and(
        eq(chatActions.endpointId, endpointId),
        eq(chatActions.kind, "provider_effect"),
        eq(chatActions.status, "delivery_unknown"),
        inArray(chatActions.deliveryId, deliveries.map((row) => row.id)),
      )) : [];
    const ambiguousProviderEffectDeliveryIds = new Set(ambiguousEffects.map((row) => row.deliveryId));
    const transferRows = publications.length
      ? await db
          .select(fileTransferProjectionColumns)
          .from(chatTeamsFileTransfers)
          .innerJoin(
            chatPublications,
            and(
              eq(chatPublications.id, chatTeamsFileTransfers.publicationId),
              eq(chatPublications.companyId, chatTeamsFileTransfers.companyId),
              eq(
                chatPublications.endpointId,
                chatTeamsFileTransfers.endpointId,
              ),
              eq(
                chatPublications.conversationId,
                chatTeamsFileTransfers.conversationId,
              ),
            ),
          )
          .where(
            and(
              eq(chatTeamsFileTransfers.companyId, publications[0]!.companyId),
              eq(chatTeamsFileTransfers.endpointId, endpointId),
              inArray(
                chatTeamsFileTransfers.publicationId,
                publications.map((row) => row.id),
              ),
            ),
          )
      : [];
    const transfers = new Map(
      transferRows.map((row) => [row.publicationId, row]),
    );
    const cancellableConflicts = new Map<string, number>();
    for (const transfer of transferRows) {
      if (transfer.phase !== "conflict") continue;
      const publication = publications.find(
        (row) => row.id === transfer.publicationId,
      );
      if (!publication?.conversationId) continue;
      if (
        await teamsTransferProtocol().canCancelConflict({
          companyId: publication.companyId,
          endpointId,
          conversationId: publication.conversationId,
          publicationId: publication.id,
          version: transfer.version,
        })
      )
        cancellableConflicts.set(publication.id, transfer.version);
    }
    return [
      ...deliveries.map((row) => {
        const normalized =
          row.normalizedEvent &&
          typeof row.normalizedEvent === "object" &&
          !Array.isArray(row.normalizedEvent)
            ? (row.normalizedEvent as Record<string, unknown>)
            : {};
        const deduplication =
          normalized.deduplication &&
          typeof normalized.deduplication === "object" &&
          !Array.isArray(normalized.deduplication)
            ? (normalized.deduplication as Record<string, unknown>)
            : null;
        const duplicateCount =
          typeof deduplication?.duplicateCount === "number"
            ? deduplication.duplicateCount
            : 0;
        const label = row.eventKind.replaceAll("_", " ");
        const outcome =
          row.state === "filtered"
            ? "ignored"
            : row.state === "processed"
              ? "processed"
              : row.state;
        return {
          id: row.id,
          kind: "delivery" as const,
          status: row.state,
          summary: `${label} ${outcome}${duplicateCount ? ` · ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} ignored` : ""}`,
          detail: row.redactedError,
          createdAt: row.createdAt.toISOString(),
          replayable:
            row.state === "failed" &&
            Boolean(row.conversationId) &&
            !ambiguousProviderEffectDeliveryIds.has(row.id),
          resolutionActions: [],
        };
      }),
      ...publications.map((row) => {
        const transfer = transfers.get(row.id);
        const projected = projectChatFileTransfer(
          publicationSummary(row),
          transfer,
        );
        const payload = row.payload as Partial<SafeChatPublicationPayload>;
        const summary = payload.progressState
          ? `${payload.progressState.replaceAll("_", " ")} update`
          : payload.interactionId
            ? "Interactive question"
            : "Response to external conversation";
        return {
          id: row.id,
          kind: "publication" as const,
          status: projected.state,
          summary,
          detail: projected.redactedError ?? null,
          createdAt: row.createdAt.toISOString(),
          replayable: !transfer && row.state === "failed",
          ...(projected.fileTransfer
            ? { fileTransfer: projected.fileTransfer }
            : {}),
          resolutionActions: transfer
            ? chatFileTransferResolutionActions(
                projected,
                cancellableConflicts.has(row.id)
                  ? {
                      publicationId: row.id,
                      version: cancellableConflicts.get(row.id)!,
                    }
                  : undefined,
              )
            : row.state === "delivery_unknown"
              ? (["mark_delivered", "retry_anyway", "cancel"] as const)
              : [],
        };
      }),
      ...slashActions.map((row) => {
        const recovery = slackSlashTaskRecoveryPayload(row.payload);
        // Keep this GET read-only while still surfacing a crashed attempt as
        // actionable. The resolution POST persists the derived quarantine
        // before it applies the operator's audited decision.
        const status = slackTaskStartActivityStatus(row);
        return {
          id: row.id,
          kind: "action" as const,
          actionType: "slash_task_start" as const,
          status,
          summary: `Slack slash-command task start ${status.replaceAll("_", " ")}`,
          detail:
            status === "delivery_unknown"
              ? recovery
                ? "Slack may have accepted the task-start message, so Paperclip will not replay it automatically. Check Slack first; an explicit retry can create a duplicate starter message and task."
                : "Slack may have accepted the task-start message. This older action lacks the context required for a safe explicit retry, so check Slack and cancel it here before submitting a new command."
              : status === "provider_confirmed"
                ? "Slack accepted the task-start message. Paperclip is completing durable task admission without sending another Slack message."
                : status === "admitting"
                  ? "Slack accepted the task-start message. A Paperclip worker is admitting the task without replaying the Slack send."
                  : status === "failed"
                    ? "Slack rejected the task-start message. Submit the command again to retry."
                    : status === "cancelled"
                      ? "An operator cancelled this unconfirmed task start."
                      : null,
          createdAt: row.createdAt.toISOString(),
          replayable: false,
          resolutionActions:
            status === "delivery_unknown"
              ? recovery
                ? (["retry_anyway", "cancel"] as const)
                : (["cancel"] as const)
              : [],
        };
      }),
      ...providerEffects.map((row) => {
        const payload = providerEffectPayload(row.payload);
        return {
          id: row.id,
          kind: "action" as const,
          actionType: "provider_effect" as const,
          status: row.status,
          summary: "Provider reply delivery unknown",
          detail: payload?.completeConversationId
            ? "The provider may have accepted this reply, but Paperclip could not confirm it or close the task conversation. Check the provider first. Marking it delivered closes the conversation; retrying can create a duplicate message."
            : "The provider may have accepted this reply, but Paperclip could not confirm it. Check the provider first. Retrying can create a duplicate message.",
          createdAt: row.createdAt.toISOString(),
          replayable: false,
          resolutionActions: [
            "mark_delivered",
            "retry_anyway",
            "cancel",
          ] as const,
        };
      }),
      ...slackSessionActions.map((row) => {
        const isSync = row.kind === "slack_session_sync";
        const retrying =
          row.status === "received" &&
          row.result?.code === "slack_session_sync_retry";
        return {
          id: row.id,
          kind: "action" as const,
          actionType: isSync
            ? ("slack_session_sync" as const)
            : ("slack_session_stop" as const),
          status: retrying ? "retry" : row.status,
          summary: isSync ? "Slack session status" : "Slack Stop request",
          detail: isSync
            ? row.result?.outcome === "unavailable"
              ? "Slack has not enabled native session status for this destination. Message delivery continues."
              : row.result?.code === "slack_session_sync_rejected"
                ? "Slack rejected the session indicator update. Check app permissions and channel access; message delivery is tracked separately."
                : retrying
                  ? "The Slack session indicator is waiting to sync. Paperclip will not resend the response."
                  : row.result?.sessionStatus === "processing"
                    ? "Working status is refreshed automatically while the run remains active."
                    : null
            : row.status === "processed"
              ? "Paperclip stopped the work authorized by this request."
              : row.status === "cancelled"
                ? "No work was stopped: this request was no longer authorized or its target was no longer current."
                : row.status === "failed"
                  ? row.result?.retryable === true
                    ? "The Stop request could not finish yet. Paperclip will retry against the original work only."
                    : "The Stop request could not be completed. Check the task's current run before trying again."
                  : "Paperclip is processing this Stop request against its original task and run.",
          createdAt: row.updatedAt.toISOString(),
          replayable: false,
          resolutionActions: [],
        };
      }),
      ...githubIngressFailures.map((row) => {
        const deliveryId =
          typeof row.payload.deliveryId === "string"
            ? row.payload.deliveryId
            : null;
        return {
          id: row.id,
          kind: "action" as const,
          actionType: "github_webhook_ingress" as const,
          status: row.status,
          summary: "GitHub webhook could not be processed",
          detail: deliveryId
            ? `GitHub delivery ${deliveryId} was authenticated, but Paperclip could not finish processing it. Fix the connection or destination, then redeliver this delivery from the GitHub App's Recent Deliveries page.`
            : "An authenticated GitHub webhook could not be processed. Fix the connection or destination, then redeliver it from the GitHub App's Recent Deliveries page.",
          createdAt: row.createdAt.toISOString(),
          replayable: false,
          resolutionActions: [],
        };
      }),
      ...githubRecoveries.map(({ action: row, ingressStatus }) => ({
        id: row.id,
        kind: "repair" as const,
        status:
          row.status === "cancelled"
            ? "cancelled"
            : ingressStatus
              ? "received"
              : "pending",
        summary:
          row.status === "cancelled"
            ? "GitHub webhook recovery skipped"
            : ingressStatus
              ? "GitHub webhook received after recovery request"
              : "GitHub webhook redelivery requested",
        detail:
          row.status === "cancelled"
            ? row.result?.code === "source_changed_or_unavailable"
              ? "The original comment changed or is no longer available. Paperclip did not replay its old contents."
              : "This callback was not an eligible current user comment. Paperclip did not replay it."
            : ingressStatus
              ? "Paperclip received this callback. Its normal access checks and processing still apply."
              : "Paperclip asked GitHub to resend a recent missed message. This does not yet confirm receipt or a reply. Automatic requests are limited; if it remains unanswered, check the App's Recent Deliveries and send your request again in the current conversation.",
        createdAt: row.updatedAt.toISOString(),
        replayable: false,
        resolutionActions: [],
      })),
      ...githubRecoveryScans.flatMap((row) => {
        const value = row.value as { outcome?: string } | null;
        const detail =
          value?.outcome === "history_limit_reached"
            ? "Recent webhook volume exceeded automatic recovery's bounded scan. No partial history was replayed. Check the App's Recent Deliveries for missed messages."
            : value?.outcome === "callback_mismatch"
              ? "The GitHub App's callback no longer matches this connection. Reconnect the App to repair it; repository access will not change."
              : value?.outcome === "scan_failed"
                ? "Paperclip could not check GitHub's failed deliveries. The check will retry with backoff; normal callbacks are still processed."
                : null;
        return detail
          ? [
              {
                id: row.id,
                kind: "health" as const,
                status: "attention",
                summary: "GitHub webhook recovery needs attention",
                detail,
                createdAt: row.updatedAt.toISOString(),
                replayable: false,
                resolutionActions: [],
              },
            ]
          : [];
      }),
    ]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  async function listActivityPage(endpointId: string, limit = 25, cursor?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest("Activity limit must be between 1 and 100");
    let before: { createdAt: string; id: string } | undefined;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 256) throw new Error("Invalid cursor");
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(value) || value.length !== 2
          || typeof value[0] !== "string" || new Date(value[0]).toISOString() !== value[0]
          || typeof value[1] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value[1])) throw new Error("Invalid cursor");
        before = { createdAt: value[0], id: value[1] };
      } catch { throw badRequest("Invalid activity cursor"); }
    }
    const rows = await listActivity(endpointId, { limit, before });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url")
        : null,
    };
  }
  return { listConversations, listActivity, listActivityPage };
}
