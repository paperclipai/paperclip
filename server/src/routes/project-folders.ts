import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createProjectFolderSchema,
  updateProjectFolderSchema,
  reorderProjectFoldersSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { projectFolderService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function projectFolderRoutes(db: Db) {
  const router = Router();
  const svc = projectFolderService(db);

  // List all folders for a company
  router.get("/companies/:companyId/project-folders", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const folders = await svc.list(companyId);
    res.json(folders);
  });

  // Create a folder
  router.post(
    "/companies/:companyId/project-folders",
    validate(createProjectFolderSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const folder = await svc.create(companyId, req.body as { name: string; sortOrder?: number });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project_folder.created",
        entityType: "project_folder",
        entityId: folder.id,
        details: { name: folder.name },
      });

      res.status(201).json(folder);
    },
  );

  // Reorder folders (bulk sortOrder update)
  router.put(
    "/companies/:companyId/project-folders/order",
    validate(reorderProjectFoldersSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { orderedIds } = req.body as { orderedIds: string[] };
      await svc.reorder(companyId, orderedIds);
      const folders = await svc.list(companyId);
      res.json(folders);
    },
  );

  // Update a folder
  router.patch(
    "/companies/:companyId/project-folders/:folderId",
    validate(updateProjectFolderSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const folderId = req.params.folderId as string;
      assertCompanyAccess(req, companyId);

      const existing = await svc.getById(folderId);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Project folder not found" });
        return;
      }

      const folder = await svc.update(folderId, req.body as { name?: string; sortOrder?: number });
      if (!folder) {
        res.status(404).json({ error: "Project folder not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project_folder.updated",
        entityType: "project_folder",
        entityId: folder.id,
        details: { changedKeys: Object.keys(req.body).sort() },
      });

      res.json(folder);
    },
  );

  // Delete a folder (projects in it become uncategorized)
  router.delete("/companies/:companyId/project-folders/:folderId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const folderId = req.params.folderId as string;
    assertCompanyAccess(req, companyId);

    const existing = await svc.getById(folderId);
    if (!existing || existing.companyId !== companyId) {
      res.status(404).json({ error: "Project folder not found" });
      return;
    }

    const folder = await svc.remove(folderId);
    if (!folder) {
      res.status(404).json({ error: "Project folder not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project_folder.deleted",
      entityType: "project_folder",
      entityId: folder.id,
      details: { name: folder.name },
    });

    res.json(folder);
  });

  return router;
}
