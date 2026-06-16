import { Router } from "express";
import { z } from "zod";
import type { Db } from "@valadrien-os/db";
import { validate } from "../middleware/validate.js";
import { billingService, logActivity } from "../services/index.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { badRequest } from "../errors.js";

const updateBillingAccountSchema = z.object({
  markupBps: z.number().int().min(0).max(1_000_000).optional(),
  currency: z.string().trim().min(1).max(8).optional(),
  billingEmail: z.string().trim().email().nullable().optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

function currentMonthWindowUtc(now: Date): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from, to };
}

function parsePeriod(query: Record<string, unknown>): { from: Date; to: Date } {
  const fallback = currentMonthWindowUtc(new Date());
  const parseDate = (value: unknown, fallbackDate: Date): Date => {
    if (typeof value !== "string" || value.trim().length === 0) return fallbackDate;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw badRequest(`Invalid date: ${value}`);
    return date;
  };
  const from = parseDate(query.from, fallback.from);
  const to = parseDate(query.to, fallback.to);
  if (to <= from) throw badRequest("`to` must be after `from`");
  return { from, to };
}

export function billingRoutes(db: Db) {
  const router = Router();
  const billing = billingService(db);

  // The tenant (any member with company access) can view their own billing account.
  router.get("/companies/:companyId/billing/account", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await billing.getOrCreateAccount(companyId));
  });

  // Only the platform operator (instance admin) sets the markup / rate charged to a tenant.
  router.patch(
    "/companies/:companyId/billing/account",
    validate(updateBillingAccountSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertInstanceAdmin(req);
      const updated = await billing.updateAccount(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "billing.account_updated",
        entityType: "company",
        entityId: companyId,
        details: { markupBps: updated.markupBps, currency: updated.currency, status: updated.status },
      });
      res.json(updated);
    },
  );

  // The tenant can view their own usage statement (invoice preview) for a period.
  router.get("/companies/:companyId/billing/statement", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const period = parsePeriod(req.query as Record<string, unknown>);
    res.json(await billing.computeStatement(companyId, period));
  });

  return router;
}
