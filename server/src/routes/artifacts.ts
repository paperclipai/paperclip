import { Router, type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import {
  createArtifactFolderSchema,
  updateArtifactFolderSchema,
  createArtifactSchema,
  updateArtifactSchema,
  listArtifactsQuerySchema,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { artifactService, assetService, logActivity } from "../services/index.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export interface ArtifactRouteOptions {
  storageProvider: string;
  storageLocalDiskBaseDir: string;
}

export function artifactRoutes(db: Db, storage: StorageService, options: ArtifactRouteOptions) {
  const router = Router();
  const svc = artifactService(db);
  const assetSvc = assetService(db);

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

  // ── Folder endpoints ──

  router.get("/companies/:companyId/artifacts/tree", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tree = await svc.listFolderTree(companyId);
    res.json(tree);
  });

  router.post("/companies/:companyId/artifacts/folders", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsed = createArtifactFolderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const folder = await svc.createFolder(companyId, parsed.data);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "artifact_folder.created",
      entityType: "artifact_folder",
      entityId: folder.id,
      details: { name: folder.name, path: folder.path },
    });

    res.status(201).json(folder);
  });

  router.patch("/artifacts/folders/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getFolderById(id);
    if (!existing) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const parsed = updateArtifactFolderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const updated = await svc.updateFolder(id, existing.companyId, parsed.data);
    if (!updated) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "artifact_folder.updated",
      entityType: "artifact_folder",
      entityId: id,
      details: { name: updated.name, path: updated.path },
    });

    res.json(updated);
  });

  router.delete("/artifacts/folders/:id", async (req, res) => {
    const id = req.params.id as string;
    const recursive = req.query.recursive === "true";

    const existing = await svc.getFolderById(id);
    if (!existing) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    try {
      await svc.deleteFolder(id, existing.companyId, recursive);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not empty")) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "artifact_folder.deleted",
      entityType: "artifact_folder",
      entityId: id,
      details: { name: existing.name, path: existing.path, recursive },
    });

    res.status(204).end();
  });

  // ── Artifact endpoints ──

  router.get("/companies/:companyId/artifacts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsed = listArtifactsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }

    const items = await svc.listArtifacts(companyId, parsed.data);
    res.json(items);
  });

  router.post("/companies/:companyId/artifacts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    try {
      await runSingleFileUpload(req, res);
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
    const contentType = (file.mimetype || "").toLowerCase();
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported file type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "File is empty" });
      return;
    }

    const parsedMeta = createArtifactSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid metadata", details: parsedMeta.error.issues });
      return;
    }

    // Determine target folder
    let folderId = parsedMeta.data.folderId;
    if (!folderId && parsedMeta.data.path) {
      const folder = await svc.createFolder(companyId, { path: parsedMeta.data.path });
      folderId = folder.id;
    }
    if (!folderId) {
      // Default to root-level "Uncategorized" folder
      folderId = await svc.ensureAutoFolder(companyId, null, "Uncategorized");
    }

    const actor = getActorInfo(req);

    // Store the file via storage service
    const stored = await storage.putFile({
      companyId,
      namespace: "artifacts",
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    // Create asset record
    const asset = await assetSvc.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    // Create artifact record
    const title = parsedMeta.data.title || file.originalname || "Untitled";
    const artifact = await svc.createArtifact(companyId, {
      folderId,
      assetId: asset.id,
      title,
      description: parsedMeta.data.description ?? null,
      mimeType: contentType,
      issueId: parsedMeta.data.issueId ?? null,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "artifact.created",
      entityType: "artifact",
      entityId: artifact.id,
      details: { title, mimeType: contentType, folderId },
    });

    res.status(201).json(artifact);
  });

  router.get("/artifacts/:id", async (req, res) => {
    const id = req.params.id as string;
    // Look up without company scoping first, then check access
    const artifact = await svc.getArtifact(id);
    if (!artifact) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    assertCompanyAccess(req, artifact.companyId);
    res.json(artifact);
  });

  router.get("/artifacts/:id/content", async (req, res, next) => {
    const id = req.params.id as string;
    const artifact = await svc.getArtifact(id);
    if (!artifact) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    assertCompanyAccess(req, artifact.companyId);

    const asset = await assetSvc.getById(artifact.assetId);
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    const object = await storage.getObject(artifact.companyId, asset.objectKey);
    res.setHeader("Content-Type", artifact.mimeType || object.contentType || "application/octet-stream");
    if (asset.byteSize || object.contentLength) {
      res.setHeader("Content-Length", String(asset.byteSize || object.contentLength || 0));
    }
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${(artifact.title || "file").replaceAll('"', "")}"`,
    );

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.get("/artifacts/:id/local-path", async (req, res) => {
    const id = req.params.id as string;
    const artifact = await svc.getArtifact(id);
    if (!artifact) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    assertCompanyAccess(req, artifact.companyId);

    if (options.storageProvider !== "local_disk") {
      res.status(400).json({ error: "Local path only available with local_disk storage" });
      return;
    }

    const objectKey = await svc.getAssetObjectKey(id);
    if (!objectKey) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    const fullPath = path.resolve(options.storageLocalDiskBaseDir, objectKey);
    res.json({ path: fullPath });
  });

  router.patch("/artifacts/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getArtifact(id);
    if (!existing) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const parsed = updateArtifactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const updated = await svc.updateArtifact(id, existing.companyId, parsed.data);
    if (!updated) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "artifact.updated",
      entityType: "artifact",
      entityId: id,
      details: parsed.data,
    });

    res.json(updated);
  });

  router.delete("/artifacts/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getArtifact(id);
    if (!existing) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    await svc.deleteArtifact(id, existing.companyId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "artifact.deleted",
      entityType: "artifact",
      entityId: id,
      details: { title: existing.title },
    });

    res.status(204).end();
  });

  return router;
}
