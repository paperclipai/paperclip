import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { prepareOnlineEphemeralEnrollment } from "../services/ephemeral-enrollment.js";

export function ephemeralEnrollmentRoutes(db: Db) {
  const router = Router();
  router.post("/instance/ephemeral-enrollment/prepare", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.actor.source !== "cloud_control") { res.status(403).json({ error: "cloud_control_required" }); return; }
    next();
  }, validate(z.object({ attemptId: z.string().uuid() }).strict()), async (req, res) => {
    res.json(await prepareOnlineEphemeralEnrollment(db, req.body.attemptId));
  });
  return router;
}
