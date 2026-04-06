import { and, desc, eq, gt, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agentChannels, agents, channelMemberships, channelMessages, issues } from "@ironworksai/db";

export type Channel = typeof agentChannels.$inferSelect;
export type Message = typeof channelMessages.$inferSelect;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function upsertChannel(
  db: Db,
  companyId: string,
  scopeType: string,
  scopeId: string | null,
  name: string,
): Promise<string> {
  // Try to find existing channel first
  const existing = await db
    .select({ id: agentChannels.id })
    .from(agentChannels)
    .where(
      and(
        eq(agentChannels.companyId, companyId),
        eq(agentChannels.scopeType, scopeType),
        scopeId !== null
          ? eq(agentChannels.scopeId, scopeId)
          : sql`${agentChannels.scopeId} IS NULL`,
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (existing) return existing.id;

  const [created] = await db
    .insert(agentChannels)
    .values({ companyId, scopeType, scopeId: scopeId ?? undefined, name })
    .returning({ id: agentChannels.id });

  return created.id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Auto-create the #company channel for a company. Returns the channel id. */
export async function ensureCompanyChannel(db: Db, companyId: string): Promise<string> {
  return upsertChannel(db, companyId, "company", null, "company");
}

/**
 * Seed default channels for a new company (idempotent - uses upsert).
 * Creates: #company, #engineering, #marketing, #operations, #leadership
 */
export async function seedDefaultChannels(db: Db, companyId: string): Promise<void> {
  const defaults: Array<{ scopeType: string; scopeId: string | null; name: string }> = [
    { scopeType: "company", scopeId: null, name: "company" },
    { scopeType: "department", scopeId: "engineering", name: "engineering" },
    { scopeType: "department", scopeId: "marketing", name: "marketing" },
    { scopeType: "department", scopeId: "operations", name: "operations" },
    { scopeType: "department", scopeId: "leadership", name: "leadership" },
  ];

  for (const ch of defaults) {
    await upsertChannel(db, companyId, ch.scopeType, ch.scopeId, ch.name);
  }
}

/** Auto-create a department channel. Returns the channel id. */
export async function ensureDepartmentChannel(
  db: Db,
  companyId: string,
  department: string,
): Promise<string> {
  return upsertChannel(db, companyId, "department", department, department);
}

/** Auto-create a project channel. Returns the channel id. */
export async function ensureProjectChannel(
  db: Db,
  companyId: string,
  projectId: string,
  projectName: string,
): Promise<string> {
  return upsertChannel(db, companyId, "project", projectId, projectName);
}

/**
 * Auto-join an agent to the #company channel and, if a department is
 * provided, to the department channel as well.
 */
export async function autoJoinAgentChannels(
  db: Db,
  companyId: string,
  agentId: string,
  department?: string,
): Promise<void> {
  const channelIds: string[] = [];

  const companyChannelId = await ensureCompanyChannel(db, companyId);
  channelIds.push(companyChannelId);

  if (department) {
    const deptChannelId = await ensureDepartmentChannel(db, companyId, department);
    channelIds.push(deptChannelId);
  }

  for (const channelId of channelIds) {
    // Upsert membership - ignore conflict if already a member
    await db
      .insert(channelMemberships)
      .values({ channelId, agentId })
      .onConflictDoNothing();
  }
}

/** List all channels for a company, with member count. */
export async function listChannels(db: Db, companyId: string): Promise<Channel[]> {
  return db
    .select()
    .from(agentChannels)
    .where(eq(agentChannels.companyId, companyId))
    .orderBy(agentChannels.createdAt);
}

/** Get paginated messages for a channel, newest first. */
export async function getMessages(
  db: Db,
  channelId: string,
  opts?: { limit?: number; before?: string },
): Promise<Message[]> {
  const limit = opts?.limit ?? 50;
  const conditions = [eq(channelMessages.channelId, channelId)];

  if (opts?.before) {
    // before is an ISO timestamp cursor
    conditions.push(lt(channelMessages.createdAt, new Date(opts.before)));
  }

  const rows = await db
    .select()
    .from(channelMessages)
    .where(and(...conditions))
    .orderBy(desc(channelMessages.createdAt))
    .limit(limit);

  // Resolve user names for messages with authorUserId
  const userIds = [...new Set(rows.filter((r) => r.authorUserId).map((r) => r.authorUserId!))];
  const userNames = new Map<string, string>();
  if (userIds.length > 0) {
    const { authUsers } = await import("@ironworksai/db");
    const users = await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds));
    for (const u of users) userNames.set(u.id, u.name);
  }

  return rows.map((r) => ({
    ...r,
    authorUserName: r.authorUserId ? (userNames.get(r.authorUserId) ?? null) : null,
  }));
}

/**
 * Find the #company channel for a company. Returns the channel or null if it
 * doesn't exist yet (channels are created lazily on first agent join).
 */
export async function findCompanyChannel(
  db: Db,
  companyId: string,
): Promise<{ id: string } | null> {
  return db
    .select({ id: agentChannels.id })
    .from(agentChannels)
    .where(
      and(
        eq(agentChannels.companyId, companyId),
        eq(agentChannels.scopeType, "company"),
        sql`${agentChannels.scopeId} IS NULL`,
      ),
    )
    .then((rows) => rows[0] ?? null);
}

/**
 * Find the department channel for a given department. Returns null if the
 * channel doesn't exist yet or if department is null/empty.
 */
export async function findAgentDepartmentChannel(
  db: Db,
  companyId: string,
  department: string | null,
): Promise<{ id: string } | null> {
  if (!department) return null;
  return db
    .select({ id: agentChannels.id })
    .from(agentChannels)
    .where(
      and(
        eq(agentChannels.companyId, companyId),
        eq(agentChannels.scopeType, "department"),
        eq(agentChannels.scopeId, department),
      ),
    )
    .then((rows) => rows[0] ?? null);
}

/** Get last N messages from a channel for context injection, oldest first. */
export async function getRecentMessages(
  db: Db,
  channelId: string,
  limit: number,
): Promise<Message[]> {
  const rows = await db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.channelId, channelId))
    .orderBy(desc(channelMessages.createdAt))
    .limit(limit);
  // Return in chronological order (oldest first)
  return rows.reverse();
}

