import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { calendarService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function calendarRoutes(db: Db) {
  const router = Router();
  const svc = calendarService(db);

  /**
   * GET /api/companies/:companyId/calendar
   *
   * Query params:
   *   start - ISO timestamp (default: now)
   *   end   - ISO timestamp (default: now + 30 days)
   *
   * Returns a unified list of scheduled calendar events from:
   *   - routine_triggers (cron) joined to routines
   *   - plugin_jobs joined to plugins
   *
   * NOTE: All recurring schedules must use these two tables so they appear
   * here automatically. Ad-hoc shell crons or hardcoded timers are not
   * acceptable.
   */
  router.get("/companies/:companyId/calendar", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const now = new Date();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const maxWindowMs = 365 * 24 * 60 * 60 * 1000;

    const start = req.query.start
      ? new Date(req.query.start as string)
      : now;
    const end = req.query.end
      ? new Date(req.query.end as string)
      : new Date(now.getTime() + thirtyDaysMs);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      res.status(400).json({ error: "Invalid start or end date" });
      return;
    }
    if (start >= end) {
      res.status(400).json({ error: "start must be before end" });
      return;
    }
    if (end.getTime() - start.getTime() > maxWindowMs) {
      res.status(400).json({ error: "Date window may not exceed 365 days" });
      return;
    }

    const events = await svc.getEvents(companyId, start, end);
    res.json({ events });
  });

  return router;
}
