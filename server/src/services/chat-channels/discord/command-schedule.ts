import { and, eq, gt, inArray, isNotNull, ne, or } from "drizzle-orm";
import { chatEndpoints, toolConnections, type Db } from "@paperclipai/db";
import { readDiscordCommandRegistrationDeadline } from "../../chat-discord-command-registration-store.js";
import type { CommandRegistrationScope } from "./command-work-notifications.js";

export type CommandRegistrationDeadline = {
  id: string;
  companyId: string;
  connectionId: string;
  dueAt: number;
};

export function discordCommandSchedule(db: Db, reconcile: (endpointId: string) => Promise<void>) {
  async function load(scope?: CommandRegistrationScope, signal?: AbortSignal): Promise<CommandRegistrationDeadline[]> {
    const deadlines: CommandRegistrationDeadline[] = [];
    let cursor: string | undefined;
    while (true) {
      signal?.throwIfAborted();
      const rows = await db.select({
        id: chatEndpoints.id,
        companyId: chatEndpoints.companyId,
        connectionId: chatEndpoints.connectionId,
        applicationId: chatEndpoints.botExternalId,
        guildId: chatEndpoints.providerAccountId,
      }).from(chatEndpoints).innerJoin(toolConnections, and(
        eq(toolConnections.id, chatEndpoints.connectionId),
        eq(toolConnections.companyId, chatEndpoints.companyId),
      )).where(and(
        eq(chatEndpoints.provider, "discord"),
        inArray(chatEndpoints.status, ["verifying", "active", "attention"]),
        eq(toolConnections.status, "active"), eq(toolConnections.enabled, true),
        or(ne(chatEndpoints.status, "attention"), ne(toolConnections.healthStatus, "failed")),
        isNotNull(chatEndpoints.botExternalId), isNotNull(chatEndpoints.providerAccountId),
        scope?.kind === "endpoint" ? eq(chatEndpoints.id, scope.id) : undefined,
        scope?.kind === "connection" ? eq(chatEndpoints.connectionId, scope.id) : undefined,
        scope?.kind === "company" ? eq(chatEndpoints.companyId, scope.id) : undefined,
        cursor ? gt(chatEndpoints.id, cursor) : undefined,
      )).orderBy(chatEndpoints.id).limit(100);
      for (const row of rows) {
        signal?.throwIfAborted();
        if (!row.applicationId || !row.guildId) continue;
        const dueAt = await readDiscordCommandRegistrationDeadline(db, {
          companyId: row.companyId, endpointId: row.id,
          applicationId: row.applicationId, guildId: row.guildId,
        });
        if (dueAt !== null) deadlines.push({ id: row.id, companyId: row.companyId, connectionId: row.connectionId, dueAt });
      }
      if (rows.length < 100) return deadlines;
      cursor = rows[rows.length - 1].id;
    }
  }
  async function check(id: string, signal?: AbortSignal): Promise<CommandRegistrationDeadline | null> {
    const scope = { kind: "endpoint", id } as const;
    const [before] = await load(scope, signal);
    if (!before || before.dueAt > Date.now()) return before ?? null;
    signal?.throwIfAborted();
    await reconcile(id);
    const [after] = await load(scope, signal);
    return after ?? null;
  }
  return { load, check };
}
