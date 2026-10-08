import { and, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  announcementDismissals,
  authSessions,
  authUsers,
  companyMemberships,
  instanceUserRoles,
  joinRequests,
  userDisablements,
  userSidebarPreferences,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";

/** The implicit board principal `local_trusted` mode acts as. */
export const LOCAL_BOARD_USER_ID = "local-board";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Activity a user can produce before they ever hold a company membership:
 * asking to join through an invite. It names the user but is not authored
 * company work, so it does not block deleting the account.
 */
const PRE_MEMBERSHIP_ACTIVITY_ACTIONS = ["join.requested", "join.request_replayed"];

export type InstanceUserDisablement = {
  userId: string;
  reason: string | null;
  disabledByUserId: string | null;
  disabledAt: Date;
};

/**
 * Whether an instance admin has blocked this account. Every place that turns
 * a credential into a user actor calls this, so a block takes effect on the
 * next request regardless of which credential the user still holds.
 */
export async function isUserDisabled(db: DbOrTx, userId: string): Promise<boolean> {
  const row = await db
    .select({ id: userDisablements.id })
    .from(userDisablements)
    // At most one open row per user (`user_disablements_active_user_uq`).
    .where(and(eq(userDisablements.userId, userId), isNull(userDisablements.enabledAt)))
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

/**
 * Locks the account row until the transaction ends and returns it, or null
 * when the user no longer exists. Disable, enable and delete take `update`, so
 * they run one at a time per account. Approving a join request takes
 * `key share`: it waits for a delete in flight and then sees the account is
 * gone, and a delete that starts later sees the new membership. Take this lock
 * before locking any of the user's join requests, as `deleteUser` does.
 */
export async function lockUserAccount(tx: DbOrTx, userId: string, strength: "update" | "key share") {
  return tx
    .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .for(strength)
    .then((rows) => rows[0] ?? null);
}

export async function listActiveUserDisablements(
  db: DbOrTx,
  userIds: string[],
): Promise<Map<string, InstanceUserDisablement>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      userId: userDisablements.userId,
      reason: userDisablements.reason,
      disabledByUserId: userDisablements.disabledByUserId,
      disabledAt: userDisablements.disabledAt,
    })
    .from(userDisablements)
    .where(and(inArray(userDisablements.userId, userIds), isNull(userDisablements.enabledAt)));
  return new Map(rows.map((row) => [row.userId, row]));
}

export type InstanceUserServiceOptions = {
  /**
   * True in `local_trusted` mode, where the implicit local board is always an
   * instance admin. The instance then can never lose its last admin, so the
   * last-admin guards stand down.
   */
  implicitLocalAdmin?: boolean;
};

