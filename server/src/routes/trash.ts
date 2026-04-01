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

    const result: Record<string, unknown[]> = {};

    if (!entityType || entityType === "issue") {
      result.issues = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), isNotNull(issues.hiddenAt)));
    }

    if (!entityType || entityType === "agent") {
      result.agents = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), isNotNull(agents.deletedAt)));
    }

    if (!entityType || entityType === "project") {
      result.projects = await db
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, companyId), isNotNull(projects.deletedAt)));
    }

    if (!entityType || entityType === "goal") {
      result.goals = await db
        .select()
        .from(goals)
        .where(and(eq(goals.companyId, companyId), isNotNull(goals.deletedAt)));
    }

    res.json(result);
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
    let restored: unknown = null;
    let companyId: string | null = null;

    switch (entityType) {
      case "issue": {
        const issue = await issueSvc.restore(entityId);
        if (!issue) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        companyId = issue.companyId;
        restored = issue;
        break;
      }
      case "agent": {
        const agent = await agentSvc.restore(entityId);
        if (!agent) {
          res.status(404).json({ error: "Agent not found" });
          return;
        }
        companyId = agent.companyId;
        restored = agent;
        break;
      }
      case "project": {
        const project = await projectSvc.restore(entityId);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        companyId = project.companyId;
        restored = project;
        break;
      }
      case "goal": {
        const goal = await goalSvc.restore(entityId);
        if (!goal) {
          res.status(404).json({ error: "Goal not found" });
          return;
        }
        companyId = goal.companyId;
        restored = goal;
        break;
      }
    }

    if (companyId) {
      assertCompanyAccess(req, companyId);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: `${entityType}.restored`,
        entityType,
        entityId,
      });
    }

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

    switch (entityType) {
      case "issue": {
        const attachments = await issueSvc.listAttachments(entityId);
        const issue = await issueSvc.remove(entityId);
        if (!issue) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        companyId = issue.companyId;
        for (const attachment of attachments) {
          try {
            await storage.deleteObject(attachment.companyId, attachment.objectKey);
          } catch (err) {
            logger.warn({ err, issueId: entityId, attachmentId: attachment.id }, "failed to delete attachment during trash purge");
          }
        }
        break;
      }
      case "agent": {
        const agent = await agentSvc.remove(entityId);
        if (!agent) {
          res.status(404).json({ error: "Agent not found" });
          return;
        }
        companyId = agent.companyId;
        break;
      }
      case "project": {
        const project = await projectSvc.remove(entityId);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        companyId = project.companyId;
        break;
      }
      case "goal": {
        const goal = await goalSvc.remove(entityId);
        if (!goal) {
          res.status(404).json({ error: "Goal not found" });
          return;
        }
        companyId = goal.companyId;
        break;
      }
    }

    if (companyId) {
      assertCompanyAccess(req, companyId);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: `${entityType}.permanently_deleted`,
        entityType,
        entityId,
      });
    }

    res.json({ ok: true });
  });

  return router;
}
