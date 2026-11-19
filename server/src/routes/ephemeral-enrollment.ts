import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { verifiedCloudControlClaims } from "../middleware/cloud-control.js";
import { prepareOnlineEphemeralEnrollment, readOnlineEphemeralEnrollmentEligibility } from "../services/ephemeral-enrollment.js";
import { runOnlineDurableDataMigration } from "../services/online-durable-data-migration.js";

const ONLINE_MIGRATION_BUDGET_MS = 60_000;

export function ephemeralEnrollmentRoutes(db: Db) {
  const router = Router();
  router.post("/instance/ephemeral-enrollment/prepare", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.actor.source !== "cloud_control") { res.status(403).json({ error: "cloud_control_required" }); return; }
    next();
  }, validate(z.object({ attemptId: z.string().uuid() }).strict()), async (req, res) => {
    const claims = verifiedCloudControlClaims(req);
    if (claims?.action !== "ephemeral-enrollment:prepare") { res.status(403).json({ error: "cloud_control_required" }); return; }
    res.json(await prepareOnlineEphemeralEnrollment(db, req.body.attemptId, claims));
  });
  router.get("/instance/ephemeral-enrollment/eligibility", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const claims = req.actor.source === "cloud_control" ? verifiedCloudControlClaims(req) : undefined;
    if (claims?.action !== "ephemeral-enrollment:eligibility") { res.status(403).json({ error: "cloud_control_required" }); return; }
    res.json(await readOnlineEphemeralEnrollmentEligibility(db));
  });
  router.post("/instance/ephemeral-enrollment/migrate", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.actor.source !== "cloud_control") { res.status(403).json({ error: "cloud_control_required" }); return; }
    next();
  }, validate(z.object({}).strict()), async (req, res) => {
    if (verifiedCloudControlClaims(req)?.action !== "ephemeral-enrollment:migrate") { res.status(403).json({ error: "cloud_control_required" }); return; }
    res.json(await runOnlineDurableDataMigration(db, { budgetMs: ONLINE_MIGRATION_BUDGET_MS }));
  });
  return router;
}