/** Post a message to a channel. */
export async function postMessage(
  db: Db,
  opts: {
    channelId: string;
    companyId: string;
    authorAgentId?: string;
    authorUserId?: string;
    body: string;
    messageType?: string;
    mentions?: string[];
    linkedIssueId?: string;
    replyToId?: string;
    reasoning?: string;
  },
): Promise<Message> {
  // --- Contradiction detection (non-fatal) ---
  // For decision messages posted by agents, check for contradictions with prior decisions.
  let bodyWithNote = opts.body;
  if (
    opts.authorAgentId &&
    (opts.messageType === "decision" || opts.messageType === "message")
  ) {
    try {
      // Inline heuristic: find prior decision messages from this agent, check keyword negation overlap
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const newWords = new Set(
        opts.body
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length >= 5),
      );
      if (newWords.size >= 3) {
        const priorRows = await db
          .select({ id: channelMessages.id, body: channelMessages.body, createdAt: channelMessages.createdAt })
          .from(channelMessages)
          .where(
            and(
              eq(channelMessages.companyId, opts.companyId),
              eq(channelMessages.authorAgentId, opts.authorAgentId),
              eq(channelMessages.messageType, "decision"),
              gte(channelMessages.createdAt, cutoff),
            ),
          )
          .orderBy(desc(channelMessages.createdAt))
          .limit(50);

        const negWords = ["not", "never", "no", "stop", "cancel", "reject", "avoid", "remove", "disable"];
        const newHasNeg = negWords.some((n) => opts.body.toLowerCase().includes(n));
        for (const prior of priorRows) {
          const priorWords = new Set(prior.body.toLowerCase().split(/\W+/).filter((w) => w.length >= 5));
          const priorHasNeg = negWords.some((n) => prior.body.toLowerCase().includes(n));
          const overlap = [...newWords].filter((w) => priorWords.has(w)).length;
          if (overlap >= 3 && newHasNeg !== priorHasNeg) {
            const priorDate = new Date(prior.createdAt).toLocaleDateString();
            bodyWithNote = `${opts.body}\n\n[Note: This may contradict a prior decision. See message from ${priorDate}.]`;
            break;
          }
        }
      }
    } catch {
      // Non-fatal: contradiction detection must never block message delivery
    }
  }

  const [message] = await db
    .insert(channelMessages)
    .values({
      channelId: opts.channelId,
      companyId: opts.companyId,
      authorAgentId: opts.authorAgentId ?? null,
      authorUserId: opts.authorUserId ?? null,
      body: bodyWithNote,
      messageType: opts.messageType ?? "message",
      mentions: opts.mentions ?? [],
      linkedIssueId: opts.linkedIssueId ?? null,
      replyToId: opts.replyToId ?? null,
      reasoning: opts.reasoning ?? null,
    })
    .returning();

  // --- Escalation waterfall ---
  // When a non-#company channel receives an escalation message, auto-cross-post
  // a summary to #company and tag the CEO.
  if ((opts.messageType ?? "message") === "escalation") {
    try {
      const channel = await db
        .select({ scopeType: agentChannels.scopeType, name: agentChannels.name })
        .from(agentChannels)
        .where(eq(agentChannels.id, opts.channelId))
        .then((rows) => rows[0] ?? null);

      if (channel && channel.scopeType !== "company") {
        const companyChannel = await findCompanyChannel(db, opts.companyId);
        if (companyChannel) {
          // Find CEO agent id for the tag
          const ceoRow = await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(
              and(
                eq(agents.companyId, opts.companyId),
                sql`lower(${agents.role}) ~ '\\mceo\\M|\\mchief executive\\M'`,
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          const ceoTag = ceoRow ? `@${ceoRow.name}` : "@CEO";
          const crossPostBody = `[ESCALATION from #${channel.name}] ${opts.body}\n\ncc ${ceoTag}`;

          await db.insert(channelMessages).values({
            channelId: companyChannel.id,
            companyId: opts.companyId,
            authorAgentId: opts.authorAgentId ?? null,
            authorUserId: opts.authorUserId ?? null,
            body: crossPostBody,
            messageType: "escalation",
            mentions: ceoRow ? [ceoRow.id] : [],
            linkedIssueId: opts.linkedIssueId ?? null,
            replyToId: null,
          });
        }
      }
    } catch {
      // Non-fatal: escalation cross-post errors must never block message delivery
    }
  }

  // --- Phase 8 Feature 4: Cross-channel intelligence ---
  // After saving, check for overlap with other channels and post a system note if found.
  // Only for substantive messages (not system messages themselves).
  if ((opts.messageType ?? "message") === "message" && opts.body.length >= 30) {
    try {
      const overlap = await detectCrossChannelOverlap(db, opts.companyId, opts.body, opts.channelId);
      if (overlap) {
        const hoursAgo = Math.round((Date.now() - new Date(overlap.createdAt).getTime()) / (60 * 60 * 1000));
        const timeLabel = hoursAgo < 1 ? "recently" : `${hoursAgo} hour${hoursAgo === 1 ? "" : "s"} ago`;
        await db.insert(channelMessages).values({
          channelId: opts.channelId,
          companyId: opts.companyId,
          authorAgentId: null,
          authorUserId: null,
          body: `Related discussion in #${overlap.channelName} (${timeLabel}): ${overlap.messageSnippet}`,
          messageType: "announcement",
          mentions: [],
          linkedIssueId: null,
          replyToId: message.id,
        });
      }
    } catch {
      // Non-fatal
    }
  }

  return message;
}

// ---------------------------------------------------------------------------
// Enhancement 1: Decision Registry
// ---------------------------------------------------------------------------

export interface DecisionRecord {
  messageId: string;
  decisionText: string;
  decidedByAgentId: string | null;
  decidedByUserId: string | null;
  linkedIssueId: string | null;
  createdAt: Date;
}

/** Return all decision (and optional escalation) messages from a channel. */
export async function extractDecisions(
  db: Db,
  channelId: string,
  since?: Date,
): Promise<DecisionRecord[]> {
  const conditions = [
    eq(channelMessages.channelId, channelId),
    eq(channelMessages.messageType, "decision"),
  ];
  if (since) {
    conditions.push(gte(channelMessages.createdAt, since));
  }

  const rows = await db
    .select({
      id: channelMessages.id,
      body: channelMessages.body,
      authorAgentId: channelMessages.authorAgentId,
      authorUserId: channelMessages.authorUserId,
      linkedIssueId: channelMessages.linkedIssueId,
      createdAt: channelMessages.createdAt,
    })
    .from(channelMessages)
    .where(and(...conditions))
    .orderBy(desc(channelMessages.createdAt));

  return rows.map((r) => ({
    messageId: r.id,
    decisionText: r.body,
    decidedByAgentId: r.authorAgentId,
    decidedByUserId: r.authorUserId,
    linkedIssueId: r.linkedIssueId,
    createdAt: r.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Enhancement 2: @mention Response Tracking
// ---------------------------------------------------------------------------

export interface PendingMention {
  messageId: string;
  channelId: string;
  channelName: string;
  mentionedByName: string;
  body: string;
  createdAt: Date;
}

/**
 * Find messages that mention a specific agent where no reply from that agent
 * exists within the 3 messages posted after the mention.
 */
export async function getPendingMentions(
  db: Db,
  agentId: string,
  companyId: string,
): Promise<PendingMention[]> {
  // Get all messages in this company that mention the agent (mentions is jsonb array of strings)
  const mentionRows = await db
    .select({
      id: channelMessages.id,
      channelId: channelMessages.channelId,
      authorAgentId: channelMessages.authorAgentId,
      authorUserId: channelMessages.authorUserId,
      body: channelMessages.body,
      createdAt: channelMessages.createdAt,
    })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.companyId, companyId),
        sql`${channelMessages.mentions} @> ${JSON.stringify([agentId])}::jsonb`,
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(50);

  if (mentionRows.length === 0) return [];

  // Gather unique channel ids
  const channelIds = [...new Set(mentionRows.map((r) => r.channelId))];

  // Fetch channel names
  const channelRows = await db
    .select({ id: agentChannels.id, name: agentChannels.name })
    .from(agentChannels)
    .where(sql`${agentChannels.id} = ANY(${channelIds})`);
  const channelNameMap = new Map(channelRows.map((c) => [c.id, c.name]));

  // Fetch author names for the mentioning messages
  const authorAgentIds = mentionRows
    .map((r) => r.authorAgentId)
    .filter((id): id is string => id !== null);

  const authorRows =
    authorAgentIds.length > 0
      ? await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(sql`${agents.id} = ANY(${authorAgentIds})`)
      : [];
  const authorNameMap = new Map(authorRows.map((a) => [a.id, a.name]));

  const pending: PendingMention[] = [];

  for (const mention of mentionRows) {
    // Check if the agent replied within the next 3 messages in the same channel
    const nextMessages = await db
      .select({ authorAgentId: channelMessages.authorAgentId })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelId, mention.channelId),
          gt(channelMessages.createdAt, mention.createdAt),
        ),
      )
      .orderBy(channelMessages.createdAt)
      .limit(3);

    const agentReplied = nextMessages.some((m) => m.authorAgentId === agentId);
    if (agentReplied) continue;

    const mentionerName = mention.authorAgentId
      ? (authorNameMap.get(mention.authorAgentId) ?? "Unknown")
      : (mention.authorUserId ?? "User");

    pending.push({
      messageId: mention.id,
      channelId: mention.channelId,
      channelName: channelNameMap.get(mention.channelId) ?? mention.channelId,
      mentionedByName: mentionerName,
      body: mention.body,
      createdAt: mention.createdAt,
    });
  }

  return pending;
}

// ---------------------------------------------------------------------------
// Enhancement 4: Thread Pinning
// ---------------------------------------------------------------------------

/** Pin a message in a channel. Idempotent. */
export async function pinMessage(
  db: Db,
  channelId: string,
  messageId: string,
): Promise<void> {
  const channel = await db
    .select({ pinnedMessageIds: agentChannels.pinnedMessageIds })
    .from(agentChannels)
    .where(eq(agentChannels.id, channelId))
    .then((rows) => rows[0] ?? null);

  if (!channel) return;

  const current: string[] = channel.pinnedMessageIds ?? [];
  if (current.includes(messageId)) return;

  await db
    .update(agentChannels)
    .set({ pinnedMessageIds: [...current, messageId] })
    .where(eq(agentChannels.id, channelId));
}

/** Unpin a message from a channel. Idempotent. */
export async function unpinMessage(
  db: Db,
  channelId: string,
  messageId: string,
): Promise<void> {
  const channel = await db
    .select({ pinnedMessageIds: agentChannels.pinnedMessageIds })
    .from(agentChannels)
    .where(eq(agentChannels.id, channelId))
    .then((rows) => rows[0] ?? null);

  if (!channel) return;

  const updated = (channel.pinnedMessageIds ?? []).filter((id) => id !== messageId);
  await db
    .update(agentChannels)
    .set({ pinnedMessageIds: updated })
    .where(eq(agentChannels.id, channelId));
}

/** Get all pinned messages for a channel. */
export async function getPinnedMessages(
  db: Db,
  channelId: string,
): Promise<Message[]> {
  const channel = await db
    .select({ pinnedMessageIds: agentChannels.pinnedMessageIds })
    .from(agentChannels)
    .where(eq(agentChannels.id, channelId))
    .then((rows) => rows[0] ?? null);

  if (!channel || !channel.pinnedMessageIds || channel.pinnedMessageIds.length === 0) {
    return [];
  }

  const ids = channel.pinnedMessageIds;
  const rows = await db
    .select()
    .from(channelMessages)
    .where(sql`${channelMessages.id} = ANY(${ids})`);

  // Return in pinned order
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => rowMap.get(id)).filter((r): r is Message => r !== undefined);
}