export function instanceUserService(db: Db, opts: InstanceUserServiceOptions = {}) {
  async function requireUser(tx: DbOrTx, userId: string) {
    const user = await lockUserAccount(tx, userId, "update");
    if (!user) throw notFound("User not found");
    return user;
  }

  function assertNotSelfOrLocalBoard(targetUserId: string, actorUserId: string | null, verb: string) {
    if (actorUserId && actorUserId === targetUserId) {
      throw conflict(`You cannot ${verb} your own account`, { code: "instance_user_self_action" });
    }
    if (targetUserId === LOCAL_BOARD_USER_ID) {
      throw conflict(`The local board user cannot be ${verb}d`, { code: "instance_user_local_board" });
    }
  }

  /**
   * Serializes every change that can reduce the set of active instance admins
   * (disable, demote, delete). Two admins disabling each other at the same
   * time would otherwise each see the other as the remaining admin.
   */
  async function lockInstanceAdmins(tx: DbOrTx) {
    await tx.execute(sql`
      select ${instanceUserRoles.id}
      from ${instanceUserRoles}
      where ${instanceUserRoles.role} = 'instance_admin'
      for update
    `);
  }

  async function isInstanceAdmin(tx: DbOrTx, userId: string) {
    const row = await tx
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  /**
   * Instance admins other than `excludeUserId` who can still act: the user row
   * exists and no block is active. The `local-board` principal is skipped
   * because it has no credential outside `local_trusted` mode, and that mode
   * is covered by `implicitLocalAdmin`.
   */
  async function countOtherActiveInstanceAdmins(tx: DbOrTx, excludeUserId: string) {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(instanceUserRoles)
      .innerJoin(authUsers, eq(authUsers.id, instanceUserRoles.userId))
      .where(
        and(
          eq(instanceUserRoles.role, "instance_admin"),
          ne(instanceUserRoles.userId, excludeUserId),
          ne(instanceUserRoles.userId, LOCAL_BOARD_USER_ID),
          sql`not exists (
            select 1 from ${userDisablements}
            where ${userDisablements.userId} = ${instanceUserRoles.userId}
              and ${userDisablements.enabledAt} is null
          )`,
        ),
      );
    return row?.count ?? 0;
  }

  async function assertInstanceKeepsAnAdmin(tx: DbOrTx, targetUserId: string, message: string) {
    if (opts.implicitLocalAdmin) return;
    if (!(await isInstanceAdmin(tx, targetUserId))) return;
    if ((await countOtherActiveInstanceAdmins(tx, targetUserId)) > 0) return;
    throw conflict(message, { code: "instance_user_last_admin" });
  }

  async function disableUser(input: { userId: string; actorUserId: string | null; reason?: string | null }) {
    const reason = input.reason?.trim() || null;
    return db.transaction(async (tx) => {
      await requireUser(tx, input.userId);
      assertNotSelfOrLocalBoard(input.userId, input.actorUserId, "disable");
      await lockInstanceAdmins(tx);
      await assertInstanceKeepsAnAdmin(tx, input.userId, "Cannot disable the last active instance admin");

      await tx
        .insert(userDisablements)
        .values({ userId: input.userId, reason, disabledByUserId: input.actorUserId })
        .onConflictDoNothing();
      // The account lock keeps a concurrent enable from closing the block
      // between the insert and this read.
      const [disablement] = await tx
        .select()
        .from(userDisablements)
        .where(and(eq(userDisablements.userId, input.userId), isNull(userDisablements.enabledAt)));

      // Better Auth reads sessions from this table on every request, so
      // deleting the rows signs the user out everywhere. Board API keys and
      // MCP OAuth grants stay in place but stop resolving while the block is
      // active; see `boardAuthService.resolveBoardAccess`.
      const revokedSessions = await tx
        .delete(authSessions)
        .where(eq(authSessions.userId, input.userId))
        .returning({ id: authSessions.id });

      return {
        userId: input.userId,
        status: "disabled" as const,
        disabledAt: disablement!.disabledAt,
        disabledByUserId: disablement!.disabledByUserId,
        reason: disablement!.reason,
        revokedSessionCount: revokedSessions.length,
      };
    });
  }

  async function enableUser(input: { userId: string; actorUserId: string | null }) {
    return db.transaction(async (tx) => {
      await requireUser(tx, input.userId);
      const reopened = await tx
        .update(userDisablements)
        .set({ enabledAt: new Date(), enabledByUserId: input.actorUserId })
        .where(and(eq(userDisablements.userId, input.userId), isNull(userDisablements.enabledAt)))
        .returning({ id: userDisablements.id });
      return {
        userId: input.userId,
        status: "active" as const,
        wasDisabled: reopened.length > 0,
      };
    });
  }

  async function demoteInstanceAdmin(input: { userId: string }) {
    return db.transaction(async (tx) => {
      await lockInstanceAdmins(tx);
      await assertInstanceKeepsAnAdmin(tx, input.userId, "Cannot remove the last active instance admin");
      return tx
        .delete(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, input.userId), eq(instanceUserRoles.role, "instance_admin")))
        .returning()
        .then((rows) => rows[0] ?? null);
    });
  }

  /**
   * Company history that has to keep a valid author. Memberships (active or
   * archived) gate every company-scoped write a regular user can make; the
   * activity check also catches work an instance admin did without holding a
   * membership. Asking to join through an invite does not count.
   */
  async function hasCompanyHistory(tx: DbOrTx, userId: string) {
    const membership = await tx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (membership) return true;
    // `activity_log` has no index on the actor, so this scans it. Deleting a
    // user is a rare, explicit admin action and only reaches this query for
    // accounts without any membership.
    const activity = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        or(
          and(
            eq(activityLog.actorType, "user"),
            eq(activityLog.actorId, userId),
            notInArray(activityLog.action, PRE_MEMBERSHIP_ACTIVITY_ACTIONS),
          ),
          eq(activityLog.responsibleUserId, userId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(activity);
  }

  async function deleteUser(input: { userId: string; actorUserId: string | null }) {
    return db.transaction(async (tx) => {
      const user = await requireUser(tx, input.userId);
      assertNotSelfOrLocalBoard(input.userId, input.actorUserId, "delete");
      await lockInstanceAdmins(tx);
      if (await isInstanceAdmin(tx, input.userId)) {
        throw conflict("Remove the instance admin role before deleting this user", {
          code: "instance_user_is_admin",
        });
      }

      if (await hasCompanyHistory(tx, input.userId)) {
        throw conflict(
          "This user has organization history and cannot be deleted. Disable the account instead.",
          { code: "instance_user_has_history" },
        );
      }

      // A pending request left behind could later be approved into a
      // membership for a user that no longer exists. Close it the same way a
      // company admin would; the email snapshot keeps the row readable.
      const now = new Date();
      const rejectedJoinRequests = await tx
        .update(joinRequests)
        .set({ status: "rejected", rejectedByUserId: input.actorUserId, rejectedAt: now, updatedAt: now })
        .where(
          and(
            eq(joinRequests.requestingUserId, input.userId),
            eq(joinRequests.status, "pending_approval"),
          ),
        )
        .returning({ id: joinRequests.id, companyId: joinRequests.companyId, requestType: joinRequests.requestType });

      // Instance-wide rows keyed by the user id without a foreign key.
      await tx.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, input.userId));
      await tx.delete(userSidebarPreferences).where(eq(userSidebarPreferences.userId, input.userId));
      await tx.delete(announcementDismissals).where(eq(announcementDismissals.userId, input.userId));

      // Sessions, credential accounts, board API keys, MCP OAuth rows and
      // disablement records cascade through their foreign keys; CLI auth
      // approvals and comment attributions fall back to null.
      await tx.delete(authUsers).where(eq(authUsers.id, input.userId));

      return {
        userId: user.id,
        email: user.email,
        deleted: true as const,
        rejectedJoinRequests,
      };
    });
  }

  return {
    disableUser,
    enableUser,
    demoteInstanceAdmin,
    deleteUser,
  };
}
