import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  authUsers,
  toolAccessAuditEvents,
} from "@paperclipai/db";
import type {
  ToolConnectionLifecycleEvent,
  ToolConnectionLifecycleEventType,
} from "@paperclipai/shared";

/** Activity-log actions rendered as connection lifecycle rows. */
export const CONNECTION_LIFECYCLE_ACTIONS = [
  "tool_app.connected",
  "tool_app.oauth_connected",
  "tool_example.installed",
  "tool_app.reconnected",
  "tool_connection.archived",
  "tool_connection.updated",
] as const;

export function connectionLifecycleType(
  action: string,
  details: Record<string, unknown> | null,
): ToolConnectionLifecycleEventType | null {
  switch (action) {
    case "tool_app.connected":
    case "tool_app.oauth_connected":
    case "tool_example.installed":
      return "app_connected";
    case "tool_app.reconnected":
      return "reconnected";
    case "tool_connection.archived":
      return "disconnected";
    case "tool_connection.updated": {
      const lifecycle = typeof details?.lifecycle === "string" ? details.lifecycle : null;
      if (lifecycle === "paused") return "app_paused";
      if (lifecycle === "resumed") return "app_resumed";
      if (lifecycle === "allowlist_changed") return "allowlist_changed";
      return null;
    }
    default:
      return null;
  }
}

type ActivityCursor = { createdAt: Date; id: string };

type ListConnectionLifecycleEventsInput = {
  companyId: string;
  /** Omit for every connection in the company. An empty list returns no rows. */
  connectionIds?: string[];
  agentId?: string | null;
  since?: Date | null;
  cursor?: ActivityCursor | null;
  search?: string | null;
  matchedAgentIds?: string[];
  matchedConnectionIds?: string[];
  limit: number;
};

function userFallbackName(userId: string): string {
  if (userId === "local-board") return "Board";
  return userId;
}

/**
 * Read the lifecycle half of a connection activity timeline. Both the
 * per-connection page and the aggregate Apps Activity page call this helper so
 * they cannot drift onto different tables or event vocabularies.
 */
