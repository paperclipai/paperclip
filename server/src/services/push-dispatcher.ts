import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { LiveEvent } from "@paperclipai/shared";
import { subscribeAllLiveEvents } from "./live-events.js";
import { pushNotificationService } from "./push-notifications.js";
import { logger } from "../middleware/logger.js";

/**
 * Subscribes to all live events globally and dispatches push notifications
 * for three categories:
 *   1. task_complete   — agent run succeeded/failed/timed out
 *   2. agent_question  — approval.created or agent commented on issue
 *   3. board_review    — join requests, issue moved to in_review
 */
export function startPushDispatcher(db: Db) {
  const pushSvc = pushNotificationService(db);

  return subscribeAllLiveEvents((event) => {
    handleEvent(db, pushSvc, event).catch((err) => {
      logger.warn({ err, eventType: event.type }, "push dispatcher error");
    });
  });
}

async function resolveAgentName(db: Db, agentId: string): Promise<string> {
  const row = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  return row?.name ?? "An agent";
}

function readStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function handleEvent(
  db: Db,
  pushSvc: ReturnType<typeof pushNotificationService>,
  event: LiveEvent,
) {
  const vapidKey = pushSvc.getVapidPublicKey();
  if (!vapidKey) return; // Push not configured

  const payload = event.payload ?? {};

  // 1. Task complete: agent run succeeded
  if (event.type === "heartbeat.run.status") {
    const status = readStr(payload.status);
    const agentId = readStr(payload.agentId);
    if (status === "succeeded" && agentId) {
      const agentName = await resolveAgentName(db, agentId);
      await pushSvc.sendToCompany(event.companyId, {
        type: "task_complete",
        title: `${agentName} completed a task`,
        body: payload.triggerDetail ? `Trigger: ${payload.triggerDetail}` : "A run finished successfully.",
        url: `/agents/${agentId}/runs/${payload.runId}`,
      });
    }

    // Also notify on failure (still a "task complete" category — agent is done, needs attention)
    if ((status === "failed" || status === "timed_out") && agentId) {
      const agentName = await resolveAgentName(db, agentId);
      const label = status === "failed" ? "failed" : "timed out";
      await pushSvc.sendToCompany(event.companyId, {
        type: "task_complete",
        title: `${agentName} run ${label}`,
        body: readStr(payload.error) ?? `The run ${label} and may need attention.`,
        url: `/agents/${agentId}/runs/${payload.runId}`,
      });
    }
    return;
  }

  // 2 & 3. Activity events
  if (event.type === "activity.logged") {
    const action = readStr(payload.action);
    const entityType = readStr(payload.entityType);
    const details = typeof payload.details === "object" && payload.details !== null
      ? (payload.details as Record<string, unknown>)
      : null;

    // Agent created an approval request (agent_question)
    if (action === "approval.created" && entityType === "approval") {
      const agentId = readStr(payload.agentId);
      const agentName = agentId ? await resolveAgentName(db, agentId) : "An agent";
      await pushSvc.sendToCompany(event.companyId, {
        type: "agent_question",
        title: `${agentName} needs approval`,
        body: readStr(details?.title) ?? "An agent is waiting for your decision.",
        url: "/approvals",
      });
      return;
    }

    // Issue moved to in_review (agent asking board to review)
    if (
      action === "issue.updated" &&
      entityType === "issue" &&
      readStr(details?.status) === "in_review"
    ) {
      const identifier = readStr(details?.identifier) ?? readStr(payload.entityId) ?? "An issue";
      const title = readStr(details?.title) ?? "";
      await pushSvc.sendToCompany(event.companyId, {
        type: "board_review",
        title: `${identifier} needs review`,
        body: title || "An issue has been moved to review.",
        url: `/issues/${readStr(payload.entityId) ?? ""}`,
      });
      return;
    }

    // Join request (board_review — someone/agent wants to join)
    if (action === "join.requested" || action === "join.request_replayed") {
      await pushSvc.sendToCompany(event.companyId, {
        type: "board_review",
        title: "New join request",
        body: "Someone wants to join your company.",
        url: "/inbox/new",
      });
      return;
    }

    // Issue comment by an agent (agent_question — might be asking a question)
    if (
      action === "issue.comment_added" &&
      entityType === "issue" &&
      readStr(payload.actorType) === "agent"
    ) {
      const agentId = readStr(payload.agentId);
      const agentName = agentId ? await resolveAgentName(db, agentId) : "An agent";
      const identifier = readStr(details?.identifier) ?? readStr(payload.entityId) ?? "";
      const snippet = readStr(details?.bodySnippet) ?? "Left a comment on an issue.";
      await pushSvc.sendToCompany(event.companyId, {
        type: "agent_question",
        title: `${agentName} commented on ${identifier}`,
        body: snippet,
        url: `/issues/${readStr(payload.entityId) ?? ""}`,
      });
      return;
    }
  }
}
