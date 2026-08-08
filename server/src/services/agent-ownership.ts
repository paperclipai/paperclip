import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db, AgentOwnershipPrincipalType, AgentOwnershipRole, AgentOwnershipSource } from "@paperclipai/db";
import { agentOwnershipGrants, agentOwnershipTransfers } from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

/**
 * TECH-4929 stage 1: agent ownership/role data model.
 *
 * This module ONLY writes and reads rows. Nothing here is consulted by
 * `authorization.ts#decide()` and nothing here changes the outcome of any
 * existing authorization decision -- enforcement ships in a later stage.
 *
 * Nothing exported from this module is wired to any route reachable by an
 * agent-type actor. `writeInitialOwnership` is called from
 * `agentService.create` (the single insert choke point for every
 * agent-creation path, including agent-created agents), inside the same
 * DB transaction as the agent row itself, so there is no way to create an
 * agent without an owner. The propose/accept/grant/revoke functions below
 * are invoked only from board-only routes (see routes/agents.ts), gated by
 * `assertBoard`, which rejects agent-type actors outright.
 */

export type { AgentOwnershipRole };

export interface AgentOwnershipGrantRow {
  id: string;
  companyId: string;
  agentId: string;
  principalType: AgentOwnershipPrincipalType;
  principalId: string;
  role: AgentOwnershipRole;
  grantedByUserId: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  revokedReason: string | null;
  transitionFromGrantId: string | null;
  isInstanceAdminOverride: boolean;
  source: AgentOwnershipSource;
  createdAt: Date;
}

function toRow(row: typeof agentOwnershipGrants.$inferSelect): AgentOwnershipGrantRow {
  // No casts needed: role, principal_type and source are all $type-narrowed
  // on the columns themselves, so $inferSelect already yields the unions.
  return { ...row };
}

