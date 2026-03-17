import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  updateCompanySchema,
  ROLE_PRESETS,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  budgetService,
  companyPortabilityService,
  companyService,
  logActivity,
} from "../services/index.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function companyRoutes(db: Db, storageService?: StorageService) {
  const router = Router();
  const svc = companyService(db);
  const portability = companyPortabilityService(db);
  const access = accessService(db);
  const budgets = budgetService(db);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
  });

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  router.get("/", async (req, res) => {
    assertBoard(req);
    const result = await svc.list();
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      res.json(result);
      return;
    }
    const allowed = new Set(req.actor.companyIds ?? []);
    res.json(result.filter((company) => allowed.has(company.id)));
  });

  router.get("/stats", async (req, res) => {
    assertBoard(req);
    const allowed = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin
      ? null
      : new Set(req.actor.companyIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    res.json(filtered);
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.post("/:companyId/export", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      assertCompanyAccess(req, req.body.target.companyId);
    } else {
      assertBoard(req);
    }
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      assertCompanyAccess(req, req.body.target.companyId);
    } else {
      assertBoard(req);
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null);
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "company.imported",
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    assertBoard(req);
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      throw forbidden("Instance admin required");
    }
    const company = await svc.create(req.body);
    await access.ensureMembership(company.id, "user", req.actor.userId ?? "local-board", "owner", "active");
    await access.setPrincipalGrants(
      company.id,
      "user",
      req.actor.userId ?? "local-board",
      ROLE_PRESETS.owner.map((k) => ({ permissionKey: k })),
      req.actor.userId ?? null,
    );
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    if (company.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        company.id,
        {
          scopeType: "company",
          scopeId: company.id,
          amount: company.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.userId ?? "board",
      );
    }
    res.status(201).json(company);
  });

  router.patch("/:companyId", validate(updateCompanySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.update(companyId, req.body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      details: req.body,
    });
    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.userId) {
      const membership = await access.getMembership(companyId, "user", req.actor.userId);
      if (!membership || membership.membershipRole !== "owner") {
        const isAdmin = await access.isInstanceAdmin(req.actor.userId);
        if (!isAdmin) throw forbidden("Only owners can archive companies");
      }
    }
    const company = await svc.archive(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
    });
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.userId) {
      const membership = await access.getMembership(companyId, "user", req.actor.userId);
      if (!membership || membership.membershipRole !== "owner") {
        const isAdmin = await access.isInstanceAdmin(req.actor.userId);
        if (!isAdmin) throw forbidden("Only owners can delete companies");
      }
    }
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });

  // POST /:companyId/logo — upload company logo
  router.post("/:companyId/logo", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    if (!storageService) {
      res.status(503).json({ error: "Storage service not configured" });
      return;
    }

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Logo exceeds ${MAX_LOGO_BYTES} bytes (2MB max)` });
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
    if (!ALLOWED_LOGO_TYPES.has(contentType)) {
      res.status(422).json({ error: `Unsupported logo type: ${contentType}. Allowed: png, jpg, webp` });
      return;
    }

    const stored = await storageService.putFile({
      companyId,
      namespace: "logos",
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const logoUrl = `/api/companies/logos/${stored.objectKey}`;

    await db
      .update(companies)
      .set({ image: logoUrl, updatedAt: new Date() })
      .where(eq(companies.id, companyId));

    res.json({ logoUrl });
  });

  // GET /logos/* — serve company logo
  router.get("/logos/*objectKey", async (req, res, next) => {
    const rawKey = req.params.objectKey;
    const objectKey = Array.isArray(rawKey) ? rawKey.join("/") : (rawKey as string);
    if (!objectKey) {
      res.status(400).json({ error: "Missing object key" });
      return;
    }

    if (!storageService) {
      res.status(503).json({ error: "Storage service not configured" });
      return;
    }

    // Derive companyId from object key (format: {companyId}/logos/...)
    const companyId = objectKey.split("/")[0] ?? "system";

    try {
      const object = await storageService.getObject(companyId, objectKey);
      res.setHeader("Content-Type", object.contentType || "image/png");
      if (object.contentLength) res.setHeader("Content-Length", String(object.contentLength));
      res.setHeader("Cache-Control", "public, max-age=3600");
      object.stream.on("error", (err) => next(err));
      object.stream.pipe(res);
    } catch {
      res.status(404).json({ error: "Logo not found" });
    }
  });

  return router;
}
