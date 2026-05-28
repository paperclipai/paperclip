import {
  addClickUpChatMessageReaction,
  deleteClickUpChatMessageReaction,
  type ClickUpAwaitingHumanConfigOverrides,
  detectClickUpAwaitingHumanBridgeEvents,
  sendAwaitingHumanNotification,
} from "./clickup-awaiting-human-transport.js";
import type { AwaitingHumanBridgeAdapter, AwaitingHumanBridgePollEvent } from "./awaiting-human-bridge.js";
import { awaitingHumanBridges, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { awaitingHumanSettingsService } from "./awaiting-human-settings.js";
import { logActivity } from "./activity-log.js";

async function loadCompanyOverrides(db: Db, companyId: string): Promise<ClickUpAwaitingHumanConfigOverrides> {
  const resolved = await awaitingHumanSettingsService(db).resolveClickUpRuntimeConfig(companyId);
  return {
    personalToken: resolved.personalToken,
    workspaceId: resolved.workspaceId,
    channelId: resolved.channelId,
  };
}

async function loadBridgeOverrides(db: Db, bridgeId: string) {
  const [bridge] = await db
    .select({ companyId: awaitingHumanBridges.companyId })
    .from(awaitingHumanBridges)
    .where(eq(awaitingHumanBridges.id, bridgeId))
    .limit(1);
  if (!bridge) {
    throw new Error("awaiting-human-bridge-not-found");
  }
  return loadCompanyOverrides(db, bridge.companyId);
}

async function loadBridgeContext(db: Db, bridgeId: string) {
  const [bridge] = await db
    .select({
      companyId: awaitingHumanBridges.companyId,
      issueId: awaitingHumanBridges.issueId,
      interactionId: awaitingHumanBridges.interactionId,
    })
    .from(awaitingHumanBridges)
    .where(eq(awaitingHumanBridges.id, bridgeId))
    .limit(1);
  if (!bridge) {
    throw new Error("awaiting-human-bridge-not-found");
  }
  return bridge;
}

async function logBridgeReactionActivity(db: Db, input: {
  bridgeId: string;
  companyId: string;
  issueId: string;
  interactionId: string;
  messageId: string;
  reaction: string;
  target: "main" | "reply";
  status: "sent" | "failed" | "skipped";
  detail: string;
}) {
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "clickup_approval_poller",
    action: input.target === "main"
      ? "issue.awaiting_human.state_reaction"
      : "issue.awaiting_human.reply_reaction",
    entityType: "issue",
    entityId: input.issueId,
    details: {
      bridgeId: input.bridgeId,
      interactionId: input.interactionId,
      messageId: input.messageId,
      reaction: input.reaction,
      target: input.target,
      status: input.status,
      detail: input.detail,
    },
  });
}

async function applyBridgeReaction(input: {
  db: Db;
  bridgeId: string;
  companyId: string;
  issueId: string;
  interactionId: string;
  messageId: string;
  reaction: string;
  target: "main" | "reply";
  overrides: ClickUpAwaitingHumanConfigOverrides;
}) {
  try {
    const result = await addClickUpChatMessageReaction(input.messageId, input.reaction, input.overrides);
    await logBridgeReactionActivity(input.db, {
      bridgeId: input.bridgeId,
      companyId: input.companyId,
      issueId: input.issueId,
      interactionId: input.interactionId,
      messageId: input.messageId,
      reaction: input.reaction,
      target: input.target,
      status: result.status,
      detail: result.detail,
    });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await logBridgeReactionActivity(input.db, {
      bridgeId: input.bridgeId,
      companyId: input.companyId,
      issueId: input.issueId,
      interactionId: input.interactionId,
      messageId: input.messageId,
      reaction: input.reaction,
      target: input.target,
      status: "failed",
      detail,
    });
    return { status: "failed" as const, detail };
  }
}

async function removeBridgeReaction(input: {
  db: Db;
  bridgeId: string;
  companyId: string;
  issueId: string;
  interactionId: string;
  messageId: string;
  reaction: string;
  overrides: ClickUpAwaitingHumanConfigOverrides;
}) {
  try {
    const result = await deleteClickUpChatMessageReaction(input.messageId, input.reaction, input.overrides);
    await logBridgeReactionActivity(input.db, {
      bridgeId: input.bridgeId,
      companyId: input.companyId,
      issueId: input.issueId,
      interactionId: input.interactionId,
      messageId: input.messageId,
      reaction: input.reaction,
      target: "main",
      status: result.status,
      detail: result.detail,
    });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await logBridgeReactionActivity(input.db, {
      bridgeId: input.bridgeId,
      companyId: input.companyId,
      issueId: input.issueId,
      interactionId: input.interactionId,
      messageId: input.messageId,
      reaction: input.reaction,
      target: "main",
      status: "failed",
      detail,
    });
    return { status: "failed" as const, detail };
  }
}

async function acknowledgeClickUpReply(input: {
  messageId: string;
  overrides: ClickUpAwaitingHumanConfigOverrides;
}) {
  const result = await addClickUpChatMessageReaction(input.messageId, "white_check_mark", input.overrides);
  return result;
}

