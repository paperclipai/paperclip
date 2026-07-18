import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import {
  createBrandKitRequestSchema,
  upsertBrandKitDesignRequestSchema,
  brandKitAssetRoleSchema,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import {
  agentService,
  assetService,
  brandKitService,
  BrandKitConflictError,
  logActivity,
  resolveBrandKit,
  assetContentPath,
  type BrandKitRow,
} from "../services/index.js";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { sanitizeSvgBuffer } from "../lib/svg-sanitize.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const SVG_CONTENT_TYPE = "image/svg+xml";

// Content types accepted for brand-kit assets: raster/vector logos plus web fonts.
const BRAND_ASSET_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  SVG_CONTENT_TYPE,
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
  "application/font-woff",
  "application/font-woff2",
  "application/x-font-ttf",
  "application/x-font-otf",
  "application/vnd.ms-fontobject",
]);

function serializeKit(kit: BrandKitRow) {
  return {
    id: kit.id,
    companyId: kit.companyId,
    name: kit.name,
    slug: kit.slug,
    isDefault: kit.isDefault,
    designMd: kit.designMd,
    tokens: kit.tokens,
    archivedAt: kit.archivedAt,
    createdAt: kit.createdAt,
    updatedAt: kit.updatedAt,
  };
}

export function brandKitRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = brandKitService(db);
  const assets = assetService(db);
  const agents = agentService(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  // Writes are CEO/board-gated: board members (human) or the same-company CEO
  // agent only. Any company agent (or board viewer) may still read. Mirrors
  // assertSameCompanyCeoAgentOrBoard in routes/companies.ts.
  async function assertWriteAccess(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden("Only CEO agents can manage brand kits");
    }
  }

  async function runUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function loadKitOr404(companyId: string, kitId: string): Promise<BrandKitRow> {
    const kit = await svc.getKit(companyId, kitId);
    if (!kit) throw notFound("Brand kit not found");
    return kit;
  }

  // List the company brand-kit library (default flagged).
  router.get("/companies/:companyId/brand-kits", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const kits = await svc.listKits(companyId);
    res.json({ brandKits: kits.map(serializeKit) });
  });

  // Resolved active kit for this company (Phase 1 = company default).
  router.get("/companies/:companyId/brand-kit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const resolved = await resolveBrandKit(db, {
      companyId,
      issueId: (req.query.issueId as string) ?? null,
      projectId: (req.query.projectId as string) ?? null,
      goalId: (req.query.goalId as string) ?? null,
    });
    res.json(resolved);
  });

  // Create a kit (optionally seeding DESIGN.md).
  router.post("/companies/:companyId/brand-kits", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertWriteAccess(req, companyId);

    const parsed = createBrandKitRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("Invalid brand kit payload", parsed.error.issues);

    let result;
    try {
      result = await svc.createKit(companyId, parsed.data);
    } catch (err) {
      if (err instanceof BrandKitConflictError) throw conflict(err.message);
      throw err;
    }
    if (!result.ok) {
      throw unprocessable("DESIGN.md failed validation", { validationErrors: result.errors });
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "brand_kit.created",
      entityType: "brand_kit",
      entityId: result.kit.id,
      details: { name: result.kit.name, slug: result.kit.slug, isDefault: result.kit.isDefault },
    });

    res.status(201).json(serializeKit(result.kit));
  });

  // Upsert DESIGN.md for a kit; server parses/validates and rebuilds the token cache.
  router.put("/companies/:companyId/brand-kits/:kitId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const kitId = req.params.kitId as string;
    await assertWriteAccess(req, companyId);

    const parsed = upsertBrandKitDesignRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("Invalid DESIGN.md payload", parsed.error.issues);

    const result = await svc.updateDesign(companyId, kitId, parsed.data);
    if (result === null) throw notFound("Brand kit not found");
    if (!result.ok) {
      throw unprocessable("DESIGN.md failed validation", { validationErrors: result.errors });
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "brand_kit.updated",
      entityType: "brand_kit",
      entityId: result.kit.id,
      details: { name: result.kit.name, slug: result.kit.slug },
    });

    res.json(serializeKit(result.kit));
  });

  // Set a kit as the company default.
  router.post("/companies/:companyId/brand-kits/:kitId/default", async (req, res) => {
    const companyId = req.params.companyId as string;
    const kitId = req.params.kitId as string;
    await assertWriteAccess(req, companyId);

    let kit: BrandKitRow;
    try {
      kit = await svc.setDefault(companyId, kitId);
    } catch (err) {
      if (err instanceof BrandKitConflictError) throw notFound(err.message);
      throw err;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "brand_kit.default_set",
      entityType: "brand_kit",
      entityId: kit.id,
      details: { name: kit.name, slug: kit.slug },
    });

    res.json(serializeKit(kit));
  });

  // Upload + bind an asset to a kit slot (multipart, field `file`, `role`).
  router.post("/companies/:companyId/brand-kits/:kitId/assets", async (req, res) => {
    const companyId = req.params.companyId as string;
    const kitId = req.params.kitId as string;
    await assertWriteAccess(req, companyId);
    await loadKitOr404(companyId, kitId);

    try {
      await runUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          throw unprocessable(`File exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
        }
        throw badRequest(err.message);
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) throw badRequest("Missing file field 'file'");

    const roleParsed = brandKitAssetRoleSchema.safeParse(String(req.body?.role ?? ""));
    if (!roleParsed.success) throw badRequest("Invalid or missing asset role", roleParsed.error.issues);
    const role = roleParsed.data;

    const contentType = (file.mimetype || "").toLowerCase();
    if (!BRAND_ASSET_CONTENT_TYPES.has(contentType)) {
      throw unprocessable(`Unsupported asset type: ${contentType || "unknown"}`);
    }

    let fileBody = file.buffer;
    if (contentType === SVG_CONTENT_TYPE) {
      const sanitized = sanitizeSvgBuffer(file.buffer);
      if (!sanitized || sanitized.length <= 0) throw unprocessable("SVG could not be sanitized");
      fileBody = sanitized;
    }
    if (fileBody.length <= 0) throw unprocessable("Asset is empty");

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: "assets/brand-kits",
      originalFilename: file.originalname || null,
      contentType,
      body: fileBody,
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

    const kitAsset = await svc.attachAsset(kitId, asset.id, role);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "brand_kit.asset_attached",
      entityType: "brand_kit",
      entityId: kitId,
      details: { role, assetId: asset.id, contentType: asset.contentType, byteSize: asset.byteSize },
    });

    res.status(201).json({
      id: kitAsset.id,
      brandKitId: kitId,
      assetId: asset.id,
      role,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      originalFilename: asset.originalFilename,
      contentPath: assetContentPath(asset.id),
    });
  });

  // Detach an asset from a kit (does not delete the underlying asset row).
  router.delete("/companies/:companyId/brand-kits/:kitId/assets/:assetId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const kitId = req.params.kitId as string;
    const assetId = req.params.assetId as string;
    await assertWriteAccess(req, companyId);
    await loadKitOr404(companyId, kitId);

    const removed = await svc.detachAsset(kitId, assetId);
    if (removed === 0) throw notFound("Asset is not bound to this brand kit");

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "brand_kit.asset_detached",
      entityType: "brand_kit",
      entityId: kitId,
      details: { assetId },
    });

    res.status(204).end();
  });

  // Export a kit as a self-contained manifest (DESIGN.md + tokens + asset refs).
  router.get("/companies/:companyId/brand-kits/:kitId/export", async (req, res) => {
    const companyId = req.params.companyId as string;
    const kitId = req.params.kitId as string;
    assertCompanyAccess(req, companyId);
    const kit = await loadKitOr404(companyId, kitId);
    const kitAssets = await svc.listAssets(kit.id);

    res.json({
      format: "brand-kit-export/v1",
      kit: {
        id: kit.id,
        name: kit.name,
        slug: kit.slug,
        isDefault: kit.isDefault,
      },
      designMd: kit.designMd,
      tokens: kit.tokens,
      assets: kitAssets.map((row) => ({
        role: row.role,
        assetId: row.assetId,
        contentType: row.contentType,
        byteSize: row.byteSize,
        sha256: row.sha256,
        originalFilename: row.originalFilename,
        contentPath: assetContentPath(row.assetId),
      })),
    });
  });

  return router;
}
