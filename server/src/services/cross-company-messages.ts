import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentMemberships,
  agents,
  companyMemberships,
  companies,
  crossCompanyMessages,
} from "@paperclipai/db";
import { forbidden, notFound } from "../errors.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function clampLimit(limit: number | null | undefined, fallback = 100) {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(limit as number)));
}

export function crossCompanyMessageService(db: Db) {
  async function listAllowedDestinationCompanyIds(sourceCompanyId: string, sourceAgentId: string) {
    const rows = await db
      .select({ companyId: companyMemberships.companyId })
      .from(agentMemberships)
      .innerJoin(
        companyMemberships,
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, agentMemberships.userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .where(
        and(
          eq(agentMemberships.companyId, sourceCompanyId),
          eq(agentMemberships.agentId, sourceAgentId),
          eq(agentMemberships.state, "joined"),
        ),
      );
    return [...new Set(rows.map((row) => row.companyId))];
  }

  async function assertDestinationAllowed(sourceCompanyId: string, sourceAgentId: string, destinationCompanyId: string) {
    const [destination, allowedCompanyIds] = await Promise.all([
      db.select({ id: companies.id }).from(companies).where(eq(companies.id, destinationCompanyId)).then((rows) => rows[0] ?? null),
      listAllowedDestinationCompanyIds(sourceCompanyId, sourceAgentId),
    ]);

    if (!destination) throw notFound("Destination company not found");
    if (!allowedCompanyIds.includes(destinationCompanyId)) {
      throw forbidden("Destination company is not reachable from this agent");
    }
  }

  return {
    async enqueue(input: {
      sourceCompanyId: string;
      sourceAgentId: string;
      destinationCompanyId: string;
      idempotencyKey: string;
      messageType: string;
      payload: JsonValue;
    }) {
      await assertDestinationAllowed(input.sourceCompanyId, input.sourceAgentId, input.destinationCompanyId);

      const existing = await db
        .select()
        .from(crossCompanyMessages)
        .where(
          and(
            eq(crossCompanyMessages.sourceCompanyId, input.sourceCompanyId),
            eq(crossCompanyMessages.destinationCompanyId, input.destinationCompanyId),
            eq(crossCompanyMessages.idempotencyKey, input.idempotencyKey),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing) return existing;

      const inserted = await db
        .insert(crossCompanyMessages)
        .values({
          sourceCompanyId: input.sourceCompanyId,
          sourceAgentId: input.sourceAgentId,
          destinationCompanyId: input.destinationCompanyId,
          idempotencyKey: input.idempotencyKey,
          messageType: input.messageType,
          payload: input.payload,
        })
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!inserted) throw new Error("Failed to insert cross-company message");
      return inserted;
    },

    async listOutbox(sourceCompanyId: string, after: number | null | undefined, limit: number | null | undefined) {
      const query = db
        .select()
        .from(crossCompanyMessages)
        .where(
          after && after > 0
            ? and(
              eq(crossCompanyMessages.sourceCompanyId, sourceCompanyId),
              gt(crossCompanyMessages.cursor, after),
            )
            : eq(crossCompanyMessages.sourceCompanyId, sourceCompanyId),
        )
        .orderBy(asc(crossCompanyMessages.cursor))
        .limit(clampLimit(limit));
      return query;
    },

    async listInbox(destinationCompanyId: string, after: number | null | undefined, limit: number | null | undefined) {
      const afterCursor = Number.isFinite(after) ? Math.max(0, Math.trunc(after as number)) : 0;
      const query = db
        .select()
        .from(crossCompanyMessages)
        .where(
          and(
            eq(crossCompanyMessages.destinationCompanyId, destinationCompanyId),
            or(
              gt(crossCompanyMessages.cursor, afterCursor),
              isNull(crossCompanyMessages.ackedAt),
            ),
          ),
        )
        .orderBy(asc(crossCompanyMessages.cursor))
        .limit(clampLimit(limit));
      return query;
    },

    async ack(input: { destinationCompanyId: string; messageId: string; ackedByAgentId: string }) {
      const message = await db
        .select()
        .from(crossCompanyMessages)
        .where(
          and(
            eq(crossCompanyMessages.id, input.messageId),
            eq(crossCompanyMessages.destinationCompanyId, input.destinationCompanyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!message) throw notFound("Inbox message not found");
      if (message.ackedAt) return message;

      const updated = await db
        .update(crossCompanyMessages)
        .set({
          ackedAt: new Date(),
          ackedByAgentId: input.ackedByAgentId,
        })
        .where(eq(crossCompanyMessages.id, input.messageId))
        .returning()
        .then((rows) => rows[0] ?? message);
      return updated;
    },

    async listAllowedDestinationCompanyIds(sourceCompanyId: string, sourceAgentId: string) {
      return listAllowedDestinationCompanyIds(sourceCompanyId, sourceAgentId);
    },

    async listAgentsForCompany(companyId: string) {
      return db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, companyId));
    },

    async assertAckAgentBelongsToCompany(agentId: string, companyId: string) {
      const row = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Agent not found");
    },
  };
}
