import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { portfolioService } from "../services/portfolio.js";
import { assertPortfolioAccess } from "./authz.js";

function parseDateParam(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`Missing ${field} query value`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(`Invalid ${field} query value`);
  }
  return parsed;
}

function parseCompanyIds(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest("Missing companyIds query value");
  }
  const ids = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw badRequest("Missing companyIds query value");
  }
  return Array.from(new Set(ids));
}

export function portfolioRoutes(db: Db) {
  const router = Router();
  const svc = portfolioService(db);

  router.get("/portfolio/runs", async (req, res) => {
    const since = parseDateParam(req.query.since, "since");
    const until = parseDateParam(req.query.until, "until");
    if (until <= since) {
      throw badRequest("until must be after since");
    }
    const companyIds = parseCompanyIds(req.query.companyIds);
    assertPortfolioAccess(req, companyIds);

    const rows = await svc.listRunsRollup({
      actor: req.actor,
      since,
      until,
      companyIds,
    });

    res.json({
      schema: {
        version: "v1",
        window: {
          from: since.toISOString(),
          to: until.toISOString(),
        },
        fields: [
          "company_id",
          "agent_id",
          "runs_total",
          "runs_succeeded",
          "runs_failed",
          "seconds_on_task",
          "distinct_issues",
          "heartbeats_avg",
        ],
      },
      rows,
    });
  });

  return router;
}
