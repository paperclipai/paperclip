import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { providerRateLimitService } from "../services/provider-rate-limits.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";

export function providerRateLimitRoutes(db: Db) {
  const router = Router();
  const svc = providerRateLimitService(db);

  router.get("/companies/:companyId/provider-rate-limits", assertBoard, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const blocks = await svc.listActiveBlocks(companyId);
    res.json(blocks);
  });

  router.post("/companies/:companyId/provider-rate-limits/:blockId/release", assertBoard, async (req, res) => {
    const companyId = req.params.companyId as string;
    const blockId = req.params.blockId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const resolvedBy = actor.actorType === "user" ? `manual:${actor.actorId}` : "manual";

    const block = await svc.resolveBlock(blockId, resolvedBy);
    if (!block || block.companyId !== companyId) {
      throw notFound("Rate limit block not found");
    }

    const stillBlocked = await svc.isWindowStillBlocked(block.adapterType, block.limitKind);
    if (stillBlocked) {
      await svc.upsertBlock({
        companyId: block.companyId,
        adapterType: block.adapterType,
        limitKind: block.limitKind,
        modelFamily: block.modelFamily,
        message: block.message,
        resetsAt: block.resetsAt,
      });
      res.json({ released: false, reason: "limit_still_active" });
      return;
    }

    await svc.releaseAndResumeForBlock(block);
    res.json({ released: true });
  });

  return router;
}
