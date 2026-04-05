/**
 * Bridges Paperclip live events → Telegram notifications.
 *
 * Subscribes to the in-process EventEmitter and forwards relevant
 * events to the telegram-bot sidecar. All sends are fire-and-forget.
 *
 * Call `startTelegramEventBridge()` once at server startup.
 */

import type { LiveEvent } from "@paperclipai/shared";
import { subscribeGlobalLiveEvents } from "./live-events.js";
import { telegramNotify } from "./telegram-notify.js";
import { logger } from "../middleware/logger.js";

const PAPERCLIP_PUBLIC_URL = (process.env.PAPERCLIP_PUBLIC_URL ?? "").replace(/\/$/, "");

/** Issue statuses worth notifying on (skip noisy ones like backlog→todo). */
const NOTIFY_ISSUE_STATUSES = new Set(["done", "in_review", "blocked", "cancelled"]);

function issueUrl(identifier: string): string | undefined {
  if (!PAPERCLIP_PUBLIC_URL) return undefined;
  const prefix = identifier.split("-")[0];
  return `${PAPERCLIP_PUBLIC_URL}/${prefix}/issues/${identifier}`;
}

function handleEvent(event: LiveEvent): void {
  const { type, payload } = event;

  try {
    if (type === "activity.logged") {
      const action = payload.action as string | undefined;
      if (!action) return;

      // Server emits "issue.updated" for all issue mutations including status changes.
      if (action === "issue.updated") {
        const details = payload.details as Record<string, unknown> | undefined;
        const status = details?.status as string | undefined;
        if (!status || !NOTIFY_ISSUE_STATUSES.has(status)) return;

        const identifier = details?.identifier as string ?? payload.entityId as string;
        void telegramNotify.issueStatusChanged({
          identifier,
          title: details?.title as string ?? "Untitled",
          status,
          url: issueUrl(identifier),
        });
        return;
      }

      // Server emits "approval.created" when a new approval is submitted.
      if (action === "approval.created") {
        const details = payload.details as Record<string, unknown> | undefined;
        void telegramNotify.approvalRequested({
          companyName: "Paperclip",
          approvalType: details?.type as string ?? "general",
          title: `Approval required: ${details?.type ?? "action needed"}`,
          url: PAPERCLIP_PUBLIC_URL
            ? `${PAPERCLIP_PUBLIC_URL}/ANGA/approvals/${payload.entityId as string}`
            : undefined,
        });
        return;
      }

      if (action === "agent.budget_exhausted") {
        void telegramNotify.budgetExhausted({
          companyName: (payload.details as Record<string, unknown>)?.companyName as string ?? "Unknown",
          agentName: (payload.details as Record<string, unknown>)?.agentName as string ?? "Unknown agent",
          budgetUsedPct: (payload.details as Record<string, unknown>)?.budgetUsedPct as number ?? 100,
        });
        return;
      }

      if (action === "agent.paused") {
        void telegramNotify.info(
          `⏸ Agent paused: ${(payload.details as Record<string, unknown>)?.agentName ?? payload.entityId}`,
        );
        return;
      }
    }

    if (type === "heartbeat.run.status") {
      const status = payload.status as string | undefined;
      if (status === "completed" || status === "failed") {
        void telegramNotify.heartbeatCompleted({
          agentName: payload.agentName as string ?? "Unknown",
          routineName: payload.routineName as string | undefined,
          success: status === "completed",
          summary: payload.summary as string | undefined,
        });
      }
    }
  } catch (err) {
    logger.warn({ err, eventType: type }, "telegram-event-bridge: handler error");
  }
}

let _unsubscribe: (() => void) | null = null;

export function startTelegramEventBridge(): void {
  if (_unsubscribe) {
    logger.warn("telegram-event-bridge: already started, skipping");
    return;
  }

  const enabled = process.env.TELEGRAM_NOTIFY_ENABLED !== "false";
  if (!enabled) {
    logger.info("telegram-event-bridge: disabled (TELEGRAM_NOTIFY_ENABLED=false)");
    return;
  }

  _unsubscribe = subscribeGlobalLiveEvents(handleEvent);
  logger.info("telegram-event-bridge: listening for live events");
}

export function stopTelegramEventBridge(): void {
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
    logger.info("telegram-event-bridge: stopped");
  }
}
