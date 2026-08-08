import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createFolderSchema,
  ensureMySkillFolderSchema,
  folderKindSchema,
  moveFolderItemSchema,
  moveFolderSchema,
  updateFolderSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { badRequest, forbidden } from "../errors.js";
import { folderService, logActivity } from "../services/index.js";
import { FolderMigrationService } from "../services/folder-migration.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function folderRoutes(db: Db) {
  const router = Router();
  const svc = folderService(db);

  function parseKind(value: unknown) {
    const result = folderKindSchema.safeParse(value);
    if (!result.success) throw badRequest("Folder kind query parameter is required");
    return result.data;
  }

  router.get("/companies/:companyId/folders", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId, parseKind(req.query.kind)));
  });

  router.post("/companies/:companyId/folders", validate(createFolderSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const created = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "folder.created",
      entityType: "folder",
      entityId: created.id,
      details: { kind: created.kind, name: created.name, path: created.path, parentId: created.parentId, position: created.position },
    });
    res.status(201).json(created);
  });

  router.post(
    "/companies/:companyId/folders/ensure-my",
    validate(ensureMySkillFolderSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board" || !req.actor.userId) {
        throw forbidden("A signed-in board user is required to create a personal skill folder");
      }
      const folder = await svc.ensureMyFolder(companyId, req.actor.userId, req.actor.userName ?? null, req.body.slug);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "folder.personal_ensured",
        entityType: "folder",
        entityId: folder.id,
        details: { path: folder.path, systemKey: folder.systemKey },
      });
      res.json(folder);
    },
  );

  router.patch("/companies/:companyId/folders/:folderId", validate(updateFolderSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const folderId = req.params.folderId as string;
    assertCompanyAccess(req, companyId);
    const updated = await svc.update(companyId, folderId, req.body);
    if (!updated) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "folder.updated",
      entityType: "folder",
      entityId: updated.id,
      details: { kind: updated.kind, name: updated.name, path: updated.path, position: updated.position },
    });
    res.json(updated);
  });

  router.post("/companies/:companyId/folders/items/move", validate(moveFolderItemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const moved = await svc.moveItem(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "folder.item_moved",
      entityType: req.body.kind === "routine" ? "routine" : "company_skill",
      entityId: moved.itemId,
      details: { kind: moved.kind, folderId: moved.folderId },
    });
    res.json(moved);
  });

  router.post("/companies/:companyId/folders/:folderId/move", validate(moveFolderSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const folderId = req.params.folderId as string;
    assertCompanyAccess(req, companyId);
    const updated = await svc.moveFolder(companyId, folderId, req.body);
    if (!updated) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "folder.moved",
      entityType: "folder",
      entityId: updated.id,
      details: { kind: updated.kind, parentId: updated.parentId, path: updated.path, position: updated.position },
    });
    res.json(updated);
  });

  router.delete("/companies/:companyId/folders/:folderId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const folderId = req.params.folderId as string;
    assertCompanyAccess(req, companyId);
    const deleted = await svc.deleteFolder(companyId, folderId);
    if (!deleted) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "folder.deleted",
      entityType: "folder",
      entityId: deleted.id,
      details: { kind: deleted.kind, name: deleted.name },
    });
    res.json({ deleted });
  });

  // ── Folder Migration ────────────────────────────────────────

  /** GET /companies/:companyId/folders/migration-preview — Preview unassigned agents */
  router.get(
    "/companies/:companyId/folders/migration-preview",
    assertBoard,
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        const migrationService = new FolderMigrationService(db);
        const summary = await migrationService.getUnassignedSummary(companyId);
        res.json(summary);
      } catch (err) {
        next(err);
      }
    },
  );

  /** POST /companies/:companyId/folders/migrate-by-role — Migrate unassigned agents to role folders */
  router.post(
    "/companies/:companyId/folders/migrate-by-role",
    assertBoard,
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        const actor = getActorInfo(req);
        const migrationService = new FolderMigrationService(db);
        const result = await migrationService.migrateByRole(companyId);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "folder.migration_by_role",
          entityType: "folder",
          entityId: "",
          details: { total: result.totalUnassigned, groups: result.groupsCreated },
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  /** POST /companies/:companyId/folders/migrate-by-metadata — Migrate unassigned agents grouped by a metadata key */
  router.post(
    "/companies/:companyId/folders/migrate-by-metadata",
    assertBoard,
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        const key = req.body?.key;
        if (typeof key !== "string" || key.trim() === "") {
          res.status(400).json({ error: "metadata key is required in request body" });
          return;
        }
        const actor = getActorInfo(req);
        const migrationService = new FolderMigrationService(db);
        const result = await migrationService.migrateByMetadataKey(companyId, key);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "folder.migration_by_metadata",
          entityType: "folder",
          entityId: "",
          details: { key, total: result.totalUnassigned, groups: result.groupsCreated },
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  /** POST /companies/:companyId/folders/migrate-to-folder — Migrate a list of agents into a named folder */
  router.post(
    "/companies/:companyId/folders/migrate-to-folder",
    assertBoard,
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        const folderName = req.body?.folderName;
        const agentIds = req.body?.agentIds;
        if (typeof folderName !== "string" || folderName.trim() === "") {
          res.status(400).json({ error: "folderName is required in request body" });
          return;
        }
        if (!Array.isArray(agentIds) || agentIds.length === 0) {
          res.status(400).json({ error: "agentIds array is required in request body" });
          return;
        }
        const actor = getActorInfo(req);
        const migrationService = new FolderMigrationService(db);
        const result = await migrationService.migrateToCustomFolder(companyId, folderName, agentIds);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "folder.migration_to_folder",
          entityType: "folder",
          entityId: "",
          details: { folderName, total: result.totalUnassigned, foldersCreated: result.foldersCreated },
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  /** POST /companies/:companyId/folders/validate-inheritance — Validate folder inheritance chain */
  router.post(
    "/companies/:companyId/folders/validate-inheritance",
    assertBoard,
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        const actor = getActorInfo(req);
        const migrationService = new FolderMigrationService(db);
        const result = await migrationService.validateInheritance(companyId);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "folder.inheritance_validated",
          entityType: "folder",
          entityId: "",
          details: { issueCount: result.issueCount, totalAgents: result.totalAgents },
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  /** GET /companies/:companyId/folders/validate-inheritance — Validate folder inheritance chain (GET convenience) */
  router.get(
    "/companies/:companyId/folders/validate-inheritance",
    assertBoard,
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        const migrationService = new FolderMigrationService(db);
        const result = await migrationService.validateInheritance(companyId);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );


  return router;
}
