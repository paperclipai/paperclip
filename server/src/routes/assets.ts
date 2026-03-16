import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import { createAssetFileMetadataSchema, createAssetImageMetadataSchema } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { assetService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const MAX_ASSET_IMAGE_BYTES = Number(process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES) || 10 * 1024 * 1024;
const MAX_ASSET_FILE_BYTES = Number(process.env.PAPERCLIP_ASSET_MAX_BYTES) || 25 * 1024 * 1024;
const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
const ALLOWED_FILE_CONTENT_TYPES = new Set([
  "application/gzip",
  "application/json",
  "application/msword",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/x-gzip",
  "application/x-tar",
  "application/x-zip-compressed",
  "application/zip",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

function normalizeContentType(value: string | null | undefined) {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export function assetRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = assetService(db);
  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ASSET_IMAGE_BYTES, files: 1 },
  });
  const fileUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ASSET_FILE_BYTES, files: 1 },
  });

  async function runSingleFileUpload(req: Request, res: Response, upload: multer.Multer) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function toAssetResponse(asset: Awaited<ReturnType<typeof svc.create>>) {
    return {
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
    };
  }

  async function storeUploadedAsset(
    req: Request,
    res: Response,
    opts: {
      upload: multer.Multer;
      maxBytes: number;
      routeLabel: "image" | "file";
      metadataSchema: typeof createAssetImageMetadataSchema | typeof createAssetFileMetadataSchema;
      namespaceFallback: string;
      validateContentType?: (contentType: string) => string | null;
    },
  ) {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    try {
      await runSingleFileUpload(req, res, opts.upload);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `${opts.routeLabel === "image" ? "Image" : "File"} exceeds ${opts.maxBytes} bytes` });
          return null;
        }
        res.status(400).json({ error: err.message });
        return null;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return null;
    }

    const contentType = normalizeContentType(file.mimetype);
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: `${opts.routeLabel === "image" ? "Image" : "File"} is empty` });
      return null;
    }
    const validationError = opts.validateContentType?.(contentType) ?? null;
    if (validationError) {
      res.status(422).json({ error: validationError });
      return null;
    }

    const parsedMeta = opts.metadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({
        error: `Invalid ${opts.routeLabel} metadata`,
        details: parsedMeta.error.issues,
      });
      return null;
    }

    const namespaceSuffix = parsedMeta.data.namespace ?? opts.namespaceFallback;
    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `assets/${namespaceSuffix}`,
      originalFilename: file.originalname || null,
      contentType: contentType || "application/octet-stream",
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

    return asset;
  }

  router.post("/companies/:companyId/assets/images", async (req, res) => {
    const asset = await storeUploadedAsset(req, res, {
      upload: imageUpload,
      maxBytes: MAX_ASSET_IMAGE_BYTES,
      routeLabel: "image",
      metadataSchema: createAssetImageMetadataSchema,
      namespaceFallback: "general",
      validateContentType: (contentType) =>
        ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)
          ? null
          : `Unsupported image type: ${contentType || "unknown"}`,
    });
    if (!asset) return;
    res.status(201).json(toAssetResponse(asset));
  });

  router.post("/companies/:companyId/assets/files", async (req, res) => {
    const asset = await storeUploadedAsset(req, res, {
      upload: fileUpload,
      maxBytes: MAX_ASSET_FILE_BYTES,
      routeLabel: "file",
      metadataSchema: createAssetFileMetadataSchema,
      namespaceFallback: "records",
      // General record attachments are intentionally limited to inert document formats
      // so assets served from the Paperclip origin cannot become a stored-XSS vector.
      validateContentType: (contentType) =>
        ALLOWED_FILE_CONTENT_TYPES.has(contentType)
          ? null
          : `Unsupported file type: ${contentType || "unknown"}`,
    });
    if (!asset) return;
    res.status(201).json(toAssetResponse(asset));
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
    res.setHeader("X-Content-Type-Options", "nosniff");
    const filename = asset.originalFilename ?? "asset";
    res.setHeader("Content-Disposition", `inline; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  return router;
}
