import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyMemberships,
  instanceUserRoles,
  issues,
  principalGrantLock,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";
import { crossIssueWriteGrantScopeError } from "@paperclipai/shared";
import { badRequest, conflict } from "../errors.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { authorizationService, type AuthorizationActor, type AuthorizationResource } from "./authorization.js";
import { ensureHumanRoleDefaultGrants } from "./principal-access-compatibility.js";

type MembershipRow = typeof companyMemberships.$inferSelect;
type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
  /**
   * Absent means "keep whatever bound this permission already has"; explicit
   * null removes the bound (FAI-10144). See `grantRowsPreservingExpiry`.
   */
  expiresAt?: Date | string | null;
};

/**
 * Grants arrive from HTTP payloads, where an expiry is an ISO string, and from
 * internal callers, where it is already a `Date`. Normalize once at the write
 * boundary so the column only ever sees a `Date` or null.
 */
function normalizeExpiresAt(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * The one lock every writer of `principal_permission_grants` takes, so that no
 * two of them can interleave.
 *
 * Both writers have to take it, not just the replacement path.
 * `setPrincipalPermission` is a read-then-write too: it finds a grant row and
 * then updates it by id, so a replacement that lands in between deletes the row
 * it read and inserts a new one with a new id, the update matches nothing, and
 * the expiry change is discarded with no error (FAI-10144, Greptile P1 at
 * `1b6afcce`). Its revoke path has the same shape in reverse — a delete that
 * lands inside a replacement's read-then-write window is undone by the
 * reinsert, resurrecting a grant an operator just removed.
 *
 * The lock is advisory, keyed on the principal's identity, because no *row*
 * serves. Locking the grant rows orders nothing against a replacement that
 * deletes and reinserts them (see `grantRowsPreservingExpiry`), and locking the
 * principal's `company_memberships` row — what this took until FAI-10144 round
 * 3 — silently degraded to no lock whenever that row was absent. It is absent
 * more often than "a principal with no membership has no grants" suggested:
 * nothing in the schema ties a grant to a membership, the revoke path never
 * requires one, and a membership removed after grants were written leaves them
 * behind. Two writers racing there serialized nothing. See `principalGrantLock`.
 *
 * `tx` must be a real transaction. In autocommit an `_xact_` advisory lock is
 * released before the statement it was meant to guard.
 */
async function lockPrincipalGrantWrites(
  tx: Pick<Db, "execute">,
  input: { companyId: string; principalType: PrincipalType; principalId: string },
) {
  await tx.execute(principalGrantLock(input));
}

/**
 * Rows for a wholesale grant replacement, with each grant's expiry carried
 * forward when the payload does not mention it.
 *
 * These endpoints replace a principal's entire grant set, so an omitted field
 * normally means "gone" — that is exactly how `scope` behaves. Expiry cannot
 * follow that rule. A client written before `expiresAt` existed reads the grant
 * list, flips one permission and writes the list back without the field, and
 * "gone" would silently turn a deliberately time-boxed authority into an
 * indefinite one. Omission must never widen, so absent keeps the existing bound
 * and an explicit null is how a bound is removed.
 *
 * `tx` must be the replacing transaction, and this must run before the delete,
 * so the bound being carried forward is the one being replaced.
 *
 * Concurrency. This is a read-then-write, so two replacements racing have to be
 * serialized, or the second writes back a bound the first already superseded.
 *
 * Locking the *grant* rows is not sufficient on its own, because a replacement
 * deletes and reinserts them rather than updating in place. Under READ
 * COMMITTED a `SELECT ... FOR UPDATE` that blocks on a row the winner then
 * deletes resumes with that row **skipped**, and the winner's freshly inserted
 * replacement is not in the waiter's statement snapshot either. The waiter's
 * preservation map would come back empty, an omitted expiry would fall through
 * to null, and the bound the winner had just set would be silently cleared —
 * omission widening authority, which is the one thing this function exists to
 * prevent.
 *
 * So the serializing lock is an advisory lock on the principal's identity,
 * which exists whether or not any row does — see `lockPrincipalGrantWrites`. It
 * has to be taken here rather than in the callers: two of the four call sites
 * invoke this as the first statement in their transaction and hold no other
 * lock.
 *
 * `FOR UPDATE` stays on the grant read too. It is redundant once both writers
 * hold the advisory lock, but it keeps the rows this function reads pinned for
 * the duration of the replacement that follows.
 */
export async function grantRowsPreservingExpiry(
  tx: Pick<Db, "select" | "execute">,
  input: {
    companyId: string;
    principalType: PrincipalType;
    principalId: string;
    grants: readonly GrantInput[];
    grantedByUserId: string | null;
    now: Date;
  },
) {
  await lockPrincipalGrantWrites(tx, input);

  const existing = await tx
    .select({
      permissionKey: principalPermissionGrants.permissionKey,
      expiresAt: principalPermissionGrants.expiresAt,
    })
    .from(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.companyId, input.companyId),
        eq(principalPermissionGrants.principalType, input.principalType),
        eq(principalPermissionGrants.principalId, input.principalId),
      ),
    )
    .for("update");
  const expiryByKey = new Map(existing.map((row) => [row.permissionKey, row.expiresAt]));

  return input.grants.map((grant) => ({
    companyId: input.companyId,
    principalType: input.principalType,
    principalId: input.principalId,
    permissionKey: grant.permissionKey,
    scope: grant.scope ?? null,
    expiresAt: grant.expiresAt === undefined
      ? expiryByKey.get(grant.permissionKey) ?? null
      : normalizeExpiresAt(grant.expiresAt),
    grantedByUserId: input.grantedByUserId,
    createdAt: input.now,
    updatedAt: input.now,
  }));
}

