import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import {
  createMockupMetadataSchema,
  updateMockupStatusSchema,
  listMockupsQuerySchema,
  isValidStatusTransition,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { mockupService, logActivity } from "../services/index.js";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { issueService } from "../services/index.js";
import { logger } from "../middleware/logger.js";

const MOCKUP_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; script-src 'none'; img-src data:; frame-ancestors 'self'";

export function mockupRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = mockupService(db);
  const issueSvc = issueService(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // 1. POST /companies/:companyId/issues/:issueId/mockups — upload HTML mockup
  router.post("/companies/:companyId/issues/:issueId/mockups", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);

    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({ error: `Mockup exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    const contentType = (file.mimetype || "").toLowerCase();
    if (contentType !== "text/html") {
      res.status(400).json({ error: `Mockups must be text/html, got: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(400).json({ error: "Mockup file is empty" });
      return;
    }

    const parsedMeta = createMockupMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid mockup metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}/mockups`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const mockup = await svc.create({
      companyId,
      issueId,
      title: parsedMeta.data.title,
      viewport: parsedMeta.data.viewport,
      fidelityLevel: parsedMeta.data.fidelityLevel,
      notes: parsedMeta.data.notes ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.mockup_created",
      entityType: "issue",
      entityId: issueId,
      details: {
        mockupId: mockup.id,
        title: mockup.title,
        version: mockup.version,
        viewport: mockup.viewport,
        fidelityLevel: mockup.fidelityLevel,
      },
    });

    res.status(201).json({
      ...mockup,
      previewPath: `/api/mockups/${mockup.id}/preview`,
    });
  });

  // 2. GET /issues/:issueId/mockups — list mockups
  router.get("/issues/:issueId/mockups", async (req, res) => {
    const issueId = req.params.issueId as string;
    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const query = listMockupsQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid query", details: query.error.issues });
      return;
    }

    const mockups = await svc.list(issueId, query.data);
    res.json(
      mockups.map((m) => ({
        ...m,
        previewPath: `/api/mockups/${m.id}/preview`,
      })),
    );
  });

  // 3. GET /mockups/:mockupId — get single mockup
  router.get("/mockups/:mockupId", async (req, res) => {
    const mockupId = req.params.mockupId as string;
    const mockup = await svc.getById(mockupId);
    if (!mockup) {
      res.status(404).json({ error: "Mockup not found" });
      return;
    }
    assertCompanyAccess(req, mockup.companyId);
    res.json({
      ...mockup,
      previewPath: `/api/mockups/${mockup.id}/preview`,
    });
  });

  // 4. GET /mockups/:mockupId/preview — stream HTML with CSP
  router.get("/mockups/:mockupId/preview", async (req, res, next) => {
    const mockupId = req.params.mockupId as string;
    const mockup = await svc.getById(mockupId);
    if (!mockup) {
      res.status(404).json({ error: "Mockup not found" });
      return;
    }
    assertCompanyAccess(req, mockup.companyId);

    const object = await storage.getObject(mockup.companyId, mockup.objectKey);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Length", String(mockup.byteSize || object.contentLength || 0));
    res.setHeader("Content-Security-Policy", MOCKUP_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=60");

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  // 5. PATCH /mockups/:mockupId — update status
  router.patch("/mockups/:mockupId", async (req, res) => {
    const mockupId = req.params.mockupId as string;
    const mockup = await svc.getById(mockupId);
    if (!mockup) {
      res.status(404).json({ error: "Mockup not found" });
      return;
    }
    assertCompanyAccess(req, mockup.companyId);

    const parsed = updateMockupStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid status", details: parsed.error.issues });
      return;
    }

    if (!isValidStatusTransition(mockup.status, parsed.data.status)) {
      res.status(400).json({
        error: `Invalid status transition: ${mockup.status} → ${parsed.data.status}`,
      });
      return;
    }

    const updated = await svc.updateStatus(mockupId, parsed.data.status);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: mockup.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.mockup_status_changed",
      entityType: "issue",
      entityId: mockup.issueId,
      details: {
        mockupId,
        from: mockup.status,
        to: parsed.data.status,
      },
    });

    res.json(updated);
  });

  // 6. DELETE /mockups/:mockupId — cascade delete
  router.delete("/mockups/:mockupId", async (req, res) => {
    const mockupId = req.params.mockupId as string;
    const mockup = await svc.getById(mockupId);
    if (!mockup) {
      res.status(404).json({ error: "Mockup not found" });
      return;
    }
    assertCompanyAccess(req, mockup.companyId);

    try {
      await storage.deleteObject(mockup.companyId, mockup.objectKey);
    } catch (err) {
      logger.warn({ err, mockupId }, "storage delete failed while removing mockup");
    }

    const removed = await svc.remove(mockupId);
    if (!removed) {
      res.status(404).json({ error: "Mockup not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: mockup.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.mockup_deleted",
      entityType: "issue",
      entityId: mockup.issueId,
      details: { mockupId },
    });

    res.json({ ok: true });
  });

  return router;
}
