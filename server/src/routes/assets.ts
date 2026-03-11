import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import { createAssetImageMetadataSchema } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { assetService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";

export function assetRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = assetService(db);
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

  router.post("/companies/:companyId/assets/images", async (req, res) => {
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
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const parsedMeta = createAssetImageMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid image metadata", details: parsedMeta.error.issues });
      return;
    }

    const namespaceSuffix = parsedMeta.data.namespace ?? "general";
    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `assets/${namespaceSuffix}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const asset = await svc.create(companyId, {
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
      action: "asset.created",
      entityType: "asset",
      entityId: asset.id,
      details: {
        originalFilename: asset.originalFilename,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
      },
    });

    res.status(201).json({
      assetId: asset.id,
      companyId: asset.companyId,
      provider: asset.provider,
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      originalFilename: asset.originalFilename,
      createdByAgentId: asset.createdByAgentId,
      createdByUserId: asset.createdByUserId,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      contentPath: `/api/assets/${asset.id}/content`,
    });
  });

  router.get("/assets/:assetId/content", async (req, res, next) => {
    const assetId = req.params.assetId as string;
    const asset = await svc.getById(assetId);
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    assertCompanyAccess(req, asset.companyId);

    const object = await storage.getObject(asset.companyId, asset.objectKey);
    res.setHeader("Content-Type", asset.contentType || object.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(asset.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    const filename = asset.originalFilename ?? "asset";
    res.setHeader("Content-Disposition", `inline; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  return router;
}

