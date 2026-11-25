import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolAccessAuditEvents, toolConnections } from "@paperclipai/db";
import type { CreateToolConnection } from "@paperclipai/shared";
import { conflict } from "../../../errors.js";
import { connectionActorUserId } from "../actor.js";
import type { ActorInfo } from "../types.js";

type ConnectionGrant = typeof connectionGrants.$inferSelect;

/**
 * Dedicated-agent identities. A per-agent connection serves exactly one
 * agent: its credential lives on that agent's grant, never on the connection.
 * OAuth methods write the grant in their callback; methods without sign-in
 * write it here when connect names the agent.
 */
export function createAgentGrantStore(db: Db) {
  /** Upsert the one active agent grant; a grant for another agent is a conflict. */
  async function upsertConnectAgentGrant(input: {
    companyId: string;
    connectionId: string;
    subjectAgentId: string;
    credentialSecretRefs: CreateToolConnection["credentialSecretRefs"];
    actor?: ActorInfo;
  }): Promise<{ previous: ConnectionGrant | null; current: ConnectionGrant }> {
    return db.transaction(async (tx) => {
      // Lock the connection first: with no grant rows yet, locking grants
      // alone would let two concurrent connects each add a different agent.
      await tx
        .select({ id: toolConnections.id })
        .from(toolConnections)
        .where(and(eq(toolConnections.id, input.connectionId), eq(toolConnections.companyId, input.companyId)))
        .for("update");
      const grants = await tx
        .select()
        .from(connectionGrants)
        .where(and(
          eq(connectionGrants.companyId, input.companyId),
          eq(connectionGrants.connectionId, input.connectionId),
          eq(connectionGrants.kind, "agent"),
        ))
        .for("update");
      if (grants.some((grant) => grant.status === "active" && grant.subjectAgentId !== input.subjectAgentId)) {
        throw conflict(
          "This connection already belongs to another agent. Add a separate connection for this agent.",
          { code: "connection_agent_identity_in_use" },
        );
      }
      const previous = grants.find((grant) => grant.subjectAgentId === input.subjectAgentId) ?? null;
      const [current] = previous
        ? await tx
            .update(connectionGrants)
            .set({
              credentialSecretRefs: input.credentialSecretRefs,
              status: "active",
              revokedAt: null,
              revokedByAgentId: null,
              revokedByUserId: null,
              updatedAt: new Date(),
            })
            .where(eq(connectionGrants.id, previous.id))
            .returning()
        : await tx
            .insert(connectionGrants)
            .values({
              companyId: input.companyId,
              connectionId: input.connectionId,
              kind: "agent",
              subjectAgentId: input.subjectAgentId,
              credentialSecretRefs: input.credentialSecretRefs,
              status: "active",
              isDefault: false,
              createdByAgentId: input.actor?.actorType === "agent" ? (input.actor.actorId ?? null) : null,
              createdByUserId: connectionActorUserId(input.actor),
            })
            .returning();
      if (!current) throw new Error("Failed to save the agent connection grant");
      await tx.insert(toolAccessAuditEvents).values({
        companyId: input.companyId,
        connectionId: input.connectionId,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? null,
        action: previous ? "connection_grant.updated" : "connection_grant.created",
        outcome: "success",
        reasonCode: previous ? "agent_identity_reconnected" : "agent_identity_created",
        details: {
          kind: "agent",
          subjectAgentId: input.subjectAgentId,
          credentialSecretRefCount: input.credentialSecretRefs.length,
        },
      });
      return { previous, current };
    });
  }

  /** The connection's single active agent grant, or null when there is none or more than one. */
  async function activeAgentGrant(companyId: string, connectionId: string): Promise<ConnectionGrant | null> {
    const grants = await db
      .select()
      .from(connectionGrants)
      .where(and(
        eq(connectionGrants.companyId, companyId),
        eq(connectionGrants.connectionId, connectionId),
        eq(connectionGrants.kind, "agent"),
        eq(connectionGrants.status, "active"),
      ))
      .limit(2);
    return grants.length === 1 ? grants[0]! : null;
  }

  return { upsertConnectAgentGrant, activeAgentGrant };
}
