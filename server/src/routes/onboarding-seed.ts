import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { applyOnboardingSeedSchema } from "@paperclipai/shared";
import { validate } from "../middleware/index.js";
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
 *
 * "Every part" includes the audit entry, which `apply` writes inside the same
 * transaction as the seed. Because Cloud stops retrying on a 2xx, anything this
 * route reports as applied must already be durable — a half that can still be
 * lost after the response is a half that is lost for good.
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

      // The audit entry is written inside `apply`'s own transaction, so it
      // commits with the seed or not at all. A logging failure therefore rolls
      // the seed back and surfaces as a 500 — which is the *recoverable*
      // outcome, because Cloud's retry then finds no stored revision, re-applies
      // and re-logs. Handling it here instead, as this route used to, could only
      // pick which half to lose: 500 and the retry reports `changed: false` and
      // never logs; 200 and Cloud stops retrying with the entry still absent.
      const result = await svc.apply(companyId, req.body, getActorInfo(req));

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
