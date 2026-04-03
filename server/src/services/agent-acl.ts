import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentPermissionGrants, agentPermissionDefaults } from "@paperclipai/db";

export function agentAclService(db: Db) {
  async function listGrants(
    companyId: string,
    filters?: { granteeId?: string; agentId?: string; permission?: string },
  ) {
    const conditions = [eq(agentPermissionGrants.companyId, companyId)];
    if (filters?.granteeId) {
      conditions.push(eq(agentPermissionGrants.granteeId, filters.granteeId));
    }
    if (filters?.agentId) {
      conditions.push(eq(agentPermissionGrants.agentId, filters.agentId));
    }
    if (filters?.permission) {
      conditions.push(eq(agentPermissionGrants.permission, filters.permission));
    }
    return db
      .select()
      .from(agentPermissionGrants)
      .where(and(...conditions))
      .orderBy(agentPermissionGrants.createdAt);
  }

  async function getGrantById(companyId: string, grantId: string) {
    return db
      .select()
      .from(agentPermissionGrants)
      .where(
        and(
          eq(agentPermissionGrants.companyId, companyId),
          eq(agentPermissionGrants.id, grantId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function createGrant(
    companyId: string,
    granteeId: string,
    agentId: string,
    permission: string,
  ) {
    const [row] = await db
      .insert(agentPermissionGrants)
      .values({
        companyId,
        granteeId,
        agentId,
        permission,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          agentPermissionGrants.companyId,
          agentPermissionGrants.granteeId,
          agentPermissionGrants.agentId,
          agentPermissionGrants.permission,
        ],
        set: { updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async function deleteGrant(companyId: string, grantId: string) {
    return db
      .delete(agentPermissionGrants)
      .where(
        and(
          eq(agentPermissionGrants.companyId, companyId),
          eq(agentPermissionGrants.id, grantId),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function getDefaults(companyId: string) {
    return db
      .select()
      .from(agentPermissionDefaults)
      .where(eq(agentPermissionDefaults.companyId, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function upsertDefaults(
    companyId: string,
    patch: { assignDefault?: boolean; commentDefault?: boolean },
  ) {
    const existing = await getDefaults(companyId);

    const assignDefault = patch.assignDefault ?? existing?.assignDefault ?? false;
    const commentDefault = patch.commentDefault ?? existing?.commentDefault ?? false;

    const [row] = await db
      .insert(agentPermissionDefaults)
      .values({
        companyId,
        assignDefault,
        commentDefault,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [agentPermissionDefaults.companyId],
        set: {
          ...(patch.assignDefault !== undefined ? { assignDefault: patch.assignDefault } : {}),
          ...(patch.commentDefault !== undefined ? { commentDefault: patch.commentDefault } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  return {
    listGrants,
    getGrantById,
    createGrant,
    deleteGrant,
    getDefaults,
    upsertDefaults,
  };
}
