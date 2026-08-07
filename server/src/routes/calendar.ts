import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { calendarService, normalizeCalendarKinds } from "../services/calendar.js";
import { accessService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

const calendarQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  kinds: z.string().optional(),
  agentId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  routineId: z.string().uuid().optional(),
});

export function calendarRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);

  router.get("/companies/:companyId/calendar", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // Same company-scope gate the activity feed uses: the calendar aggregates
    // across every project and agent in the company, so it is only readable by
    // an actor allowed to read the company scope as a whole.
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Calendar is outside this actor's authorization boundary" });
      return;
    }

    const parsed = calendarQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid calendar query", details: parsed.error.flatten() });
      return;
    }

    const result = await calendarService(db).getCalendar({
      companyId,
      from: parsed.data.from,
      to: parsed.data.to,
      kinds: parsed.data.kinds ? normalizeCalendarKinds(parsed.data.kinds) : undefined,
      agentId: parsed.data.agentId,
      projectId: parsed.data.projectId,
      routineId: parsed.data.routineId,
    });
    res.json(result);
  });

  return router;
}
