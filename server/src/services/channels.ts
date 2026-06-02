import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { channels, channelMessages, channelRoutes } from "@paperclipai/db";
import type {
  Channel,
  ChannelMessage,
  ChannelRoute,
  CreateChannel,
  CreateChannelRoute,
  ListChannelMessagesQuery,
  UpdateChannel,
  UpdateChannelRoute,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

const SENSITIVE_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|signing[-_]?secret|webhook[-_]?url|bot[-_]?token)/i;

const REDACTED = "***REDACTED***";

export function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/**
 * Recursively redact values for sensitive keys in a channel config object.
 * Used before returning config in GET responses so secrets stay in the DB row
 * but never reach API consumers in plaintext.
 */
export function redactChannelConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactChannelConfig);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveConfigKey(key) && val !== null && val !== undefined && val !== "") {
      out[key] = REDACTED;
    } else if (val && typeof val === "object") {
      out[key] = redactChannelConfig(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function rowToChannel(row: typeof channels.$inferSelect, opts?: { redact?: boolean }): Channel {
  const config = row.config as Record<string, unknown>;
  return {
    id: row.id,
    companyId: row.companyId,
    platform: row.platform as Channel["platform"],
    name: row.name,
    config: opts?.redact === false ? config : (redactChannelConfig(config) as Record<string, unknown>),
    status: row.status as Channel["status"],
    direction: row.direction as Channel["direction"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToRoute(row: typeof channelRoutes.$inferSelect): ChannelRoute {
  return {
    id: row.id,
    companyId: row.companyId,
    channelId: row.channelId,
    trigger: row.trigger,
    filter: row.filter as Record<string, unknown> | null,
    template: row.template,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

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

export function channelService(db: Db) {
  async function listChannels(companyId: string): Promise<Channel[]> {
    const rows = await db
      .select()
      .from(channels)
      .where(eq(channels.companyId, companyId))
      .orderBy(desc(channels.createdAt));
    return rows.map((row) => rowToChannel(row));
  }

  async function getChannel(id: string): Promise<Channel | null> {
    const rows = await db.select().from(channels).where(eq(channels.id, id));
    return rows[0] ? rowToChannel(rows[0]) : null;
  }

  /**
   * Internal-only: returns the channel with full plaintext config. Use this
   * for adapter dispatch where the bot token / webhook URL is required.
   * Never return the result of this function from an HTTP route.
   */
  async function getChannelWithSecrets(id: string): Promise<Channel | null> {
    const rows = await db.select().from(channels).where(eq(channels.id, id));
    return rows[0] ? rowToChannel(rows[0], { redact: false }) : null;
  }

  async function createChannel(companyId: string, input: CreateChannel): Promise<Channel> {
    const rows = await db
      .insert(channels)
      .values({
        companyId,
        platform: input.platform,
        name: input.name,
        config: input.config ?? {},
        status: input.status ?? "active",
        direction: input.direction ?? "outbound",
      })
      .returning();
    return rowToChannel(rows[0]);
  }

  async function updateChannel(
    companyId: string,
    id: string,
    input: UpdateChannel,
  ): Promise<Channel> {
    if (Object.keys(input).length === 0) {
      throw unprocessable("Update body must contain at least one field");
    }
    const rows = await db
      .update(channels)
      .set({
        ...(input.platform !== undefined && { platform: input.platform }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.config !== undefined && { config: input.config }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.direction !== undefined && { direction: input.direction }),
        updatedAt: new Date(),
      })
      .where(and(eq(channels.id, id), eq(channels.companyId, companyId)))
      .returning();
    if (rows.length === 0) throw notFound("Channel not found");
    return rowToChannel(rows[0]);
  }

  async function deleteChannel(companyId: string, id: string): Promise<void> {
    const result = await db
      .delete(channels)
      .where(and(eq(channels.id, id), eq(channels.companyId, companyId)))
      .returning({ id: channels.id });
    if (result.length === 0) throw notFound("Channel not found");
  }

  async function listRoutes(companyId: string, channelId?: string): Promise<ChannelRoute[]> {
    const conditions = [eq(channelRoutes.companyId, companyId)];
    if (channelId) conditions.push(eq(channelRoutes.channelId, channelId));
    const rows = await db
      .select()
      .from(channelRoutes)
      .where(and(...conditions))
      .orderBy(desc(channelRoutes.createdAt));
    return rows.map(rowToRoute);
  }

  async function getRoute(id: string): Promise<ChannelRoute | null> {
    const rows = await db.select().from(channelRoutes).where(eq(channelRoutes.id, id));
    return rows[0] ? rowToRoute(rows[0]) : null;
  }

  async function createRoute(companyId: string, input: CreateChannelRoute): Promise<ChannelRoute> {
    const channelRows = await db
      .select({ companyId: channels.companyId })
      .from(channels)
      .where(eq(channels.id, input.channelId));
    if (channelRows.length === 0 || channelRows[0].companyId !== companyId) {
      throw notFound("Channel not found");
    }
    const rows = await db
      .insert(channelRoutes)
      .values({
        companyId,
        channelId: input.channelId,
        trigger: input.trigger,
        filter: input.filter ?? null,
        template: input.template ?? null,
        enabled: input.enabled ?? true,
      })
      .returning();
    return rowToRoute(rows[0]);
  }

  async function updateRoute(
    companyId: string,
    id: string,
    input: UpdateChannelRoute,
  ): Promise<ChannelRoute> {
    if (Object.keys(input).length === 0) {
      throw unprocessable("Update body must contain at least one field");
    }
    const rows = await db
      .update(channelRoutes)
      .set({
        ...(input.trigger !== undefined && { trigger: input.trigger }),
        ...(input.filter !== undefined && { filter: input.filter }),
        ...(input.template !== undefined && { template: input.template }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
      })
      .where(and(eq(channelRoutes.id, id), eq(channelRoutes.companyId, companyId)))
      .returning();
    if (rows.length === 0) throw notFound("Channel route not found");
    return rowToRoute(rows[0]);
  }

  async function deleteRoute(companyId: string, id: string): Promise<void> {
    const result = await db
      .delete(channelRoutes)
      .where(and(eq(channelRoutes.id, id), eq(channelRoutes.companyId, companyId)))
      .returning({ id: channelRoutes.id });
    if (result.length === 0) throw notFound("Channel route not found");
  }

  async function listMessages(companyId: string, query: ListChannelMessagesQuery): Promise<ChannelMessage[]> {
    const conditions = [eq(channelMessages.companyId, companyId)];
    if (query.channelId) conditions.push(eq(channelMessages.channelId, query.channelId));
    if (query.direction) conditions.push(eq(channelMessages.direction, query.direction));
    if (query.status) conditions.push(eq(channelMessages.status, query.status));
    const rows = await db
      .select()
      .from(channelMessages)
      .where(and(...conditions))
      .orderBy(desc(channelMessages.createdAt))
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0);
    return rows.map(rowToMessage);
  }

  return {
    listChannels,
    getChannel,
    getChannelWithSecrets,
    createChannel,
    updateChannel,
    deleteChannel,
    listRoutes,
    getRoute,
    createRoute,
    updateRoute,
    deleteRoute,
    listMessages,
  };
}