// ---------------------------------------------------------------------------
// Enhancement 6: Signal-to-Noise / Channel Health
// ---------------------------------------------------------------------------

export interface ChannelHealthResult {
  status: "healthy" | "quiet" | "noisy" | "stalled";
  messagesLast48h: number;
  decisionsLast7d: number;
  circularTopicScore: number;
}

/**
 * Evaluate channel health:
 * - quiet:   < 2 messages in 48 h
 * - noisy:   > 50 messages in 48 h with < 2 decisions
 * - stalled: > 8 messages sharing repeated keywords with no decision
 * - healthy: everything else
 */
export async function channelHealth(
  db: Db,
  channelId: string,
): Promise<ChannelHealthResult> {
  const now = new Date();
  const cutoff48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const cutoff7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        gte(channelMessages.createdAt, cutoff48h),
      ),
    );
  const messagesLast48h = Number(countRow?.count ?? 0);

  const [decisionRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        eq(channelMessages.messageType, "decision"),
        gte(channelMessages.createdAt, cutoff7d),
      ),
    );
  const decisionsLast7d = Number(decisionRow?.count ?? 0);

  // Circular topic detection: fetch last 20 messages and check keyword repetition
  const recentBodies = await db
    .select({ body: channelMessages.body, messageType: channelMessages.messageType })
    .from(channelMessages)
    .where(eq(channelMessages.channelId, channelId))
    .orderBy(desc(channelMessages.createdAt))
    .limit(20);

  // Extract significant words (>= 5 chars), count frequency
  const wordFreq = new Map<string, number>();
  for (const row of recentBodies) {
    const words = row.body
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 5);
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
    }
  }
  const repeatedWords = [...wordFreq.values()].filter((c) => c >= 3).length;
  const circularTopicScore = Math.min(repeatedWords, 10);

  const recentHasDecision = recentBodies.some((r) => r.messageType === "decision");

  let status: ChannelHealthResult["status"] = "healthy";

  if (messagesLast48h < 2) {
    status = "quiet";
  } else if (messagesLast48h > 50 && decisionsLast7d < 2) {
    status = "noisy";
  } else if (recentBodies.length > 8 && circularTopicScore >= 3 && !recentHasDecision) {
    status = "stalled";
  }

  return { status, messagesLast48h, decisionsLast7d, circularTopicScore };
}