export async function listConnectionLifecycleEvents(
  db: Db,
  input: ListConnectionLifecycleEventsInput,
): Promise<ToolConnectionLifecycleEvent[]> {
  if (input.connectionIds?.length === 0) return [];

  const safeLimit = Math.max(1, Math.min(101, Math.floor(input.limit)));
  const activityConditions: SQL[] = [
    eq(activityLog.companyId, input.companyId),
    eq(activityLog.entityType, "tool_connection"),
    inArray(activityLog.action, [...CONNECTION_LIFECYCLE_ACTIONS]),
  ];
  const quarantineConditions: SQL[] = [
    eq(toolAccessAuditEvents.companyId, input.companyId),
    eq(toolAccessAuditEvents.action, "tool_connection.catalog_refresh"),
    sql`(${toolAccessAuditEvents.details}->>'quarantinedCount')::int > 0`,
  ];

  if (input.connectionIds) {
    activityConditions.push(inArray(activityLog.entityId, input.connectionIds));
    quarantineConditions.push(inArray(toolAccessAuditEvents.connectionId, input.connectionIds));
  }
  if (input.agentId) {
    activityConditions.push(eq(activityLog.agentId, input.agentId));
  }
  if (input.since) {
    activityConditions.push(gte(activityLog.createdAt, input.since));
    quarantineConditions.push(gte(toolAccessAuditEvents.createdAt, input.since));
  }
  if (input.cursor) {
    activityConditions.push(or(
      lt(activityLog.createdAt, input.cursor.createdAt),
      and(eq(activityLog.createdAt, input.cursor.createdAt), lt(activityLog.id, input.cursor.id)),
    )!);
    quarantineConditions.push(or(
      lt(toolAccessAuditEvents.createdAt, input.cursor.createdAt),
      and(
        eq(toolAccessAuditEvents.createdAt, input.cursor.createdAt),
        lt(toolAccessAuditEvents.id, input.cursor.id),
      ),
    )!);
  }
  if (input.search) {
    const like = `%${input.search.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    const activitySearch: SQL[] = [
      ilike(activityLog.action, like),
      sql`${activityLog.details}::text ilike ${like}`,
    ];
    const quarantineSearch: SQL[] = [
      ilike(toolAccessAuditEvents.action, like),
      sql`${toolAccessAuditEvents.details}::text ilike ${like}`,
    ];
    if (input.matchedAgentIds?.length) {
      activitySearch.push(inArray(activityLog.agentId, input.matchedAgentIds));
    }
    if (input.matchedConnectionIds?.length) {
      activitySearch.push(inArray(activityLog.entityId, input.matchedConnectionIds));
      quarantineSearch.push(inArray(toolAccessAuditEvents.connectionId, input.matchedConnectionIds));
    }
    activityConditions.push(or(...activitySearch)!);
    quarantineConditions.push(or(...quarantineSearch)!);
  }

  const [logRows, quarantineRows] = await Promise.all([
    db
      .select()
      .from(activityLog)
      .where(and(...activityConditions))
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(safeLimit),
    input.agentId
      ? []
      : db
        .select()
        .from(toolAccessAuditEvents)
        .where(and(...quarantineConditions))
        .orderBy(desc(toolAccessAuditEvents.createdAt), desc(toolAccessAuditEvents.id))
        .limit(safeLimit),
  ]);

  type Pending = Omit<ToolConnectionLifecycleEvent, "actorDisplayName">;
  const pending: Pending[] = [];
  for (const row of logRows) {
    const type = connectionLifecycleType(row.action, row.details ?? null);
    if (!type) continue;
    pending.push({
      id: row.id,
      connectionId: row.entityId,
      type,
      actorType: (row.actorType as Pending["actorType"]) ?? "system",
      actorId: row.actorId ?? null,
      agentId: row.agentId ?? null,
      details: row.details ?? null,
      createdAt: row.createdAt,
    });
  }
  for (const row of quarantineRows) {
    if (!row.connectionId) continue;
    const count = Number((row.details as Record<string, unknown> | null)?.quarantinedCount ?? 0);
    pending.push({
      id: row.id,
      connectionId: row.connectionId,
      type: "actions_quarantined",
      actorType: (row.actorType as Pending["actorType"]) ?? "system",
      actorId: row.actorId ?? null,
      agentId: null,
      details: { count: Number.isFinite(count) ? count : 0 },
      createdAt: row.createdAt,
    });
  }

  pending.sort((a, b) => {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
  });
  const limited = pending.slice(0, safeLimit);

  const agentIds = new Set<string>();
  const userIds = new Set<string>();
  for (const item of limited) {
    if (item.agentId) agentIds.add(item.agentId);
    if (item.actorType === "agent" && item.actorId) agentIds.add(item.actorId);
    if (item.actorType === "user" && item.actorId && item.actorId !== "board") userIds.add(item.actorId);
  }
  const [agentRows, userRows] = await Promise.all([
    agentIds.size
      ? db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, [...agentIds])))
      : [],
    userIds.size
      ? db
        .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(inArray(authUsers.id, [...userIds]))
      : [],
  ]);
  const agentNames = new Map(agentRows.map((agent) => [agent.id, agent.name]));
  const userNames = new Map(
    userRows.map((user) => [user.id, user.name?.trim() || user.email?.trim() || user.id]),
  );

  return limited.map((item) => {
    let actorDisplayName: string | null = null;
    if (item.agentId) actorDisplayName = agentNames.get(item.agentId) ?? null;
    else if (item.actorType === "agent" && item.actorId) {
      actorDisplayName = agentNames.get(item.actorId) ?? null;
    } else if (item.actorType === "user" && item.actorId) {
      actorDisplayName = item.actorId === "board"
        ? "The board"
        : userNames.get(item.actorId) ?? userFallbackName(item.actorId);
    }
    return { ...item, actorDisplayName };
  });
}
