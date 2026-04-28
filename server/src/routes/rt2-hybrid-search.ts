import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2HybridSearchService } from "../services/rt2-hybrid-search.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2HybridSearchRoutes(db: Db) {
  const router = Router();
  const searchService = rt2HybridSearchService(db);

  /**
   * GET /companies/:companyId/rt2/search
   * Search documents and wiki pages
   */
  router.get("/companies/:companyId/rt2/search", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      const query = req.query.q as string;

      assertCompanyAccess(req, companyId);

      if (!query || query.trim().length === 0) {
        return res.status(400).json({ error: "Query parameter 'q' is required" });
      }

      const options = {
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
        type: (req.query.type ?? req.query.sourceType) as
          | "all"
          | "document"
          | "wiki_page"
          | "daily_wiki_page"
          | "task"
          | "deliverable"
          | "work_artifact"
          | "graph_node"
          | "graph_edge"
          | undefined,
        sourceType: req.query.sourceType as
          | "all"
          | "document"
          | "wiki_page"
          | "daily_wiki_page"
          | "task"
          | "deliverable"
          | "work_artifact"
          | "graph_node"
          | "graph_edge"
          | undefined,
        projectId: req.query.projectId as string | undefined,
        workObjectId: req.query.workObjectId as string | undefined,
        dateFrom: req.query.dateFrom as string | undefined,
        dateTo: req.query.dateTo as string | undefined,
        confidence: req.query.confidence as string | undefined,
        contradictionStatus: req.query.contradictionStatus as
          | "all"
          | "none"
          | "unknown"
          | "unresolved"
          | "resolved"
          | undefined,
      };

      const results = await searchService.search(companyId, query, options);

      return res.json(results);
    } catch (error) {
      console.error("Error searching:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/search/stats
   * Get search index statistics
   */
  router.get("/companies/:companyId/rt2/search/stats", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;

      assertCompanyAccess(req, companyId);

      const stats = await searchService.getSearchStats(companyId);

      return res.json(stats);
    } catch (error) {
      console.error("Error getting search stats:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/search/reindex
   * Trigger index rebuild
   */
  router.post("/companies/:companyId/rt2/search/reindex", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;

      assertCompanyAccess(req, companyId);

      const result = await searchService.rebuildIndex(companyId);

      return res.json(result);
    } catch (error) {
      console.error("Error rebuilding index:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
