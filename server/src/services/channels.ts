import { and, asc, desc, eq, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  channelMembers,
  channelMessages,
  channels,
  companies,
  companyMemberships,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import type {
  ChannelCardKind,
  ChannelMessageType,
  ChannelPresenceAgent,
  ChannelWorkMode,
  PrincipalType,
} from "@paperclipai/shared";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { publishLiveEvent } from "./live-events.js";

/** Issue statuses that no longer need a visible task card in a project channel. */
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];

const GENERAL_CHANNEL_SLUG = "general";
const DEFAULT_MESSAGE_PAGE_SIZE = 50;
const MAX_MESSAGE_PAGE_SIZE = 200;
/** Cap on lazily materialized task cards per request so a large project cannot stall a page load. */
const MAX_MATERIALIZED_ROOTS_PER_CALL = 200;

export interface ChannelActor {
  principalType: PrincipalType;
  principalId: string;
}

export interface ChannelMessagePage {
  messages: ChannelMessageRow[];
  nextCursor: string | null;
}

type ChannelRow = typeof channels.$inferSelect;
type ChannelMemberRow = typeof channelMembers.$inferSelect;
type ChannelMessageRow = typeof channelMessages.$inferSelect & {
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  issueStatus?: string | null;
};

export interface ChannelWithMembership extends ChannelRow {
  unreadCount: number;
  muted: boolean;
  isMember: boolean;
}

export interface PostChannelMessageInput {
  companyId: string;
  channelId: string;
  authorType: PrincipalType | "system";
  authorId: string | null;
  body?: string;
  messageType?: ChannelMessageType;
  threadRootId?: string | null;
  replyToId?: string | null;
  cardKind?: ChannelCardKind | null;
  channelWorkMode?: ChannelWorkMode | null;
  issueId?: string | null;
  heartbeatRunId?: string | null;
  workProductId?: string | null;
  interactionId?: string | null;
  approvalId?: string | null;
  documentId?: string | null;
  mentionedAgentIds?: string[];
  mentionedUserIds?: string[];
  metadata?: Record<string, unknown> | null;
  /** Set false for system/status cards that should not wake mentioned agents. */
  wakeMentionedAgents?: boolean;
}

export interface ChannelServiceOptions {
  /**
   * Wake hook used when a message mentions an agent. Defaults to the heartbeat
   * service so channel mentions behave like any other wake source.
   */
  enqueueWakeup?: (
    agentId: string,
    options: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
      reason?: string | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cursors carry only the boundary message id. The `(created_at, id)` keyset is
 * resolved in SQL so pagination is not skewed by the sub-millisecond precision
 * that Postgres keeps but JavaScript `Date` cannot represent.
 */
function decodeCursor(cursor: string): string {
  if (!UUID_RE.test(cursor)) throw badRequest("Invalid channel message cursor");
  return cursor;
}

function keysetBoundary(messageId: string) {
  return sql`(select "boundary"."created_at", "boundary"."id" from "channel_messages" as "boundary" where "boundary"."id" = ${messageId}::uuid)`;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_MESSAGE_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_MESSAGE_PAGE_SIZE);
}

export function slugifyChannelName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "channel";
}

