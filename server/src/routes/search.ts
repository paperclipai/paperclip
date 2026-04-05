import { Router } from "express";
import { assertCompanyAccess } from "./authz.js";
import { webSearch } from "../services/web-search.js";

export function searchRoutes() {
  const router = Router();

  /**
   * GET /api/companies/:companyId/search?q=QUERY&limit=5
   *
   * Company-scoped web search via SearXNG. Returns up to `limit` results
   * (default 5, max 20). Returns an empty array if SearXNG is unreachable.
   */
  router.get("/companies/:companyId/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "Missing required query parameter: q" });
      return;
    }

    const limitParam = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 5;
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 20) : 5;

    const results = await webSearch(q, limit);
    res.json({ query: q, results });
  });

  return router;
}
