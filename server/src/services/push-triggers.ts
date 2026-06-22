import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { LogActivityInput } from "./activity-log.js";
import { pushSubscriptionStore } from "./push-subscription-store.js";
import {
  isPushConfigured,
  sendPushToSubscriptions,
  type PushNotificationPayload,
} from "./push-notifications.js";

/**
 * Maps high-signal, board-directed activity events to Web Push notifications
 * (TON-2312). `logActivity` is the single choke point every domain mutation
 * flows through, so hooking here lets us fan out pushes without editing each
 * hot-path call site.
 *
 * Scope is intentionally narrow: only events that require the board's
 * attention (approvals, input requests, mentions/comments, assignment,
 * escalations). Run finished/failed flows through the separate
 * `heartbeat.run.status` live event rather than `logActivity`; that trigger is
 * tracked as a follow-up.
 */

function pickString(details: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Best-effort deep link; the UI redirects bare `/issues/:id` to the prefixed route. */
function issueUrl(input: LogActivityInput): string {
  const identifier = pickString(input.details, "identifier") ?? pickString(input.details, "issueIdentifier");
  if (identifier) return `/issues/${identifier}`;
  if (input.entityType === "issue") return `/issues/${input.entityId}`;
  return "/";
}

/**
 * Pure mapping from an activity event to a notification payload, or null when
 * the event should not produce a push. Unit-tested.
 */
export function buildActivityNotification(input: LogActivityInput): PushNotificationPayload | null {
  const url = issueUrl(input);
  const tag = `${input.entityType}:${input.entityId}`;

  switch (input.action) {
    case "approval.created":
      return { title: "Approval needed", body: "An agent is requesting your approval.", url, tag };

    case "issue.thread_interaction_created": {
      const kind = pickString(input.details, "interactionKind");
      const body =
        kind === "ask_user_questions"
          ? "An agent has questions for you."
          : kind === "request_confirmation"
            ? "An agent is requesting your confirmation."
            : kind === "suggest_tasks"
              ? "An agent suggested tasks for you to review."
              : "An agent needs your input.";
      return { title: "Input needed", body, url, tag };
    }

    case "issue.comment.created":
    case "issue.comment_added":
      return { title: "New comment", body: "There's a new comment on an issue you're following.", url, tag };

    case "issue.assignment_wakeup_requested":
      return { title: "Issue assigned", body: "An issue was assigned and is starting work.", url, tag };

    case "issue.monitor_escalated_to_board":
      return { title: "Escalated to board", body: "An issue was escalated and needs your attention.", url, tag };

    default:
      return null;
  }
}

/**
 * Fire-and-forget push dispatch for an activity event. Never throws; failures
 * are logged and swallowed so notification delivery can never break the
 * originating mutation.
 */
export async function dispatchActivityPush(db: Db, input: LogActivityInput): Promise<void> {
  try {
    if (!isPushConfigured()) return;
    const payload = buildActivityNotification(input);
    if (!payload) return;

    const store = pushSubscriptionStore(db);
    const all = await store.list();
    // Don't notify the actor about their own action.
    const recipients =
      input.actorType === "user"
        ? all.filter((s) => s.userId !== input.actorId)
        : all;
    if (recipients.length === 0) return;

    const { expiredEndpoints } = await sendPushToSubscriptions(recipients, payload);
    if (expiredEndpoints.length > 0) {
      await store.removeEndpoints(expiredEndpoints);
    }
  } catch (err) {
    logger.warn({ err, action: input.action }, "Failed to dispatch push notification");
  }
}
