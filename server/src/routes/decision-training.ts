import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { decisionTrainingService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

const sourceKindSchema = z.enum(["interaction", "approval", "execution_decision"]);
const exampleIdSchema = z.string().uuid();
const createSchema = z.object({
  sourceKind: sourceKindSchema,
  sourceId: z.string().uuid(),
  issueId: z.string().uuid(),
  notes: z.string().max(100_000).default(""),
}).strict();
const updateSchema = z.object({ notes: z.string().max(100_000) }).strict();
const previewSchema = z.object({
  sourceKind: sourceKindSchema,
  sourceId: z.string().uuid(),
  issueId: z.string().uuid(),
}).strict();

function requireHumanUser(req: Request, res: Response) {
  if (req.actor.type !== "board") {
    res.status(403).json({ error: "Decision training writes require a human user" });
    return null;
  }
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

function parseExampleId(req: Request, res: Response) {
  const parsed = exampleIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(404).json({ error: "Decision training example not found" });
    return null;
  }
  return parsed.data;
}

function requireExampleOwner(res: Response, userId: string, createdByUserId: string) {
  if (userId !== createdByUserId) {
    res.status(403).json({ error: "Only the example author can change decision training examples" });
    return false;
  }
  return true;
}

export function decisionTrainingRoutes(db: Db) {
  const router = Router();
  const svc = decisionTrainingService(db);

  router.post(
    "/companies/:companyId/decision-training",
    validate(createSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireHumanUser(req, res);
      if (!userId) return;

      const example = await svc.create({
        companyId,
        sourceKind: req.body.sourceKind,
        sourceId: req.body.sourceId,
        issueId: req.body.issueId,
        notes: req.body.notes,
        createdByUserId: userId,
      });
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "decision_training.created",
        entityType: "decision_training_example",
        entityId: example.id,
        details: { sourceKind: example.sourceKind, sourceId: example.sourceId, issueId: example.issueId },
      });
      res.status(201).json(example);
    },
  );

  // Read-only snapshot preview for the create drawer. Same authz as a write
  // (humans only) since it exposes the same captured decision state, but it
  // never persists anything.
  router.post(
    "/companies/:companyId/decision-training/preview",
    validate(previewSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireHumanUser(req, res);
      if (!userId) return;
      const preview = await svc.preview({
        companyId,
        sourceKind: req.body.sourceKind,
        sourceId: req.body.sourceId,
        issueId: req.body.issueId,
      });
      res.json({
        cutoffAt: preview.cutoffAt.toISOString(),
        decisionOutcome: preview.decisionOutcome,
        snapshot: preview.snapshot,
      });
    },
  );

  router.get("/companies/:companyId/decision-training", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const parsed = z.object({
      project: z.string().uuid().optional(),
      kind: sourceKindSchema.optional(),
      author: z.string().optional(),
      q: z.string().trim().max(500).optional(),
    }).safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid decision training query", details: parsed.error.flatten() });
      return;
    }
    res.json(await svc.list(companyId, {
      projectId: parsed.data.project,
      kind: parsed.data.kind,
      author: parsed.data.author,
      q: parsed.data.q,
    }));
  });

  router.get("/companies/:companyId/decision-training/export.jsonl", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const rows = await svc.list(companyId);
    const body = rows
      .map(({ example }) => JSON.stringify({
        retentionPolicy: example.retentionPolicy,
        state: example.snapshot,
        label: { outcome: example.decisionOutcome, notes: example.notes },
      }))
      .join("\n");
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "decision_training.exported",
      entityType: "decision_training_export",
      entityId: companyId,
      details: { exampleCount: rows.length, exampleIds: rows.map(({ example }) => example.id) },
    });
    res.type("application/x-ndjson").send(body ? `${body}\n` : "");
  });

  router.get("/decision-training/:id", async (req, res) => {
    assertBoard(req);
    const exampleId = parseExampleId(req, res);
    if (!exampleId) return;
    const example = await svc.getById(exampleId);
    if (!example || !hasCompanyAccess(req, example.companyId)) {
      res.status(404).json({ error: "Decision training example not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: example.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "decision_training.read",
      entityType: "decision_training_example",
      entityId: example.id,
      details: { sourceKind: example.sourceKind, sourceId: example.sourceId, issueId: example.issueId },
    });
    res.json(example);
  });

  router.patch("/decision-training/:id", validate(updateSchema), async (req, res) => {
    const exampleId = parseExampleId(req, res);
    if (!exampleId) return;
    const existing = await svc.getById(exampleId);
    if (!existing || !hasCompanyAccess(req, existing.companyId)) {
      res.status(404).json({ error: "Decision training example not found" });
      return;
    }
    const userId = requireHumanUser(req, res);
    if (!userId) return;
    if (!requireExampleOwner(res, userId, existing.createdByUserId)) return;
    const notesChanged = req.body.notes !== existing.notes;
    const updated = await svc.updateNotes(existing.id, userId, req.body.notes);
    if (!updated) {
      res.status(404).json({ error: "Decision training example not found" });
      return;
    }
    if (notesChanged) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "decision_training.notes_updated",
        entityType: "decision_training_example",
        entityId: updated.id,
        details: { issueId: updated.issueId },
      });
    }
    res.json(updated);
  });

  router.delete("/decision-training/:id", async (req, res) => {
    const exampleId = parseExampleId(req, res);
    if (!exampleId) return;
    const existing = await svc.getById(exampleId);
    if (!existing || !hasCompanyAccess(req, existing.companyId)) {
      res.status(404).json({ error: "Decision training example not found" });
      return;
    }
    const userId = requireHumanUser(req, res);
    if (!userId) return;
    if (!requireExampleOwner(res, userId, existing.createdByUserId)) return;
    const deleted = await svc.delete(existing.id);
    if (deleted.length === 0) {
      res.status(404).json({ error: "Decision training example not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "decision_training.deleted",
      entityType: "decision_training_example",
      entityId: existing.id,
      details: { issueId: existing.issueId, deletedByUserId: userId },
    });
    res.status(204).send();
  });

  return router;
}
