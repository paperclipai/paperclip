import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { requestMcDispatchFallbackSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { mcDispatchFallbackService } from "../services/mc-dispatch-fallback.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

/**
 * Jarvis-OS Phase-4 4c-3 — mc-dispatch fallback endpoint.
 *
 * Hermes-Health-Observer (separate Hermes-side script, 4c-1) POSTs this when
 * Hermes is down for >= threshold and an issue is fallback-eligible.
 *
 * Per 4D-2 + 4D-6 auth model: assertInstanceAdmin OR a future scoped capability.
 * For Wave 1 we require instance-admin to avoid accidental fallback storms
 * from misconfigured workers.
 */
export function mcDispatchFallbackRoutes(db: Db) {
  const router = Router();
  const svc = mcDispatchFallbackService(db);

  router.post(
    "/api/internal/fallback/mc-dispatch",
    validate(requestMcDispatchFallbackSchema),
    async (req, res) => {
      assertBoard(req);
      assertInstanceAdmin(req);
      assertCompanyAccess(req, req.body.companyId as string);
      const result = await svc.recordDecision(req.body);
      const accepted = result.outcome === "accepted-dry-run" || result.outcome === "accepted-spawned";
      res.status(accepted ? 200 : 409).json({
        accepted,
        mode: "mc-dispatch",
        outcome: result.outcome,
        legacyTaskId: result.legacyTaskId,
        issueRunId: result.issueRunId,
        warnings: result.warnings,
      });
    },
  );

  router.post(
    "/api/internal/fallback/mc-dispatch/evaluate",
    validate(requestMcDispatchFallbackSchema.pick({ companyId: true, issueId: true })),
    async (req, res) => {
      assertBoard(req);
      assertInstanceAdmin(req);
      assertCompanyAccess(req, req.body.companyId as string);
      const result = await svc.evaluate(req.body);
      res.json(result);
    },
  );

  router.get("/api/internal/fallback/mc-dispatch/eligible-issues", async (req, res) => {
    assertBoard(req);
    assertInstanceAdmin(req);
    const companyId = req.query.companyId;
    if (typeof companyId !== "string" || companyId.length === 0) {
      res.status(400).json({ error: "companyId query param required" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const limitRaw = req.query.limit;
    let limit: number | undefined;
    if (typeof limitRaw === "string" && limitRaw.length > 0) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        res.status(400).json({ error: "limit must be positive integer" });
        return;
      }
      limit = parsed;
    }
    const issues = await svc.listEligibleIssues({ companyId, limit });
    res.json({ companyId, issues });
  });

  return router;
}
