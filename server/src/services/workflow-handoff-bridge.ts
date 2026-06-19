import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowHandoffBridges,
  workflowHandoffs,
  workflowRunPhases,
  workflowRuns,
  workflows,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { awaitingHumanSettingsService } from "./awaiting-human-settings.js";
import {
  addClickUpChatMessageReaction,
  deleteClickUpChatMessageReaction,
  detectClickUpAwaitingHumanBridgeEvents,
  detectClickUpAwaitingHumanBridgeEventsAfterMessage,
  sendAwaitingHumanNotification,
  sendAwaitingHumanNotificationReply,
} from "./clickup-awaiting-human-transport.js";
import type { AwaitingHumanNotificationResult } from "./awaiting-human-notifications.js";
import type { AwaitingHumanNotificationPayload } from "./awaiting-human-notifications.js";

const POLL_INTERVAL_MS = 60_000;
const POLL_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const TERMINAL_WORKFLOW_RUN_STATUSES = ["succeeded", "failed", "cancelled"];
type BridgeCloseOutcome = "responded" | "approved" | "rejected" | "expired" | "cancelled" | "failed";
type ResolvedHandoffStatus = Extract<BridgeCloseOutcome, "responded" | "approved" | "rejected">;
type TerminalBridgeCloseOutcome = Extract<BridgeCloseOutcome, "expired" | "cancelled" | "failed">;

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

function buildWorkflowThreadNotification(input: {
  workflowTitle: string | null;
  workflowRunId: string;
  inputMarkdown: string | null;
  createdAt: Date | null;
}): AwaitingHumanNotificationPayload {
  const title = input.workflowTitle?.trim() || "Workflow";
  const lines = [
    `Workflow: ${title}`,
    `Run ID: ${input.workflowRunId}`,
  ];
  if (input.createdAt) {
    lines.push(`Created: ${input.createdAt.toISOString()}`);
  }
  const runInput = input.inputMarkdown?.trim();
  if (runInput) {
    lines.push("");
    lines.push("Input:");
    lines.push(truncateText(runInput, 800));
  }
  return {
    title: `Workflow handoff: ${title}`,
    summary: `Human input thread for workflow run ${input.workflowRunId}`,
    body: lines.join("\n"),
    link: "",
    cta: "",
    labels: ["workflow_handoff", "workflow_thread"],
  };
}

