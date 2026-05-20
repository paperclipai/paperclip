import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { DashboardTokenUsageRange } from "@paperclipai/shared";
import { dashboardService } from "../services/dashboard.js";
import { badRequest } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

function parseTokenUsageRange(raw: unknown): DashboardTokenUsageRange {
  if (raw == null) return "daily";
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "daily" || value === "weekly" || value === "monthly") return value;
  throw badRequest("invalid 'range' value");
}

function parseOptionalAgentId(raw: unknown): string | null {
  if (raw == null) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") throw badRequest("invalid 'agentId' value");
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  router.get("/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  router.get("/:companyId/dashboard/token-usage", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseTokenUsageRange(req.query.range);
    const agentId = parseOptionalAgentId(req.query.agentId);
    const usage = await svc.tokenUsage(companyId, { range, agentId });
    res.json(usage);
  });

  return router;
}
