import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { channelMessages } from "@paperclipai/db";
import type {
  ChannelMessage,
  ChannelMessageStatus,
} from "@paperclipai/shared";
import {
  createSender,
  type ChannelMessageStore,
  type SendOptions,
  type SendResult,
} from "@paperclipai/channels";
import { channelService } from "./channels.js";
import { notFound } from "../errors.js";

function rowToMessage(row: typeof channelMessages.$inferSelect): ChannelMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    channelId: row.channelId,
    direction: row.direction as ChannelMessage["direction"],
    content: row.content,
    metadata: row.metadata as Record<string, unknown>,
    issueId: row.issueId,
    agentId: row.agentId,
    status: row.status as ChannelMessage["status"],
    createdAt: row.createdAt.toISOString(),
  };
}

function createDrizzleStore(db: Db): ChannelMessageStore {
  return {
    async create(input) {
      const rows = await db
        .insert(channelMessages)
        .values({
          companyId: input.companyId,
          channelId: input.channelId,
          direction: "outbound",
          content: input.content,
          metadata: input.metadata,
          issueId: input.issueId ?? null,
          agentId: input.agentId ?? null,
          status: "pending",
        })
        .returning();
      return rowToMessage(rows[0]);
    },
    async updateStatus(id, status: ChannelMessageStatus, metadata) {
      const rows = await db
        .update(channelMessages)
        .set({ status, metadata })
        .where(eq(channelMessages.id, id))
        .returning();
      if (rows.length === 0) throw new Error(`channel message ${id} not found`);
      return rowToMessage(rows[0]);
    },
  };
}

export function channelSenderService(db: Db) {
  const svc = channelService(db);
  const store = createDrizzleStore(db);
  const sender = createSender({ store });

  /**
   * Send a message through a configured channel. Resolves the channel
   * (with plaintext config — never returned outside this service),
   * dispatches via the platform adapter, persists pending → delivered/failed.
   */
  async function sendByChannelId(
    companyId: string,
    channelId: string,
    content: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const channel = await svc.getChannelWithSecrets(channelId);
    if (!channel || channel.companyId !== companyId) {
      throw notFound("Channel not found");
    }
    return sender.send(channel, content, options);
  }

  /**
   * Send a verification "test" message. Returns the freshly stored
   * message row so the caller can surface delivery status without
   * leaking adapter internals.
   */
  async function sendTestMessage(
    companyId: string,
    channelId: string,
    options: { content?: string; agentId?: string | null } = {},
  ): Promise<SendResult> {
    const content =
      options.content ??
      "Paperclip test message: this channel is wired up correctly.";
    return sendByChannelId(companyId, channelId, content, {
      agentId: options.agentId ?? null,
      metadata: { test: true },
    });
  }

  /**
   * Verify a message belongs to the company. Useful for any future
   * status-poll endpoint.
   */
  async function getMessage(
    companyId: string,
    messageId: string,
  ): Promise<ChannelMessage | null> {
    const rows = await db
      .select()
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.id, messageId),
          eq(channelMessages.companyId, companyId),
        ),
      );
    return rows[0] ? rowToMessage(rows[0]) : null;
  }

  return { sendByChannelId, sendTestMessage, getMessage };
}