export function clickupAwaitingHumanBridgeAdapter(db: Db): AwaitingHumanBridgeAdapter {
  return {
    async send(input) {
      const overrides = await loadCompanyOverrides(db, input.companyId);
      const result = await sendAwaitingHumanNotification({
        companyId: input.companyId,
        issueId: input.issueId,
        handoffKind: input.handoffKind,
        notification: input.notification,
      }, overrides);
      if (result.status !== "sent") {
        throw new Error(result.detail);
      }
      if (result.externalId) {
        await applyBridgeReaction({
          db,
          bridgeId: input.bridgeId,
          companyId: input.companyId,
          issueId: input.issueId,
          interactionId: input.interactionId,
          messageId: result.externalId,
          reaction: "brain_is_thinking",
          target: "main",
          overrides,
        });
      }
      return {
        externalThreadId: result.externalId ?? null,
        externalMessageId: result.externalId ?? null,
        nextPollAt: new Date(Date.now() + 60_000),
      };
    },

    async poll(input) {
      const messageId = input.externalMessageId?.trim();
      if (!messageId) {
        return { status: "skipped", detail: "missing-external-message-id", events: [] };
      }
      const overrides = await loadBridgeOverrides(db, input.bridgeId);
      const bridge = await loadBridgeContext(db, input.bridgeId);
      const detected = await detectClickUpAwaitingHumanBridgeEvents(messageId, overrides);
      const events: AwaitingHumanBridgePollEvent[] = detected.events.map((event) => ({
        kind: event.kind,
        externalEventId: event.externalEventId,
        externalMessageId: event.externalMessageId,
        body: event.body ?? null,
        metadata: event.metadata ?? {},
      }));
      const status: "ok" | "skipped" | "failed" =
        detected.status === "sent"
          ? "ok"
          : detected.status === "skipped"
          ? "skipped"
            : "failed";

      if (events.length > 0) {
        const replyMessageIds = new Set<string>();
        for (const event of events) {
          const replyMessageId = typeof event.metadata?.clickupReplyId === "string" && event.metadata.clickupReplyId.trim().length > 0
            ? event.metadata.clickupReplyId.trim()
            : null;
          if (!replyMessageId) continue;
          replyMessageIds.add(replyMessageId);
        }
        for (const replyMessageId of replyMessageIds) {
          await applyBridgeReaction({
            db,
            bridgeId: input.bridgeId,
            companyId: bridge.companyId,
            issueId: bridge.issueId,
            interactionId: bridge.interactionId,
            messageId: replyMessageId,
            reaction: "white_check_mark",
            target: "reply",
            overrides,
          });
        }
      }

      return {
        status,
        detail: detected.detail,
        events,
      };
    },

    async pollOutboxReplies(input) {
      const messageId = input.externalMessageId?.trim();
      if (!messageId) {
        return { status: "skipped", detail: "missing-external-message-id", events: [] };
      }
      const overrides = await loadCompanyOverrides(db, input.companyId);
      const detected = await detectClickUpAwaitingHumanBridgeEvents(messageId, overrides);
      if (detected.status === "failed" || detected.status === "skipped") {
        return { status: detected.status, detail: detected.detail, events: detected.events.map((event) => ({
          kind: event.kind,
          externalEventId: event.externalEventId,
          externalMessageId: event.externalMessageId,
          body: event.body ?? null,
          metadata: event.metadata ?? {},
        })) };
      }

      const events: AwaitingHumanBridgePollEvent[] = detected.events.map((event) => ({
        kind: event.kind,
        externalEventId: event.externalEventId,
        externalMessageId: event.externalMessageId,
        body: event.body ?? null,
        metadata: event.metadata ?? {},
      }));

      const replyMessageIds = new Set<string>();
      for (const event of events) {
        const replyMessageId = typeof event.metadata?.clickupReplyId === "string" && event.metadata.clickupReplyId.trim().length > 0
          ? event.metadata.clickupReplyId.trim()
          : null;
        if (!replyMessageId) continue;
        replyMessageIds.add(replyMessageId);
      }
      for (const replyMessageId of replyMessageIds) {
        await acknowledgeClickUpReply({ messageId: replyMessageId, overrides });
      }

      return {
        status: "ok" as const,
        detail: detected.detail,
        events,
      };
    },

    async close(input) {
      const messageId = input.externalMessageId?.trim();
      if (!messageId) return;
      const overrides = await loadBridgeOverrides(db, input.bridgeId);
      const bridge = await loadBridgeContext(db, input.bridgeId);
      await removeBridgeReaction({
        db,
        bridgeId: input.bridgeId,
        companyId: bridge.companyId,
        issueId: bridge.issueId,
        interactionId: bridge.interactionId,
        messageId,
        reaction: "brain_is_thinking",
        overrides,
      });
      if (input.outcome === "approved" || input.outcome === "superseded") {
        await applyBridgeReaction({
          db,
          bridgeId: input.bridgeId,
          companyId: bridge.companyId,
          issueId: bridge.issueId,
          interactionId: bridge.interactionId,
          messageId,
          reaction: "white_check_mark",
          target: "main",
          overrides,
        });
      } else if (input.outcome === "rejected") {
        await applyBridgeReaction({
          db,
          bridgeId: input.bridgeId,
          companyId: bridge.companyId,
          issueId: bridge.issueId,
          interactionId: bridge.interactionId,
          messageId,
          reaction: "thumbsdown",
          target: "main",
          overrides,
        });
      }
    },
  };
}
