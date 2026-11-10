import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  parseUiLayoutForSurface,
  uiLayoutSurfaceSchema,
  upsertUiLayoutSchema,
  type UiLayoutSurface,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { uiLayoutService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

function requireSurface(req: Request): UiLayoutSurface {
  const parsed = uiLayoutSurfaceSchema.safeParse(req.params.surface);
  if (!parsed.success) throw notFound("Unknown UI layout surface");
  return parsed.data;
}

export function uiLayoutRoutes(db: Db) {
  const router = Router();
  const svc = uiLayoutService(db);

  router.get("/companies/:companyId/ui-layouts/:surface/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.get(companyId, userId, requireSurface(req)));
  });

  router.put(
    "/companies/:companyId/ui-layouts/:surface/me",
    validate(upsertUiLayoutSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireBoardUserId(req, res);
      if (!userId) return;
      const surface = requireSurface(req);

      const parsed = parseUiLayoutForSurface(surface, req.body.layout);
      if (!parsed.ok) throw badRequest(parsed.error);

      const result = await svc.upsert(companyId, userId, surface, {
        layout: parsed.layout as Record<string, unknown>,
        schemaVersion: parsed.schemaVersion,
      });
      res.json(result);
    },
  );

  router.delete("/companies/:companyId/ui-layouts/:surface/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const surface = requireSurface(req);

    const result = await svc.remove(companyId, userId, surface);
    res.json(result);
  });

  return router;
}
