import {
  addClickUpChatMessageReaction,
  deleteClickUpChatMessageReaction,
  type ClickUpAwaitingHumanConfigOverrides,
  detectClickUpAwaitingHumanBridgeEvents,
  resolveClickUpAttachmentTaskId,
  sendAwaitingHumanNotification,
  uploadClickUpReviewFile,
} from "./clickup-awaiting-human-transport.js";
import type { AwaitingHumanBridgeAdapter, AwaitingHumanBridgePollEvent } from "./awaiting-human-bridge.js";
import { awaitingHumanBridges, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { Readable } from "node:stream";
import { awaitingHumanSettingsService } from "./awaiting-human-settings.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import type { StorageService } from "../storage/types.js";
import { resolveMostRecentIssueAttachmentForUpload } from "./awaiting-human-issue-attachments.js";


function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function readStreamToBuffer(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function loadIssueAttachmentUploadPayload(
  db: Db,
  storage: StorageService,
  companyId: string,
  attachmentId: string,
  meta: { title: string; contentPath: string },
) {
  const attachment = await issueService(db).getAttachmentById(attachmentId);
  if (!attachment || attachment.companyId !== companyId) return null;
  const object = await storage.getObject(attachment.companyId, attachment.objectKey);
  const body = await readStreamToBuffer(object.stream);
  return {
    body,
    reviewFile: {
      source: "artifact" as const,
      deliverableId: attachment.id,
      title: meta.title,
      filename: attachment.originalFilename ?? "attachment",
      contentType: attachment.contentType ?? object.contentType ?? "application/octet-stream",
      byteSize: attachment.byteSize ?? object.contentLength ?? body.length,
      contentPath: meta.contentPath,
      deliverableUrl: meta.contentPath,
      attachmentId: attachment.id,
      objectKey: attachment.objectKey,
      sha256: attachment.sha256,
    },
  };
}

async function resolveClickUpUploadPayload(
  db: Db,
  storage: StorageService | undefined,
  companyId: string,
  issueId: string,
) {
  if (!storage) return null;

  const issueAttachment = await resolveMostRecentIssueAttachmentForUpload(db, {
    companyId,
    issueId,
  });
  if (!issueAttachment) return null;

  const loaded = await loadIssueAttachmentUploadPayload(
    db,
    storage,
    companyId,
    issueAttachment.attachmentId,
    {
      title: issueAttachment.label,
      contentPath: issueAttachment.href,
    },
  );
  if (!loaded) return null;
  return { ...loaded, attachTo: "target" as const };
}


async function loadCompanyOverrides(db: Db, companyId: string): Promise<ClickUpAwaitingHumanConfigOverrides> {
  const resolved = await awaitingHumanSettingsService(db).resolveClickUpRuntimeConfig(companyId);
  return {
    personalToken: resolved.personalToken,
    workspaceId: resolved.workspaceId,
    channelId: resolved.channelId,
    attachmentTaskId: resolved.attachmentTaskId,
  };
}

function requireClickUpAttachmentTaskId(overrides: ClickUpAwaitingHumanConfigOverrides) {
  const taskId = resolveClickUpAttachmentTaskId(overrides);
  if (!taskId) {
    throw new Error("missing-target: attachmentTaskId");
  }
  return taskId;
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
      let clickupNotification = input.notification;

      const uploadPayload = await resolveClickUpUploadPayload(
        db,
        input.storage,
        input.companyId,
        input.issueId,
      );
      if (uploadPayload) {
        if (!input.storage) {
          throw new Error("missing-storage: awaiting human ClickUp attachment upload requires storage");
        }
        const attachmentTaskId = requireClickUpAttachmentTaskId(overrides);
        logger.info({
          companyId: input.companyId,
          issueId: input.issueId,
          interactionId: input.interactionId,
          attachmentTaskId,
          attachTo: uploadPayload.attachTo,
          filename: uploadPayload.reviewFile.filename,
        }, "clickup awaiting human attachment upload starting");

        const uploaded = await uploadClickUpReviewFile(
          overrides,
          attachmentTaskId,
          uploadPayload.reviewFile,
          uploadPayload.body,
        );

        clickupNotification = {
          ...clickupNotification,
          target: {
            ...clickupNotification.target,
            clickupAttachmentUrl: uploaded.attachmentUrl ?? null,
          },
        };
      } else if (resolveClickUpAttachmentTaskId(overrides)) {
        logger.warn({
          companyId: input.companyId,
          issueId: input.issueId,
          interactionId: input.interactionId,
          targetHref: readString(input.notification.target?.href),
          hasStorage: Boolean(input.storage),
        }, "clickup awaiting human attachment upload skipped: no uploadable file resolved");
      }

      const result = await sendAwaitingHumanNotification({
        companyId: input.companyId,
        issueId: input.issueId,
        handoffKind: input.handoffKind,
        notification: clickupNotification,
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
      let detected;
      try {
        detected = await detectClickUpAwaitingHumanBridgeEvents(messageId, overrides);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error({
          err: error,
          bridgeId: input.bridgeId,
          companyId: bridge.companyId,
          issueId: bridge.issueId,
          interactionId: bridge.interactionId,
          messageId,
        }, "clickup awaiting human reply detect failed");
        return { status: "failed" as const, detail, events: [] };
      }
      const events: AwaitingHumanBridgePollEvent[] = detected.events;
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
        return { status: detected.status, detail: detected.detail, events: detected.events };
      }

      const events: AwaitingHumanBridgePollEvent[] = detected.events;

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
      if (input.outcome === "approved" || input.outcome === "superseded" || input.outcome === "rejected") {
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
      } else if (input.outcome === "failed") {
        await applyBridgeReaction({
          db,
          bridgeId: input.bridgeId,
          companyId: bridge.companyId,
          issueId: bridge.issueId,
          interactionId: bridge.interactionId,
          messageId,
          reaction: "x",
          target: "main",
          overrides,
        });
      }
    },
  };
}
