import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { youtubeExtractionService } from "../services/youtube-extractions.js";
import { processYoutubeExtraction } from "../services/youtube-worker.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const createSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.includes("youtube.com") || u.includes("youtu.be"), {
      message: "Must be a YouTube URL",
    }),
});

export function youtubeExtractionRoutes(db: Db) {
  const router = Router();
  const svc = youtubeExtractionService(db);

  // List extractions for a company
  router.get("/companies/:companyId/youtube-extractions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const rows = await svc.list(companyId, { limit, offset });
    res.json(rows);
  });

  // Submit a URL for extraction
  router.post(
    "/companies/:companyId/youtube-extractions",
    validate(createSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);

      const userId = (req.actor as { userId: string }).userId;
      const submittedUrl = req.body.url as string;

      // Dedup: return existing completed/processing extraction for the same video
      const existing = await svc.findExisting(companyId, submittedUrl);
      if (existing) {
        res.status(200).json({ ...existing, alreadyExtracted: true });
        return;
      }

      const extraction = await svc.create({
        companyId,
        submittedByUserId: userId,
        url: submittedUrl,
      });

      // Fire-and-forget background processing
      processYoutubeExtraction(db, extraction.id, extraction.url).catch((err: unknown) => {
        console.error("[youtube-worker] unhandled error", err);
      });

      res.status(201).json(extraction);
    },
  );

  // Get a single extraction
  router.get("/youtube-extractions/:id", async (req, res) => {
    const id = req.params.id as string;
    const row = await svc.getById(id);
    if (!row) {
      res.status(404).json({ error: "Extraction not found" });
      return;
    }
    assertCompanyAccess(req, row.companyId);
    res.json(row);
  });

  // Delete an extraction
  router.delete("/youtube-extractions/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Extraction not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await svc.remove(id, existing.companyId);
    res.status(204).end();
  });

  return router;
}
