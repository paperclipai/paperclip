import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, toolConnections, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { CHAT_ACTION_QUEUES, type ScheduledChatAction } from "./chat-work-notifications.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerChatQueueWork } from "./chat-delivery-work.js";

export const SLACK_COMMAND_POST_STALE_MS = 60_000;
export const SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS = 5 * 60_000;
export const SLACK_COMMAND_ADMISSION_STALE_MS = 60_000;
export const FAILED_RUN_RETRY_STALE_MS = 60_000;
export const PROVIDER_EFFECT_STALE_MS = 60_000;

/** The dispatch predicate and scheduler use the same eligibility and deadlines.
 * Zero means ready now; null means terminal or waiting for an external change. */
export function chatActionDeadline(kind: ScheduledChatAction) {
  const updated = sql`extract(epoch from ${chatActions.updatedAt}) * 1000`;
  const retry = sql`coalesce(extract(epoch from (${chatActions.result}->>'retryAt')::timestamptz) * 1000, 0)`;
  if (kind === "failed_run_retry") return sql<number>`case
    when ${chatActions.status} = 'issued' then ${retry}
    when ${chatActions.status} = 'processing' then greatest(${updated} + ${FAILED_RUN_RETRY_STALE_MS}, ${retry}) end`;
  if (kind === "slack_board_message") return sql<number>`case
    when ${chatActions.status} = 'received' and ${chatEndpoints.status} not in ('paused', 'attention') then 0::numeric end`;
  if (kind === "slash_task_start") return sql<number>`case
    when ${chatActions.status} = 'queued' and (${chatEndpoints.id} is null or ${chatEndpoints.status} in ('verifying', 'active', 'archived')) then ${retry}
    when ${chatActions.status} = 'provider_confirmed' and (${chatEndpoints.id} is null or ${chatEndpoints.status} in ('verifying', 'active', 'archived')) then ${retry}
    when ${chatActions.status} = 'admitting' then ${updated} + ${SLACK_COMMAND_ADMISSION_STALE_MS}
    when ${chatActions.status} = 'resolving' then ${updated} + ${SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS}
    when ${chatActions.status} = 'validating' then ${updated} + ${SLACK_COMMAND_POST_STALE_MS} end`;
  if (kind === "slack_session_sync") return sql<number>`case
    when ${chatEndpoints.status} in ('paused', 'attention') then null
    when ${chatActions.status} = 'received' then ${retry}
    when ${chatActions.status} = 'processing' then ${updated} + ${PROVIDER_EFFECT_STALE_MS} end`;
  return sql<number>`case
    when ${chatActions.status} = 'received' then 0
    when ${chatActions.status} = 'processing' then ${updated} + ${PROVIDER_EFFECT_STALE_MS}
    when ${chatActions.status} = 'failed' and ${chatActions.result}->>'retryable' = 'true' then ${retry} end`;
}

function pendingChatAction(kind: ScheduledChatAction) {
  // Filter history before the endpoint join and aggregate. Failed actions
  // only remain live when the saved result permits another attempt.
  const status = kind === "failed_run_retry"
    ? inArray(chatActions.status, ["issued", "processing"])
    : kind === "slack_board_message"
      ? eq(chatActions.status, "received")
      : kind === "slash_task_start"
        ? inArray(chatActions.status, ["queued", "provider_confirmed", "admitting", "resolving", "validating"])
        : kind === "slack_session_sync"
          ? inArray(chatActions.status, ["received", "processing"])
          : or(inArray(chatActions.status, ["received", "processing"]),
          and(eq(chatActions.status, "failed"), sql`${chatActions.result}->>'retryable' = 'true'`));
  // Subscription repair is parked while its current endpoint/connection is
  // inactive. Registration and removal retain their existing dispatch rules.
  const telegramEligible = kind === "telegram_maintenance" ? sql`(
    ${chatActions.payload}->>'operation' <> 'stop_subscription' or exists (
      select 1 from ${chatEndpoints} inner join ${toolConnections}
        on ${toolConnections.id} = ${chatEndpoints.connectionId} and ${toolConnections.companyId} = ${chatEndpoints.companyId}
      where ${chatEndpoints.id} = ${chatActions.endpointId} and ${chatEndpoints.companyId} = ${chatActions.companyId}
        and ${chatEndpoints.provider} = 'telegram' and ${chatEndpoints.status} = 'active'
        and ${toolConnections.status} = 'active' and ${toolConnections.enabled} = true
    ))` : undefined;
  return and(eq(chatActions.kind, kind), status, telegramEligible);
}

