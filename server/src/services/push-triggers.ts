import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
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
 * escalations). Agent run finished/failed events do NOT flow through
 * `logActivity` — they are emitted from `setRunStatus` in heartbeat.ts and
 * fanned out on the `heartbeat.run.status` live event. The run-status push
 * trigger below (TON-2315) hooks that choke point with the same fire-and-forget
 * contract.
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

// --- Run finished/failed push (TON-2315) ----------------------------------

/**
 * Failure-ish run states always push. `succeeded` is opt-in (off by default)
 * because every agent run succeeding would be high-volume noise; flip
 * `PAPERCLIP_PUSH_RUN_SUCCEEDED=1` to receive them too.
 */
const FAILURE_RUN_STATUSES = new Set(["failed", "timed_out"]);

function succeededPushEnabled(): boolean {
  const raw = process.env.PAPERCLIP_PUSH_RUN_SUCCEEDED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Whether a run reaching `status` should produce a push at all. */
export function shouldPushRunStatus(status: string): boolean {
  if (FAILURE_RUN_STATUSES.has(status)) return true;
  if (status === "succeeded") return succeededPushEnabled();
  return false;
}

export interface RunStatusNotificationInput {
  status: string;
  runId: string;
  agentName?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  error?: string | null;
}

/** Best-effort deep link to the run's issue; falls back to the runs view. */
function runIssueUrl(input: RunStatusNotificationInput): string {
  if (input.issueIdentifier) return `/issues/${input.issueIdentifier}`;
  if (input.issueId) return `/issues/${input.issueId}`;
  return "/runs";
}

/**
 * Pure mapping from a run-status transition to a notification payload, or null
 * when the transition should not produce a push. Unit-tested.
 */
export function buildRunStatusNotification(
  input: RunStatusNotificationInput,
): PushNotificationPayload | null {
  if (!shouldPushRunStatus(input.status)) return null;

  const who = input.agentName?.trim() || "An agent";
  const where = input.issueIdentifier
    ? `${input.issueIdentifier}${input.issueTitle ? ` (${input.issueTitle})` : ""}`
    : input.issueTitle || "an issue";
  // Coalesce by run so a run that flips status replaces its own notification.
  const tag = `run:${input.runId}`;
  const url = runIssueUrl(input);

  if (input.status === "succeeded") {
    return { title: "Agent run finished", body: `${who} finished its run on ${where}.`, url, tag };
  }

  const verb = input.status === "timed_out" ? "timed out" : "failed";
  const errorSnippet = input.error?.trim() ? ` — ${input.error.trim().slice(0, 140)}` : "";
  return {
    title: input.status === "timed_out" ? "Agent run timed out" : "Agent run failed",
    body: `${who}'s run on ${where} ${verb}${errorSnippet}.`,
    url,
    tag,
  };
}

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;

/** Pull the run's issue id out of the persisted context snapshot, if present. */
function issueIdFromRun(run: HeartbeatRunRow): string | null {
  const snapshot = run.contextSnapshot;
  if (snapshot && typeof snapshot === "object") {
    const value = (snapshot as Record<string, unknown>).issueId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Fire-and-forget push dispatch for an agent run reaching a terminal status.
 * Hooked from `setRunStatus` in heartbeat.ts. Never throws; failures are logged
 * and swallowed so notification delivery can never break run bookkeeping.
 *
 * The actor is the agent (not a board user), so every registered subscription
 * is a recipient. Recipient/issue resolution is best-effort and only runs once
 * the status passes the cheap `shouldPushRunStatus` gate, keeping the common
 * `running`/`cancelled` transitions free of extra DB work.
 */
export async function dispatchRunStatusPush(db: Db, run: HeartbeatRunRow): Promise<void> {
  try {
    if (!shouldPushRunStatus(run.status)) return;
    if (!isPushConfigured()) return;

    const store = pushSubscriptionStore(db);
    const recipients = await store.list();
    if (recipients.length === 0) return;

    const issueId = issueIdFromRun(run);
    const [issueRow, agentRow] = await Promise.all([
      issueId
        ? db
            .select({ identifier: issues.identifier, title: issues.title })
            .from(issues)
            .where(eq(issues.id, issueId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, run.agentId))
        .then((rows) => rows[0] ?? null),
    ]);

    const payload = buildRunStatusNotification({
      status: run.status,
      runId: run.id,
      agentName: agentRow?.name ?? null,
      issueId,
      issueIdentifier: issueRow?.identifier ?? null,
      issueTitle: issueRow?.title ?? null,
      error: run.error ?? null,
    });
    if (!payload) return;

    const { expiredEndpoints } = await sendPushToSubscriptions(recipients, payload);
    if (expiredEndpoints.length > 0) {
      await store.removeEndpoints(expiredEndpoints);
    }
  } catch (err) {
    logger.warn({ err, runId: run.id, status: run.status }, "Failed to dispatch run-status push notification");
  }
}
