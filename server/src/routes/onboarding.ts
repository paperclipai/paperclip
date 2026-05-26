import {
  onboardingApplyRequestSchema,
  onboardingRecommendationRequestSchema,
  onboardingScanRequestSchema,
} from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { Router } from "express";

import { validate } from "../middleware/validate.js";
import { applyOnboardingSetup } from "../services/onboarding-apply.js";
import { pickOnboardingDirectory } from "../services/onboarding-directory-picker.js";
import {
  getOnboardingAdapterOptions,
  recommendOnboardingSetupWithAi,
} from "../services/onboarding-recommend.js";
import { scanOnboardingDirectory } from "../services/onboarding-scan.js";
import { assertBoard, getActorInfo } from "./authz.js";

export function onboardingRoutes(db?: Db) {
  const router = Router();

  router.post("/onboarding/scan", validate(onboardingScanRequestSchema), async (req, res) => {
    assertBoard(req);
    res.json(await scanOnboardingDirectory(req.body));
  });

  router.post("/onboarding/pick-directory", async (req, res) => {
    assertBoard(req);
    res.json(await pickOnboardingDirectory());
  });

  router.get("/onboarding/adapter-options", async (req, res) => {
    assertBoard(req);
    res.json(await getOnboardingAdapterOptions());
  });

  router.post("/onboarding/recommend", validate(onboardingRecommendationRequestSchema), async (req, res) => {
    assertBoard(req);
    res.json(await recommendOnboardingSetupWithAi(req.body));
  });

  if (db) {
    router.post("/onboarding/apply", validate(onboardingApplyRequestSchema), async (req, res) => {
      assertBoard(req);
      const actor = getActorInfo(req);
      const result = await applyOnboardingSetup(db, req.body, {
        actorType: actor.actorType === "user" ? "user" : "system",
        actorId: actor.actorId,
      });
      res.status(201).json(result);
    });
  }

  return router;
}
