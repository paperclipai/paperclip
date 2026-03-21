import { Router } from "express";
import type { Db } from "@paperclipai/db";
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
import { accessService, companyPortabilityService, companyService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo, requirePermission } from "./authz.js";

export function companyRoutes(db: Db) {
  const router = Router();
  const svc = companyService(db);
  const portability = companyPortabilityService(db);
  const access = accessService(db);

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
    await requirePermission(req, access, companyId, "company:export");
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      await requirePermission(req, access, req.body.target.companyId, "company:export");
    } else {
      assertBoard(req);
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        throw forbidden("Instance admin required for new company import");
      }
    }
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      await requirePermission(req, access, req.body.target.companyId, "company:export");
    } else {
      assertBoard(req);
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        throw forbidden("Instance admin required for new company import");
      }
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
    const creatorUserId = req.actor.userId ?? "local-board";
    await access.ensureMembership(company.id, "user", creatorUserId, "owner", "active");
    // Auto-grant owner permissions to company creator
    const ownerPreset = ROLE_PRESETS.find((p) => p.id === "owner");
    if (ownerPreset) {
      const membership = await access.getMembership(company.id, "user", creatorUserId);
      if (membership) {
        await access.setMemberPermissions(
          company.id,
          membership.id,
          ownerPreset.permissions.map((key) => ({ permissionKey: key })),
          req.actor.userId ?? null,
        );
      }
    }
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    res.status(201).json(company);
  });

  router.patch("/:companyId", validate(updateCompanySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const allowed = await access.canUser(companyId, req.actor.userId, "company:settings");
        if (!allowed) throw forbidden("Missing permission: company:settings");
      }
    } else {
      throw forbidden("Board access required");
    }

    // Deep-merge settings if provided (so partial updates don't clobber other keys)
    if (req.body.settings) {
      const existing = await svc.getById(companyId);
      if (!existing) {
        res.status(404).json({ error: "Company not found" });
        return;
      }
      const existingSettings = (existing.settings ?? {}) as Record<string, unknown>;
      req.body.settings = { ...existingSettings, ...req.body.settings };
    }

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
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const allowed = await access.canUser(companyId, req.actor.userId, "company:settings");
        if (!allowed) throw forbidden("Missing permission: company:settings");
      }
    } else {
      throw forbidden("Board access required");
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
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const allowed = await access.canUser(companyId, req.actor.userId, "company:settings");
        if (!allowed) throw forbidden("Missing permission: company:settings");
      }
    } else {
      throw forbidden("Board access required");
    }
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
