import type { Db } from "@paperclipai/db";
import { adapterReadinessProbeRequestSchema } from "@paperclipai/shared";
import { Router } from "express";

import { adapterReadinessService } from "../services/adapter-readiness/index.js";
import { onboardingSetupStateService } from "../services/onboarding-setup-state.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function adapterReadinessRoutes(db: Db) {
  const router = Router();
  const service = adapterReadinessService(db);
  const onboardingSetup = onboardingSetupStateService(db);

  router.get("/companies/:companyId/agents/:agentId/adapter-readiness", async (req, res) => {
    const { companyId, agentId } = req.params;
    assertCompanyAccess(req, companyId);

    res.json(await service.getLatestForAgent(companyId, agentId));
  });

  router.post("/companies/:companyId/agents/:agentId/adapter-readiness/probe", async (req, res) => {
    const { companyId, agentId } = req.params;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const body = adapterReadinessProbeRequestSchema.parse(req.body);
    const actor = getActorInfo(req);

    const readiness = await service.probeAgent(companyId, agentId, {
      adapterType: body.adapterType,
      strictMode: body.strictMode ?? false,
      checkedByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await onboardingSetup.refreshFromEvidence(companyId);
    res.json(readiness);
  });

  return router;
}
