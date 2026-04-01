import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { organizations, orgMemberships, companies } from "@paperclipai/db";

export function organizationService(db: Db) {
  return {
    /** Create an organization and auto-add the creator as owner member. */
    async create(data: { name: string; ownerUserId: string }) {
      const [org] = await db
        .insert(organizations)
        .values({
          name: data.name,
          ownerUserId: data.ownerUserId,
        })
        .returning();

      // Auto-add creator as owner member
      await db.insert(orgMemberships).values({
        organizationId: org.id,
        userId: data.ownerUserId,
        role: "owner",
      });

      return org;
    },

    /** Get organization by ID. */
    async getById(id: string) {
      const [row] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, id))
        .limit(1);
      return row ?? null;
    },

    /** List organizations the user belongs to (via org_memberships). */
    async listForUser(userId: string) {
      const rows = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          ownerUserId: organizations.ownerUserId,
          settings: organizations.settings,
          role: orgMemberships.role,
          createdAt: organizations.createdAt,
          updatedAt: organizations.updatedAt,
        })
        .from(orgMemberships)
        .innerJoin(organizations, eq(orgMemberships.organizationId, organizations.id))
        .where(eq(orgMemberships.userId, userId))
        .orderBy(organizations.name);
      return rows;
    },

    /** Update organization name and/or settings. */
    async update(id: string, data: { name?: string; settings?: Record<string, unknown> }) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) updates.name = data.name;
      if (data.settings !== undefined) updates.settings = data.settings;

      const [updated] = await db
        .update(organizations)
        .set(updates)
        .where(eq(organizations.id, id))
        .returning();

      return updated ?? null;
    },

    /** Add a member to the organization. */
    async addMember(orgId: string, userId: string, role: string) {
      const [membership] = await db
        .insert(orgMemberships)
        .values({
          organizationId: orgId,
          userId,
          role,
        })
        .returning();
      return membership;
    },

    /** Remove a member from the organization. */
    async removeMember(orgId: string, userId: string) {
      const [removed] = await db
        .delete(orgMemberships)
        .where(
          and(
            eq(orgMemberships.organizationId, orgId),
            eq(orgMemberships.userId, userId),
          ),
        )
        .returning();
      return removed ?? null;
    },

    /** List all members of an organization. */
    async listMembers(orgId: string) {
      const rows = await db
        .select({
          id: orgMemberships.id,
          organizationId: orgMemberships.organizationId,
          userId: orgMemberships.userId,
          role: orgMemberships.role,
          createdAt: orgMemberships.createdAt,
          updatedAt: orgMemberships.updatedAt,
        })
        .from(orgMemberships)
        .where(eq(orgMemberships.organizationId, orgId))
        .orderBy(orgMemberships.createdAt);
      return rows;
    },

    /** Check if a user is the owner of an organization. */
    async isOwner(orgId: string, userId: string) {
      const org = await this.getById(orgId);
      return org?.ownerUserId === userId;
    },

    /** Check if a user is a member of an organization. */
    async isMember(orgId: string, userId: string) {
      const [row] = await db
        .select({ id: orgMemberships.id })
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.organizationId, orgId),
            eq(orgMemberships.userId, userId),
          ),
        )
        .limit(1);
      return !!row;
    },

    /** Assign a company to an organization. */
    async assignCompany(orgId: string, companyId: string) {
      const [updated] = await db
        .update(companies)
        .set({ organizationId: orgId, updatedAt: new Date() })
        .where(eq(companies.id, companyId))
        .returning();
      return updated ?? null;
    },

    /** Remove a company from its organization (set organization_id to null). */
    async unassignCompany(companyId: string) {
      const [updated] = await db
        .update(companies)
        .set({ organizationId: null, updatedAt: new Date() })
        .where(eq(companies.id, companyId))
        .returning();
      return updated ?? null;
    },

    /** List companies belonging to an organization. */
    async listCompanies(orgId: string) {
      const rows = await db
        .select({
          id: companies.id,
          name: companies.name,
          description: companies.description,
          status: companies.status,
          organizationId: companies.organizationId,
          createdAt: companies.createdAt,
          updatedAt: companies.updatedAt,
        })
        .from(companies)
        .where(eq(companies.organizationId, orgId))
        .orderBy(companies.name);
      return rows;
    },
  };
}
