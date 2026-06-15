import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { analyticsService, type ModelUsageGroupBy } from "../services/analytics.js";
import { accessService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import { parseCostDateRange } from "./costs.js";
import { badRequest } from "../errors.js";

const VALID_GROUP_BY = new Set<string>(["model", "agent", "provider", "taskType"]);

export function analyticsRoutes(db: Db) {
  const router = Router();
  const analytics = analyticsService(db);
  const access = accessService(db);

  async function assertCostReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Analytics are outside this actor's authorization boundary" });
    return false;
  }

  async function handleModelUsage(req: Parameters<typeof assertCompanyAccess>[0], res: any, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (!(await assertCostReadAllowed(req, res, companyId))) return;

    const groupByRaw = req.query.groupBy as string | undefined;
    if (groupByRaw != null && !VALID_GROUP_BY.has(groupByRaw)) {
      throw badRequest(`invalid 'groupBy' value; must be one of: ${[...VALID_GROUP_BY].join(", ")}`);
    }

    const range = parseCostDateRange(req.query);
    const rows = await analytics.modelUsage(companyId, {
      from: range?.from,
      to: range?.to,
      groupBy: (groupByRaw as ModelUsageGroupBy) ?? "model",
    });

    res.json({ groupBy: groupByRaw ?? "model", rows });
  }

  // Path-param form: /companies/:companyId/analytics/model-usage
  router.get("/companies/:companyId/analytics/model-usage", async (req, res) => {
    await handleModelUsage(req, res, req.params.companyId as string);
  });

  // Query-param form: /analytics/model-usage?companyId=...  (used by agents/TODD)
  router.get("/analytics/model-usage", async (req, res) => {
    const companyId = req.query.companyId as string | undefined;
    if (!companyId) throw badRequest("'companyId' query parameter is required");
    await handleModelUsage(req, res, companyId);
  });

  return router;
}