// ---------------------------------------------------------------------------
// Feature 1: Deliberation Protocol
// ---------------------------------------------------------------------------

export interface Deliberation {
  id: string;
  channelId: string;
  topic: string;
  initiatedByAgentId: string;
  invitedAgentIds: string[];
  responses: Array<{ agentId: string; position: string; respondedAt: Date }>;
  synthesis: string | null;
  status: "open" | "concluded";
  createdAt: Date;
}

/**
 * Start a deliberation in a channel. Posts a "deliberation_start" message
 * tagging all invited agents. Returns the message id (used as deliberation id).
 */
export async function startDeliberation(
  db: Db,
  opts: {
    channelId: string;
    companyId: string;
    topic: string;
    initiatedByAgentId: string;
    invitedAgentIds: string[];
  },
): Promise<string> {
  // Fetch invited agent names for @mentions
  const agentRows =
    opts.invitedAgentIds.length > 0
      ? await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(sql`${agents.id} = ANY(${opts.invitedAgentIds})`)
      : [];
  const agentNames = agentRows.map((a) => `@${a.name}`).join(", ");

  const body =
    `[DELIBERATION] Topic: ${opts.topic}\n\nAgents invited to share their position: ${agentNames}.\n` +
    `Please reply with your analysis and recommendation.`;

  const [message] = await db
    .insert(channelMessages)
    .values({
      channelId: opts.channelId,
      companyId: opts.companyId,
      authorAgentId: opts.initiatedByAgentId,
      body,
      messageType: "deliberation_start",
      mentions: opts.invitedAgentIds,
      // Store metadata in reasoning field for later retrieval
      reasoning: JSON.stringify({
        deliberationId: null, // self-referential; the message id becomes the deliberation id
        topic: opts.topic,
        initiatedByAgentId: opts.initiatedByAgentId,
        invitedAgentIds: opts.invitedAgentIds,
      }),
    })
    .returning({ id: channelMessages.id });

  return message.id;
}

/**
 * Submit an agent's position in an open deliberation.
 * Posts a reply to the deliberation_start message.
 */
export async function submitDeliberationPosition(
  db: Db,
  deliberationId: string,
  agentId: string,
  position: string,
): Promise<void> {
  const deliberationMsg = await db
    .select({
      channelId: channelMessages.channelId,
      companyId: channelMessages.companyId,
    })
    .from(channelMessages)
    .where(eq(channelMessages.id, deliberationId))
    .then((rows) => rows[0] ?? null);

  if (!deliberationMsg) return;

  await db.insert(channelMessages).values({
    channelId: deliberationMsg.channelId,
    companyId: deliberationMsg.companyId,
    authorAgentId: agentId,
    body: position,
    messageType: "message",
    mentions: [],
    replyToId: deliberationId,
  });
}

/**
 * Conclude a deliberation: gather all reply positions, synthesize them,
 * and post a "deliberation_summary" message.
 * Returns the synthesis text.
 */
