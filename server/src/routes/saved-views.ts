import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { savedViewService } from "../services/saved-views.js";
import { assertCompanyAccess } from "./authz.js";

const VALID_SORT_FIELDS = ["updated", "created", "priority", "status", "identifier"] as const;
const VALID_SORT_DIRECTIONS = ["asc", "desc"] as const;
const VALID_GROUP_BY = ["none", "status", "priority", "assignee", "label"] as const;

export function savedViewRoutes(db: Db) {
  const router = Router();
  const svc = savedViewService(db);

  router.get("/companies/:companyId/saved-views", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const views = await svc.list(companyId);
    res.json(views);
  });

  router.post("/companies/:companyId/saved-views", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { name, filters, groupBy, sortField, sortDirection } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (name.length > 255) {
      res.status(400).json({ error: "name must be 255 characters or fewer" });
      return;
    }
    if (sortField !== undefined && !VALID_SORT_FIELDS.includes(sortField)) {
      res.status(400).json({ error: `sortField must be one of: ${VALID_SORT_FIELDS.join(", ")}` });
      return;
    }
    if (sortDirection !== undefined && !VALID_SORT_DIRECTIONS.includes(sortDirection)) {
      res.status(400).json({ error: `sortDirection must be one of: ${VALID_SORT_DIRECTIONS.join(", ")}` });
      return;
    }
    if (groupBy !== undefined && !VALID_GROUP_BY.includes(groupBy)) {
      res.status(400).json({ error: `groupBy must be one of: ${VALID_GROUP_BY.join(", ")}` });
      return;
    }
    const existing = await svc.list(companyId);
    if (existing.length >= 50) {
      res.status(400).json({ error: "Maximum 50 saved views per company" });
      return;
    }
    const view = await svc.create(companyId, {
      name,
      filters: filters ?? { statuses: [], priorities: [], assignees: [], labels: [] },
      groupBy: groupBy ?? "none",
      sortField: sortField ?? "updated",
      sortDirection: sortDirection ?? "desc",
    });
    res.status(201).json(view);
  });

  router.patch("/companies/:companyId/saved-views/:viewId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const viewId = req.params.viewId as string;
    assertCompanyAccess(req, companyId);
    const { name, filters, groupBy, sortField, sortDirection } = req.body;
    if (name !== undefined && (typeof name !== "string" || name.trim().length === 0 || name.length > 255)) {
      res.status(400).json({ error: "name must be a non-empty string of 255 characters or fewer" });
      return;
    }
    if (sortField !== undefined && !VALID_SORT_FIELDS.includes(sortField)) {
      res.status(400).json({ error: `sortField must be one of: ${VALID_SORT_FIELDS.join(", ")}` });
      return;
    }
    if (sortDirection !== undefined && !VALID_SORT_DIRECTIONS.includes(sortDirection)) {
      res.status(400).json({ error: `sortDirection must be one of: ${VALID_SORT_DIRECTIONS.join(", ")}` });
      return;
    }
    if (groupBy !== undefined && !VALID_GROUP_BY.includes(groupBy)) {
      res.status(400).json({ error: `groupBy must be one of: ${VALID_GROUP_BY.join(", ")}` });
      return;
    }
    const view = await svc.update(viewId, companyId, {
      name,
      filters,
      groupBy,
      sortField,
      sortDirection,
    });
    res.json(view);
  });

  router.delete("/companies/:companyId/saved-views/:viewId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const viewId = req.params.viewId as string;
    assertCompanyAccess(req, companyId);
    await svc.remove(viewId, companyId);
    res.json({ ok: true });
  });

  return router;
}
