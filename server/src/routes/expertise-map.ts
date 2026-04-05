import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { computeExpertiseMap, suggestAssignee } from "../services/expertise-map.js";
import { assertCompanyAccess } from "./authz.js";

export function expertiseMapRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/expertise-map/skills", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const result = await computeExpertiseMap(db, companyId);
    res.json(result);
  });

  router.get("/companies/:companyId/expertise-map/suggest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const labelsParam = typeof req.query.labels === "string" ? req.query.labels : "";
    const labelNames = labelsParam.split(",").filter(Boolean);

    if (labelNames.length === 0) {
      res.status(400).json({ error: "labels query parameter is required (comma-separated)" });
      return;
    }

    const suggestion = await suggestAssignee(db, companyId, labelNames);
    res.json(suggestion ?? { agentId: null, agentName: null, score: 0 });
  });

  return router;
}