export async function concludeDeliberation(
  db: Db,
  deliberationId: string,
): Promise<string> {
  const deliberationMsg = await db
    .select({
      channelId: channelMessages.channelId,
      companyId: channelMessages.companyId,
      reasoning: channelMessages.reasoning,
      body: channelMessages.body,
    })
    .from(channelMessages)
    .where(eq(channelMessages.id, deliberationId))
    .then((rows) => rows[0] ?? null);

  if (!deliberationMsg) return "Deliberation not found.";

  let meta: { topic?: string; invitedAgentIds?: string[] } = {};
  try {
    meta = deliberationMsg.reasoning ? JSON.parse(deliberationMsg.reasoning) : {};
  } catch {
    // ignore parse errors
  }

  // Fetch all reply positions
  const replies = await db
    .select({
      authorAgentId: channelMessages.authorAgentId,
      body: channelMessages.body,
      createdAt: channelMessages.createdAt,
    })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.replyToId, deliberationId),
        eq(channelMessages.channelId, deliberationMsg.channelId),
      ),
    )
    .orderBy(channelMessages.createdAt);

  // Fetch agent names
  const agentIds = replies
    .map((r) => r.authorAgentId)
    .filter((id): id is string => id !== null);

  const agentNameMap = new Map<string, string>();
  if (agentIds.length > 0) {
    const agentRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(sql`${agents.id} = ANY(${agentIds})`);
    for (const a of agentRows) agentNameMap.set(a.id, a.name);
  }

  // Heuristic synthesis
  const topic = meta.topic ?? "the deliberation topic";
  const positionLines = replies.map((r) => {
    const name = r.authorAgentId ? (agentNameMap.get(r.authorAgentId) ?? "Unknown") : "Unknown";
    return `- ${name}: ${r.body}`;
  });

  // Identify agreement: if all positions contain the same action keyword
  const ACTION_WORDS = ["use", "choose", "select", "implement", "adopt", "switch", "prefer", "recommend"];
  const actionCounts = new Map<string, number>();
  for (const reply of replies) {
    const words = reply.body.toLowerCase().split(/\W+/);
    for (const w of words) {
      if (ACTION_WORDS.includes(w)) {
        actionCounts.set(w, (actionCounts.get(w) ?? 0) + 1);
      }
    }
  }
  const totalReplies = replies.length;
  const majorityActions = [...actionCounts.entries()]
    .filter(([, count]) => count >= Math.ceil(totalReplies / 2))
    .map(([w]) => w);

  const agreementNote =
    majorityActions.length > 0
      ? `Majority position uses action keywords: ${majorityActions.join(", ")}.`
      : "No clear majority action identified.";

  const synthesis = [
    `[DELIBERATION SUMMARY] Topic: ${topic}`,
    ``,
    `Positions submitted (${totalReplies}/${meta.invitedAgentIds?.length ?? "?"} invited):`,
    ...positionLines,
    ``,
    agreementNote,
  ].join("\n");

  await db.insert(channelMessages).values({
    channelId: deliberationMsg.channelId,
    companyId: deliberationMsg.companyId,
    body: synthesis,
    messageType: "deliberation_summary",
    mentions: [],
    replyToId: deliberationId,
  });

  return synthesis;
}

// ---------------------------------------------------------------------------
// Feature 4: Expertise Discovery
// ---------------------------------------------------------------------------

// Topic keywords grouped by domain
const TOPIC_KEYWORD_MAP: Record<string, string[]> = {
  engineering: ["code", "deploy", "bug", "test", "api", "database", "backend", "frontend", "build", "ci", "pipeline", "refactor", "typescript", "python", "golang"],
  design: ["design", "ux", "ui", "wireframe", "prototype", "figma", "layout", "color", "typography", "accessibility", "brand"],
  marketing: ["marketing", "campaign", "seo", "content", "social", "email", "ad", "conversion", "funnel", "lead", "brand", "copy"],
  sales: ["sales", "deal", "prospect", "customer", "crm", "quota", "pipeline", "close", "revenue", "contract", "proposal"],
  finance: ["finance", "budget", "cost", "spend", "invoice", "accounting", "forecast", "revenue", "profit", "cash"],
  hr: ["hiring", "recruit", "onboard", "performance", "review", "team", "culture", "headcount", "compensation"],
  product: ["product", "roadmap", "feature", "sprint", "backlog", "priority", "requirements", "stakeholder", "launch", "milestone"],
  security: ["security", "vulnerability", "audit", "compliance", "encryption", "auth", "permission", "threat", "risk"],
  data: ["data", "analytics", "dashboard", "metrics", "report", "kpi", "insight", "model", "ml", "ai", "llm"],
  operations: ["operations", "process", "workflow", "automation", "infrastructure", "monitoring", "alerting", "incident"],
};

function detectTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORD_MAP)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      found.push(topic);
    }
  }
  return found;
}

export async function discoverExpertise(
  db: Db,
  companyId: string,
): Promise<
  Array<{
    agentId: string;
    agentName: string;
    topics: Array<{ topic: string; messageCount: number; decisionCount: number }>;
  }>