/**
 * `issues:cross-write` is the one grant whose whole contract is "narrow". An
 * unscoped one — or one scoped only on keys the authorization evaluator does
 * not recognize — is refused at save time so the stored grant and the evaluated
 * grant cannot disagree (FAI-10132 / FAI-10134 finding 3). Every other
 * permission key keeps its existing scope contract untouched.
 */
export function assertGrantScopesAreSaveable(grants: readonly GrantInput[]) {
  for (const grant of grants) {
    const error = crossIssueWriteGrantScopeError(grant.permissionKey, grant.scope ?? null);
    if (error) throw badRequest(error, { permissionKey: grant.permissionKey });
  }
}

type MemberArchiveInput = {
  reassignment?: {
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
  } | null;
};

export function accessService(db: Db) {
  const authorization = authorizationService(db);

  async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const row = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function getMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<MembershipRow | null> {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          eq(companyMemberships.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function hasPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    return authorization.decidePrincipalGrant({
      companyId,
      principalType,
      principalId,
      permissionKey,
      action: permissionKey,
    }).then((decision) => decision.allowed);
  }

  async function canUser(
    companyId: string,
    userId: string | null | undefined,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    return authorization.decide({
      actor: { type: "board", userId },
      action: permissionKey,
      resource: { type: "company", companyId },
    }).then((decision) => decision.allowed);
  }

  async function decide(input: {
    actor: AuthorizationActor;
    action: Parameters<typeof authorization.decide>[0]["action"];
    resource: AuthorizationResource;
    scope?: Record<string, unknown> | null;
  }) {
    return authorization.decide(input);
  }

  async function listMembers(companyId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, companyId))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  async function getMemberById(companyId: string, memberId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .then((rows) => rows[0] ?? null);
  }

  async function listActiveUserMemberships(companyId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(sql`${companyMemberships.createdAt} asc`);
  }

  async function setMemberPermissions(
    companyId: string,
    memberId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    assertGrantScopesAreSaveable(grants);
    const member = await getMemberById(companyId, memberId);
    if (!member) return null;

    await db.transaction(async (tx) => {
      // `member` above is a pooled read taken before this transaction existed,
      // so on its own it is only enough to name the principal. The state the
      // write is authorized against has to be read here, under the lock: a
      // removal committing in the gap would otherwise have this delete the
      // grants it had already deleted and reinsert the caller's set behind it
      // (FAI-10152 round 4).
      await lockPrincipalGrantWrites(tx, {
        companyId,
        principalType: member.principalType as PrincipalType,
        principalId: member.principalId,
      });
      await ensureMembershipForGrantWrite(
        tx,
        companyId,
        member.principalType as PrincipalType,
        member.principalId,
      );
      const rows = await grantRowsPreservingExpiry(tx, {
        companyId,
        principalType: member.principalType as PrincipalType,
        principalId: member.principalId,
        grants,
        grantedByUserId,
        now: new Date(),
      });
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, member.principalType),
            eq(principalPermissionGrants.principalId, member.principalId),
          ),
        );
      if (rows.length > 0) await tx.insert(principalPermissionGrants).values(rows);
    });

    return member;
  }

  async function updateMemberAndPermissions(
    companyId: string,
    memberId: string,
    data: {
      membershipRole?: string | null;
      status?: "pending" | "active" | "suspended";
      grants: GrantInput[];
    },
    grantedByUserId: string | null,
  ) {
    assertGrantScopesAreSaveable(data.grants);
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${companyMemberships.id}
        from ${companyMemberships}
        where ${companyMemberships.companyId} = ${companyId}
          and ${companyMemberships.principalType} = 'user'
          and ${companyMemberships.status} = 'active'
          and ${companyMemberships.membershipRole} = 'owner'
        for update
      `);

      const found = await tx
        .select()
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
        .then((rows) => rows[0] ?? null);
      if (!found) return null;

      // Taken here, between the owner-row locks and the membership state this
      // decides on, which is the order every writer of these two tables uses.
      // The read above is only enough to name the principal: under READ
      // COMMITTED each statement takes a fresh snapshot, so a removal that
      // commits while this transaction waits for the lock is invisible to a
      // decision made before it and present in the table the write lands in
      // after. Re-read once the lock is held and the answer is binding
      // (FAI-10152 round 4).
      await lockPrincipalGrantWrites(tx, {
        companyId,
        principalType: found.principalType as PrincipalType,
        principalId: found.principalId,
      });
      const existing = await tx
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.id, found.id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      if (existing.status === "archived") {
        throw conflict(
          `Principal ${existing.principalType}:${existing.principalId} has been removed from company ${companyId} and cannot be granted permissions`,
        );
      }

      const nextMembershipRole =
        data.membershipRole !== undefined ? data.membershipRole : existing.membershipRole;
      const nextStatus = data.status ?? existing.status;

      if (
        existing.principalType === "user" &&
        existing.status === "active" &&
        existing.membershipRole === "owner" &&
        (nextStatus !== "active" || nextMembershipRole !== "owner")
      ) {
        const activeOwnerCount = await tx
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              eq(companyMemberships.membershipRole, "owner"),
            ),
          )
          .then((rows) => rows.length);
        if (activeOwnerCount <= 1) {
          throw conflict("Cannot remove the last active owner");
        }
      }

      const now = new Date();
      const updated = await tx
        .update(companyMemberships)
        .set({
          membershipRole: nextMembershipRole,
          status: nextStatus,
          updatedAt: now,
        })
        .where(eq(companyMemberships.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? existing);

      const rows = await grantRowsPreservingExpiry(tx, {
        companyId,
        principalType: existing.principalType as PrincipalType,
        principalId: existing.principalId,
        grants: data.grants,
        grantedByUserId,
        now,
      });
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, existing.principalType),
            eq(principalPermissionGrants.principalId, existing.principalId),
          ),
        );
      if (rows.length > 0) await tx.insert(principalPermissionGrants).values(rows);

      return updated;
    });
  }

  async function assertCanRemoveActiveOwner(
    companyId: string,
    principalType: PrincipalType,
    status: string,
    membershipRole: string | null,
    tx: Pick<Db, "select">,
  ) {
    if (
      principalType !== "user" ||
      status !== "active" ||
      membershipRole !== "owner"
    ) {
      return;
    }

    const activeOwnerCount = await tx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          eq(companyMemberships.membershipRole, "owner"),
        ),
      )
      .then((rows) => rows.length);
    if (activeOwnerCount <= 1) {
      throw conflict("Cannot remove the last active owner");
    }
  }

  async function assertAssignableArchiveTarget(
    companyId: string,
    input: MemberArchiveInput["reassignment"],
    tx: Pick<Db, "select">,
  ) {
    if (!input?.assigneeAgentId && !input?.assigneeUserId) return;
    if (input.assigneeAgentId && input.assigneeUserId) {
      throw conflict("Choose either an agent or user reassignment target");
    }
    if (input.assigneeUserId) {
      const membership = await tx
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, input.assigneeUserId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!membership) {
        throw conflict("Replacement user must be an active company member");
      }
      return;
    }

    await assertAssignableAgent(tx as Db, companyId, input.assigneeAgentId, { kind: "work" });
  }

  async function archiveMember(companyId: string, memberId: string, input: MemberArchiveInput = {}) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${companyMemberships.id}
        from ${companyMemberships}
        where ${companyMemberships.companyId} = ${companyId}
          and ${companyMemberships.principalType} = 'user'
          and ${companyMemberships.status} = 'active'
          and ${companyMemberships.membershipRole} = 'owner'
        for update
      `);

      const existing = await tx
        .select()
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      if (existing.principalType !== "user") {
        throw conflict("Only human company members can be archived");
      }
      if (existing.status === "archived") {
        // Not a no-op. Archiving is idempotent on the membership row, but the
        // grants are a separate table with no foreign key to it, so "already
        // archived" is not the same as "already has no grants" — a writer that
        // raced the first archive can leave rows behind it. Returning here
        // meant the obvious remedy, calling archive again, was the one thing
        // that could not clean them up. Take the lock and repeat the delete;
        // on the common path it removes nothing (FAI-10152 round 4).
        await lockPrincipalGrantWrites(tx, {
          companyId,
          principalType: existing.principalType,
          principalId: existing.principalId,
        });
        await tx
          .delete(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, companyId),
              eq(principalPermissionGrants.principalType, existing.principalType),
              eq(principalPermissionGrants.principalId, existing.principalId),
            ),
          );
        return { member: existing, reassignedIssueCount: 0 };
      }
      if (input.reassignment?.assigneeUserId === existing.principalId) {
        throw conflict("Replacement user cannot be the archived member");
      }

      await assertCanRemoveActiveOwner(
        companyId,
        existing.principalType,
        existing.status,
        existing.membershipRole,
        tx,
      );
      await assertAssignableArchiveTarget(companyId, input.reassignment, tx);

      const now = new Date();
      const assignmentPatch = {
        assigneeAgentId: input.reassignment?.assigneeAgentId ?? null,
        assigneeUserId: input.reassignment?.assigneeUserId ?? null,
        updatedAt: now,
      };
      const assignedOpenIssueWhere = and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeUserId, existing.principalId),
        sql`${issues.status} not in ('done', 'cancelled')`,
      );
      const resetInProgress = await tx
        .update(issues)
        .set({
          ...assignmentPatch,
          status: "todo",
          startedAt: null,
          checkoutRunId: null,
          executionRunId: null,
          executionLockedAt: null,
        })
        .where(and(assignedOpenIssueWhere, eq(issues.status, "in_progress")))
        .returning({ id: issues.id });
      const reassigned = await tx
        .update(issues)
        .set(assignmentPatch)
        .where(and(assignedOpenIssueWhere, ne(issues.status, "in_progress")))
        .returning({ id: issues.id });

      // The membership is archived *before* the grants are dropped so this path
      // takes the same membership-row-then-advisory-key order every other grant
      // writer takes. The reverse order deadlocks against `setMemberPermissions`,
      // which updates the membership row first and reaches the advisory lock
      // inside `grantRowsPreservingExpiry`. Both statements commit together, so
      // nothing outside the transaction can tell the difference.
      const archived = await tx
        .update(companyMemberships)
        .set({
          status: "archived",
          updatedAt: now,
        })
        .where(eq(companyMemberships.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? existing);

      // Dropping a member's grants is a revocation, so it has to serialize
      // against the replacement and upsert paths exactly as every other grant
      // write does. Unlocked, a replacement that read its rows before this
      // delete reinserts them afterwards and hands an archived member their
      // authority back (FAI-10144).
      await lockPrincipalGrantWrites(tx, {
        companyId,
        principalType: existing.principalType,
        principalId: existing.principalId,
      });
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, existing.principalType),
            eq(principalPermissionGrants.principalId, existing.principalId),
          ),
        );

      return {
        member: archived,
        reassignedIssueCount: resetInProgress.length + reassigned.length,
      };
    });
  }

  async function promoteInstanceAdmin(userId: string) {
    const existing = await db
      .select()
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    return db
      .insert(instanceUserRoles)
      .values({
        userId,
        role: "instance_admin",
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function demoteInstanceAdmin(userId: string) {
    return db
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function listUserCompanyAccess(userId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId)))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  async function setUserCompanyAccess(
    userId: string,
    companyIds: string[],
    options: { actorUserId?: string | null } = {},
  ) {
    const existing = await listUserCompanyAccess(userId);
    const existingByCompany = new Map(existing.map((row) => [row.companyId, row]));
    const target = new Set(companyIds);

    await db.transaction(async (tx) => {
      const toArchive = existing.filter((row) => !target.has(row.companyId) && row.status !== "archived");
      if (toArchive.length > 0 && options.actorUserId && options.actorUserId === userId) {
        throw conflict("You cannot remove yourself");
      }
      if (toArchive.length > 0 && (await isInstanceAdmin(userId))) {
        throw conflict("Instance admins cannot be removed from company access");
      }
      const protectedArchives = toArchive.filter((row) => row.membershipRole === "owner" || row.membershipRole === "admin");
      if (protectedArchives.length > 0) {
        throw conflict("Owners and admins cannot be removed from company access");
      }
      const activeOwnerArchives = toArchive.filter(
        (row) => row.status === "active" && row.membershipRole === "owner",
      );
      if (activeOwnerArchives.length > 0) {
        const activeOwnerRows = await tx
          .select({ companyId: companyMemberships.companyId, id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              eq(companyMemberships.membershipRole, "owner"),
              inArray(companyMemberships.companyId, activeOwnerArchives.map((row) => row.companyId)),
            ),
          );
        for (const row of activeOwnerArchives) {
          const remainingOwners =
            activeOwnerRows.filter((owner) => owner.companyId === row.companyId).length - 1;
          if (remainingOwners <= 0) {
            throw conflict("Cannot remove the last active owner");
          }
        }
      }
      if (toArchive.length > 0) {
        await tx
          .update(companyMemberships)
          .set({ status: "archived", updatedAt: new Date() })
          .where(inArray(companyMemberships.id, toArchive.map((row) => row.id)));
        // Same rule as `archiveMember`: this is a revocation and must serialize
        // against the replacement and upsert paths, or a concurrent replacement
        // reinserts the rows it just removed. One lock per company, since the
        // key is per company/principal, taken in a fixed order so two
        // multi-company updates for the same user cannot deadlock each other.
        for (const archivedCompanyId of toArchive.map((row) => row.companyId).sort()) {
          await lockPrincipalGrantWrites(tx, {
            companyId: archivedCompanyId,
            principalType: "user",
            principalId: userId,
          });
        }
        await tx
          .delete(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.principalType, "user"),
              eq(principalPermissionGrants.principalId, userId),
              inArray(principalPermissionGrants.companyId, toArchive.map((row) => row.companyId)),
            ),
          );
      }

      for (const companyId of target) {
        const existingMembership = existingByCompany.get(companyId);
        if (existingMembership) {
          if (existingMembership.status !== "active") {
            await tx
              .update(companyMemberships)
              .set({
                status: "active",
                membershipRole: existingMembership.membershipRole ?? "operator",
                updatedAt: new Date(),
              })
              .where(eq(companyMemberships.id, existingMembership.id));
          }
          continue;
        }
        await tx.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: "operator",
        });
      }
    });

    return listUserCompanyAccess(userId);
  }

  /**
   * The membership half of a grant write, on the caller's transaction and under
   * the grant advisory lock the caller already holds.
   *
   * Two things separate it from `ensureMembership`. It runs inside `tx`, so the
   * membership check and the grant write are one serialized operation rather
   * than a pooled read followed by an unrelated transaction — a revoker
   * committing in that gap left an archived membership carrying a live grant
   * row, dormant until the principal was re-added and it woke up with them.
   *
   * And it never writes the membership. `ensureMembership(…, "member",
   * "active")` in front of a grant write was an *activation*: it flipped a
   * pending or suspended principal to active, and outside the lock at that, so
   * writing a permission quietly re-admitted someone an operator had stood
   * down. Standing is decided by the membership endpoints; this only reads it.
   * An `archived` row is refused outright, because that is the tombstone every
   * removal path leaves (`archiveMember`, `setUserCompanyAccess`) and it is the
   * one state where the removal also deleted the grants — writing them back is
   * resurrection. `pending` and `suspended` are left alone: those keep their
   * grants by design, and `decidePrincipalGrant` already refuses to honour a
   * grant behind either.
   *
   * Absent means never a member rather than removed, so it is still created —
   * that is how the default-grant seeders admit a freshly built agent.
   *
   * Ordering falls out of the lock the caller holds: a revoker either commits
   * first, and this sees `archived` and refuses, or it waits, and archives the
   * membership and drops the grants after this commits (FAI-10152 round 4).
   */
  async function ensureMembershipForGrantWrite(
    tx: Db,
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    const existing = await tx
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          eq(companyMemberships.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      if (existing.status === "archived") {
        throw conflict(
          `Principal ${principalType}:${principalId} has been removed from company ${companyId} and cannot be granted permissions`,
        );
      }
      return existing;
    }

    return tx
      .insert(companyMemberships)
      .values({ companyId, principalType, principalId, status: "active", membershipRole: "member" })
      .returning()
      .then((rows) => rows[0]);
  }

  async function ensureMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    membershipRole: string | null = "member",
    status: "pending" | "active" | "suspended" = "active",
  ) {
    const existing = await getMembership(companyId, principalType, principalId);
    if (existing) {
      if (existing.status !== status || existing.membershipRole !== membershipRole) {
        const updated = await db
          .update(companyMemberships)
          .set({ status, membershipRole, updatedAt: new Date() })
          .where(eq(companyMemberships.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return updated ?? existing;
      }
      return existing;
    }

    return db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType,
        principalId,
        status,
        membershipRole,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    assertGrantScopesAreSaveable(grants);
    await db.transaction(async (tx) => {
      // Lock first, then read the membership. Revalidating at all is the point:
      // every caller that ensures a membership does it on the pool before this
      // transaction opens, so a removal committing in that gap was invisible —
      // this deleted the principal's grants and reinserted the caller's set
      // behind the revoker's own delete, leaving an archived member holding a
      // full grant set that woke up the moment they were re-added.
      //
      // Taking the lock explicitly rather than leaning on the one
      // `grantRowsPreservingExpiry` takes puts the membership read *after* it,
      // which is what makes the answer binding: a revoker has then either
      // committed, and this reads `archived` and refuses, or it is queued
      // behind this transaction and drops the grants once we commit. The read
      // stays non-locking on purpose — `archiveMember` holds the membership row
      // and waits for this same advisory lock, so taking it `FOR UPDATE` here
      // would close a deadlock cycle (FAI-10152 round 4).
      await lockPrincipalGrantWrites(tx, { companyId, principalType, principalId });
      await ensureMembershipForGrantWrite(tx, companyId, principalType, principalId);
      const rows = await grantRowsPreservingExpiry(tx, {
        companyId,
        principalType,
        principalId,
        grants,
        grantedByUserId,
        now: new Date(),
      });
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
          ),
        );
      if (rows.length === 0) return;
      await tx.insert(principalPermissionGrants).values(rows);
    });
  }

  async function copyActiveUserMemberships(sourceCompanyId: string, targetCompanyId: string) {
    const sourceMemberships = await listActiveUserMemberships(sourceCompanyId);
    for (const membership of sourceMemberships) {
      await ensureMembership(
        targetCompanyId,
        "user",
        membership.principalId,
        membership.membershipRole,
        "active",
      );
      await ensureHumanRoleDefaultGrants(db, {
        companyId: targetCompanyId,
        principalId: membership.principalId,
        membershipRole: membership.membershipRole,
        grantedByUserId: null,
      });
    }
    return sourceMemberships;
  }

  async function ensureRoleDefaultGrants(
    companyId: string,
    principalId: string,
    membershipRole: string | null | undefined,
    grantedByUserId: string | null,
  ) {
    return ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId,
      membershipRole,
      grantedByUserId,
    });
  }

  async function listPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      )
      .orderBy(principalPermissionGrants.permissionKey);
  }

  async function setPrincipalPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
    enabled: boolean,
    grantedByUserId: string | null,
    scope: Record<string, unknown> | null = null,
    /**
     * `undefined` leaves an existing grant's expiry alone; `null` clears it.
     * The distinction matters because the default-grant seeders (built-in
     * agents, company import) call this on every ensure with no expiry — if
     * absent meant "clear", a re-seed would silently un-time-box a grant an
     * operator had deliberately bounded (FAI-10144).
     */
    expiresAt: Date | null | undefined = undefined,
  ) {
    if (!enabled) {
      await db.transaction(async (tx) => {
        await lockPrincipalGrantWrites(tx, { companyId, principalType, principalId });
        await tx
          .delete(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, companyId),
              eq(principalPermissionGrants.principalType, principalType),
              eq(principalPermissionGrants.principalId, principalId),
              eq(principalPermissionGrants.permissionKey, permissionKey),
            ),
          );
      });
      return;
    }

    assertGrantScopesAreSaveable([{ permissionKey, scope }]);

    const now = new Date();
    await db.transaction(async (tx) => {
      await lockPrincipalGrantWrites(tx, { companyId, principalType, principalId });
      // Inside the transaction and under the lock, not before either. Read on
      // the pooled handle first, this was a check whose answer could be false by
      // the time the grant landed: a revoker archiving the membership in that
      // gap left the row it deleted being reinserted right behind it.
      await ensureMembershipForGrantWrite(tx, companyId, principalType, principalId);
      // Written against the natural key rather than a row id read moments
      // earlier, so a replacement that recycles the row cannot turn this into
      // an update of zero rows. `expiresAt` is left out of the conflict update
      // when it is `undefined`, which is how "leave the existing bound alone"
      // is expressed; a fresh insert has no bound to keep, so it takes null.
      await tx
        .insert(principalPermissionGrants)
        .values({
          companyId,
          principalType,
          principalId,
          permissionKey,
          scope,
          expiresAt: expiresAt ?? null,
          grantedByUserId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            principalPermissionGrants.companyId,
            principalPermissionGrants.principalType,
            principalPermissionGrants.principalId,
            principalPermissionGrants.permissionKey,
          ],
          set: {
            scope,
            grantedByUserId,
            ...(expiresAt === undefined ? {} : { expiresAt }),
            updatedAt: now,
          },
        });
    });
  }

  async function updateMember(
    companyId: string,
    memberId: string,
    data: {
      membershipRole?: string | null;
      status?: "pending" | "active" | "suspended";
    },
  ) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${companyMemberships.id}
        from ${companyMemberships}
        where ${companyMemberships.companyId} = ${companyId}
          and ${companyMemberships.principalType} = 'user'
          and ${companyMemberships.status} = 'active'
          and ${companyMemberships.membershipRole} = 'owner'
        for update
      `);

      const existing = await tx
        .select()
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const nextMembershipRole =
        data.membershipRole !== undefined ? data.membershipRole : existing.membershipRole;
      const nextStatus = data.status ?? existing.status;

      if (
        existing.principalType === "user" &&
        existing.status === "active" &&
        existing.membershipRole === "owner" &&
        (nextStatus !== "active" || nextMembershipRole !== "owner")
      ) {
        const activeOwnerCount = await tx
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              eq(companyMemberships.membershipRole, "owner"),
            ),
          )
          .then((rows) => rows.length);
        if (activeOwnerCount <= 1) {
          throw conflict("Cannot remove the last active owner");
        }
      }

      return tx
        .update(companyMemberships)
        .set({
          membershipRole: nextMembershipRole,
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(eq(companyMemberships.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? existing);
    });
  }

  return {
    isInstanceAdmin,
    decide,
    canUser,
    hasPermission,
    getMembership,
    getMemberById,
    ensureMembership,
    listMembers,
    listActiveUserMemberships,
    copyActiveUserMemberships,
    ensureRoleDefaultGrants,
    archiveMember,
    setMemberPermissions,
    updateMemberAndPermissions,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    setPrincipalGrants,
    listPrincipalGrants,
    setPrincipalPermission,
    updateMember,
  };
}
