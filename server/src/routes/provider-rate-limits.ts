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

    // Read the block first (without mutating it) and verify tenant ownership.
    const existing = await svc.getBlock(blockId);
    if (!existing || existing.companyId !== companyId) {
      throw notFound("Rate limit block not found");
    }

    // Check the live quota window *before* resolving. If the provider window is
    // still exhausted we leave the block — and its issue-member associations —
    // intact rather than resolving and re-creating a fresh, memberless block.
    const stillBlocked = await svc.isWindowStillBlocked(existing.adapterType, existing.limitKind);
    if (stillBlocked) {
      res.json({ released: false, reason: "limit_still_active" });
      return;
    }

    const block = await svc.resolveBlock(blockId, resolvedBy, companyId);
    if (!block) {
      throw notFound("Rate limit block not found");
    }

    await svc.releaseAndResumeForBlock(block);
    res.json({ released: true });
  });

  return router;
}