> {
  // Fetch all agent messages for this company (limit 2000 for performance)
  const rows = await db
    .select({
      authorAgentId: channelMessages.authorAgentId,
      body: channelMessages.body,
      messageType: channelMessages.messageType,
    })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.companyId, companyId),
        sql`${channelMessages.authorAgentId} IS NOT NULL`,
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(2000);

  // Aggregate per agent per topic
  const agentTopicMessageCount = new Map<string, Map<string, number>>();
  const agentTopicDecisionCount = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (!row.authorAgentId) continue;
    const topics = detectTopics(row.body);
    const isDecision = row.messageType === "decision";

    for (const topic of topics) {
      // message counts
      const topicMap = agentTopicMessageCount.get(row.authorAgentId) ?? new Map<string, number>();
      topicMap.set(topic, (topicMap.get(topic) ?? 0) + 1);
      agentTopicMessageCount.set(row.authorAgentId, topicMap);

      // decision counts
      if (isDecision) {
        const dMap = agentTopicDecisionCount.get(row.authorAgentId) ?? new Map<string, number>();
        dMap.set(topic, (dMap.get(topic) ?? 0) + 1);
        agentTopicDecisionCount.set(row.authorAgentId, dMap);
      }
    }
  }

  if (agentTopicMessageCount.size === 0) return [];

  // Fetch agent names
  const agentIds = [...agentTopicMessageCount.keys()];
  const agentRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(sql`${agents.id} = ANY(${agentIds})`);
  const agentNameMap = new Map(agentRows.map((a) => [a.id, a.name]));

  // Build result, only topics with >= 2 messages (expertise signal)
  const result: Array<{
    agentId: string;
    agentName: string;
    topics: Array<{ topic: string; messageCount: number; decisionCount: number }>;
  }> = [];

  for (const [agentId, topicCounts] of agentTopicMessageCount) {
    const topics = [...topicCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([topic, messageCount]) => ({
        topic,
        messageCount,
        decisionCount: agentTopicDecisionCount.get(agentId)?.get(topic) ?? 0,
      }))
      .sort((a, b) => b.messageCount + b.decisionCount * 2 - (a.messageCount + a.decisionCount * 2));

    if (topics.length > 0) {
      result.push({
        agentId,
        agentName: agentNameMap.get(agentId) ?? agentId,
        topics,
      });
    }
  }

  // Sort by most signals overall
  result.sort((a, b) => {
    const aScore = a.topics.reduce((s, t) => s + t.messageCount + t.decisionCount * 2, 0);
    const bScore = b.topics.reduce((s, t) => s + t.messageCount + t.decisionCount * 2, 0);
    return bScore - aScore;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Feature 5: Fork-and-Test
// ---------------------------------------------------------------------------

export async function createForkAndTest(
  db: Db,
  opts: {
    companyId: string;
    channelId: string;
    topic: string;
    approachA: { agentId: string; description: string };
    approachB: { agentId: string; description: string };
    goalId?: string | null;
    projectId?: string | null;
  },
): Promise<{ issueAId: string; issueBId: string }> {
  // Import here to avoid circular dependency
  const { issueService } = await import("./issues.js");

  // Fetch agent names for message
  const agentIds = [opts.approachA.agentId, opts.approachB.agentId];
  const agentRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(sql`${agents.id} = ANY(${agentIds})`);
  const agentNameMap = new Map(agentRows.map((a) => [a.id, a.name]));

  const agentAName = agentNameMap.get(opts.approachA.agentId) ?? "Agent A";
  const agentBName = agentNameMap.get(opts.approachB.agentId) ?? "Agent B";

  // Create issue A
  const issueA = await issueService(db).create(opts.companyId, {
    title: `[Fork A] ${opts.topic}`,
    description: opts.approachA.description,
    status: "todo",
    priority: "medium",
    assigneeAgentId: opts.approachA.agentId,
    originKind: "deliberation",
    originId: opts.channelId,
    ...(opts.goalId ? { goalId: opts.goalId } : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  });

  // Create issue B
  const issueB = await issueService(db).create(opts.companyId, {
    title: `[Fork B] ${opts.topic}`,
    description: opts.approachB.description,
    status: "todo",
    priority: "medium",
    assigneeAgentId: opts.approachB.agentId,
    originKind: "deliberation",
    originId: opts.channelId,
    ...(opts.goalId ? { goalId: opts.goalId } : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  });

  // Post announcement in channel
  const body =
    `[FORK-AND-TEST] Topic: ${opts.topic}\n\n` +
    `Approach A assigned to @${agentAName} (${issueA.identifier}): ${opts.approachA.description}\n` +
    `Approach B assigned to @${agentBName} (${issueB.identifier}): ${opts.approachB.description}\n\n` +
    `Results will be compared when both issues are completed.`;

  await db.insert(channelMessages).values({
    channelId: opts.channelId,
    companyId: opts.companyId,
    body,
    messageType: "announcement",
    mentions: agentIds,
  });

  return { issueAId: issueA.id, issueBId: issueB.id };
}

// ---------------------------------------------------------------------------
// Feature 6: Pending Deliberations for Heartbeat Injection
// ---------------------------------------------------------------------------

export interface PendingDeliberation {
  deliberationId: string;
  channelId: string;
  channelName: string;
  topic: string;
  initiatedByAgentId: string;
}

/**
 * Returns all open deliberations (deliberation_start messages) where this
 * agent is invited but has not yet replied. Used to inject context into
 * agent heartbeats.
 */
export async function getPendingDeliberations(
  db: Db,
  agentId: string,
  companyId: string,
): Promise<PendingDeliberation[]> {
  // Find deliberation_start messages that mention this agent
  const deliberationMsgs = await db
    .select({
      id: channelMessages.id,
      channelId: channelMessages.channelId,
      reasoning: channelMessages.reasoning,
    })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.companyId, companyId),
        eq(channelMessages.messageType, "deliberation_start"),
        sql`${channelMessages.mentions} @> ${JSON.stringify([agentId])}::jsonb`,
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(20);

  if (deliberationMsgs.length === 0) return [];

  // Filter to only those where no deliberation_summary exists yet (still open)
  // and where this agent hasn't replied
  const pending: PendingDeliberation[] = [];

  const channelIds = [...new Set(deliberationMsgs.map((m) => m.channelId))];
  const channelRows = await db
    .select({ id: agentChannels.id, name: agentChannels.name })
    .from(agentChannels)
    .where(sql`${agentChannels.id} = ANY(${channelIds})`);
  const channelNameMap = new Map(channelRows.map((c) => [c.id, c.name]));

  for (const msg of deliberationMsgs) {
    // Check if concluded
    const summary = await db
      .select({ id: channelMessages.id })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.replyToId, msg.id),
          eq(channelMessages.messageType, "deliberation_summary"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (summary) continue;

    // Check if this agent already replied
    const agentReply = await db
      .select({ id: channelMessages.id })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.replyToId, msg.id),
          eq(channelMessages.authorAgentId, agentId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (agentReply) continue;

    let topic = "an ongoing discussion";
    try {
      const meta = msg.reasoning ? JSON.parse(msg.reasoning) : {};
      if (typeof meta.topic === "string") topic = meta.topic;
    } catch {
      // ignore
    }

    let initiatedByAgentId = "";
    try {
      const meta = msg.reasoning ? JSON.parse(msg.reasoning) : {};
      if (typeof meta.initiatedByAgentId === "string") initiatedByAgentId = meta.initiatedByAgentId;
    } catch {
      // ignore
    }

    pending.push({
      deliberationId: msg.id,
      channelId: msg.channelId,
      channelName: channelNameMap.get(msg.channelId) ?? msg.channelId,
      topic,
      initiatedByAgentId,
    });
  }

  return pending;
}

// ---------------------------------------------------------------------------
// Contradiction Detection (used internally by postMessage)
// ---------------------------------------------------------------------------

export interface ContradictionResult {
  contradictionFound: boolean;
  priorMessageId: string | null;
  priorMessageCreatedAt: Date | null;
}

/**
 * Heuristic contradiction check: look for prior decision messages in the same
 * company that share significant keyword overlap with the new message body.
 * No LLM call — keyword intersection only.
 */
export async function detectContradictions(
  db: Db,
  companyId: string,
  _authorAgentId: string,
  newBody: string,
): Promise<ContradictionResult> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const newWords = new Set(
    newBody
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 5),
  );
  if (newWords.size < 3) return { contradictionFound: false, priorMessageId: null, priorMessageCreatedAt: null };

  const priorDecisions = await db
    .select({ id: channelMessages.id, body: channelMessages.body, createdAt: channelMessages.createdAt })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.companyId, companyId),
        eq(channelMessages.messageType, "decision"),
        gte(channelMessages.createdAt, cutoff),
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(50);

  const negationWords = ["not", "never", "no", "stop", "cancel", "reject", "avoid", "remove", "disable", "don't"];
  const newHasNegation = negationWords.some((n) => newBody.toLowerCase().includes(n));

  for (const prior of priorDecisions) {
    const priorWords = new Set(
      prior.body
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length >= 5),
    );
    const priorHasNegation = negationWords.some((n) => prior.body.toLowerCase().includes(n));
    const overlap = [...newWords].filter((w) => priorWords.has(w)).length;

    if (overlap >= 3 && newHasNegation !== priorHasNegation) {
      return { contradictionFound: true, priorMessageId: prior.id, priorMessageCreatedAt: prior.createdAt };
    }
  }

  return { contradictionFound: false, priorMessageId: null, priorMessageCreatedAt: null };
}

