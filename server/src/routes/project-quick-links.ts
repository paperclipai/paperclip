import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createProjectQuickLinkSchema,
  previewProjectQuickLinkSchema,
  updateProjectQuickLinkSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, projectQuickLinkService } from "../services/index.js";
import type { ProjectQuickLinkPreviewFetcher } from "../services/project-quick-link-preview.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

type ProjectQuickLinkRoutesOptions = {
  previewFetcher?: ProjectQuickLinkPreviewFetcher;
};

export function projectQuickLinkRoutes(db: Db, options: ProjectQuickLinkRoutesOptions = {}) {
  const router = Router();
  const svc = projectQuickLinkService(db, options);

  router.get("/companies/:companyId/projects/:projectId/quick-links", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId, projectId));
  });

  router.post(
    "/companies/:companyId/projects/:projectId/quick-links/preview",
    validate(previewProjectQuickLinkSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      assertCompanyAccess(req, companyId);
      res.json(await svc.preview(companyId, projectId, req.body.url));
    },
  );

  router.post(
    "/companies/:companyId/projects/:projectId/quick-links",
    validate(createProjectQuickLinkSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const link = await svc.create(companyId, projectId, {
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
        action: "project.quick_link_created",
        entityType: "project_quick_link",
        entityId: link.id,
        details: {
          projectId,
          title: link.title,
          url: link.url,
        },
      });
      res.status(201).json(link);
    },
  );

  router.patch(
    "/companies/:companyId/projects/:projectId/quick-links/:linkId",
    validate(updateProjectQuickLinkSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      const linkId = req.params.linkId as string;
      assertCompanyAccess(req, companyId);
      const link = await svc.update(companyId, projectId, linkId, req.body);
      if (!link) {
        res.status(404).json({ error: "Project quick link not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "project.quick_link_updated",
        entityType: "project_quick_link",
        entityId: link.id,
        details: {
          projectId,
          changedKeys: Object.keys(req.body).sort(),
        },
      });
      res.json(link);
    },
  );

  router.delete("/companies/:companyId/projects/:projectId/quick-links/:linkId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    const linkId = req.params.linkId as string;
    assertCompanyAccess(req, companyId);
    const link = await svc.remove(companyId, projectId, linkId);
    if (!link) {
      res.status(404).json({ error: "Project quick link not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.quick_link_deleted",
      entityType: "project_quick_link",
      entityId: link.id,
      details: {
        projectId,
        title: link.title,
        url: link.url,
      },
    });
    res.json(link);
  });

  return router;
}
