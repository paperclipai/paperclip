import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  addOrgMemberSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import { forbidden, notFound } from "../errors.js";
import { logActivity } from "../services/index.js";
import { organizationService } from "../services/organizations.js";

export function organizationRoutes(db: Db) {
  const router = Router();
  const svc = organizationService(db);

  /** Helper: assert the current board user is the org owner. */
  async function assertOrgOwner(req: Express.Request & { actor: any }, orgId: string) {
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

      await logActivity(db, {
        companyId: org.id, // use org id as entity context
        actorType: "user",
        actorId: userId,
        action: "organization.created",
        entityType: "organization",
        entityId: org.id,
        details: { name: org.name },
      });

      res.status(201).json(org);
    },
  );

  // ── List user's organizations ────────────────────────────────────────
  router.get("/organizations", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) throw forbidden("User identity required");

    const orgs = await svc.listForUser(userId);
    res.json(orgs);
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

      await logActivity(db, {
        companyId: orgId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "organization.updated",
        entityType: "organization",
        entityId: orgId,
        details: { name: updated.name },
      });

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

      const membership = await svc.addMember(orgId, req.body.userId, req.body.role);

      await logActivity(db, {
        companyId: orgId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "organization.member_added",
        entityType: "org_membership",
        entityId: membership.id,
        details: { userId: req.body.userId, role: req.body.role },
      });

      res.status(201).json(membership);
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

    await logActivity(db, {
      companyId: orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "organization.member_removed",
      entityType: "org_membership",
      entityId: removed.id,
      details: { userId: targetUserId },
    });

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

    const updated = await svc.assignCompany(orgId, companyId);
    if (!updated) {
      res.status(404).json({ error: "Company not found" });
      return;
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

    res.json(updated);
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