// ---------------------------------------------------------------------------
// Phase 8: Enhancement 1 — Conversation Summarizer
// ---------------------------------------------------------------------------

export interface ChannelSummary {
  summary: string;
  decisions: string[];
  openQuestions: string[];
  actionItems: string[];
  messageCount: number;
}

const ACTION_ITEM_PATTERN = /create issue|will do|i'll|i will|assigned to|TODO/i;

/**
 * Summarize a channel over the last N days (default 7).
 * Heuristic only — no LLM call.
 */
export async function summarizeChannel(
  db: Db,
  channelId: string,
  sinceDays?: number,
): Promise<ChannelSummary> {
  const days = sinceDays ?? 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: channelMessages.id,
      body: channelMessages.body,
      messageType: channelMessages.messageType,
      replyToId: channelMessages.replyToId,
      createdAt: channelMessages.createdAt,
    })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        gte(channelMessages.createdAt, since),
      ),
    )
    .orderBy(channelMessages.createdAt);

  const decisions: string[] = [];
  const openQuestions: string[] = [];
  const actionItems: string[] = [];

  const repliedToIds = new Set(rows.filter((r) => r.replyToId).map((r) => r.replyToId!));

  for (const row of rows) {
    if (row.messageType === "decision") {
      decisions.push(row.body.slice(0, 120));
    } else if (row.messageType === "question" && !repliedToIds.has(row.id)) {
      openQuestions.push(row.body.slice(0, 120));
    }
    if (ACTION_ITEM_PATTERN.test(row.body)) {
      actionItems.push(row.body.slice(0, 120));
    }
  }

  const messageCount = rows.length;
  const summary = `${messageCount} messages in ${days} days. ${decisions.length} decisions made. ${openQuestions.length} questions pending.`;

  return { summary, decisions, openQuestions, actionItems, messageCount };
}

// ---------------------------------------------------------------------------
// Phase 8: Enhancement 3 — Standing Agendas
// ---------------------------------------------------------------------------

/**
 * Post a standing agenda message to a channel as a system announcement.
 */
export async function postStandingAgenda(
  db: Db,
  channelId: string,
  companyId: string,
  topic: string,
): Promise<void> {
  await db.insert(channelMessages).values({
    channelId,
    companyId,
    authorAgentId: null,
    authorUserId: null,
    body: topic,
    messageType: "announcement",
    mentions: [],
    linkedIssueId: null,
    replyToId: null,
  });
}

// ---------------------------------------------------------------------------
// Phase 8: Enhancement 4 — Cross-Channel Intelligence
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "have", "from", "they",
  "will", "been", "would", "could", "should", "their", "there", "here",
  "were", "what", "when", "where", "which", "your", "about", "more",
  "also", "then", "than", "into", "some", "does", "just", "very",
]);

function extractKeywords(text: string, topN: number): string[] {
  const freq = new Map<string, number>();
  const words = text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
}

export interface CrossChannelMatch {
  channelName: string;
  messageSnippet: string;
  createdAt: Date;
}

/**
 * Check if a new message body overlaps significantly with recent messages in
 * other channels. Returns the first strong match or null.
 */
