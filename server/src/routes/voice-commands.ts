import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { voiceCommandService } from "../services/voice-commands.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const createSchema = z.object({
  rawText: z.string().min(1),
  routerAgentId: z.string().uuid().optional(),
  chatId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  classification: z.string().optional(),
  actionTaken: z.string().optional(),
  createdIssueId: z.string().uuid().optional(),
  chatId: z.string().uuid().optional(),
  status: z.enum(["pending", "processing", "completed", "corrected", "failed"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const correctSchema = z.object({
  correctionText: z.string().min(1),
  previousClassification: z.string().nullable().optional().default(null),
  newClassification: z.string().nullable().optional().default(null),
  previousIssueId: z.string().uuid().nullable().optional().default(null),
  newIssueId: z.string().uuid().nullable().optional().default(null),
  action: z.enum(["reclassified", "cancelled", "recreated", "updated"]),
});

export function voiceCommandRoutes(db: Db) {
  const router = Router();
  const svc = voiceCommandService(db);

  // List voice commands for a company
  router.get("/companies/:companyId/voice-commands", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const opts = {
      initiatedByUserId: req.query.userId as string | undefined,
      status: req.query.status as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0,
    };

    const commands = await svc.list(companyId, opts);
    res.json(commands);
  });

  // Get status counts
  router.get("/companies/:companyId/voice-commands/stats", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const userId = req.query.userId as string | undefined;
    const stats = await svc.countByStatus(companyId, userId);
    res.json(stats);
  });

  // Create a voice command
  router.post(
    "/companies/:companyId/voice-commands",
    validate(createSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);

      const userId = (req as any).userId ?? (req as any).agentId;
      const cmd = await svc.create({
        companyId,
        initiatedByUserId: userId,
        rawText: req.body.rawText,
        routerAgentId: req.body.routerAgentId,
        chatId: req.body.chatId,
        metadata: req.body.metadata,
      });
      res.status(201).json(cmd);
    },
  );

  // Get a single voice command
  router.get("/voice-commands/:id", async (req, res) => {
    const id = req.params.id as string;
    // We need to look up the command first to check company access
    // For now, use assertBoard to ensure the caller is authenticated
    assertBoard(req);

    // Query without company filter since we don't know it yet
    const cmd = await svc.getById(id);
    if (!cmd) {
      res.status(404).json({ error: "Voice command not found" });
      return;
    }
    assertCompanyAccess(req, cmd.companyId);
    res.json(cmd);
  });

  // Update a voice command (used by router agent to fill in classification/action)
  router.patch(
    "/voice-commands/:id",
    validate(updateSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;

      // Look up command to get companyId
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Voice command not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const updated = await svc.update(id, existing.companyId, req.body);
      if (!updated) {
        res.status(404).json({ error: "Voice command not found" });
        return;
      }
      res.json(updated);
    },
  );

  // Submit a correction for a voice command
  router.post(
    "/voice-commands/:id/correct",
    validate(correctSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;

      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Voice command not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const corrected = await svc.addCorrection(id, existing.companyId, req.body);
      if (!corrected) {
        res.status(404).json({ error: "Voice command not found" });
        return;
      }
      res.json(corrected);
    },
  );

  return router;
}
