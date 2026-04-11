import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { createAnalyticsService } from "../services/analytics.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DAYS = 365;
const MIN_DAYS = 1;

function parseDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_DAYS) return 30;
  return Math.min(n, MAX_DAYS);
}

function parseUuid(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return UUID_RE.test(raw) ? raw : undefined;
}

export function analyticsRoutes(db: Db) {
  const router = Router();
  const analyticsService = createAnalyticsService(db);

  router.get("/companies/:companyId/analytics/throughput", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const days = parseDays(req.query.days);
    const deptLabelId = parseUuid(req.query.deptLabelId);
    const initiativeId = parseUuid(req.query.initiativeId);
    const data = await analyticsService.throughput(companyId, {
      days,
      deptLabelId,
      initiativeId,
    });
    res.json(data);
  });

  router.get("/companies/:companyId/analytics/flow", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const days = parseDays(req.query.days);
    const deptLabelId = parseUuid(req.query.deptLabelId);
    const initiativeId = parseUuid(req.query.initiativeId);
    const data = await analyticsService.flow(companyId, {
      days,
      deptLabelId,
      initiativeId,
    });
    res.json(data);
  });

  return router;
}
