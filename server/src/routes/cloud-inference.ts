import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  cloudTrialTelemetryEventSchema,
  migrateCloudTrialAgentsSchema,
} from "@paperclipai/shared";
import { forbidden, HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  getDefaultCloudTrialInferenceController,
  type CloudTrialInferenceController,
} from "../services/cloud-trial-inference.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { trackCloudPostHogEvent, trackCloudTrialExposure } from "../telemetry.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Internal OpenRouter reverse proxy mounted at `/api/internal/cloud-inference`.
 * Authenticated strictly via ephemeral per-run bearer tokens (never board cookies),
 * keeping the real Cloud-issued OpenRouter API key strictly on the server process.
 */
export function cloudInferenceInternalProxyRoutes(
  controller: CloudTrialInferenceController = getDefaultCloudTrialInferenceController(),
) {
  const router = Router();

  router.all("/v1/*subpath", async (req, res) => {
    const rawSubpath = (req.params as Record<string, string | string[]>).subpath;
    const subpath = Array.isArray(rawSubpath) ? rawSubpath.join("/") : rawSubpath ?? "";
    await controller.proxyOpenRouterRequest(req, res, subpath);
  });

  return router;
}

/**
 * Company-scoped board routes for inspecting Cloud starter inference status
 * and migrating trial agents onto a newly connected user AI subscription/key.
 */
export function cloudInferenceRoutes(
  db: Db,
  controller: CloudTrialInferenceController = getDefaultCloudTrialInferenceController(),
) {
  const router = Router();

  router.get("/companies/:companyId/cloud-inference/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const refreshUsage = req.query.refresh === "1" || req.query.refresh === "true";
    res.setHeader("Cache-Control", "no-store");
    res.json(
      await controller.getCompanyStatus(db, companyId, {
        refreshUsage,
        actor: req.actor,
      }),
    );
  });

  router.post(
    "/companies/:companyId/cloud-inference/migrate",
    validate(migrateCloudTrialAgentsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const membership = req.actor.memberships?.find(
        (m) => m.companyId === companyId && m.status === "active",
      );
      if (membership?.membershipRole === "viewer" && !req.actor.isInstanceAdmin) {
        throw forbidden("Viewers cannot migrate agent AI connections");
      }
      const actor = getActorInfo(req);
      try {
        const result = await controller.migrateTrialAgents(db, companyId, req.body, {
          userId: actor.actorId,
          actor: req.actor,
        });
        res.setHeader("Cache-Control", "no-store");
        res.json(result);
      } catch (err) {
        const errorCode =
          err instanceof HttpError
            ? `http_${err.status}`
            : "unexpected_error";
        trackCloudPostHogEvent(
          "cloud_trial.migration_failed",
          {
            provider: req.body?.provider ?? "unknown",
            auth_method: req.body?.method ?? "unknown",
            error_code: errorCode,
          },
          { userId: actor.actorId, companyId },
        );
        throw err;
      }
    },
  );

  router.post(
    "/companies/:companyId/cloud-inference/telemetry",
    validate(cloudTrialTelemetryEventSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const body = req.body as
        | { event: "onboarding_exposure"; surface: "onboarding_wizard" | "onboarding_seed" }
        | { event: "modal_shown"; trialAgentCount: number };
      if (body.event === "onboarding_exposure") {
        const experimental = await instanceSettingsService(db).getExperimental();
        trackCloudTrialExposure({
          surface: body.surface,
          userId: actor.actorId,
          companyId,
          enabledOverride: experimental.enableCloudTrialInference === true,
        });
      } else if (body.event === "modal_shown") {
        trackCloudPostHogEvent(
          "cloud_trial.modal_shown",
          { trial_agent_count: body.trialAgentCount },
          { userId: actor.actorId, companyId },
        );
      }
      res.status(204).end();
    },
  );

  return router;
}
