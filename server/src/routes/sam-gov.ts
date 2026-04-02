import { Router } from "express";
import { samGovService, type SamSearchParams } from "../services/sam-gov.js";

/**
 * SAM.gov proxy routes.
 *
 * GET /sam/opportunities          — search federal contract opportunities
 * GET /sam/opportunities/:noticeId — get a single opportunity by notice ID
 */
export function samGovRoutes(samApiKey: string | undefined) {
  const router = Router();

  // Guard: all routes require a configured API key
  router.use((_req, res, next) => {
    if (!samApiKey) {
      res.status(503).json({
        error: "SAM.gov integration is not configured. Set the SAM_API_KEY environment variable.",
      });
      return;
    }
    next();
  });

  router.get("/opportunities", async (req, res) => {
    try {
      const service = samGovService(samApiKey!);

      // Default date range: last 30 days
      const now = new Date();
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const fmt = (d: Date) =>
        `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

      const params: SamSearchParams = {
        postedFrom: (req.query.postedFrom as string) || fmt(thirtyDaysAgo),
        postedTo: (req.query.postedTo as string) || fmt(now),
        limit: req.query.limit ? Number(req.query.limit) : 10,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      };

      // Pass through optional filters
      const optionalKeys: (keyof SamSearchParams)[] = [
        "ptype",
        "solnum",
        "noticeid",
        "title",
        "state",
        "zip",
        "ncode",
        "ccode",
        "typeOfSetAside",
        "organizationName",
        "rdlfrom",
        "rdlto",
      ];
      for (const key of optionalKeys) {
        const val = req.query[key];
        if (typeof val === "string" && val.length > 0) {
          (params as unknown as Record<string, unknown>)[key] = val;
        }
      }

      const result = await service.search(params);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(502).json({ error: message });
    }
  });

  router.get("/opportunities/:noticeId", async (req, res) => {
    try {
      const service = samGovService(samApiKey!);
      const opportunity = await service.getOpportunity(req.params.noticeId);

      if (!opportunity) {
        res.status(404).json({ error: "Opportunity not found" });
        return;
      }

      res.json(opportunity);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(502).json({ error: message });
    }
  });

  return router;
}
