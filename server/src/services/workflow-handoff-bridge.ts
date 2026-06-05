import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowHandoffBridges,
  workflowHandoffs,
  workflowRunPhases,
  workflowRuns,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { awaitingHumanSettingsService } from "./awaiting-human-settings.js";
import {
  addClickUpChatMessageReaction,
  deleteClickUpChatMessageReaction,
  detectClickUpAwaitingHumanBridgeEvents,
  sendAwaitingHumanNotification,
} from "./clickup-awaiting-human-transport.js";
import type { AwaitingHumanNotificationPayload } from "./awaiting-human-notifications.js";

const POLL_INTERVAL_MS = 60_000;
const POLL_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

function truncateText(value: string, maxLength: number) {
  const compact = value.trim().replace(/\s+/g, " ");
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildHandoffNotification(handoff: {
  kind: string;
  promptMarkdown: string;
}): AwaitingHumanNotificationPayload {
  const isApproval = handoff.kind === "approval";
  return {
    title: isApproval ? "Workflow approval required" : "Workflow input required",
    summary: truncateText(handoff.promptMarkdown, 280),
    body: handoff.promptMarkdown,
    link: "",
    cta: isApproval
      ? "Reply with: approve or reject (optionally include a note)."
      : "Reply with your response.",
    labels: ["workflow_handoff", handoff.kind],
  };
}

async function applyReaction(input: {
  db: Db;
  bridgeId: string;
  companyId: string;
  workflowHandoffId: string;
  messageId: string;
  reaction: string;
  target: "main" | "reply";
  overrides: { personalToken: string | null; workspaceId: string | null; channelId: string | null };
}) {
  try {
    await addClickUpChatMessageReaction(input.messageId, input.reaction, input.overrides);
  } catch (error) {
    logger.warn({
      err: error,
      bridgeId: input.bridgeId,
      companyId: input.companyId,
      workflowHandoffId: input.workflowHandoffId,
      messageId: input.messageId,
      reaction: input.reaction,
    }, "workflow handoff bridge: failed to apply ClickUp reaction");
  }
}

async function removeReaction(input: {
  db: Db;
  bridgeId: string;
  companyId: string;
  workflowHandoffId: string;
  messageId: string;
  reaction: string;
  overrides: { personalToken: string | null; workspaceId: string | null; channelId: string | null };
}) {
  try {
    await deleteClickUpChatMessageReaction(input.messageId, input.reaction, input.overrides);
  } catch (error) {
    logger.warn({
      err: error,
      bridgeId: input.bridgeId,
      companyId: input.companyId,
      workflowHandoffId: input.workflowHandoffId,
      messageId: input.messageId,
      reaction: input.reaction,
    }, "workflow handoff bridge: failed to remove ClickUp reaction");
  }
}

async function closeBridgeRow(
  db: Db,
  bridge: typeof workflowHandoffBridges.$inferSelect,
  outcome: "responded" | "approved" | "rejected" | "expired" | "cancelled" | "failed",
  overrides: { personalToken: string | null; workspaceId: string | null; channelId: string | null },
) {
  const now = new Date();
  await db.update(workflowHandoffBridges).set({
    status: "closed",
    closeOutcome: outcome,
    closedAt: now,
    nextPollAt: null,
    updatedAt: now,
  }).where(eq(workflowHandoffBridges.id, bridge.id));

  const messageId = bridge.externalMessageId?.trim();
  if (!messageId) return;

  await removeReaction({
    db,
    bridgeId: bridge.id,
    companyId: bridge.companyId,
    workflowHandoffId: bridge.workflowHandoffId,
    messageId,
    reaction: "brain_is_thinking",
    overrides,
  });

  if (outcome === "responded" || outcome === "approved" || outcome === "rejected") {
    await applyReaction({
      db,
      bridgeId: bridge.id,
      companyId: bridge.companyId,
      workflowHandoffId: bridge.workflowHandoffId,
      messageId,
      reaction: "white_check_mark",
      target: "main",
      overrides,
    });
  } else if (outcome === "failed" || outcome === "expired") {
    await applyReaction({
      db,
      bridgeId: bridge.id,
      companyId: bridge.companyId,
      workflowHandoffId: bridge.workflowHandoffId,
      messageId,
      reaction: "x",
      target: "main",
      overrides,
    });
  }
}

async function resolveHandoffFromBridge(
  db: Db,
  bridge: typeof workflowHandoffBridges.$inferSelect,
  resolution: "responded" | "approved" | "rejected",
  responseMarkdown: string | null,
) {
  const now = new Date();

  const [handoff] = await db
    .select()
    .from(workflowHandoffs)
    .where(and(
      eq(workflowHandoffs.id, bridge.workflowHandoffId),
      eq(workflowHandoffs.status, "pending"),
    ))
    .limit(1);

  if (!handoff) return;

  await db.transaction(async (tx) => {
    await tx.update(workflowHandoffs).set({
      status: resolution,
      responseMarkdown: responseMarkdown ?? null,
      decidedByUserId: "clickup_bridge",
      decidedAt: now,
      updatedAt: now,
    }).where(and(
      eq(workflowHandoffs.id, bridge.workflowHandoffId),
      eq(workflowHandoffs.status, "pending"),
    ));

    // Wake the run back to running state
    await tx.update(workflowRunPhases).set({
      status: "running",
      updatedAt: now,
    }).where(and(
      eq(workflowRunPhases.workflowRunId, bridge.workflowRunId),
      eq(workflowRunPhases.phaseKey, handoff.phaseKey),
      inArray(workflowRunPhases.status, ["awaiting_human"]),
    ));

    await tx.update(workflowRuns).set({
      status: "running",
      updatedAt: now,
    }).where(and(
      eq(workflowRuns.id, bridge.workflowRunId),
      eq(workflowRuns.status, "awaiting_human"),
    ));
  });

  await logActivity(db, {
    companyId: bridge.companyId,
    actorType: "system",
    actorId: "workflow_handoff_bridge",
    action: "workflow.handoff.bridge_resolved",
    entityType: "workflow_run",
    entityId: bridge.workflowRunId,
    details: {
      bridgeId: bridge.id,
      workflowHandoffId: bridge.workflowHandoffId,
      resolution,
      provider: bridge.provider,
      externalMessageId: bridge.externalMessageId ?? null,
    },
  });
}

export function workflowHandoffBridgeService(db: Db) {
  const settings = awaitingHumanSettingsService(db);

  async function openForHandoff(handoff: {
    id: string;
    companyId: string;
    workflowRunId: string;
    kind: string;
    promptMarkdown: string;
  }) {
    let config: Awaited<ReturnType<typeof settings.resolveClickUpRuntimeConfig>>;
    try {
      config = await settings.resolveClickUpRuntimeConfig(handoff.companyId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const isBridgeDisabled = detail === "awaiting-human-bridge-disabled";
      throw Object.assign(
        new Error(
          isBridgeDisabled
            ? "ClickUp integration is not configured for this company. Workflow input() handoffs require ClickUp to be set up in company settings."
            : `Failed to load ClickUp configuration: ${detail}`,
        ),
        { code: "clickup_not_configured", status: 503 },
      );
    }

    const overrides = {
      personalToken: config.personalToken,
      workspaceId: config.workspaceId,
      channelId: config.channelId,
      attachmentTaskId: config.attachmentTaskId,
    };

    const existingBridge = await getActiveBridge(handoff.id);
    if (existingBridge) {
      return existingBridge;
    }

    const notification = buildHandoffNotification(handoff);

    const result = await sendAwaitingHumanNotification(
      {
        companyId: handoff.companyId,
        issueId: handoff.id, // not an issue -- reusing field for context
        handoffKind: handoff.kind === "approval" ? "request_confirmation" : "ask_user_questions",
        notification,
      },
      overrides,
    );

    if (result.status !== "sent") {
      throw Object.assign(
        new Error(`Failed to post workflow handoff to ClickUp: ${result.detail}`),
        { code: "clickup_send_failed", status: 503 },
      );
    }

    const externalMessageId = result.externalId ?? null;
    const now = new Date();

    const [bridge] = await db.insert(workflowHandoffBridges).values({
      companyId: handoff.companyId,
      workflowRunId: handoff.workflowRunId,
      workflowHandoffId: handoff.id,
      provider: "clickup",
      status: "waiting_for_human",
      externalMessageId,
      nextPollAt: new Date(now.getTime() + POLL_INTERVAL_MS),
    }).onConflictDoNothing({
      target: workflowHandoffBridges.workflowHandoffId,
      where: inArray(workflowHandoffBridges.status, ["pending_delivery", "waiting_for_human"]),
    }).returning();

    if (externalMessageId && bridge) {
      await applyReaction({
        db,
        bridgeId: bridge.id,
        companyId: handoff.companyId,
        workflowHandoffId: handoff.id,
        messageId: externalMessageId,
        reaction: "brain_is_thinking",
        target: "main",
        overrides,
      });
    }

    await logActivity(db, {
      companyId: handoff.companyId,
      actorType: "system",
      actorId: "workflow_handoff_bridge",
      action: "workflow.handoff.bridge_opened",
      entityType: "workflow_run",
      entityId: handoff.workflowRunId,
      details: {
        bridgeId: bridge?.id ?? null,
        workflowHandoffId: handoff.id,
        provider: "clickup",
        externalMessageId,
      },
    });

    return bridge ?? null;
  }

  async function pollActiveBridges() {
    const now = new Date();
    const bridges = await db
      .select()
      .from(workflowHandoffBridges)
      .where(and(
        eq(workflowHandoffBridges.status, "waiting_for_human"),
        lte(workflowHandoffBridges.nextPollAt, now),
      ))
      .orderBy(
        asc(workflowHandoffBridges.nextPollAt),
        asc(workflowHandoffBridges.createdAt),
      )
      .limit(50);

    const summary = { checked: 0, resolved: 0, noSignal: 0, failed: 0 };

    for (const bridge of bridges) {
      summary.checked += 1;
      const messageId = bridge.externalMessageId?.trim();
      if (!messageId) {
        await db.update(workflowHandoffBridges).set({
          lastPolledAt: now,
          nextPollAt: new Date(now.getTime() + POLL_INTERVAL_MS),
          updatedAt: now,
        }).where(eq(workflowHandoffBridges.id, bridge.id));
        summary.noSignal += 1;
        continue;
      }

      let overrides: { personalToken: string | null; workspaceId: string | null; channelId: string | null; attachmentTaskId: string | null };
      try {
        const config = await settings.resolveClickUpRuntimeConfig(bridge.companyId);
        overrides = {
          personalToken: config.personalToken,
          workspaceId: config.workspaceId,
          channelId: config.channelId,
          attachmentTaskId: config.attachmentTaskId,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await db.update(workflowHandoffBridges).set({
          lastError: detail,
          lastPolledAt: now,
          nextPollAt: new Date(now.getTime() + POLL_FAILURE_BACKOFF_MS),
          updatedAt: now,
        }).where(eq(workflowHandoffBridges.id, bridge.id));
        summary.failed += 1;
        continue;
      }

      let detected: Awaited<ReturnType<typeof detectClickUpAwaitingHumanBridgeEvents>>;
      try {
        detected = await detectClickUpAwaitingHumanBridgeEvents(messageId, overrides);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error({
          err: error,
          bridgeId: bridge.id,
          companyId: bridge.companyId,
          workflowHandoffId: bridge.workflowHandoffId,
          messageId,
        }, "workflow handoff bridge: ClickUp poll failed");
        await db.update(workflowHandoffBridges).set({
          lastError: detail,
          lastPolledAt: now,
          nextPollAt: new Date(now.getTime() + POLL_FAILURE_BACKOFF_MS),
          updatedAt: now,
        }).where(eq(workflowHandoffBridges.id, bridge.id));
        await logActivity(db, {
          companyId: bridge.companyId,
          actorType: "system",
          actorId: "workflow_handoff_bridge",
          action: "workflow.handoff.bridge_poll_failed",
          entityType: "workflow_run",
          entityId: bridge.workflowRunId,
          details: { bridgeId: bridge.id, workflowHandoffId: bridge.workflowHandoffId, detail },
        });
        summary.failed += 1;
        continue;
      }

      if (detected.status === "failed") {
        await db.update(workflowHandoffBridges).set({
          lastError: detected.detail,
          lastPolledAt: now,
          nextPollAt: new Date(now.getTime() + POLL_FAILURE_BACKOFF_MS),
          updatedAt: now,
        }).where(eq(workflowHandoffBridges.id, bridge.id));
        summary.failed += 1;
        continue;
      }

      if (detected.events.length === 0) {
        await db.update(workflowHandoffBridges).set({
          lastPolledAt: now,
          lastError: null,
          nextPollAt: new Date(now.getTime() + POLL_INTERVAL_MS),
          updatedAt: now,
        }).where(eq(workflowHandoffBridges.id, bridge.id));
        summary.noSignal += 1;
        continue;
      }

      // Process first meaningful event -- acknowledge all reply messages
      const replyMessageIds = new Set<string>();
      for (const event of detected.events) {
        const replyId = typeof event.metadata?.clickupReplyId === "string" && event.metadata.clickupReplyId.trim().length > 0
          ? event.metadata.clickupReplyId.trim()
          : null;
        if (replyId) replyMessageIds.add(replyId);
      }
      for (const replyId of replyMessageIds) {
        await applyReaction({
          db,
          bridgeId: bridge.id,
          companyId: bridge.companyId,
          workflowHandoffId: bridge.workflowHandoffId,
          messageId: replyId,
          reaction: "white_check_mark",
          target: "reply",
          overrides,
        });
      }

      // Resolve using the first event
      const event = detected.events[0]!;
      let resolution: "responded" | "approved" | "rejected";
      let responseMarkdown: string | null;

      if (event.kind === "approval_signal") {
        resolution = "approved";
        responseMarkdown = event.body?.trim() || null;
      } else if (event.kind === "reject_signal") {
        resolution = "rejected";
        responseMarkdown = event.body?.trim() || null;
      } else {
        // "reply" -- raw text response
        resolution = "responded";
        responseMarkdown = event.body?.trim() || null;
      }

      try {
        await resolveHandoffFromBridge(db, bridge, resolution, responseMarkdown);
        await closeBridgeRow(db, bridge, resolution, overrides);
        summary.resolved += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error({
          err: error,
          bridgeId: bridge.id,
          companyId: bridge.companyId,
          workflowHandoffId: bridge.workflowHandoffId,
        }, "workflow handoff bridge: failed to resolve handoff after reply");
        await db.update(workflowHandoffBridges).set({
          lastError: detail,
          lastPolledAt: now,
          nextPollAt: new Date(now.getTime() + POLL_FAILURE_BACKOFF_MS),
          updatedAt: now,
        }).where(eq(workflowHandoffBridges.id, bridge.id));
        summary.failed += 1;
      }
    }

    return summary;
  }

  async function getActiveBridge(workflowHandoffId: string) {
    const [bridge] = await db
      .select()
      .from(workflowHandoffBridges)
      .where(and(
        eq(workflowHandoffBridges.workflowHandoffId, workflowHandoffId),
        inArray(workflowHandoffBridges.status, ["pending_delivery", "waiting_for_human"]),
      ))
      .limit(1);
    return bridge ?? null;
  }

  async function getBridgeForHandoff(workflowHandoffId: string) {
    const [bridge] = await db
      .select()
      .from(workflowHandoffBridges)
      .where(eq(workflowHandoffBridges.workflowHandoffId, workflowHandoffId))
      .orderBy(desc(workflowHandoffBridges.createdAt))
      .limit(1);
    return bridge ?? null;
  }

  return {
    openForHandoff,
    pollActiveBridges,
    getActiveBridge,
    getBridgeForHandoff,
  };
}