export function dueChatAction(kind: ScheduledChatAction, now = Date.now()) {
  return and(pendingChatAction(kind), lte(chatActionDeadline(kind), now));
}

export async function nextChatActionAt(db: Db, kind: ScheduledChatAction): Promise<number | null> {
  const [row] = await db.select({ at: sql<string | null>`min(${chatActionDeadline(kind)})` })
    .from(chatActions)
    .leftJoin(chatEndpoints, and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
    .where(pendingChatAction(kind));
  return row?.at == null ? null : Number(row.at);
}

type ChatActionService = {
  processFailedChatRunRetries(): Promise<unknown>;
  processPendingTelegramActions(): Promise<unknown>;
  processTelegramSubscriptionDiscovery(signal?: AbortSignal): Promise<unknown>;
  scheduleTelegramSubscriptionDiscovery(connectionId: string): void;
  hasPendingTelegramSubscriptionDiscovery(): boolean;
  processPendingProviderEffects(): Promise<unknown>;
  processPendingGitHubWebhookIngress(): Promise<unknown>;
  processPendingSlackSessionSyncs(): Promise<unknown>;
  processPendingSlackBoardMessages(): Promise<unknown>;
  processPendingSlackTaskStarts(): Promise<unknown>;
  processPendingReceiptReactions(): Promise<unknown>;
  processPendingSlackSessionStops(): Promise<unknown>;
  processPendingVerificationMessages(): Promise<unknown>;
  nextChatActionAt(kind: ScheduledChatAction): Promise<number | null>;
  nextVerificationMessageAt(): Promise<number | null>;
};

export function registerChatActionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ChatActionService,
  canRun: () => boolean,
) {
  const actions = [
    { kind: "failed_run_retry", run: service.processFailedChatRunRetries },
    { kind: "telegram_maintenance", run: service.processPendingTelegramActions },
    { kind: "provider_effect", run: service.processPendingProviderEffects },
    { kind: "github_webhook_ingress", run: service.processPendingGitHubWebhookIngress },
    { kind: "slack_session_sync", run: service.processPendingSlackSessionSyncs },
    { kind: "slack_board_message", run: service.processPendingSlackBoardMessages },
    { kind: "slash_task_start", run: service.processPendingSlackTaskStarts },
    { kind: "receipt_reaction", run: service.processPendingReceiptReactions },
    { kind: "slack_session_stop", run: service.processPendingSlackSessionStops },
  ] as const;
  const workers = actions.map(({ kind, run }) => registerChatQueueWork(coordinator, {
    queue: CHAT_ACTION_QUEUES[kind], run, next: () => service.nextChatActionAt(kind),
  }, canRun));
  workers.push(registerChatQueueWork(coordinator, {
    queue: DELIVERY_QUEUES.chatVerification,
    run: service.processPendingVerificationMessages, next: service.nextVerificationMessageAt,
  }, canRun));
  // Startup recovery visits the full inventory in bounded pages. Configuration
  // commits only enqueue the changed connection, never restart a global sweep.
  const discovery = coordinator.register(DELIVERY_QUEUES.chatTelegramSubscriptions, {
    retryMs: 1000,
    run: signal => service.processTelegramSubscriptionDiscovery(signal),
    onSettled: hints => { for (const id of hints ?? []) service.scheduleTelegramSubscriptionDiscovery(id); },
    // Preserve a configuration wake received during idle drain without SQL.
    hasPending: async () => !canRun() || service.hasPendingTelegramSubscriptionDiscovery(),
  });
  workers.push(discovery);
  return { ready: Promise.all(workers.map(worker => worker.ready)) };
}
