import type { Request } from "express";
import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { organizations, orgMemberships, companies, authUsers } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import { badRequest, forbidden } from "../errors.js";
import { logActivity } from "../services/index.js";

// ── Inline validators (shared package lacks these in merge-upstream) ───
const createOrganizationSchema = z.object({
  name: z.string().min(1).max(200),
});

const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  settings: z.record(z.unknown()).optional(),
});

const addOrgMemberSchema = z
  .object({
    userId: z.string().min(1).optional(),
    email: z.string().email().optional(),
    role: z.enum(["owner", "admin", "member"]).optional().default("member"),
  })
  .refine((data) => !!data.userId || !!data.email, {
    message: "Provide either userId or email",
  });

const updateOrgMemberSchema = z.object({
  role: z.enum(["owner", "admin", "member"]),
});

export function organizationRoutes(db: Db) {
  const router = Router();

  // ── Inline service helpers (organizationService not present in merge-upstream) ─
  const svc = {
    async create(data: { name: string; ownerUserId: string }) {
      const [org] = await db
        .insert(organizations)
        .values({
          name: data.name,
          ownerUserId: data.ownerUserId,
        })
        .returning();

      await db.insert(orgMemberships).values({
        organizationId: org.id,
        userId: data.ownerUserId,
        role: "owner",
      });

      return org;
    },

    async getById(id: string) {
      const [row] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, id))
        .limit(1);
      return row ?? null;
    },

    async listForUser(userId: string, opts: { includeArchived?: boolean } = {}) {
      const whereClauses = opts.includeArchived
        ? eq(orgMemberships.userId, userId)
        : and(eq(orgMemberships.userId, userId), isNull(organizations.archivedAt));
      const rows = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          ownerUserId: organizations.ownerUserId,
          settings: organizations.settings,
          role: orgMemberships.role,
          archivedAt: organizations.archivedAt,
          createdAt: organizations.createdAt,
          updatedAt: organizations.updatedAt,
        })
        .from(orgMemberships)
        .innerJoin(organizations, eq(orgMemberships.organizationId, organizations.id))
        .where(whereClauses)
        .orderBy(organizations.name);
      return rows;
    },

    async setArchived(id: string, archived: boolean) {
      const [updated] = await db
        .update(organizations)
        .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
        .where(eq(organizations.id, id))
        .returning();
      return updated ?? null;
    },

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

    async addMember(orgId: string, userId: string, role: string) {
      const [membership] = await db
        .insert(orgMemberships)
        .values({
          organizationId: orgId,
          userId,
          role,
        })
        .returning();
      if (!membership) return null;
      const [user] = await db
        .select({ name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.id, membership.userId))
        .limit(1);
      return {
        ...membership,
        displayName: user?.name ?? null,
        email: user?.email ?? null,
      };
    },

    async updateMemberRole(orgId: string, userId: string, role: string) {
      const [updated] = await db
        .update(orgMemberships)
        .set({ role, updatedAt: new Date() })
        .where(
          and(
            eq(orgMemberships.organizationId, orgId),
            eq(orgMemberships.userId, userId),
          ),
        )
        .returning();
      if (!updated) return null;
      const [user] = await db
        .select({ name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.id, updated.userId))
        .limit(1);
      return {
        ...updated,
        displayName: user?.name ?? null,
        email: user?.email ?? null,
      };
    },

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

    async listMembers(orgId: string) {
      const rows = await db
        .select({
          id: orgMemberships.id,
          organizationId: orgMemberships.organizationId,
          userId: orgMemberships.userId,
          role: orgMemberships.role,
          displayName: authUsers.name,
          email: authUsers.email,
          createdAt: orgMemberships.createdAt,
          updatedAt: orgMemberships.updatedAt,
        })
        .from(orgMemberships)
        .leftJoin(authUsers, eq(authUsers.id, orgMemberships.userId))
        .where(eq(orgMemberships.organizationId, orgId))
        .orderBy(orgMemberships.createdAt);
      return rows;
    },

    async isOwner(orgId: string, userId: string) {
      const org = await this.getById(orgId);
      return org?.ownerUserId === userId;
    },

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

    async assignCompany(orgId: string, companyId: string) {
      const [existing] = await db
        .select({ id: companies.id, organizationId: companies.organizationId })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!existing) return { status: "not_found" as const };
      if (existing.organizationId && existing.organizationId !== orgId) {
        return { status: "already_assigned" as const, organizationId: existing.organizationId };
      }
      const [updated] = await db
        .update(companies)
        .set({ organizationId: orgId, updatedAt: new Date() })
        .where(eq(companies.id, companyId))
        .returning();
      return { status: "ok" as const, company: updated ?? null };
    },

    async unassignCompany(companyId: string) {
      const [updated] = await db
        .update(companies)
        .set({ organizationId: null, updatedAt: new Date() })
        .where(eq(companies.id, companyId))
        .returning();
      return updated ?? null;
    },

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

  /** Helper: assert the current board user is the org owner. */
  async function assertOrgOwner(req: Request, orgId: string) {
    const userId = req.actor.userId;
    if (!userId) throw forbidden("User identity required");
    const isOwner = await svc.isOwner(orgId, userId);
    if (!isOwner) throw forbidden("Only the organization owner can perform this action");
  }

  // ── Create organization ──────────────────────────────────────────────
  router.post(
    "/organizations",
    validate(createOrganizationSchema),
    async (req, res) => {
      assertBoard(req);
      const userId = req.actor.userId;
      if (!userId) throw forbidden("User identity required");

      const org = await svc.create({
        name: req.body.name,
        ownerUserId: userId,
      });

      res.status(201).json(org);
    },
  );

  // ── List user's organizations ────────────────────────────────────────
  router.get("/organizations", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) throw forbidden("User identity required");

    const includeArchived = req.query.includeArchived === "true";
    const orgs = await svc.listForUser(userId, { includeArchived });
    res.json(orgs);
  });

  // ── Archive organization ─────────────────────────────────────────────
  router.post("/organizations/:id/archive", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.id as string;
    const org = await svc.getById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await assertOrgOwner(req, orgId);
    const updated = await svc.setArchived(orgId, true);
    res.json(updated);
  });

  // ── Unarchive organization ───────────────────────────────────────────
  router.post("/organizations/:id/unarchive", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.id as string;
    const org = await svc.getById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await assertOrgOwner(req, orgId);
    const updated = await svc.setArchived(orgId, false);
    res.json(updated);
  });

  // ── Get organization details ─────────────────────────────────────────
  router.get("/organizations/:id", async (req, res) => {
    assertBoard(req);
    const org = await svc.getById(req.params.id as string);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    // Any member can view
    const userId = req.actor.userId;
    if (userId) {
      const isMember = await svc.isMember(org.id, userId);
      if (!isMember && !req.actor.isInstanceAdmin && req.actor.source !== "local_implicit") {
        throw forbidden("Not a member of this organization");
      }
    }

    res.json(org);
  });

  // ── Update organization ──────────────────────────────────────────────
  router.patch(
    "/organizations/:id",
    validate(updateOrganizationSchema),
    async (req, res) => {
      assertBoard(req);
      const orgId = req.params.id as string;
      const org = await svc.getById(orgId);
      if (!org) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }

      await assertOrgOwner(req, orgId);

      const updated = await svc.update(orgId, {
        name: req.body.name,
        settings: req.body.settings,
      });

      if (!updated) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }

      res.json(updated);
    },
  );

  // ── Add member to organization ───────────────────────────────────────
  router.post(
    "/organizations/:id/members",
    validate(addOrgMemberSchema),
    async (req, res) => {
      assertBoard(req);
      const orgId = req.params.id as string;
      const org = await svc.getById(orgId);
      if (!org) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }

      await assertOrgOwner(req, orgId);

      let resolvedUserId = req.body.userId as string | undefined;
      if (!resolvedUserId && req.body.email) {
        const needle = (req.body.email as string).trim().toLowerCase();
        const [user] = await db
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(eq(authUsers.email, needle))
          .limit(1);
        if (!user) throw badRequest(`No user found with email ${req.body.email}`);
        resolvedUserId = user.id;
      }
      if (!resolvedUserId) throw badRequest("Provide either userId or email");

      const membership = await svc.addMember(orgId, resolvedUserId, req.body.role);

      res.status(201).json(membership);
    },
  );

  // ── Update organization member role ──────────────────────────────────
  router.patch(
    "/organizations/:id/members/:userId",
    validate(updateOrgMemberSchema),
    async (req, res) => {
      assertBoard(req);
      const orgId = req.params.id as string;
      const org = await svc.getById(orgId);
      if (!org) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }

      await assertOrgOwner(req, orgId);

      const targetUserId = req.params.userId as string;
      const nextRole = req.body.role as "owner" | "admin" | "member";

      // The org's designated owner always stays at role "owner" — they're the
      // root of trust for this org.
      if (targetUserId === org.ownerUserId && nextRole !== "owner") {
        throw forbidden("Cannot change the organization owner's role");
      }

      const updated = await svc.updateMemberRole(orgId, targetUserId, nextRole);
      if (!updated) {
        res.status(404).json({ error: "Membership not found" });
        return;
      }
      res.json(updated);
    },
  );

  // ── Remove member from organization ──────────────────────────────────
  router.delete("/organizations/:id/members/:userId", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.id as string;
    const org = await svc.getById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    await assertOrgOwner(req, orgId);

    const targetUserId = req.params.userId as string;

    // Prevent owner from removing themselves
    if (targetUserId === org.ownerUserId) {
      throw forbidden("Cannot remove the organization owner");
    }

    const removed = await svc.removeMember(orgId, targetUserId);
    if (!removed) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }

    res.json({ ok: true });
  });

  // ── List organization members ────────────────────────────────────────
  router.get("/organizations/:id/members", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.id as string;
    const org = await svc.getById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    // Any member (or admin) can list members
    const userId = req.actor.userId;
    if (userId) {
      const isMember = await svc.isMember(orgId, userId);
      if (!isMember && !req.actor.isInstanceAdmin && req.actor.source !== "local_implicit") {
        throw forbidden("Not a member of this organization");
      }
    }

    const members = await svc.listMembers(orgId);
    res.json(members);
  });

  // ── Assign company to organization ───────────────────────────────────
  router.post("/organizations/:id/companies/:companyId", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.id as string;
    const companyId = req.params.companyId as string;

    const org = await svc.getById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    await assertOrgOwner(req, orgId);

    const result = await svc.assignCompany(orgId, companyId);
    if (result.status === "not_found") {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    if (result.status === "already_assigned") {
      throw badRequest(
        "Company already belongs to another organization. Detach it first before attaching.",
      );
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "organization.company_assigned",
      entityType: "company",
      entityId: companyId,
      details: { organizationId: orgId },
    });

    res.json(result.company);
  });

  // ── Unassign company from organization ───────────────────────────────
  router.delete("/organizations/:id/companies/:companyId", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.id as string;
    const companyId = req.params.companyId as string;

    const org = await svc.getById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    await assertOrgOwner(req, orgId);

    const updated = await svc.unassignCompany(companyId);
    if (!updated) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "organization.company_unassigned",
      entityType: "company",
      entityId: companyId,
      details: { organizationId: orgId },
    });

    res.json({ ok: true });
  });

  // ── List companies in organization ───────────────────────────────────
  router.get("/organizations/:id/companies", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.id as string;
    const org = await svc.getById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    // Any member (or admin) can list companies
    const userId = req.actor.userId;
    if (userId) {
      const isMember = await svc.isMember(orgId, userId);
      if (!isMember && !req.actor.isInstanceAdmin && req.actor.source !== "local_implicit") {
        throw forbidden("Not a member of this organization");
      }
    }

    const orgCompanies = await svc.listCompanies(orgId);
    res.json(orgCompanies);
  });

  return router;
}