/** Normalizes a display name so `@Ada Lovelace` and `@ada-lovelace` resolve alike. */
function normalizeMentionToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function extractMentionTokens(body: string): string[] {
  const tokens = new Set<string>();
  for (const match of body.matchAll(/(?:^|[\s(<[{])@([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
    const token = normalizeMentionToken(match[1] ?? "");
    if (token) tokens.add(token);
  }
  return [...tokens];
}

/** Stable fingerprint for a DM so `(a, b)` and `(b, a)` map to the same channel. */
export function dmFingerprint(participants: ChannelActor[]): string {
  return participants
    .map((participant) => `${participant.principalType}:${participant.principalId}`)
    .sort()
    .join("|");
}

export function channelService(db: Db, options: ChannelServiceOptions = {}) {
  const issuesSvc = issueService(db);

  let heartbeat: ReturnType<typeof heartbeatService> | null = null;
  const wakeAgent: NonNullable<ChannelServiceOptions["enqueueWakeup"]> =
    options.enqueueWakeup ?? ((agentId, wakeOptions) => {
      heartbeat ??= heartbeatService(db);
      return heartbeat.wakeup(agentId, wakeOptions);
    });

  async function getChannelById(channelId: string): Promise<ChannelRow | null> {
    return db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .then((rows) => rows[0] ?? null);
  }

  async function requireChannel(companyId: string, channelId: string): Promise<ChannelRow> {
    const channel = await getChannelById(channelId);
    if (!channel || channel.companyId !== companyId) throw notFound("Channel not found");
    return channel;
  }

  /** All company principals that should be auto-joined to broadcast channels. */
  async function listCompanyPrincipals(companyId: string): Promise<ChannelActor[]> {
    const [humanRows, agentRows] = await Promise.all([
      db
        .select({ principalId: companyMemberships.principalId })
        .from(companyMemberships)
        .where(and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        )),
      db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"))),
    ]);

    return [
      ...humanRows.map((row) => ({ principalType: "user" as const, principalId: row.principalId })),
      ...agentRows.map((row) => ({ principalType: "agent" as const, principalId: row.id })),
    ];
  }

  async function addMembers(
    companyId: string,
    channelId: string,
    principals: ChannelActor[],
    role: "member" | "admin" = "member",
  ): Promise<void> {
    if (principals.length === 0) return;
    await db
      .insert(channelMembers)
      .values(principals.map((principal) => ({
        companyId,
        channelId,
        principalType: principal.principalType,
        principalId: principal.principalId,
        role,
      })))
      .onConflictDoNothing();
  }

  async function getMember(
    channelId: string,
    actor: ChannelActor,
  ): Promise<ChannelMemberRow | null> {
    return db
      .select()
      .from(channelMembers)
      .where(and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.principalType, actor.principalType),
        eq(channelMembers.principalId, actor.principalId),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function listChannels(
    companyId: string,
    actor: ChannelActor,
    listOptions: { includeArchived?: boolean } = {},
  ): Promise<ChannelWithMembership[]> {
    const channelRows = await db
      .select()
      .from(channels)
      .where(listOptions.includeArchived
        ? eq(channels.companyId, companyId)
        : and(eq(channels.companyId, companyId), isNull(channels.archivedAt)))
      .orderBy(asc(channels.kind), asc(channels.name));

    if (channelRows.length === 0) return [];

    const memberRows = await db
      .select()
      .from(channelMembers)
      .where(and(
        eq(channelMembers.companyId, companyId),
        eq(channelMembers.principalType, actor.principalType),
        eq(channelMembers.principalId, actor.principalId),
      ));
    const memberByChannelId = new Map(memberRows.map((row) => [row.channelId, row]));

    const unreadRows = await db
      .select({
        channelId: channelMessages.channelId,
        unread: sql<number>`count(*)::int`,
      })
      .from(channelMessages)
      .innerJoin(channelMembers, and(
        eq(channelMembers.channelId, channelMessages.channelId),
        eq(channelMembers.principalType, actor.principalType),
        eq(channelMembers.principalId, actor.principalId),
      ))
      .where(and(
        eq(channelMessages.companyId, companyId),
        isNull(channelMessages.deletedAt),
        sql`${channelMessages.createdAt} > coalesce(${channelMembers.lastReadAt}, to_timestamp(0))`,
        sql`not (${channelMessages.authorType} = ${actor.principalType} and ${channelMessages.authorId} = ${actor.principalId})`,
      ))
      .groupBy(channelMessages.channelId);
    const unreadByChannelId = new Map(unreadRows.map((row) => [row.channelId, Number(row.unread)]));

    return channelRows
      // DMs are private to their members; broadcast channels stay visible to the company.
      .filter((channel) => channel.kind !== "dm" && channel.kind !== "group_dm"
        ? true
        : memberByChannelId.has(channel.id))
      .map((channel) => {
        const member = memberByChannelId.get(channel.id);
        return {
          ...channel,
          unreadCount: unreadByChannelId.get(channel.id) ?? 0,
          muted: member?.muted ?? false,
          isMember: Boolean(member),
        };
      });
  }

  function findChannelBySlug(companyId: string, slug: string) {
    return db
      .select()
      .from(channels)
      .where(and(eq(channels.companyId, companyId), eq(channels.slug, slug)))
      .then((rows) => rows[0] ?? null);
  }

  async function ensureGeneralChannel(companyId: string): Promise<ChannelRow> {
    let channel = await findChannelBySlug(companyId, GENERAL_CHANNEL_SLUG);

    if (!channel) {
      channel = await db
        .insert(channels)
        .values({
          companyId,
          kind: "public",
          name: "general",
          slug: GENERAL_CHANNEL_SLUG,
          topic: "Company-wide channel",
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
      // Lost the insert race against a concurrent bootstrap.
      channel ??= await findChannelBySlug(companyId, GENERAL_CHANNEL_SLUG);
      if (!channel) throw unprocessable("Failed to create the general channel");
    }

    await addMembers(companyId, channel.id, await listCompanyPrincipals(companyId));
    return channel;
  }

  async function ensureProjectChannel(
    companyId: string,
    projectId: string,
    projectName?: string,
  ): Promise<ChannelRow> {
    const existing = await db
      .select()
      .from(channels)
      .where(and(eq(channels.companyId, companyId), eq(channels.projectId, projectId)))
      .then((rows) => rows[0] ?? null);

    let channel = existing;
    if (!channel) {
      let name = projectName;
      if (!name) {
        const project = await db
          .select({ name: projects.name })
          .from(projects)
          .where(eq(projects.id, projectId))
          .then((rows) => rows[0] ?? null);
        name = project?.name ?? "project";
      }

      channel = await db
        .insert(channels)
        .values({
          companyId,
          kind: "project",
          name,
          slug: slugifyChannelName(name),
          projectId,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);

      // A concurrent create (or a slug collision) means the channel already exists.
      channel ??= await db
        .select()
        .from(channels)
        .where(and(eq(channels.companyId, companyId), eq(channels.projectId, projectId)))
        .then((rows) => rows[0] ?? null);

      if (!channel) {
        // Slug collision with an unrelated channel: retry without a slug.
        channel = await db
          .insert(channels)
          .values({ companyId, kind: "project", name, slug: null, projectId })
          .returning()
          .then((rows) => rows[0]);
      }
    }

    await addMembers(companyId, channel.id, await listCompanyPrincipals(companyId));
    return channel;
  }

  async function getOrCreateDm(
    companyId: string,
    actor: ChannelActor,
    target: ChannelActor,
  ): Promise<ChannelRow> {
    if (actor.principalType === target.principalType && actor.principalId === target.principalId) {
      throw unprocessable("Cannot open a direct message with yourself");
    }
    if (target.principalType === "agent") {
      const agent = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, target.principalId))
        .then((rows) => rows[0] ?? null);
      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
    }

    const participants = [actor, target];
    const fingerprint = dmFingerprint(participants);

    const findDm = () => db
      .select()
      .from(channels)
      .where(and(eq(channels.companyId, companyId), eq(channels.dmFingerprint, fingerprint)))
      .then((rows) => rows[0] ?? null);

    let channel = await findDm();
    if (!channel) {
      channel = await db
        .insert(channels)
        .values({
          companyId,
          kind: "dm",
          name: fingerprint,
          dmFingerprint: fingerprint,
          createdByUserId: actor.principalType === "user" ? actor.principalId : null,
          createdByAgentId: actor.principalType === "agent" ? actor.principalId : null,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
      channel ??= await findDm();
      if (!channel) throw unprocessable("Failed to open the direct message channel");
    }

    await addMembers(companyId, channel.id, participants);
    return channel;
  }

  const messageIssueSelection = {
    issueIdentifier: issues.identifier,
    issueTitle: issues.title,
    issueStatus: issues.status,
  };

  async function listRootMessages(
    channelId: string,
    pageOptions: { cursor?: string | null; limit?: number; includeCompleted?: boolean } = {},
  ): Promise<ChannelMessagePage> {
    const limit = clampLimit(pageOptions.limit);
    const conditions = [
      eq(channelMessages.channelId, channelId),
      isNull(channelMessages.threadRootId),
      isNull(channelMessages.deletedAt),
    ];

    if (!pageOptions.includeCompleted) {
      // Completed task cards are hidden by default; freeform roots always show.
      const notCompleted = or(
        isNull(channelMessages.issueId),
        isNull(issues.status),
        notInArray(issues.status, TERMINAL_ISSUE_STATUSES),
      );
      if (notCompleted) conditions.push(notCompleted);
    }

    if (pageOptions.cursor) {
      const boundaryId = decodeCursor(pageOptions.cursor);
      conditions.push(sql`(${channelMessages.createdAt}, ${channelMessages.id}) < ${keysetBoundary(boundaryId)}`);
    }

    const rows = await db
      .select({ message: channelMessages, ...messageIssueSelection })
      .from(channelMessages)
      .leftJoin(issues, eq(issues.id, channelMessages.issueId))
      .where(and(...conditions))
      .orderBy(desc(channelMessages.createdAt), desc(channelMessages.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const oldest = page.at(-1);

    return {
      // Oldest-first for rendering; the cursor walks backwards into history.
      messages: page
        .map((row) => ({
          ...row.message,
          issueIdentifier: row.issueIdentifier,
          issueTitle: row.issueTitle,
          issueStatus: row.issueStatus,
        }))
        .reverse(),
      nextCursor: hasMore && oldest ? oldest.message.id : null,
    };
  }

  async function listThreadMessages(
    rootId: string,
    pageOptions: { cursor?: string | null; limit?: number } = {},
  ): Promise<ChannelMessagePage> {
    const limit = clampLimit(pageOptions.limit);
    const conditions = [
      eq(channelMessages.threadRootId, rootId),
      isNull(channelMessages.deletedAt),
    ];

    if (pageOptions.cursor) {
      const boundaryId = decodeCursor(pageOptions.cursor);
      conditions.push(sql`(${channelMessages.createdAt}, ${channelMessages.id}) > ${keysetBoundary(boundaryId)}`);
    }

    const rows = await db
      .select({ message: channelMessages, ...messageIssueSelection })
      .from(channelMessages)
      .leftJoin(issues, eq(issues.id, channelMessages.issueId))
      .where(and(...conditions))
      .orderBy(asc(channelMessages.createdAt), asc(channelMessages.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const newest = page.at(-1);

    return {
      messages: page.map((row) => ({
        ...row.message,
        issueIdentifier: row.issueIdentifier,
        issueTitle: row.issueTitle,
        issueStatus: row.issueStatus,
      })),
      nextCursor: hasMore && newest ? newest.message.id : null,
    };
  }

  /**
   * Resolves `@name` tokens in a message body to company agent ids. Human
   * display names are not stored in the control-plane database, so user
   * mentions must be supplied explicitly by the caller.
   */
  async function resolveMentionedAgentIds(companyId: string, body: string): Promise<string[]> {
    const tokens = extractMentionTokens(body);
    if (tokens.length === 0) return [];

    const agentRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

    const byToken = new Map<string, string>();
    for (const agent of agentRows) {
      byToken.set(normalizeMentionToken(agent.name), agent.id);
    }

    const matched = new Set<string>();
    for (const token of tokens) {
      const agentId = byToken.get(token);
      if (agentId) matched.add(agentId);
    }
    return [...matched];
  }

  async function wakeMentionedAgents(input: {
    companyId: string;
    channelId: string;
    messageId: string;
    threadRootId: string | null;
    agentIds: string[];
    authorType: PrincipalType | "system";
    authorId: string | null;
  }): Promise<void> {
    for (const agentId of input.agentIds) {
      // A self-mention must not re-wake the author mid-run.
      if (input.authorType === "agent" && input.authorId === agentId) continue;
      try {
        await wakeAgent(agentId, {
          source: "on_demand",
          triggerDetail: "system",
          reason: "channel_mention",
          requestedByActorType: input.authorType === "system" ? "system" : input.authorType,
          requestedByActorId: input.authorId,
          contextSnapshot: {
            wakeReason: "channel_mention",
            wakeSource: "channel",
            channelId: input.channelId,
            channelMessageId: input.messageId,
            channelThreadRootId: input.threadRootId,
          },
        });
      } catch (error) {
        // A busy or paused agent must not fail the post; the message is queued in the channel.
        logger.warn({
          err: error,
          companyId: input.companyId,
          channelId: input.channelId,
          agentId,
        }, "channel mention wake failed");
      }
    }
  }

  async function postMessage(input: PostChannelMessageInput): Promise<ChannelMessageRow> {
    const channel = await requireChannel(input.companyId, input.channelId);
    const body = input.body ?? "";

    let threadRoot: ChannelMessageRow | null = null;
    if (input.threadRootId) {
      threadRoot = await db
        .select()
        .from(channelMessages)
        .where(eq(channelMessages.id, input.threadRootId))
        .then((rows) => rows[0] ?? null);
      if (!threadRoot || threadRoot.channelId !== channel.id) {
        throw notFound("Thread root not found");
      }
      if (threadRoot.threadRootId) {
        throw unprocessable("Threads cannot be nested");
      }
    }

    const mentionedAgentIds = input.mentionedAgentIds
      ?? await resolveMentionedAgentIds(input.companyId, body);
    const mentionedUserIds = input.mentionedUserIds ?? [];

    const message = await db
      .insert(channelMessages)
      .values({
        companyId: input.companyId,
        channelId: channel.id,
        authorType: input.authorType,
        authorId: input.authorId,
        messageType: input.messageType
          ?? (input.authorType === "system" ? "system" : input.authorType),
        body,
        threadRootId: threadRoot?.id ?? null,
        replyToId: input.replyToId ?? null,
        cardKind: input.cardKind ?? null,
        channelWorkMode: input.channelWorkMode ?? null,
        issueId: input.issueId ?? null,
        heartbeatRunId: input.heartbeatRunId ?? null,
        workProductId: input.workProductId ?? null,
        interactionId: input.interactionId ?? null,
        approvalId: input.approvalId ?? null,
        documentId: input.documentId ?? null,
        mentionedAgentIds,
        mentionedUserIds,
        metadata: input.metadata ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    if (threadRoot) {
      await db
        .update(channelMessages)
        .set({
          replyCount: sql`${channelMessages.replyCount} + 1`,
          lastReplyAt: message.createdAt,
          updatedAt: new Date(),
        })
        .where(eq(channelMessages.id, threadRoot.id));
    }

    publishLiveEvent({
      companyId: input.companyId,
      type: "channel.message.created",
      payload: {
        channelId: channel.id,
        messageId: message.id,
        threadRootId: message.threadRootId,
        authorType: message.authorType,
        authorId: message.authorId,
      },
    });

    if (input.wakeMentionedAgents !== false && mentionedAgentIds.length > 0) {
      await wakeMentionedAgents({
        companyId: input.companyId,
        channelId: channel.id,
        messageId: message.id,
        threadRootId: message.threadRootId,
        agentIds: mentionedAgentIds,
        authorType: input.authorType,
        authorId: input.authorId,
      });
    }

    return message;
  }

  /** Idempotently creates the root task card for an issue in its project channel. */
  async function ensureTaskRootMessage(
    companyId: string,
    issue: {
      id: string;
      projectId: string | null;
      title: string;
      assigneeAgentId?: string | null;
    },
  ): Promise<ChannelMessageRow | null> {
    if (!issue.projectId) return null;

    const existing = await db
      .select()
      .from(channelMessages)
      .where(and(
        eq(channelMessages.companyId, companyId),
        eq(channelMessages.issueId, issue.id),
        eq(channelMessages.cardKind, "task"),
        isNull(channelMessages.threadRootId),
        isNull(channelMessages.deletedAt),
      ))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const channel = await ensureProjectChannel(companyId, issue.projectId);

    const inserted = await db
      .insert(channelMessages)
      .values({
        companyId,
        channelId: channel.id,
        authorType: "system",
        authorId: null,
        messageType: "card",
        cardKind: "task",
        body: issue.title,
        issueId: issue.id,
      })
      .onConflictDoNothing()
      .returning()
      .then((rows) => rows[0] ?? null);

    if (inserted) {
      publishLiveEvent({
        companyId,
        type: "channel.message.created",
        payload: { channelId: channel.id, messageId: inserted.id, cardKind: "task" },
      });
      return inserted;
    }

    // Lost the insert race: another caller already materialized the card.
    return db
      .select()
      .from(channelMessages)
      .where(and(
        eq(channelMessages.issueId, issue.id),
        eq(channelMessages.cardKind, "task"),
        isNull(channelMessages.threadRootId),
        isNull(channelMessages.deletedAt),
      ))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Lazily backfills task cards for a project channel. Channels are created
   * eagerly, roots are materialized on first view.
   */
  async function materializeProjectTaskRoots(channelId: string): Promise<number> {
    const channel = await getChannelById(channelId);
    if (!channel?.projectId) return 0;

    const missing = await db
      .select({
        id: issues.id,
        title: issues.title,
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .leftJoin(channelMessages, and(
        eq(channelMessages.issueId, issues.id),
        eq(channelMessages.cardKind, "task"),
        isNull(channelMessages.threadRootId),
        isNull(channelMessages.deletedAt),
      ))
      .where(and(
        eq(issues.companyId, channel.companyId),
        eq(issues.projectId, channel.projectId),
        notInArray(issues.status, TERMINAL_ISSUE_STATUSES),
        isNull(issues.hiddenAt),
        isNull(channelMessages.id),
      ))
      .orderBy(asc(issues.createdAt))
      .limit(MAX_MATERIALIZED_ROOTS_PER_CALL);

    let created = 0;
    for (const issue of missing) {
      const message = await ensureTaskRootMessage(channel.companyId, issue);
      if (message) created += 1;
    }
    return created;
  }

  async function markRead(
    companyId: string,
    channelId: string,
    actor: ChannelActor,
    messageId?: string | null,
  ): Promise<ChannelMemberRow> {
    await requireChannel(companyId, channelId);
    await addMembers(companyId, channelId, [actor]);

    // Read the watermark straight out of the row so the stored timestamp keeps
    // full Postgres precision; a JS `Date` roundtrip would leave the marked
    // message itself looking unread.
    let lastReadAt: Date | SQL<Date> = new Date();
    if (messageId) {
      const message = await db
        .select({ channelId: channelMessages.channelId })
        .from(channelMessages)
        .where(eq(channelMessages.id, messageId))
        .then((rows) => rows[0] ?? null);
      if (!message || message.channelId !== channelId) throw notFound("Message not found");
      lastReadAt = sql<Date>`(select "watermark"."created_at" from "channel_messages" as "watermark" where "watermark"."id" = ${messageId}::uuid)`;
    }

    const member = await db
      .update(channelMembers)
      .set({ lastReadAt, lastReadMessageId: messageId ?? null, updatedAt: new Date() })
      .where(and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.principalType, actor.principalType),
        eq(channelMembers.principalId, actor.principalId),
      ))
      .returning()
      .then((rows) => rows[0]);

    publishLiveEvent({
      companyId,
      type: "channel.member.updated",
      payload: { channelId, principalType: actor.principalType, principalId: actor.principalId },
    });

    return member;
  }

  async function updateMember(
    companyId: string,
    channelId: string,
    actor: ChannelActor,
    data: { muted?: boolean; role?: "member" | "admin" },
  ): Promise<ChannelMemberRow> {
    await requireChannel(companyId, channelId);
    await addMembers(companyId, channelId, [actor]);

    const member = await db
      .update(channelMembers)
      .set({
        ...(data.muted === undefined ? {} : { muted: data.muted }),
        ...(data.role === undefined ? {} : { role: data.role }),
        updatedAt: new Date(),
      })
      .where(and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.principalType, actor.principalType),
        eq(channelMembers.principalId, actor.principalId),
      ))
      .returning()
      .then((rows) => rows[0]);

    publishLiveEvent({
      companyId,
      type: "channel.member.updated",
      payload: { channelId, principalType: actor.principalType, principalId: actor.principalId },
    });

    return member;
  }

  /**
   * Promotes a channel message into an issue. Root messages become task cards
   * in place; thread replies get a new root plus a link card in the thread so
   * the parent conversation keeps its context.
   */
  async function createIssueFromMessage(input: {
    companyId: string;
    channelId: string;
    messageId: string;
    actor: ChannelActor;
    title: string;
    assigneeAgentId?: string | null;
    projectId?: string | null;
    workMode?: "standard" | "ask" | "planning";
    wakeAssignee?: boolean;
  }) {
    const channel = await requireChannel(input.companyId, input.channelId);
    const message = await db
      .select()
      .from(channelMessages)
      .where(eq(channelMessages.id, input.messageId))
      .then((rows) => rows[0] ?? null);
    if (!message || message.channelId !== channel.id) throw notFound("Message not found");
    if (message.issueId) throw unprocessable("Message is already linked to an issue");

    const projectId = input.projectId ?? channel.projectId ?? null;
    const issue = await issuesSvc.create(input.companyId, {
      title: input.title,
      description: message.body || null,
      projectId,
      status: input.assigneeAgentId ? "todo" : "backlog",
      workMode: input.workMode ?? "standard",
      assigneeAgentId: input.assigneeAgentId ?? null,
      createdByUserId: input.actor.principalType === "user" ? input.actor.principalId : null,
      createdByAgentId: input.actor.principalType === "agent" ? input.actor.principalId : null,
      originKind: "manual",
      originId: message.id,
    });

    let rootMessage: ChannelMessageRow;
    if (!message.threadRootId) {
      rootMessage = await db
        .update(channelMessages)
        .set({
          issueId: issue.id,
          cardKind: "task",
          messageType: "card",
          updatedAt: new Date(),
        })
        .where(eq(channelMessages.id, message.id))
        .returning()
        .then((rows) => rows[0]);
    } else {
      rootMessage = await postMessage({
        companyId: input.companyId,
        channelId: channel.id,
        authorType: "system",
        authorId: null,
        messageType: "card",
        cardKind: "task",
        body: input.title,
        issueId: issue.id,
        wakeMentionedAgents: false,
      });
      await postMessage({
        companyId: input.companyId,
        channelId: channel.id,
        authorType: "system",
        authorId: null,
        messageType: "card",
        cardKind: "stub",
        body: `Created task from this message`,
        threadRootId: message.threadRootId,
        issueId: issue.id,
        metadata: { linkedRootMessageId: rootMessage.id, sourceMessageId: message.id },
        wakeMentionedAgents: false,
      });
    }

    if (input.wakeAssignee !== false && input.assigneeAgentId) {
      await wakeMentionedAgents({
        companyId: input.companyId,
        channelId: channel.id,
        messageId: rootMessage.id,
        threadRootId: null,
        agentIds: [input.assigneeAgentId],
        authorType: input.actor.principalType,
        authorId: input.actor.principalId,
      });
    }

    return { issue, message: rootMessage };
  }

  /** Agents currently executing a run, used for the channel presence rail. */
  async function listPresence(companyId: string): Promise<ChannelPresenceAgent[]> {
    const rows = await db
      .select({
        agentId: agents.id,
        name: agents.name,
        status: agents.status,
        runId: heartbeatRuns.id,
        startedAt: heartbeatRuns.startedAt,
        issueId: issues.id,
        issueIdentifier: issues.identifier,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .leftJoin(issues, eq(issues.executionRunId, heartbeatRuns.id))
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ))
      .orderBy(desc(heartbeatRuns.startedAt));

    const seen = new Set<string>();
    const presence: ChannelPresenceAgent[] = [];
    for (const row of rows) {
      if (seen.has(row.agentId)) continue;
      seen.add(row.agentId);
      presence.push({
        agentId: row.agentId,
        name: row.name,
        status: row.status,
        issueId: row.issueId ?? null,
        issueIdentifier: row.issueIdentifier ?? null,
        runId: row.runId,
        startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      });
    }
    return presence;
  }

  async function channelsEnabled(companyId: string): Promise<boolean> {
    return db
      .select({ enabled: companies.channelsEnabled })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.enabled ?? false);
  }

  async function createChannel(
    companyId: string,
    actor: ChannelActor,
    data: { kind: "public" | "private"; name: string; topic?: string | null; slug?: string },
  ): Promise<ChannelRow> {
    const channel = await db
      .insert(channels)
      .values({
        companyId,
        kind: data.kind,
        name: data.name,
        slug: data.slug ?? slugifyChannelName(data.name),
        topic: data.topic ?? null,
        createdByUserId: actor.principalType === "user" ? actor.principalId : null,
        createdByAgentId: actor.principalType === "agent" ? actor.principalId : null,
      })
      .returning()
      .then((rows) => rows[0]);

    // The creator is inserted first so the admin role wins over the bulk insert.
    await addMembers(companyId, channel.id, [actor], "admin");
    if (data.kind === "public") {
      await addMembers(companyId, channel.id, await listCompanyPrincipals(companyId));
    }
    return channel;
  }

  async function updateChannel(
    companyId: string,
    channelId: string,
    data: { name?: string; topic?: string | null; archivedAt?: Date | null },
  ): Promise<ChannelRow> {
    await requireChannel(companyId, channelId);
    return db
      .update(channels)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(channels.id, channelId))
      .returning()
      .then((rows) => rows[0]);
  }

  return {
    listChannels,
    getChannelById,
    requireChannel,
    createChannel,
    updateChannel,
    ensureGeneralChannel,
    ensureProjectChannel,
    getOrCreateDm,
    listRootMessages,
    listThreadMessages,
    postMessage,
    ensureTaskRootMessage,
    materializeProjectTaskRoots,
    markRead,
    updateMember,
    getMember,
    createIssueFromMessage,
    listPresence,
    channelsEnabled,
    listCompanyPrincipals,
    addMembers,
  };
}
