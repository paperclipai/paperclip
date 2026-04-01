import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createAgentTemplateSchema,
  updateAgentTemplateSchema,
  instantiateAgentTemplateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import { forbidden, notFound } from "../errors.js";
import { logActivity } from "../services/index.js";
import { agentTemplateService } from "../services/agent-templates.js";
import { organizationService } from "../services/organizations.js";

export function agentTemplateRoutes(db: Db) {
  const router = Router();
  const svc = agentTemplateService(db);
  const orgSvc = organizationService(db);

  /** Assert the current board user is a member of the organization. */
  async function assertOrgMember(req: Request, orgId: string) {
    assertBoard(req);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (!userId) throw forbidden("User identity required");
    const isMember = await orgSvc.isMember(orgId, userId);
    if (!isMember) throw forbidden("Not a member of this organization");
  }

  /** Assert the current board user is the org owner (for write operations). */
  async function assertOrgOwner(req: Request, orgId: string) {
    assertBoard(req);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (!userId) throw forbidden("User identity required");
    const isOwner = await orgSvc.isOwner(orgId, userId);
    if (!isOwner) throw forbidden("Only the organization owner can manage templates");
  }

  // ── List templates for an organization ──────────────────────────────
  router.get("/organizations/:orgId/templates", async (req, res) => {
    const orgId = req.params.orgId as string;
    const org = await orgSvc.getById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await assertOrgMember(req, orgId);

    const templates = await svc.list(orgId);
    res.json(templates);
  });

  // ── Create a template ───────────────────────────────────────────────
  router.post(
    "/organizations/:orgId/templates",
    validate(createAgentTemplateSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const org = await orgSvc.getById(orgId);
      if (!org) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }
      await assertOrgOwner(req, orgId);

      const template = await svc.create(orgId, req.body);

      await logActivity(db, {
        companyId: orgId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "agent_template.created",
        entityType: "agent_template",
        entityId: template.id,
        details: { name: template.name },
      });

      res.status(201).json(template);
    },
  );

  // ── Get a template ──────────────────────────────────────────────────
  router.get("/organizations/:orgId/templates/:id", async (req, res) => {
    const orgId = req.params.orgId as string;
    const org = await orgSvc.getById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await assertOrgMember(req, orgId);

    const template = await svc.getById(req.params.id as string);
    if (!template || template.organizationId !== orgId) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    res.json(template);
  });

  // ── Update a template ───────────────────────────────────────────────
  router.patch(
    "/organizations/:orgId/templates/:id",
    validate(updateAgentTemplateSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const org = await orgSvc.getById(orgId);
      if (!org) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }
      await assertOrgOwner(req, orgId);

      const existing = await svc.getById(req.params.id as string);
      if (!existing || existing.organizationId !== orgId) {
        res.status(404).json({ error: "Template not found" });
        return;
      }

      const updated = await svc.update(req.params.id as string, req.body);
      if (!updated) {
        res.status(404).json({ error: "Template not found" });
        return;
      }

      await logActivity(db, {
        companyId: orgId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "agent_template.updated",
        entityType: "agent_template",
        entityId: updated.id,
        details: { name: updated.name },
      });

      res.json(updated);
    },
  );

  // ── Delete a template ───────────────────────────────────────────────
  router.delete("/organizations/:orgId/templates/:id", async (req, res) => {
    const orgId = req.params.orgId as string;
    const org = await orgSvc.getById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await assertOrgOwner(req, orgId);

    const existing = await svc.getById(req.params.id as string);
    if (!existing || existing.organizationId !== orgId) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const deleted = await svc.remove(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    await logActivity(db, {
      companyId: orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent_template.deleted",
      entityType: "agent_template",
      entityId: existing.id,
      details: { name: existing.name },
    });

    res.json({ ok: true });
  });

  // ── Instantiate: create an agent from a template ────────────────────
  router.post(
    "/organizations/:orgId/templates/:id/instantiate",
    validate(instantiateAgentTemplateSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const org = await orgSvc.getById(orgId);
      if (!org) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }
      await assertOrgOwner(req, orgId);

      const existing = await svc.getById(req.params.id as string);
      if (!existing || existing.organizationId !== orgId) {
        res.status(404).json({ error: "Template not found" });
        return;
      }

      const agent = await svc.instantiate(req.params.id as string, req.body.companyId, {
        name: req.body.name,
        credentialId: req.body.credentialId,
      });

      await logActivity(db, {
        companyId: req.body.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "agent_template.instantiated",
        entityType: "agent",
        entityId: agent.id,
        details: { templateId: req.params.id, templateName: existing.name },
      });

      res.status(201).json(agent);
    },
  );

  // ── List instances of a template ────────────────────────────────────
  router.get("/organizations/:orgId/templates/:id/instances", async (req, res) => {
    const orgId = req.params.orgId as string;
    const org = await orgSvc.getById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await assertOrgMember(req, orgId);

    const existing = await svc.getById(req.params.id as string);
    if (!existing || existing.organizationId !== orgId) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const instances = await svc.listInstances(req.params.id as string);
    res.json(instances);
  });

  return router;
}
