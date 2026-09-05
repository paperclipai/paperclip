import { Router } from "express";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, agents, projects, goals } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import {
  agentService,
  goalService,
  issueService,
  projectService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { logger } from "../middleware/logger.js";

const VALID_ENTITY_TYPES = ["issue", "agent", "project", "goal"] as const;
type TrashEntityType = (typeof VALID_ENTITY_TYPES)[number];

function isValidEntityType(t: string): t is TrashEntityType {
  return (VALID_ENTITY_TYPES as readonly string[]).includes(t);
}

export function trashRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const issueSvc = issueService(db);
  const agentSvc = agentService(db);
  const projectSvc = projectService(db);
  const goalSvc = goalService(db);

  // List all trashed items for a company
  router.get("/companies/:companyId/trash", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const entityType = typeof req.query.entityType === "string" ? req.query.entityType : undefined;

    const items: { entityType: string; entityId: string; name: string; deletedAt: Date | null }[] = [];

    if (!entityType || entityType === "issue") {
      const rows = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), isNotNull(issues.hiddenAt)));
      for (const row of rows) {
        items.push({ entityType: "issue", entityId: row.id, name: row.title, deletedAt: row.hiddenAt });
      }
    }

    if (!entityType || entityType === "agent") {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), isNotNull(agents.deletedAt)));
      for (const row of rows) {
        items.push({ entityType: "agent", entityId: row.id, name: row.name, deletedAt: row.deletedAt });
      }
    }

    if (!entityType || entityType === "project") {
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, companyId), isNotNull(projects.deletedAt)));
      for (const row of rows) {
        items.push({ entityType: "project", entityId: row.id, name: row.name, deletedAt: row.deletedAt });
      }
    }

    if (!entityType || entityType === "goal") {
      const rows = await db
        .select()
        .from(goals)
        .where(and(eq(goals.companyId, companyId), isNotNull(goals.deletedAt)));
      for (const row of rows) {
        items.push({ entityType: "goal", entityId: row.id, name: row.title, deletedAt: row.deletedAt });
      }
    }

    res.json(items);
  });

  // Restore a trashed item
  router.post("/trash/:entityType/:entityId/restore", async (req, res) => {
    const { entityType, entityId } = req.params;
    assertBoard(req);

    if (!isValidEntityType(entityType)) {
      res.status(400).json({ error: `Invalid entity type: ${entityType}. Valid types: ${VALID_ENTITY_TYPES.join(", ")}` });
      return;
    }

    const actor = getActorInfo(req);
    let companyId: string | null = null;

    // Look up entity first to get companyId, then assert access before mutating
    switch (entityType) {
      case "issue": {
        const existing = await issueSvc.getById(entityId);
        if (!existing) { res.status(404).json({ error: "Issue not found" }); return; }
        companyId = existing.companyId;
        break;
      }
      case "agent": {
        const existing = await agentSvc.getById(entityId);
        if (!existing) { res.status(404).json({ error: "Agent not found" }); return; }
        companyId = existing.companyId;
        break;
      }
      case "project": {
        const existing = await projectSvc.getById(entityId);
        if (!existing) { res.status(404).json({ error: "Project not found" }); return; }
        companyId = existing.companyId;
        break;
      }
      case "goal": {
        const existing = await goalSvc.getById(entityId);
        if (!existing) { res.status(404).json({ error: "Goal not found" }); return; }
        companyId = existing.companyId;
        break;
      }
    }

    assertCompanyAccess(req, companyId!);

    let restored: unknown = null;
    switch (entityType) {
      case "issue": restored = await issueSvc.restore(entityId); break;
      case "agent": restored = await agentSvc.restore(entityId); break;
      case "project": restored = await projectSvc.restore(entityId); break;
      case "goal": restored = await goalSvc.restore(entityId); break;
    }

    await logActivity(db, {
      companyId: companyId!,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: `${entityType}.restored`,
      entityType,
      entityId,
    });

    res.json(restored);
  });

  // Permanently delete a trashed item
  router.delete("/trash/:entityType/:entityId", async (req, res) => {
    const { entityType, entityId } = req.params;
    assertBoard(req);

    if (!isValidEntityType(entityType)) {
      res.status(400).json({ error: `Invalid entity type: ${entityType}. Valid types: ${VALID_ENTITY_TYPES.join(", ")}` });
      return;
    }

    const actor = getActorInfo(req);
    let companyId: string | null = null;

    // Look up entity first to get companyId, then assert access before mutating
    switch (entityType) {
      case "issue": {
        const existing = await issueSvc.getById(entityId);
        if (!existing) { res.status(404).json({ error: "Issue not found" }); return; }
        companyId = existing.companyId;
        break;
      }
      case "agent": {
        const existing = await agentSvc.getById(entityId);
        if (!existing) { res.status(404).json({ error: "Agent not found" }); return; }
        companyId = existing.companyId;
        break;
      }
      case "project": {
        const existing = await projectSvc.getById(entityId);
        if (!existing) { res.status(404).json({ error: "Project not found" }); return; }
        companyId = existing.companyId;
        break;
      }
      case "goal": {
        const existing = await goalSvc.getById(entityId);
        if (!existing) { res.status(404).json({ error: "Goal not found" }); return; }
        companyId = existing.companyId;
        break;
      }
    }

    assertCompanyAccess(req, companyId!);

    switch (entityType) {
      case "issue": {
        const attachments = await issueSvc.listAttachments(entityId);
        await issueSvc.remove(entityId);
        for (const attachment of attachments) {
          try {
            await storage.deleteObject(attachment.companyId, attachment.objectKey);
          } catch (err) {
            logger.warn({ err, issueId: entityId, attachmentId: attachment.id }, "failed to delete attachment during trash purge");
          }
        }
        break;
      }
      case "agent": await agentSvc.remove(entityId); break;
      case "project": await projectSvc.remove(entityId); break;
      case "goal": await goalSvc.remove(entityId); break;
    }

    await logActivity(db, {
      companyId: companyId!,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: `${entityType}.permanently_deleted`,
      entityType,
      entityId,
    });

    res.json({ ok: true });
  });

  return router;
}
