import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createJiraIntegrationSchema,
  updateJiraIntegrationSchema,
  jiraImportSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, jiraIntegrationService } from "../services/index.js";
import { getStorageService } from "../storage/index.js";

export function jiraIntegrationRoutes(db: Db) {
  const router = Router();
  const svc = jiraIntegrationService(db);

  // List Jira integrations for a company
  router.get("/companies/:companyId/jira-integrations", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const integrations = await svc.list(companyId);
    res.json(integrations);
  });

  // Create Jira integration
  router.post("/companies/:companyId/jira-integrations", validate(createJiraIntegrationSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const created = await svc.create(companyId, req.body);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "jira_integration.created",
      entityType: "jira_integration",
      entityId: created.id,
      details: { name: created.name },
    });

    res.status(201).json(created);
  });

  // Get single Jira integration
  router.get("/jira-integrations/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const integration = await svc.getById(id);
    if (!integration) {
      res.status(404).json({ error: "Jira integration not found" });
      return;
    }
    assertCompanyAccess(req, integration.companyId);
    res.json(integration);
  });

  // Update Jira integration
  router.patch("/jira-integrations/:id", validate(updateJiraIntegrationSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Jira integration not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const updated = await svc.update(id, req.body);
    if (!updated) {
      res.status(404).json({ error: "Jira integration not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "jira_integration.updated",
      entityType: "jira_integration",
      entityId: updated.id,
      details: { name: updated.name },
    });

    res.json(updated);
  });

  // Delete Jira integration
  router.delete("/jira-integrations/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Jira integration not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Jira integration not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "jira_integration.deleted",
      entityType: "jira_integration",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  // Test connection
  router.post("/jira-integrations/:id/test", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Jira integration not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    try {
      const result = await svc.testConnection(id);
      res.json({ ok: true, user: result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "Connection failed" });
    }
  });

  // List projects
  router.get("/jira-integrations/:id/projects", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Jira integration not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const projects = await svc.listProjects(id);
    res.json(projects);
  });

  // Get project statuses
  router.get("/jira-integrations/:id/projects/:projectKey/statuses", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Jira integration not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const statuses = await svc.getProjectStatuses(id, req.params.projectKey as string);
    res.json(statuses);
  });

  // Get assignable users
  router.get("/jira-integrations/:id/projects/:projectKey/assignees", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Jira integration not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const users = await svc.getAssignableUsers(id, req.params.projectKey as string);
    res.json(users);
  });

  // Preview issues
  router.post("/jira-integrations/:id/preview", validate(jiraImportSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Jira integration not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    try {
      const issues = await svc.previewIssues(id, req.body);
      res.json(issues);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to search Jira issues",
      });
    }
  });

  // Import issues
  router.post("/jira-integrations/:id/import", validate(jiraImportSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Jira integration not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const result = await svc.importIssues(existing.companyId, req.body, {
      userId: req.actor.userId,
    }, getStorageService());

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "jira_integration.imported",
      entityType: "jira_integration",
      entityId: id,
      details: { imported: result.imported, skipped: result.skipped, errors: result.errors.length },
    });

    res.json(result);
  });

  return router;
}
