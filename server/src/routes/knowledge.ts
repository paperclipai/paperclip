import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  attachIssueKnowledgeItemSchema,
  createKnowledgeItemSchema,
  updateKnowledgeItemSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";
import { agentService, knowledgeService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function knowledgeRoutes(db: Db) {
  const router = Router();
  const svc = knowledgeService(db);
  const agentsSvc = agentService(db);

  async function assertCanDeleteKnowledgeItem(req: Request, knowledgeItem: {
    companyId: string;
    createdByAgentId: string | null;
  }) {
    assertCompanyAccess(req, knowledgeItem.companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) {
      throw forbidden("Only the creator, CEO, or board can delete this knowledge item");
    }
    if (knowledgeItem.createdByAgentId && knowledgeItem.createdByAgentId === req.actor.agentId) return;

    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (actorAgent && actorAgent.companyId === knowledgeItem.companyId && actorAgent.role === "ceo") return;

    throw forbidden("Only the creator, CEO, or board can delete this knowledge item");
  }

  router.get("/companies/:companyId/knowledge-items", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const items = await svc.list(companyId);
    res.json(items);
  });

  router.post("/companies/:companyId/knowledge-items", validate(createKnowledgeItemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const item = await svc.create(companyId, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    if (!item) {
      res.status(500).json({ error: "Knowledge item could not be created" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "knowledge_item.created",
      entityType: "knowledge_item",
      entityId: item.id,
      details: {
        title: item.title,
        kind: item.kind,
      },
    });

    res.status(201).json(item);
  });

  router.get("/knowledge-items/:id", async (req, res) => {
    const knowledgeItemId = req.params.id as string;
    const item = await svc.getById(knowledgeItemId);
    if (!item) {
      res.status(404).json({ error: "Knowledge item not found" });
      return;
    }

    assertCompanyAccess(req, item.companyId);
    res.json(item);
  });

  router.patch("/knowledge-items/:id", validate(updateKnowledgeItemSchema), async (req, res) => {
    const knowledgeItemId = req.params.id as string;
    const existing = await svc.getById(knowledgeItemId);
    if (!existing) {
      res.status(404).json({ error: "Knowledge item not found" });
      return;
    }

    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const updated = await svc.update(knowledgeItemId, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!updated) {
      res.status(404).json({ error: "Knowledge item not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "knowledge_item.updated",
      entityType: "knowledge_item",
      entityId: updated.id,
      details: {
        updatedFields: Object.keys(req.body).sort(),
      },
    });

    res.json(updated);
  });

  router.delete("/knowledge-items/:id", async (req, res) => {
    const knowledgeItemId = req.params.id as string;
    const existing = await svc.getById(knowledgeItemId);
    if (!existing) {
      res.status(404).json({ error: "Knowledge item not found" });
      return;
    }

    await assertCanDeleteKnowledgeItem(req, existing);
    const removed = await svc.remove(knowledgeItemId);
    if (!removed) {
      res.status(404).json({ error: "Knowledge item not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "knowledge_item.deleted",
      entityType: "knowledge_item",
      entityId: removed.id,
      details: {
        title: removed.title,
      },
    });

    res.json({ ok: true });
  });

  router.get("/issues/:issueId/knowledge-items", async (req, res) => {
    const issueId = req.params.issueId as string;
    const issue = await svc.getIssueById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    assertCompanyAccess(req, issue.companyId);
    const attachments = await svc.listForIssue(issueId);
    res.json(attachments);
  });

  router.post("/issues/:issueId/knowledge-items", validate(attachIssueKnowledgeItemSchema), async (req, res) => {
    const issueId = req.params.issueId as string;
    const issue = await svc.getIssueById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const attachment = await svc.attachToIssue(issueId, req.body.knowledgeItemId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.knowledge_attached",
      entityType: "issue",
      entityId: issueId,
      details: {
        knowledgeItemId: attachment.knowledgeItemId,
      },
    });

    res.status(201).json(attachment);
  });

  router.delete("/issues/:issueId/knowledge-items/:knowledgeItemId", async (req, res) => {
    const issueId = req.params.issueId as string;
    const knowledgeItemId = req.params.knowledgeItemId as string;
    const issue = await svc.getIssueById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    assertCompanyAccess(req, issue.companyId);
    const removed = await svc.detachFromIssue(issueId, knowledgeItemId);
    if (!removed) {
      res.status(404).json({ error: "Knowledge item attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.knowledge_detached",
      entityType: "issue",
      entityId: issueId,
      details: {
        knowledgeItemId,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
