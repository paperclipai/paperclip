import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { deliverableService, logActivity } from "../services/index.js";
import { companyVaultService } from "../services/company-vault.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";

const updateDeliverableSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(["draft", "in_review", "changes_requested", "approved", "rejected"]).optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  type: z.enum(["code", "document", "deployment", "mixed"]).optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  issueId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
}).strict();

export function deliverableRoutes(db: Db) {
  const router = Router();
  const svc = deliverableService(db);
  const vault = companyVaultService(db);

  // ── List deliverables ──────────────────────────────────────────────
  router.get("/companies/:companyId/deliverables", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const filters = {
      status: (req.query.status as string) || undefined,
      projectId: (req.query.projectId as string) || undefined,
      issueId: (req.query.issueId as string) || undefined,
      submittedByAgentId: (req.query.submittedByAgentId as string) || undefined,
    };
    const result = await svc.list(companyId, filters);
    res.json(result);
  });

  // ── Create deliverable ─────────────────────────────────────────────
  router.post("/companies/:companyId/deliverables", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const { title, description, type, priority, projectId, issueId, dueAt, templateId, stages } = req.body;
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    const deliverable = await svc.create(companyId, {
      title,
      description: description ?? null,
      type: type ?? "mixed",
      priority: priority ?? "medium",
      projectId: projectId ?? null,
      issueId: issueId ?? null,
      dueAt: dueAt ?? null,
      templateId: templateId ?? null,
      submittedByAgentId: actor.agentId ?? null,
      submittedByUserId: actor.actorType === "user" ? actor.actorId : null,
      stages: stages ?? undefined,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "deliverable.created",
      entityType: "deliverable",
      entityId: deliverable.id,
      details: { title: deliverable.title, type: deliverable.type },
    });

    res.status(201).json(deliverable);
  });

  // ── Get deliverable detail ─────────────────────────────────────────
  router.get("/deliverables/:id", async (req, res) => {
    const id = req.params.id as string;
    const deliverable = await svc.getById(id);
    if (!deliverable) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, deliverable.companyId);
    res.json(deliverable);
  });

  // ── Update deliverable ─────────────────────────────────────────────
  router.patch("/deliverables/:id", validate(updateDeliverableSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const deliverable = await svc.update(id, req.body);
    res.json(deliverable);
  });

  // ── Delete deliverable ─────────────────────────────────────────────
  router.delete("/deliverables/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    const deliverable = await svc.remove(id);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "deliverable.deleted",
      entityType: "deliverable",
      entityId: id,
    });
    res.json(deliverable);
  });

  // ── Submit for review ──────────────────────────────────────────────
  router.post("/deliverables/:id/submit", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    try {
      const deliverable = await svc.submit(id);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "deliverable.submitted",
        entityType: "deliverable",
        entityId: id,
        details: { resultStatus: deliverable?.status },
      });
      res.json(deliverable);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Submit failed";
      res.status(400).json({ error: message });
    }
  });

  // ── Approve stage ──────────────────────────────────────────────────
  router.post("/deliverables/:id/stages/:stageId/approve", async (req, res) => {
    const id = req.params.id as string;
    const stageId = req.params.stageId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    try {
      const deliverable = await svc.approveStage(id, stageId, req.body.decisionNote ?? null);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "deliverable.stage_approved",
        entityType: "deliverable",
        entityId: id,
        details: { stageId, resultStatus: deliverable?.status },
      });
      res.json(deliverable);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Approve failed";
      res.status(400).json({ error: message });
    }
  });

  // ── Request changes ────────────────────────────────────────────────
  router.post("/deliverables/:id/stages/:stageId/request-changes", async (req, res) => {
    const id = req.params.id as string;
    const stageId = req.params.stageId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    try {
      const deliverable = await svc.requestChanges(id, stageId, req.body.decisionNote ?? null);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "deliverable.changes_requested",
        entityType: "deliverable",
        entityId: id,
        details: { stageId },
      });

      // Auto-wake agent
      if (existing.submittedByAgentId) {
        try {
          const { heartbeatService } = await import("../services/index.js");
          const hb = heartbeatService(db);
          await hb.wakeup(existing.submittedByAgentId, {
            source: "automation",
            reason: "deliverable_changes_requested",
            payload: {
              deliverableId: existing.id,
              deliverableTitle: existing.title,
              stageLabel: existing.stages?.find((s: { id: string; label?: string }) => s.id === stageId)?.label ?? "Review",
              reviewerNote: req.body.decisionNote ?? "",
              issueId: existing.issueId,
            },
          });
        } catch {
          // Log but don't fail
        }
      }

      res.json(deliverable);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Request changes failed";
      res.status(400).json({ error: message });
    }
  });

  // ── Reject stage ───────────────────────────────────────────────────
  router.post("/deliverables/:id/stages/:stageId/reject", async (req, res) => {
    const id = req.params.id as string;
    const stageId = req.params.stageId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    try {
      const deliverable = await svc.rejectStage(id, stageId, req.body.decisionNote ?? null);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "deliverable.rejected",
        entityType: "deliverable",
        entityId: id,
        details: { stageId },
      });
      res.json(deliverable);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Reject failed";
      res.status(400).json({ error: message });
    }
  });

  // ── Skip stage (CEO override) ─────────────────────────────────────
  router.post("/deliverables/:id/stages/:stageId/skip", async (req, res) => {
    const id = req.params.id as string;
    const stageId = req.params.stageId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    try {
      const deliverable = await svc.skipStage(id, stageId);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "deliverable.stage_skipped",
        entityType: "deliverable",
        entityId: id,
        details: { stageId },
      });
      res.json(deliverable);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Skip failed";
      res.status(400).json({ error: message });
    }
  });

  // ── Reassign ───────────────────────────────────────────────────────
  router.post("/deliverables/:id/reassign", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    const deliverable = await svc.reassign(id, req.body.agentId);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "deliverable.reassigned",
      entityType: "deliverable",
      entityId: id,
      details: { newAgentId: req.body.agentId },
    });
    res.json(deliverable);
  });

  // ── Reopen ─────────────────────────────────────────────────────────
  router.post("/deliverables/:id/reopen", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    try {
      const deliverable = await svc.reopen(id);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "deliverable.reopened",
        entityType: "deliverable",
        entityId: id,
      });
      res.json(deliverable);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Reopen failed";
      res.status(400).json({ error: message });
    }
  });

  // ── Content management ─────────────────────────────────────────────
  router.post("/deliverables/:id/contents", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const content = await svc.addContent(id, req.body);
    res.status(201).json(content);
  });

  router.patch("/deliverables/:id/contents/:contentId", async (req, res) => {
    const id = req.params.id as string;
    const contentId = req.params.contentId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const content = await svc.updateContent(contentId, req.body);
    res.json(content);
  });

  router.delete("/deliverables/:id/contents/:contentId", async (req, res) => {
    const id = req.params.id as string;
    const contentId = req.params.contentId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    await svc.removeContent(contentId);
    res.json({ ok: true });
  });

  // ── Stage management ───────────────────────────────────────────────
  router.post("/deliverables/:id/stages", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const stage = await svc.addStage(id, req.body);
    res.status(201).json(stage);
  });

  router.patch("/deliverables/:id/stages/:stageId", async (req, res) => {
    const id = req.params.id as string;
    const stageId = req.params.stageId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const stage = await svc.updateStage(stageId, req.body);
    res.json(stage);
  });

  router.delete("/deliverables/:id/stages/:stageId", async (req, res) => {
    const id = req.params.id as string;
    const stageId = req.params.stageId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    await svc.removeStage(stageId);
    res.json({ ok: true });
  });

  // ── Comments ───────────────────────────────────────────────────────
  router.get("/deliverables/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/deliverables/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    // Auto-detect and vault any secrets in the comment
    let commentBody = req.body.body as string;
    try {
      const vaultResult = await vault.processComment(
        existing.companyId,
        `deliverable-${id}`,
        id,
        commentBody,
        actor.actorType === "user" ? actor.actorId : actor.agentId ?? undefined,
      );
      commentBody = vaultResult.redactedBody;
    } catch (_) { /* vault failure should not block comment */ }

    const comment = await svc.addComment(id, commentBody, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "deliverable.comment_added",
      entityType: "deliverable",
      entityId: id,
    });

    res.status(201).json(comment);
  });

  return router;
}
