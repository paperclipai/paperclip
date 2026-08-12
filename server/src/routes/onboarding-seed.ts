import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { applyOnboardingSeedSchema } from "@paperclipai/shared";
import { validate } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/index.js";
import { onboardingSeedService } from "../services/onboarding-seed.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Receiver for the onboarding seed Paperclip Cloud collects at signup and
 * pushes into the stack at activation.
 *
 * Authentication is the trusted Cloud envelope, resolved exactly as it is for
 * `POST /api/companies/:companyId/logo`: the `x-paperclip-cloud-*` headers
 * produce a company-scoped actor and `assertCompanyAccess` fails closed for
 * anyone else. The seed itself is customer free text and rides the JSON body
 * only — it is never read from a header. Every `x-paperclip-cloud-*` value is
 * derived server-side from the host plus verified domain records, which is
 * what makes that set trustworthy; customer free text must not be mixed into
 * it.
 *
 * Cloud treats any 2xx as "the tenant holds this content" and writes the
 * acknowledged revision only afterwards, retrying from the next portfolio
 * fetch otherwise. So this route answers 200 only once every part of the seed
 * has been applied, and a replay of an already-applied revision is a
 * successful no-op rather than a second agent and a second task.
 */
export function onboardingSeedRoutes(db: Db) {
  const router = Router();
  const svc = onboardingSeedService(db);

  router.post(
    "/companies/:companyId/onboarding-seed",
    validate(applyOnboardingSeedSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const result = await svc.apply(companyId, req.body);

      if (result.changed) {
        const actor = getActorInfo(req);
        // Best-effort. The seed and its revision are already committed by the
        // time we get here, and Cloud reads any 2xx as "applied" and stops
        // retrying. If this audit write threw and we let it 500, the retry
        // would come back `changed: false` and skip the log for good — the
        // entry would be permanently absent *and* the caller would have seen a
        // spurious failure for an application that succeeded. So a logging
        // failure is recorded server-side and the request still answers 200.
        try {
          await logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "company.onboarding_seed_applied",
            entityType: "company",
            entityId: companyId,
            details: {
              revision: result.revision,
              goalId: result.goalId,
              agentId: result.agentId,
              issueId: result.issueId,
            },
          });
        } catch (err) {
          logger.error(
            { err, companyId, revision: result.revision },
            "onboarding seed applied but its activity-log entry could not be written",
          );
        }
      }

      res.status(200).json({
        companyId,
        revision: result.revision,
        applied: true,
        changed: result.changed,
        goalId: result.goalId,
        agentId: result.agentId,
        issueId: result.issueId,
      });
    },
  );

  return router;
}
