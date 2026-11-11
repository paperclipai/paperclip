import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  parseUiLayoutForSurface,
  uiLayoutSurfaceSchema,
  upsertUiLayoutSchema,
  type UiLayoutSurface,
} from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { uiLayoutService } from "../services/index.js";
import { assertBoard, hasCompanyAccess } from "./authz.js";

function requireLayoutOwner(req: Request, companyId: string): string {
  assertBoard(req);
  if (!hasCompanyAccess(req, companyId)) throw forbidden("User does not have access to this company");
  if (!req.actor.userId) throw forbidden("Board user access required");
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin
    && !req.actor.memberships?.some((member) => member.companyId === companyId && member.status === "active")) {
    throw forbidden("User does not have active company access");
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
    const userId = requireLayoutOwner(req, companyId);
    res.json(await svc.get(companyId, userId, requireSurface(req)));
  });

  router.put(
    "/companies/:companyId/ui-layouts/:surface/me",
    validate(upsertUiLayoutSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = requireLayoutOwner(req, companyId);
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
    const userId = requireLayoutOwner(req, companyId);
    const surface = requireSurface(req);

    const result = await svc.remove(companyId, userId, surface);
    res.json(result);
  });

  return router;
}