export function agentOwnershipService(db: Db) {
  /**
   * Write the owner grant for a brand-new agent. MUST be called inside the
   * same transaction as the `agents` insert so an agent row can never
   * commit without an owning row. Throws rather than silently skipping if
   * no owner can be determined -- callers must resolve one (acting board
   * user, or the run's responsibleUserId when an agent creates an agent)
   * before calling `agents.create`.
   */
  async function writeInitialOwnership(
    tx: Db,
    input: { companyId: string; agentId: string; ownerUserId: string; source: AgentOwnershipSource },
  ): Promise<AgentOwnershipGrantRow> {
    const ownerUserId = input.ownerUserId?.trim();
    if (!ownerUserId) {
      throw unprocessable(
        `Cannot create agent ${input.agentId} without a resolvable owner (no acting user and no responsibleUserId).`,
      );
    }
    const created = await tx
      .insert(agentOwnershipGrants)
      .values({
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        principalType: "user",
        principalId: ownerUserId,
        role: "owner",
        grantedByUserId: ownerUserId,
        source: input.source,
      })
      .returning()
      .then((rows) => rows[0]);
    return toRow(created);
  }

  async function getActiveOwner(agentId: string): Promise<AgentOwnershipGrantRow | null> {
    const row = await db
      .select()
      .from(agentOwnershipGrants)
      .where(
        and(
          eq(agentOwnershipGrants.agentId, agentId),
          eq(agentOwnershipGrants.role, "owner"),
          isNull(agentOwnershipGrants.revokedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return row ? toRow(row) : null;
  }

  async function listActiveGrants(agentId: string): Promise<AgentOwnershipGrantRow[]> {
    const rows = await db
      .select()
      .from(agentOwnershipGrants)
      .where(and(eq(agentOwnershipGrants.agentId, agentId), isNull(agentOwnershipGrants.revokedAt)));
    return rows.map(toRow);
  }

  /**
   * Board-admin/owner grants or changes a non-owner role for a principal.
   * Owner can never be assigned through this path -- use the transfer flow.
   * A role change (principal already holds a different active role on this
   * agent) revokes the old row and inserts a new one, linked via
   * transitionFromGrantId, rather than overwriting in place.
   */
  async function setRole(input: {
    companyId: string;
    agentId: string;
    principalType: AgentOwnershipPrincipalType;
    principalId: string;
    role: "admin" | "user";
    grantedByUserId: string;
  }): Promise<AgentOwnershipGrantRow> {
    if ((input.role as string) === "owner") {
      throw forbidden("Ownership cannot be granted directly; use the transfer flow.");
    }
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const existing = await txDb
        .select()
        .from(agentOwnershipGrants)
        .where(
          and(
            eq(agentOwnershipGrants.agentId, input.agentId),
            eq(agentOwnershipGrants.principalType, input.principalType),
            eq(agentOwnershipGrants.principalId, input.principalId),
            isNull(agentOwnershipGrants.revokedAt),
          ),
        );
      const activeNonOwner = existing.find((row) => row.role !== "owner") ?? null;
      if (activeNonOwner && activeNonOwner.role === input.role) {
        return toRow(activeNonOwner);
      }
      const now = new Date();
      if (activeNonOwner) {
        await txDb
          .update(agentOwnershipGrants)
          .set({ revokedAt: now, revokedByUserId: input.grantedByUserId, revokedReason: "role_change" })
          .where(eq(agentOwnershipGrants.id, activeNonOwner.id));
      }
      const created = await txDb
        .insert(agentOwnershipGrants)
        .values({
          id: randomUUID(),
          companyId: input.companyId,
          agentId: input.agentId,
          principalType: input.principalType,
          principalId: input.principalId,
          role: input.role,
          grantedByUserId: input.grantedByUserId,
          transitionFromGrantId: activeNonOwner?.id ?? null,
          source: "manual_grant",
        })
        .returning()
        .then((rows) => rows[0]);
      return toRow(created);
    });
  }

  /** Revoke a principal's admin/user role. Never revokes the owner. */
  async function revokeRole(input: {
    agentId: string;
    principalType: AgentOwnershipPrincipalType;
    principalId: string;
    revokedByUserId: string;
    reason?: string;
  }): Promise<void> {
    const active = await db
      .select()
      .from(agentOwnershipGrants)
      .where(
        and(
          eq(agentOwnershipGrants.agentId, input.agentId),
          eq(agentOwnershipGrants.principalType, input.principalType),
          eq(agentOwnershipGrants.principalId, input.principalId),
          isNull(agentOwnershipGrants.revokedAt),
        ),
      );
    const target = active.find((row) => row.role !== "owner");
    if (!target) return;
    await db
      .update(agentOwnershipGrants)
      .set({
        revokedAt: new Date(),
        revokedByUserId: input.revokedByUserId,
        revokedReason: input.reason ?? "revoked",
      })
      .where(eq(agentOwnershipGrants.id, target.id));
  }

  /** Owner (or instance admin) proposes handing ownership to another user. */
  async function proposeTransfer(input: {
    companyId: string;
    agentId: string;
    toUserId: string;
    proposedByUserId: string;
  }) {
    const owner = await getActiveOwner(input.agentId);
    if (!owner) throw notFound("Agent has no active owner to transfer from");
    if (owner.principalId !== input.proposedByUserId) {
      throw forbidden("Only the current owner can propose an ownership transfer");
    }
    if (owner.principalId === input.toUserId) {
      throw unprocessable("Agent is already owned by this user");
    }
    const existingPending = await db
      .select()
      .from(agentOwnershipTransfers)
      .where(
        and(eq(agentOwnershipTransfers.agentId, input.agentId), eq(agentOwnershipTransfers.status, "pending")),
      )
      .then((rows) => rows[0] ?? null);
    if (existingPending) {
      throw conflict("A transfer is already pending for this agent");
    }
    const created = await db
      .insert(agentOwnershipTransfers)
      .values({
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        fromUserId: owner.principalId,
        toUserId: input.toUserId,
        status: "pending",
        proposedByUserId: input.proposedByUserId,
      })
      .returning()
      .then((rows) => rows[0]);
    return created;
  }

  /**
   * The proposed recipient accepts. This is the only way ownership moves
   * outside of an instance-admin break-glass override: acceptance revokes
   * the outgoing owner's grant and inserts a new one for the accepting
   * user, atomically, so the "exactly one active owner" invariant never
   * has a zero- or two-owner window.
   */
  async function acceptTransfer(input: { transferId: string; acceptingUserId: string }) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const transfer = await txDb
        .select()
        .from(agentOwnershipTransfers)
        .where(eq(agentOwnershipTransfers.id, input.transferId))
        .then((rows) => rows[0] ?? null);
      if (!transfer) throw notFound("Transfer not found");
      if (transfer.status !== "pending") throw conflict(`Transfer is not pending (status: ${transfer.status})`);
      if (transfer.toUserId !== input.acceptingUserId) {
        throw forbidden("Only the proposed recipient can accept this transfer");
      }
      const owner = await txDb
        .select()
        .from(agentOwnershipGrants)
        .where(
          and(
            eq(agentOwnershipGrants.agentId, transfer.agentId),
            eq(agentOwnershipGrants.role, "owner"),
            isNull(agentOwnershipGrants.revokedAt),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!owner || owner.principalId !== transfer.fromUserId) {
        throw conflict("Current owner no longer matches the transfer's source owner");
      }
      const now = new Date();
      await txDb
        .update(agentOwnershipGrants)
        .set({ revokedAt: now, revokedByUserId: input.acceptingUserId, revokedReason: "transfer_accepted" })
        .where(eq(agentOwnershipGrants.id, owner.id));
      const newOwnerGrant = await txDb
        .insert(agentOwnershipGrants)
        .values({
          id: randomUUID(),
          companyId: transfer.companyId,
          agentId: transfer.agentId,
          principalType: "user",
          principalId: transfer.toUserId,
          role: "owner",
          grantedByUserId: transfer.fromUserId,
          transitionFromGrantId: owner.id,
          source: "transfer_accept",
        })
        .returning()
        .then((rows) => rows[0]);
      await txDb
        .update(agentOwnershipTransfers)
        .set({
          status: "accepted",
          respondedByUserId: input.acceptingUserId,
          respondedAt: now,
          resultingGrantId: newOwnerGrant.id,
          updatedAt: now,
        })
        .where(eq(agentOwnershipTransfers.id, transfer.id));
      return toRow(newOwnerGrant);
    });
  }

  async function declineOrCancelTransfer(input: {
    transferId: string;
    byUserId: string;
    action: "decline" | "cancel";
  }) {
    const transfer = await db
      .select()
      .from(agentOwnershipTransfers)
      .where(eq(agentOwnershipTransfers.id, input.transferId))
      .then((rows) => rows[0] ?? null);
    if (!transfer) throw notFound("Transfer not found");
    if (transfer.status !== "pending") throw conflict(`Transfer is not pending (status: ${transfer.status})`);
    if (input.action === "decline" && transfer.toUserId !== input.byUserId) {
      throw forbidden("Only the proposed recipient can decline this transfer");
    }
    if (input.action === "cancel" && transfer.fromUserId !== input.byUserId) {
      throw forbidden("Only the proposing owner can cancel this transfer");
    }
    const now = new Date();
    await db
      .update(agentOwnershipTransfers)
      .set({
        status: input.action === "decline" ? "declined" : "cancelled",
        respondedByUserId: input.byUserId,
        respondedAt: now,
        updatedAt: now,
      })
      .where(eq(agentOwnershipTransfers.id, transfer.id));
  }

  /**
   * Instance-admin break-glass: force ownership to a new user without
   * acceptance, for offboarding / recovery. Callers MUST log this via
   * `logActivity` -- this function only writes the ownership rows and the
   * forced transfer record; it does not itself write to the activity log,
   * since callers already have the request context (actor, IP, etc.) that
   * belongs in that entry.
   *
   * SECURITY: this function performs NO authorization check of its own --
   * it trusts `input.instanceAdminUserId` and executes unconditionally.
   * That is deliberate: the route guard (`assertInstanceAdmin` in
   * server/src/routes/agents.ts) owns verifying the caller is actually an
   * instance admin. This function is exported from services/index.ts, so
   * every caller (route handler, script, future service) MUST
   * independently re-verify instance-admin authorization before invoking
   * it -- do not add a new call site that skips that check.
   */
  async function forceTransferByInstanceAdmin(input: {
    companyId: string;
    agentId: string;
    toUserId: string;
    instanceAdminUserId: string;
    reason?: string;
  }) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const owner = await txDb
        .select()
        .from(agentOwnershipGrants)
        .where(
          and(
            eq(agentOwnershipGrants.agentId, input.agentId),
            eq(agentOwnershipGrants.role, "owner"),
            isNull(agentOwnershipGrants.revokedAt),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!owner) throw notFound("Agent has no active owner");
      const now = new Date();
      await txDb
        .update(agentOwnershipGrants)
        .set({
          revokedAt: now,
          revokedByUserId: input.instanceAdminUserId,
          revokedReason: input.reason ?? "instance_admin_override",
        })
        .where(eq(agentOwnershipGrants.id, owner.id));
      const newOwnerGrant = await txDb
        .insert(agentOwnershipGrants)
        .values({
          id: randomUUID(),
          companyId: input.companyId,
          agentId: input.agentId,
          principalType: "user",
          principalId: input.toUserId,
          role: "owner",
          grantedByUserId: input.instanceAdminUserId,
          transitionFromGrantId: owner.id,
          isInstanceAdminOverride: true,
          source: "instance_admin_override",
        })
        .returning()
        .then((rows) => rows[0]);
      const transfer = await txDb
        .insert(agentOwnershipTransfers)
        .values({
          id: randomUUID(),
          companyId: input.companyId,
          agentId: input.agentId,
          fromUserId: owner.principalId,
          toUserId: input.toUserId,
          status: "forced",
          proposedByUserId: input.instanceAdminUserId,
          respondedByUserId: input.instanceAdminUserId,
          respondedAt: now,
          forcedByInstanceAdminUserId: input.instanceAdminUserId,
          resultingGrantId: newOwnerGrant.id,
        })
        .returning()
        .then((rows) => rows[0]);
      return { grant: toRow(newOwnerGrant), transfer };
    });
  }

  return {
    writeInitialOwnership,
    getActiveOwner,
    listActiveGrants,
    setRole,
    revokeRole,
    proposeTransfer,
    acceptTransfer,
    declineOrCancelTransfer,
    forceTransferByInstanceAdmin,
  };
}

export type AgentOwnershipService = ReturnType<typeof agentOwnershipService>;
