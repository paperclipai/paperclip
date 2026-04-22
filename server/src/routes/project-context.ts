import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import {
  contextSourceCreateSchema,
  contextSourceSearchSchema,
  contextSourceUpsertItemSchema,
  projectContextProfileUpdateSchema,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { assetService, logActivity, projectContextService } from "../services/index.js";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const TEXTUAL_CONTENT_TYPES = new Set([
  "application/csv",
  "application/javascript",
  "application/json",
  "application/markdown",
  "application/x-javascript",
  "application/x-yaml",
  "application/xml",
  "text/csv",
  "text/markdown",
  "text/x-markdown",
  "text/yaml",
]);

function isTextualContentType(contentType: string) {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return normalized.startsWith("text/") || TEXTUAL_CONTENT_TYPES.has(normalized);
}

function extractTextForIndex(contentType: string, body: Buffer) {
  if (!isTextualContentType(contentType)) return null;
  const text = body.toString("utf8");
  if (!text.trim()) return null;
  return text;
}

async function runSingleFileUpload(
  upload: ReturnType<typeof multer>,
  req: Request,
  res: Response,
) {
  await new Promise<void>((resolve, reject) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function projectContextRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = projectContextService(db);
  const assets = assetService(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  router.get("/companies/:companyId/projects/:projectId/context", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.overview(companyId, projectId));
  });

  router.patch(
    "/companies/:companyId/projects/:projectId/context",
    validate(projectContextProfileUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      assertCompanyAccess(req, companyId);
      const profile = await svc.updateProfile(companyId, projectId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "project.context_updated",
        entityType: "project",
        entityId: projectId,
        details: {
          changedKeys: Object.keys(req.body).sort(),
          defaultSkillCount: profile.defaultSkillKeys.length,
        },
      });
      res.json(profile);
    },
  );

  router.get("/companies/:companyId/projects/:projectId/context/sources", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listSources(companyId, projectId));
  });

  router.post(
    "/companies/:companyId/projects/:projectId/context/sources",
    validate(contextSourceCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const source = await svc.createSource(companyId, projectId, {
        ...req.body,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "project.context_source_created",
        entityType: "context_source",
        entityId: source.id,
        details: {
          projectId,
          sourceType: source.sourceType,
          title: source.title,
        },
      });
      res.status(201).json(source);
    },
  );

  router.post("/companies/:companyId/projects/:projectId/context/sources/upload", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);

    try {
      await runSingleFileUpload(upload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `File exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
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

    const contentType = (file.mimetype || "application/octet-stream").toLowerCase();
    const body = file.buffer;
    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `context/${projectId}`,
      originalFilename: file.originalname || null,
      contentType,
      body,
    });
    const asset = await assets.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    const text = extractTextForIndex(contentType, body);
    const source = await svc.createSource(companyId, projectId, {
      sourceType: "upload",
      title: file.originalname || "Uploaded file",
      uri: `/api/assets/${asset.id}/content`,
      assetId: asset.id,
      bodyText: text,
      metadata: {
        originalFilename: asset.originalFilename,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
        searchable: Boolean(text),
      },
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!text) {
      await svc.upsertSourceItem(companyId, source.id, {
        externalId: asset.id,
        title: file.originalname || "Uploaded file",
        uri: `/api/assets/${asset.id}/content`,
        mimeType: contentType,
        status: "unsupported",
        statusMessage: "Stored, but this file type is not text-indexable yet.",
        metadata: {
          assetId: asset.id,
          originalFilename: asset.originalFilename,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
        },
      });
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.context_source_uploaded",
      entityType: "context_source",
      entityId: source.id,
      details: {
        projectId,
        assetId: asset.id,
        originalFilename: asset.originalFilename,
        contentType,
        searchable: Boolean(text),
      },
    });
    res.status(201).json(source);
  });

  router.get("/companies/:companyId/projects/:projectId/context/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const parsed = contextSourceSearchSchema.parse(req.query);
    res.json(await svc.search(companyId, projectId, parsed.q, parsed.limit));
  });

  router.post(
    "/companies/:companyId/context/sources/:sourceId/items",
    validate(contextSourceUpsertItemSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const sourceId = req.params.sourceId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.upsertSourceItem(companyId, sourceId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "project.context_source_item_upserted",
        entityType: "context_source",
        entityId: sourceId,
        details: {
          itemId: result.item.id,
          chunkCount: result.chunkCount,
        },
      });
      res.json(result.item);
    },
  );

  router.post("/companies/:companyId/context/sources/:sourceId/sync", async (req, res) => {
    const companyId = req.params.companyId as string;
    const sourceId = req.params.sourceId as string;
    assertCompanyAccess(req, companyId);
    const source = await svc.reindexSource(companyId, sourceId);
    if (!source) {
      res.status(404).json({ error: "Context source not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.context_source_synced",
      entityType: "context_source",
      entityId: source.id,
      details: {
        projectId: source.projectId,
        sourceType: source.sourceType,
      },
    });
    res.json(source);
  });

  router.delete("/companies/:companyId/context/sources/:sourceId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const sourceId = req.params.sourceId as string;
    assertCompanyAccess(req, companyId);
    const source = await svc.deleteSource(companyId, sourceId);
    if (!source) {
      res.status(404).json({ error: "Context source not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.context_source_deleted",
      entityType: "context_source",
      entityId: source.id,
      details: {
        projectId: source.projectId,
        sourceType: source.sourceType,
        title: source.title,
      },
    });
    res.json(source);
  });

  return router;
}
