import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { Db, AgentOwnershipPrincipalType, AgentOwnershipRole, AgentOwnershipSource } from "@paperclipai/db";
import { agentOwnershipGrants, agentOwnershipTransfers, agents, companyMemberships } from "@paperclipai/db";
import { conflict, forbidden, isPostgresError, notFound, unprocessable } from "../errors.js";

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

/**
 * A user counts as an eligible non-viewer member if their membershipRole is
 * anything other than "viewer" -- including NULL/unset (no role assigned at
 * all is not the same as explicitly being a viewer). Extracted to a single
 * place after `bootstrapOwnership` and `buildEnforcementDryRunReport`
 * independently drifted: both used bare `ne(membershipRole, "viewer")`,
 * which silently excludes NULL-role members too (SQL's `<>` against NULL is
 * NULL, not true) -- fixed in one, not the other, until this extraction made
 * them structurally impossible to desync again. This is one specific model
 * of "who can act on an agent" (mirrors `authorization.ts`'s NULL !==
 * "viewer" treatment); other access paths in this codebase (e.g.
 * routes/issues.ts) treat a NULL role as denied, a real, currently
 * undocumented divergence -- not resolved here, since reconciling it is a
 * separate question from the bug this predicate was extracted to prevent.
 */
function isActiveNonViewerMember(companyId: string, principalId?: string) {
  return and(
    eq(companyMemberships.companyId, companyId),
    eq(companyMemberships.principalType, "user"),
    ...(principalId ? [eq(companyMemberships.principalId, principalId)] : []),
    eq(companyMemberships.status, "active"),
    or(isNull(companyMemberships.membershipRole), ne(companyMemberships.membershipRole, "viewer")),
  );
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

  /**
   * TECH-4930 stage 2 follow-up: one-time backfill for agents that predate
   * TECH-4929 stage 1 (write-on-create) and therefore have zero ownership
   * grants at all -- `companyService.update` refuses to enable
   * `enforceAgentOwnership` while any such agent exists (see that file's
   * comment), and neither `setRole` (owner can't be assigned through it)
   * nor `proposeTransfer`/`forceTransferByInstanceAdmin` (both require an
   * existing owner to transfer from) can create the first grant. This is
   * the only path that can. Instance-admin only, and refuses outright if
   * the agent already has an active owner -- this is a bootstrap for
   * genuinely unowned agents, not a quieter way to reassign an owned one
   * (that's `forceTransferByInstanceAdmin`).
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
  async function bootstrapOwnership(input: {
    companyId: string;
    agentId: string;
    ownerUserId: string;
    instanceAdminUserId: string;
  }): Promise<AgentOwnershipGrantRow> {
    const ownerUserId = input.ownerUserId?.trim();
    if (!ownerUserId) throw unprocessable("ownerUserId is required");
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const existingOwner = await txDb
        .select({ id: agentOwnershipGrants.id })
        .from(agentOwnershipGrants)
        .where(
          and(
            eq(agentOwnershipGrants.agentId, input.agentId),
            eq(agentOwnershipGrants.role, "owner"),
            isNull(agentOwnershipGrants.revokedAt),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existingOwner) {
        throw conflict("Agent already has an active owner -- use the transfer flow to change it.");
      }
      // Nothing upstream has already validated that ownerUserId belongs to
      // this company for THIS path specifically -- the sibling transfer
      // paths (proposeTransfer, forceTransferByInstanceAdmin) do not check
      // membership either today, so this is not yet a codebase-wide
      // invariant, only a bootstrap-specific one. Without this check, an
      // instance admin could bootstrap an agent to a nonexistent user or one
      // from a different tenant, orphaning the agent the moment enforcement
      // is turned on (an unreachable owner is worse than none).
      // `isActiveNonViewerMember` is shared with buildEnforcementDryRunReport
      // below -- see that function's definition for why this is extracted
      // rather than duplicated. The NULL-role accept path is covered by the
      // pre-existing happy-path test above (seedActiveMembership leaves
      // membershipRole unset); the non-NULL, non-viewer accept path and the
      // viewer-reject path each have their own dedicated test below.
      // `.for("update")` locks the matched row for the rest of this
      // transaction so a concurrent membership revocation can't land between
      // this check and the INSERT below (TOCTOU).
      const membership = await txDb
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(isActiveNonViewerMember(input.companyId, ownerUserId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!membership) {
        throw unprocessable("ownerUserId must be an active, non-viewer member of this company");
      }
      // The pre-check SELECT above is not a lock -- two concurrent bootstrap
      // calls for the same agent can both pass it. The partial unique index
      // `agent_ownership_grants_one_active_owner_idx` is what actually
      // enforces "at most one active owner"; catch its violation here and
      // translate it to the same 409 the pre-check produces, rather than
      // letting the raw Postgres error surface as an unhandled 500.
      try {
        const created = await txDb
          .insert(agentOwnershipGrants)
          .values({
            id: randomUUID(),
            companyId: input.companyId,
            agentId: input.agentId,
            principalType: "user",
            principalId: ownerUserId,
            role: "owner",
            grantedByUserId: input.instanceAdminUserId,
            isInstanceAdminOverride: true,
            source: "instance_admin_bootstrap",
          })
          .returning()
          .then((rows) => rows[0]);
        return toRow(created);
      } catch (error) {
        if (isPostgresError(error, "23505")) {
          throw conflict("Agent already has an active owner -- use the transfer flow to change it.");
        }
        throw error;
      }
    });
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

  /**
   * TECH-4930 stage 2: does `principalId` hold any active (non-revoked)
   * role -- owner, admin, or user -- on `agentId`? This is the single
   * predicate `server/src/services/authorization.ts#applyAgentOwnershipEnforcement`
   * and the `responsibleUserId` ownership check consult; any active row
   * counts; the caller decides whether a specific role is required.
   */
  async function hasActiveGrant(
    agentId: string,
    principalType: AgentOwnershipPrincipalType,
    principalId: string,
  ): Promise<boolean> {
    const row = await db
      .select({ id: agentOwnershipGrants.id })
      .from(agentOwnershipGrants)
      .where(
        and(
          eq(agentOwnershipGrants.agentId, agentId),
          eq(agentOwnershipGrants.principalType, principalType),
          eq(agentOwnershipGrants.principalId, principalId),
          isNull(agentOwnershipGrants.revokedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  /**
   * Agents in `companyId` with zero active `role = 'owner'` grants -- the
   * exact "incomplete data" set that must block enabling enforcement
   * (`companyService.update` calls the equivalent query in the same
   * transaction before flipping `companies.enforce_agent_ownership`; this
   * standalone version backs the dry-run report and tests). A LEFT JOIN
   * against the partial-unique "one active owner" index, filtered to rows
   * where the join found nothing.
   */
  async function listUnownedAgents(companyId: string): Promise<Array<{ id: string; name: string }>> {
    return db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .leftJoin(
        agentOwnershipGrants,
        and(
          eq(agentOwnershipGrants.agentId, agents.id),
          eq(agentOwnershipGrants.role, "owner"),
          isNull(agentOwnershipGrants.revokedAt),
        ),
      )
      .where(and(eq(agents.companyId, companyId), isNull(agentOwnershipGrants.id)));
  }

  /**
   * Dry-run report for an admin deciding whether to flip
   * `companies.enforce_agent_ownership` on. Answers two questions:
   *
   *  1. Would enabling be refused outright? (`readyToEnable` /
   *     `unownedAgents` -- mirrors the check `companyService.update` runs
   *     for real.)
   *  2. For every agent that *does* have an owner, which currently-active
   *     non-viewer company members would lose the ability to drive it?
   *
   * (2) exists because today -- see the six paths in TECH-4930 -- any
   * active non-viewer company member can trigger a run on any agent in the
   * company (comment on its issue, hit /wakeup, checkout when already
   * assignee, retry-now, resolve an approval that wakes it, or assert its
   * responsibleUserId). Enforcement narrows that to principals holding an
   * active ownership grant on the specific agent. So "who currently has
   * access that would be revoked" is exactly "active non-viewer members
   * minus principals with an active grant on this agent" -- there is no
   * narrower existing ACL to diff against, because none exists yet. This
   * is why the report is agent-by-agent rather than permission-by-permission:
   * the only permission being narrowed is "member of the company", and the
   * report's job is to make that narrowing's blast radius legible before
   * an admin flips the flag, not to enumerate every route path.
   */
  async function buildEnforcementDryRunReport(companyId: string): Promise<AgentOwnershipDryRunReport> {
    const [allAgents, activeGrants, nonViewerMembers] = await Promise.all([
      db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, companyId)),
      db
        .select()
        .from(agentOwnershipGrants)
        .where(and(eq(agentOwnershipGrants.companyId, companyId), isNull(agentOwnershipGrants.revokedAt))),
      db
        .select({ principalId: companyMemberships.principalId, membershipRole: companyMemberships.membershipRole })
        .from(companyMemberships)
        // Models "who has run-triggering access to this company's agents
        // today" (see isActiveNonViewerMember's own definition for the
        // NULL-role rationale and the known issues.ts divergence this does
        // NOT resolve) -- shared with bootstrapOwnership's eligible-owner
        // check above so the two can't independently drift again.
        .where(isActiveNonViewerMember(companyId)),
    ]);

    const grantsByAgent = new Map<string, typeof activeGrants>();
    for (const grant of activeGrants) {
      const list = grantsByAgent.get(grant.agentId) ?? [];
      list.push(grant);
      grantsByAgent.set(grant.agentId, list);
    }

    const unownedAgents = allAgents.filter((agent) => {
      const grants = grantsByAgent.get(agent.id) ?? [];
      return !grants.some((grant) => grant.role === "owner");
    });

    const impactedAgents = allAgents
      .filter((agent) => !unownedAgents.some((unowned) => unowned.id === agent.id))
      .map((agent) => {
        const grants = grantsByAgent.get(agent.id) ?? [];
        const ownerGrant = grants.find((grant) => grant.role === "owner") ?? null;
        const grantedUserIds = new Set(
          grants.filter((grant) => grant.principalType === "user").map((grant) => grant.principalId),
        );
        const wouldLoseAccess = nonViewerMembers
          .filter((member) => !grantedUserIds.has(member.principalId))
          .map((member) => ({
            userId: member.principalId,
            membershipRole: member.membershipRole,
            reason:
              "Currently has agent-wake/comment/checkout/retry/approval-resolve access to this agent via " +
              "active non-viewer company membership alone; holds no ownership grant on this specific agent.",
          }));
        return {
          agentId: agent.id,
          agentName: agent.name,
          ownerUserId: ownerGrant?.principalId ?? null,
          wouldLoseAccess,
        };
      })
      .filter((entry) => entry.wouldLoseAccess.length > 0);

    return {
      companyId,
      generatedAt: new Date().toISOString(),
      readyToEnable: unownedAgents.length === 0,
      unownedAgents,
      impactedAgents,
    };
  }

  return {
    writeInitialOwnership,
    bootstrapOwnership,
    getActiveOwner,
    listActiveGrants,
    setRole,
    revokeRole,
    proposeTransfer,
    acceptTransfer,
    declineOrCancelTransfer,
    forceTransferByInstanceAdmin,
    hasActiveGrant,
    listUnownedAgents,
    buildEnforcementDryRunReport,
  };
}

export interface AgentOwnershipDryRunReport {
  companyId: string;
  generatedAt: string;
  /** If false, `companyService.update` will refuse to enable enforcement. */
  readyToEnable: boolean;
  unownedAgents: Array<{ id: string; name: string }>;
  impactedAgents: Array<{
    agentId: string;
    agentName: string;
    ownerUserId: string | null;
    wouldLoseAccess: Array<{ userId: string; membershipRole: string | null; reason: string }>;
  }>;
}

export type AgentOwnershipService = ReturnType<typeof agentOwnershipService>;
