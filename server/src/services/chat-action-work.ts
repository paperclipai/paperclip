import { and, eq, lte, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { CHAT_ACTION_QUEUES, type ScheduledChatAction } from "./chat-work-notifications.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerChatQueueWork } from "./chat-delivery-work.js";

export const SLACK_COMMAND_POST_STALE_MS = 60_000;
export const SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS = 5 * 60_000;
export const SLACK_COMMAND_ADMISSION_STALE_MS = 60_000;
export const PROVIDER_EFFECT_STALE_MS = 60_000;

/** The dispatch predicate and scheduler use the same eligibility and deadlines.
 * Zero means ready now; null means terminal or waiting for an external change. */
export function chatActionDeadline(kind: ScheduledChatAction) {
  const updated = sql`extract(epoch from ${chatActions.updatedAt}) * 1000`;
  const retry = sql`coalesce(extract(epoch from (${chatActions.result}->>'retryAt')::timestamptz) * 1000, 0)`;
  if (kind === "slack_board_message") return sql<number>`case
    when ${chatActions.status} = 'received' and ${chatEndpoints.status} not in ('paused', 'attention') then 0::numeric end`;
  if (kind === "slash_task_start") return sql<number>`case
    when ${chatActions.status} = 'queued' and (${chatEndpoints.id} is null or ${chatEndpoints.status} in ('verifying', 'active', 'archived')) then ${retry}
    when ${chatActions.status} = 'provider_confirmed' and (${chatEndpoints.id} is null or ${chatEndpoints.status} in ('verifying', 'active', 'archived')) then ${retry}
    when ${chatActions.status} = 'admitting' then ${updated} + ${SLACK_COMMAND_ADMISSION_STALE_MS}
    when ${chatActions.status} = 'resolving' then ${updated} + ${SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS}
    when ${chatActions.status} = 'validating' then ${updated} + ${SLACK_COMMAND_POST_STALE_MS} end`;
  return sql<number>`case
    when ${chatActions.status} = 'received' then 0
    when ${chatActions.status} = 'processing' then ${updated} + ${PROVIDER_EFFECT_STALE_MS}
    when ${chatActions.status} = 'failed' and ${chatActions.result}->>'retryable' = 'true' then ${retry} end`;
}

export function dueChatAction(kind: ScheduledChatAction, now = Date.now()) {
  return and(eq(chatActions.kind, kind), lte(chatActionDeadline(kind), now));
}

export async function nextChatActionAt(db: Db, kind: ScheduledChatAction): Promise<number | null> {
  const [row] = await db.select({ at: sql<string | null>`min(${chatActionDeadline(kind)})` })
    .from(chatActions)
    .leftJoin(chatEndpoints, and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
    .where(eq(chatActions.kind, kind));
  return row?.at == null ? null : Number(row.at);
}

type ChatActionService = {
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
  return { ready: Promise.all(workers.map(worker => worker.ready)) };
}