function requireClickUpExternalId(
  result: AwaitingHumanNotificationResult,
  failurePrefix: string,
) {
  if (result.status !== "sent") {
    throw Object.assign(
      new Error(`${failurePrefix}: ${result.detail}`),
      { code: "clickup_send_failed", status: 503 },
    );
  }
  const externalId = result.externalId?.trim();
  if (!externalId) {
    throw Object.assign(
      new Error(`${failurePrefix}: missing-external-id`),
      { code: "clickup_send_failed", status: 503 },
    );
  }
  return externalId;
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
  outcome: BridgeCloseOutcome,
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
  } else if (outcome === "failed" || outcome === "expired" || outcome === "cancelled") {
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

function isResolvedHandoffStatus(status: string | null | undefined): status is ResolvedHandoffStatus {
  return status === "responded" || status === "approved" || status === "rejected";
}

function toCloseOutcome(run: { status: string | null; error: string | null } | null | undefined): TerminalBridgeCloseOutcome {
  if (run?.status === "failed" && run.error?.startsWith("Timed out after ")) return "expired";
  if (run?.status === "failed") return "failed";
  return "cancelled";
}

async function recordBridgePollFailure(
  db: Db,
  bridge: typeof workflowHandoffBridges.$inferSelect,
  now: Date,
  detail: string,
) {
  await db.update(workflowHandoffBridges).set({
    lastError: detail,
    lastPolledAt: now,
    nextPollAt: new Date(now.getTime() + POLL_FAILURE_BACKOFF_MS),
    updatedAt: now,
  }).where(eq(workflowHandoffBridges.id, bridge.id));
}

async function tryRecordBridgePollFailure(
  db: Db,
  bridge: typeof workflowHandoffBridges.$inferSelect,
  now: Date,
  detail: string,
) {
  try {
    await recordBridgePollFailure(db, bridge, now, detail);
  } catch (error) {
    logger.error({
      err: error,
      bridgeId: bridge.id,
      companyId: bridge.companyId,
      workflowHandoffId: bridge.workflowHandoffId,
    }, "workflow handoff bridge: failed to record poll failure");
  }
}

async function resolveHandoffFromBridge(
  db: Db,
  bridge: typeof workflowHandoffBridges.$inferSelect,
  resolution: "responded" | "approved" | "rejected",
  responseMarkdown: string | null,
): Promise<boolean> {
  const now = new Date();

  const [handoff] = await db
    .select()
    .from(workflowHandoffs)
    .where(and(
      eq(workflowHandoffs.id, bridge.workflowHandoffId),
      eq(workflowHandoffs.status, "pending"),
    ))
    .limit(1);

  if (!handoff) return false;

  let resolved = false;
  await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: workflowRuns.status })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, bridge.workflowRunId))
      .limit(1);

    if (run?.status !== "awaiting_human") return;

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
    resolved = true;
  });

  if (!resolved) return false;

  try {
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
        externalThreadId: bridge.externalThreadId ?? null,
      },
    });
  } catch (error) {
    logger.warn({
      err: error,
      bridgeId: bridge.id,
      companyId: bridge.companyId,
      workflowHandoffId: bridge.workflowHandoffId,
    }, "workflow handoff bridge: failed to log handoff resolution");
  }
  return true;
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
    const externalThreadId = await getOrCreateWorkflowThreadId(handoff, overrides);

    const result = await sendAwaitingHumanNotificationReply(
      externalThreadId,
      {
        companyId: handoff.companyId,
        issueId: handoff.id, // not an issue -- reusing field for context
        handoffKind: handoff.kind === "approval" ? "request_confirmation" : "ask_user_questions",
        notification,
      },
      overrides,
    );

    const externalMessageId = requireClickUpExternalId(result, "Failed to post workflow handoff question to ClickUp");
    const now = new Date();

    const [bridge] = await db.insert(workflowHandoffBridges).values({
      companyId: handoff.companyId,
      workflowRunId: handoff.workflowRunId,
      workflowHandoffId: handoff.id,
      provider: "clickup",
      status: "waiting_for_human",
      externalMessageId,
      externalThreadId,
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

    try {
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
          externalThreadId,
        },
      });
    } catch (error) {
      logger.warn({
        err: error,
        bridgeId: bridge?.id ?? null,
        companyId: handoff.companyId,
        workflowHandoffId: handoff.id,
      }, "workflow handoff bridge: failed to log handoff open");
    }

    return bridge ?? null;
  }

  async function getExistingWorkflowThreadId(workflowRunId: string) {
    const [bridge] = await db
      .select({ externalThreadId: workflowHandoffBridges.externalThreadId })
      .from(workflowHandoffBridges)
      .where(and(
        eq(workflowHandoffBridges.workflowRunId, workflowRunId),
        eq(workflowHandoffBridges.provider, "clickup"),
        isNotNull(workflowHandoffBridges.externalThreadId),
      ))
      .orderBy(asc(workflowHandoffBridges.createdAt))
      .limit(1);
    return bridge?.externalThreadId?.trim() || null;
  }

  async function loadWorkflowThreadContext(workflowRunId: string) {
    const [row] = await db
      .select({
        workflowTitle: workflows.title,
        workflowRunId: workflowRuns.id,
        inputMarkdown: workflowRuns.inputMarkdown,
        createdAt: workflowRuns.createdAt,
      })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
      .where(eq(workflowRuns.id, workflowRunId))
      .limit(1);
    return row ?? {
      workflowTitle: null,
      workflowRunId,
      inputMarkdown: null,
      createdAt: null,
    };
  }

  async function getOrCreateWorkflowThreadId(
    handoff: {
      id: string;
      companyId: string;
      workflowRunId: string;
    },
    overrides: { personalToken: string | null; workspaceId: string | null; channelId: string | null; attachmentTaskId: string | null },
  ) {
    const existingThreadId = await getExistingWorkflowThreadId(handoff.workflowRunId);
    if (existingThreadId) return existingThreadId;

    const context = await loadWorkflowThreadContext(handoff.workflowRunId);
    const result = await sendAwaitingHumanNotification(
      {
        companyId: handoff.companyId,
        issueId: handoff.id, // not an issue -- reusing field for context
        handoffKind: "ask_user_questions",
        notification: buildWorkflowThreadNotification(context),
      },
      overrides,
    );
    return requireClickUpExternalId(result, "Failed to post workflow thread to ClickUp");
  }

  async function detectBridgeEvents(
    bridge: typeof workflowHandoffBridges.$inferSelect,
    messageId: string,
    overrides: { personalToken: string | null; workspaceId: string | null; channelId: string | null; attachmentTaskId: string | null },
  ) {
    const threadId = bridge.externalThreadId?.trim();
    if (threadId && threadId !== messageId) {
      return detectClickUpAwaitingHumanBridgeEventsAfterMessage(threadId, messageId, overrides);
    }
    return detectClickUpAwaitingHumanBridgeEvents(messageId, overrides);
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

    const summary = { checked: 0, resolved: 0, noSignal: 0, failed: 0, terminalClosed: 0 };

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

      const [run] = await db
        .select({ status: workflowRuns.status, error: workflowRuns.error })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, bridge.workflowRunId))
        .limit(1);
      if (!run || TERMINAL_WORKFLOW_RUN_STATUSES.includes(run.status)) {
        let detectedTerminal: Awaited<ReturnType<typeof detectClickUpAwaitingHumanBridgeEvents>>;
        try {
          detectedTerminal = await detectBridgeEvents(bridge, messageId, overrides);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          logger.warn({
            err: error,
            bridgeId: bridge.id,
            companyId: bridge.companyId,
            workflowHandoffId: bridge.workflowHandoffId,
            messageId,
            runStatus: run?.status ?? null,
            runError: run?.error ?? null,
          }, "workflow handoff bridge: terminal run reply poll failed while closing bridge");
          await tryRecordBridgePollFailure(db, bridge, now, detail);
          detectedTerminal = { status: "sent", detail: "terminal-reply-detection-failed", events: [] };
        }

        if (detectedTerminal.status === "failed") {
          await tryRecordBridgePollFailure(db, bridge, now, detectedTerminal.detail);
          detectedTerminal = { status: "sent", detail: detectedTerminal.detail, events: [] };
        }

        try {
          const replyMessageIds = new Set<string>();
          for (const event of detectedTerminal.events) {
            const replyId = typeof event.metadata?.clickupReplyId === "string" && event.metadata.clickupReplyId.trim().length > 0
              ? event.metadata.clickupReplyId.trim()
              : null;
            if (replyId) replyMessageIds.add(replyId);
          }
          const [currentHandoff] = await db
            .select({ status: workflowHandoffs.status })
            .from(workflowHandoffs)
            .where(eq(workflowHandoffs.id, bridge.workflowHandoffId))
            .limit(1);
          const acceptedOutcome = isResolvedHandoffStatus(currentHandoff?.status)
            ? currentHandoff.status
            : null;
          for (const replyId of replyMessageIds) {
            await applyReaction({
              db,
              bridgeId: bridge.id,
              companyId: bridge.companyId,
              workflowHandoffId: bridge.workflowHandoffId,
              messageId: replyId,
              reaction: acceptedOutcome ? "white_check_mark" : "x",
              target: "reply",
              overrides,
            });
          }

          if (!acceptedOutcome) {
            await db.update(workflowHandoffs).set({
              status: "cancelled",
              responseMarkdown: null,
              decidedByUserId: "workflow_handoff_bridge",
              decidedAt: now,
              updatedAt: now,
            }).where(and(
              eq(workflowHandoffs.id, bridge.workflowHandoffId),
              eq(workflowHandoffs.status, "pending"),
            ));
          }
          const closeOutcome = acceptedOutcome ?? toCloseOutcome(run);
          await closeBridgeRow(db, bridge, closeOutcome, overrides);
          try {
            await logActivity(db, {
              companyId: bridge.companyId,
              actorType: "system",
              actorId: "workflow_handoff_bridge",
              action: "workflow.handoff.bridge_closed_terminal",
              entityType: "workflow_run",
              entityId: bridge.workflowRunId,
              details: {
                bridgeId: bridge.id,
                workflowHandoffId: bridge.workflowHandoffId,
                provider: bridge.provider,
                externalMessageId: bridge.externalMessageId ?? null,
                externalThreadId: bridge.externalThreadId ?? null,
                runStatus: run?.status ?? null,
                runError: run?.error ?? null,
                handoffStatus: currentHandoff?.status ?? null,
                closeOutcome,
              },
            });
          } catch (error) {
            logger.warn({
              err: error,
              bridgeId: bridge.id,
              companyId: bridge.companyId,
              workflowHandoffId: bridge.workflowHandoffId,
            }, "workflow handoff bridge: failed to log terminal bridge closure");
          }
          summary.terminalClosed += 1;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          logger.error({
            err: error,
            bridgeId: bridge.id,
            companyId: bridge.companyId,
            workflowHandoffId: bridge.workflowHandoffId,
            messageId,
            runStatus: run?.status ?? null,
            runError: run?.error ?? null,
          }, "workflow handoff bridge: failed to close terminal bridge");
          await tryRecordBridgePollFailure(db, bridge, now, detail);
          try {
            await logActivity(db, {
              companyId: bridge.companyId,
              actorType: "system",
              actorId: "workflow_handoff_bridge",
              action: "workflow.handoff.bridge_poll_failed",
              entityType: "workflow_run",
              entityId: bridge.workflowRunId,
              details: { bridgeId: bridge.id, workflowHandoffId: bridge.workflowHandoffId, detail },
            });
          } catch (activityError) {
            logger.warn({
              err: activityError,
              bridgeId: bridge.id,
              companyId: bridge.companyId,
              workflowHandoffId: bridge.workflowHandoffId,
            }, "workflow handoff bridge: failed to log terminal bridge close failure");
          }
          summary.failed += 1;
        }
        continue;
      }

      let detected: Awaited<ReturnType<typeof detectClickUpAwaitingHumanBridgeEvents>>;
      try {
        detected = await detectBridgeEvents(bridge, messageId, overrides);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error({
          err: error,
          bridgeId: bridge.id,
          companyId: bridge.companyId,
          workflowHandoffId: bridge.workflowHandoffId,
          messageId,
        }, "workflow handoff bridge: ClickUp poll failed");
        await tryRecordBridgePollFailure(db, bridge, now, detail);
        try {
          await logActivity(db, {
            companyId: bridge.companyId,
            actorType: "system",
            actorId: "workflow_handoff_bridge",
            action: "workflow.handoff.bridge_poll_failed",
            entityType: "workflow_run",
            entityId: bridge.workflowRunId,
            details: { bridgeId: bridge.id, workflowHandoffId: bridge.workflowHandoffId, detail },
          });
        } catch (activityError) {
          logger.warn({
            err: activityError,
            bridgeId: bridge.id,
            companyId: bridge.companyId,
            workflowHandoffId: bridge.workflowHandoffId,
          }, "workflow handoff bridge: failed to log active bridge poll failure");
        }
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

      // Process first meaningful event -- acknowledge reply messages only after the workflow accepts them.
      const replyMessageIds = new Set<string>();
      for (const event of detected.events) {
        const replyId = typeof event.metadata?.clickupReplyId === "string" && event.metadata.clickupReplyId.trim().length > 0
          ? event.metadata.clickupReplyId.trim()
          : null;
        if (replyId) replyMessageIds.add(replyId);
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
        const applied = await resolveHandoffFromBridge(db, bridge, resolution, responseMarkdown);
        if (!applied) {
          const [currentHandoff] = await db
            .select({ status: workflowHandoffs.status })
            .from(workflowHandoffs)
            .where(eq(workflowHandoffs.id, bridge.workflowHandoffId))
            .limit(1);
          const acceptedOutcome = isResolvedHandoffStatus(currentHandoff?.status)
            ? currentHandoff.status
            : null;
          for (const replyId of replyMessageIds) {
            await applyReaction({
              db,
              bridgeId: bridge.id,
              companyId: bridge.companyId,
              workflowHandoffId: bridge.workflowHandoffId,
              messageId: replyId,
              reaction: acceptedOutcome ? "white_check_mark" : "x",
              target: "reply",
              overrides,
            });
          }
          const [staleRun] = await db
            .select({ status: workflowRuns.status, error: workflowRuns.error })
            .from(workflowRuns)
            .where(eq(workflowRuns.id, bridge.workflowRunId))
            .limit(1);
          if (!acceptedOutcome) {
            await db.update(workflowHandoffs).set({
              status: "cancelled",
              responseMarkdown: null,
              decidedByUserId: "workflow_handoff_bridge",
              decidedAt: now,
              updatedAt: now,
            }).where(and(
              eq(workflowHandoffs.id, bridge.workflowHandoffId),
              eq(workflowHandoffs.status, "pending"),
            ));
          }
          const closeOutcome = acceptedOutcome ?? toCloseOutcome(staleRun);
          await closeBridgeRow(db, bridge, closeOutcome, overrides);
          try {
            await logActivity(db, {
              companyId: bridge.companyId,
              actorType: "system",
              actorId: "workflow_handoff_bridge",
              action: "workflow.handoff.bridge_closed_terminal",
              entityType: "workflow_run",
              entityId: bridge.workflowRunId,
              details: {
                bridgeId: bridge.id,
                workflowHandoffId: bridge.workflowHandoffId,
                provider: bridge.provider,
                externalMessageId: bridge.externalMessageId ?? null,
                externalThreadId: bridge.externalThreadId ?? null,
                runStatus: staleRun?.status ?? null,
                runError: staleRun?.error ?? null,
                handoffStatus: currentHandoff?.status ?? null,
                closeOutcome,
              },
            });
          } catch (error) {
            logger.warn({
              err: error,
              bridgeId: bridge.id,
              companyId: bridge.companyId,
              workflowHandoffId: bridge.workflowHandoffId,
            }, "workflow handoff bridge: failed to log stale-run bridge closure");
          }
          if (acceptedOutcome) {
            summary.resolved += 1;
          } else {
            summary.terminalClosed += 1;
          }
          continue;
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

  async function closeResolvedHandoff(
    workflowHandoffId: string,
    outcome: "responded" | "approved" | "rejected",
  ) {
    const bridge = await getActiveBridge(workflowHandoffId);
    if (!bridge) return null;

    const config = await settings.resolveClickUpRuntimeConfig(bridge.companyId);
    const overrides = {
      personalToken: config.personalToken,
      workspaceId: config.workspaceId,
      channelId: config.channelId,
      attachmentTaskId: config.attachmentTaskId,
    };
    await closeBridgeRow(db, bridge, outcome, overrides);
    return getBridgeForHandoff(workflowHandoffId);
  }

  async function closeTerminalRunHandoffs(
    workflowRunId: string,
    outcome: TerminalBridgeCloseOutcome,
  ) {
    const bridges = await db
      .select()
      .from(workflowHandoffBridges)
      .where(and(
        eq(workflowHandoffBridges.workflowRunId, workflowRunId),
        inArray(workflowHandoffBridges.status, ["pending_delivery", "waiting_for_human"]),
      ))
      .orderBy(asc(workflowHandoffBridges.createdAt));
    if (bridges.length === 0) return [];

    const config = await settings.resolveClickUpRuntimeConfig(bridges[0]!.companyId);
    const overrides = {
      personalToken: config.personalToken,
      workspaceId: config.workspaceId,
      channelId: config.channelId,
      attachmentTaskId: config.attachmentTaskId,
    };

    for (const bridge of bridges) {
      await closeBridgeRow(db, bridge, outcome, overrides);
    }

    return Promise.all(bridges.map((bridge) => getBridgeForHandoff(bridge.workflowHandoffId)));
  }

  return {
    openForHandoff,
    pollActiveBridges,
    closeResolvedHandoff,
    closeTerminalRunHandoffs,
    getActiveBridge,
    getBridgeForHandoff,
  };
}