export async function detectCrossChannelOverlap(
  db: Db,
  companyId: string,
  messageBody: string,
  currentChannelId: string,
): Promise<CrossChannelMatch | null> {
  const keywords = extractKeywords(messageBody, 3);
  if (keywords.length < 2) return null;

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const recentRows = await db
    .select({
      id: channelMessages.id,
      channelId: channelMessages.channelId,
      body: channelMessages.body,
      createdAt: channelMessages.createdAt,
    })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.companyId, companyId),
        gte(channelMessages.createdAt, cutoff),
        sql`${channelMessages.channelId} != ${currentChannelId}`,
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(200);

  if (recentRows.length === 0) return null;

  const channelIds = [...new Set(recentRows.map((r) => r.channelId))];
  const channelRows = await db
    .select({ id: agentChannels.id, name: agentChannels.name })
    .from(agentChannels)
    .where(sql`${agentChannels.id} = ANY(${channelIds})`);
  const channelNameMap = new Map(channelRows.map((c) => [c.id, c.name]));

  for (const row of recentRows) {
    const rowKeywords = extractKeywords(row.body, 5);
    const overlap = keywords.filter((k) => rowKeywords.includes(k)).length;
    if (overlap >= 2) {
      return {
        channelName: channelNameMap.get(row.channelId) ?? row.channelId,
        messageSnippet: row.body.slice(0, 100),
        createdAt: row.createdAt,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Phase 8: Enhancement 5 — Token-Aware Context Budget
// ---------------------------------------------------------------------------

function estimateTokens(body: string): number {
  return Math.ceil(body.length / 4);
}

/**
 * Return a prioritized set of messages from a channel that fits within
 * the given token budget.
 *
 * Priority order:
 * 1. Pending mentions for this agent (always include)
 * 2. Decision messages (last 48h)
 * 3. Escalation messages (last 48h)
 * 4. Questions (last 48h)
 * 5. Recent messages (fill remaining budget)
 */
export async function getHighSignalMessages(
  db: Db,
  channelId: string,
  agentId: string,
  tokenBudget: number,
): Promise<Message[]> {
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const mentionRows = await db
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        sql`${channelMessages.mentions} @> ${JSON.stringify([agentId])}::jsonb`,
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(20);

  const decisionRows = await db
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        eq(channelMessages.messageType, "decision"),
        gte(channelMessages.createdAt, cutoff48h),
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(20);

  const escalationRows = await db
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        eq(channelMessages.messageType, "escalation"),
        gte(channelMessages.createdAt, cutoff48h),
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(20);

  const questionRows = await db
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        eq(channelMessages.messageType, "question"),
        gte(channelMessages.createdAt, cutoff48h),
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(20);

  const recentRows = await db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.channelId, channelId))
    .orderBy(desc(channelMessages.createdAt))
    .limit(50);

  const selected: Message[] = [];
  const seenIds = new Set<string>();
  let remainingBudget = tokenBudget;

  function tryAdd(msg: Message): boolean {
    if (seenIds.has(msg.id)) return false;
    const tokens = estimateTokens(msg.body);
    if (tokens > remainingBudget) return false;
    selected.push(msg);
    seenIds.add(msg.id);
    remainingBudget -= tokens;
    return true;
  }

  for (const msg of mentionRows) tryAdd(msg);
  for (const msg of decisionRows) tryAdd(msg);
  for (const msg of escalationRows) tryAdd(msg);
  for (const msg of questionRows) tryAdd(msg);
  for (const msg of recentRows) {
    if (remainingBudget <= 0) break;
    tryAdd(msg);
  }

  return selected.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

// ---------------------------------------------------------------------------
// Phase 8: Enhancement 7 — Quorum Detection
// ---------------------------------------------------------------------------

export interface QuorumResult {
  required: string[];
  responded: string[];
  missing: string[];
  quorumReached: boolean;
}

/**
 * For a decision message, check how many channel members have replied
 * after that message.
 */
export async function checkQuorum(
  db: Db,
  channelId: string,
  messageId: string,
): Promise<QuorumResult> {
  const decisionMsg = await db
    .select({ createdAt: channelMessages.createdAt })
    .from(channelMessages)
    .where(eq(channelMessages.id, messageId))
    .then((rows) => rows[0] ?? null);

  if (!decisionMsg) {
    return { required: [], responded: [], missing: [], quorumReached: false };
  }

  const members = await db
    .select({ agentId: channelMemberships.agentId })
    .from(channelMemberships)
    .where(eq(channelMemberships.channelId, channelId));

  const required = members.map((m) => m.agentId);

  if (required.length === 0) {
    return { required: [], responded: [], missing: [], quorumReached: false };
  }

  const respondedRows = await db
    .select({ authorAgentId: channelMessages.authorAgentId })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        gt(channelMessages.createdAt, decisionMsg.createdAt),
        sql`${channelMessages.authorAgentId} IS NOT NULL`,
      ),
    );

  const respondedSet = new Set(
    respondedRows
      .map((r) => r.authorAgentId)
      .filter((id): id is string => id !== null),
  );

  const responded = required.filter((id) => respondedSet.has(id));
  const missing = required.filter((id) => !respondedSet.has(id));
  const quorumReached = missing.length === 0 && required.length > 0;

  return { required, responded, missing, quorumReached };
}

// ---------------------------------------------------------------------------
// Phase 8: Enhancement 8 — Conversation Replay for Onboarding
// ---------------------------------------------------------------------------

/**
 * Generate a markdown onboarding replay for a new channel member.
 * Uses the channel summary + last 5 decisions + open escalations.
 */
export async function generateOnboardingReplay(
  db: Db,
  channelId: string,
  days?: number,
): Promise<string> {
  const channelRow = await db
    .select({ name: agentChannels.name })
    .from(agentChannels)
    .where(eq(agentChannels.id, channelId))
    .then((rows) => rows[0] ?? null);

  const channelName = channelRow?.name ?? channelId;
  const summary = await summarizeChannel(db, channelId, days ?? 7);

  const lines: string[] = [
    `## Channel Briefing: #${channelName}`,
    "",
    `**Overview:** ${summary.summary}`,
    "",
  ];

  if (summary.decisions.length > 0) {
    lines.push("**Recent Decisions:**");
    for (const d of summary.decisions.slice(0, 5)) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  if (summary.openQuestions.length > 0) {
    lines.push("**Open Questions:**");
    for (const q of summary.openQuestions.slice(0, 3)) {
      lines.push(`- ${q}`);
    }
    lines.push("");
  }

  const cutoff = new Date(Date.now() - (days ?? 7) * 24 * 60 * 60 * 1000);
  const escalations = await db
    .select({ body: channelMessages.body })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        eq(channelMessages.messageType, "escalation"),
        gte(channelMessages.createdAt, cutoff),
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(3);

  if (escalations.length > 0) {
    lines.push("**Open Escalations:**");
    for (const e of escalations) {
      lines.push(`- ${e.body.slice(0, 120)}`);
    }
    lines.push("");
  }

  lines.push("_Review the above and engage where your input is needed._");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 8: Enhancement 10 — Cognitive Load Balancing
// ---------------------------------------------------------------------------

export interface AgentLoadResult {
  openIssues: number;
  pendingMentions: number;
  activeThreads: number;
  loadScore: number;
}

/**
 * Calculate a cognitive load score (0-100) for an agent.
 * Combines open issue count + pending mentions + recent channel activity.
 */
export async function agentCognitiveLoad(
  db: Db,
  agentId: string,
): Promise<AgentLoadResult> {
  const [issueRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.assigneeAgentId, agentId),
        sql`${issues.status} IN ('todo', 'in_progress')`,
      ),
    );
  const openIssues = Number(issueRow?.count ?? 0);

  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const [mentionRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channelMessages)
    .where(
      and(
        gte(channelMessages.createdAt, cutoff48h),
        sql`${channelMessages.mentions} @> ${JSON.stringify([agentId])}::jsonb`,
      ),
    );
  const pendingMentions = Number(mentionRow?.count ?? 0);

  const [threadRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.authorAgentId, agentId),
        gte(channelMessages.createdAt, cutoff48h),
      ),
    );
  const activeThreads = Number(threadRow?.count ?? 0);

  const issueScore = Math.min(openIssues * 6, 60);
  const mentionScore = Math.min(pendingMentions * 5, 25);
  const threadScore = Math.min(activeThreads * 3, 15);
  const loadScore = Math.round(issueScore + mentionScore + threadScore);

  return { openIssues, pendingMentions, activeThreads, loadScore };
}
