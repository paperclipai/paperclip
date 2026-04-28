import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2SemanticIndexService, type Rt2SemanticIndexMode } from "../services/rt2-semantic-index.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2SemanticIndexRoutes(db: Db) {
  const router = Router();
  const service = rt2SemanticIndexService(db);

  router.get("/companies/:companyId/rt2/semantic-index/status", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const status = await service.getStatus(companyId);
      return res.json(status);
    } catch (error) {
      console.error("Error getting RT2 semantic index status:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/companies/:companyId/rt2/semantic-index/reindex", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const mode = normalizeMode(req.body?.mode ?? req.query.mode);
      if (!mode) {
        return res.status(400).json({ error: "mode must be 'full' or 'changed'" });
      }

      const result = await service.reindexCompany(companyId, { mode });
      return res.json(result);
    } catch (error) {
      console.error("Error rebuilding RT2 semantic index:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

function normalizeMode(value: unknown): Rt2SemanticIndexMode | null {
  if (value === undefined || value === null || value === "") return "changed";
  if (value === "full" || value === "changed") return value;
  return null;
}
