import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import * as gw from "../services/gateway.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

async function assertAgentOwnership(db: Db, agentId: string, companyId: string) {
  const [row] = await db.select({ companyId: agents.companyId })
    .from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!row || row.companyId !== companyId) {
    throw badRequest("agentId does not belong to this company");
  }
}

export function gatewayRoutes(db: Db) {
  const router = Router();

  // ---- List routes ----
  router.get("/companies/:companyId/gateway/routes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const agentId = (req.query.agentId as string | undefined) || undefined;
    const routes = await gw.listRoutes(db, companyId, agentId);
    const enriched = routes.map((route) => ({
      ...route,
      health: gw.getRouteHealth(route.id),
    }));
    res.json(enriched);
  });

  // ---- Create route ----
  router.post("/companies/:companyId/gateway/routes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const { adapterType, model } = req.body;
    if (!adapterType || !model) {
      throw badRequest("adapterType and model are required");
    }

    if (req.body.agentId) {
      await assertAgentOwnership(db, req.body.agentId, companyId);
    }

    const route = await gw.createRoute(db, {
      companyId,
      agentId: req.body.agentId || null,
      name: req.body.name || `${adapterType}/${model}`,
      priority: req.body.priority ?? 0,
      adapterType,
      model,
      weight: req.body.weight ?? 100,
      isEnabled: req.body.isEnabled ?? true,
      quotaTokensPerMinute: req.body.quotaTokensPerMinute ?? null,
      quotaTokensPerHour: req.body.quotaTokensPerHour ?? null,
      quotaTokensPerDay: req.body.quotaTokensPerDay ?? null,
      quotaRequestsPerMinute: req.body.quotaRequestsPerMinute ?? null,
      quotaRequestsPerHour: req.body.quotaRequestsPerHour ?? null,
      quotaRequestsPerDay: req.body.quotaRequestsPerDay ?? null,
      circuitBreakerEnabled: req.body.circuitBreakerEnabled ?? false,
      circuitBreakerFailureThreshold: req.body.circuitBreakerFailureThreshold ?? 3,
      circuitBreakerResetSec: req.body.circuitBreakerResetSec ?? 300,
      timeoutSec: req.body.timeoutSec ?? null,
      adapterConfigOverrides: req.body.adapterConfigOverrides ?? null,
    });

    res.status(201).json({ ...route, health: gw.getRouteHealth(route.id) });
  });

  // ---- Update route ----
  router.patch("/companies/:companyId/gateway/routes/:routeId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const routeId = req.params.routeId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const existing = await gw.getRoute(db, routeId);
    if (!existing || existing.companyId !== companyId) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    if (req.body.agentId) {
      await assertAgentOwnership(db, req.body.agentId, companyId);
    }

    const allowedFields = [
      "name", "priority", "adapterType", "model", "weight", "isEnabled", "agentId",
      "quotaTokensPerMinute", "quotaTokensPerHour", "quotaTokensPerDay",
      "quotaRequestsPerMinute", "quotaRequestsPerHour", "quotaRequestsPerDay",
      "circuitBreakerEnabled", "circuitBreakerFailureThreshold", "circuitBreakerResetSec",
      "timeoutSec", "adapterConfigOverrides",
    ] as const;

    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in req.body) updates[field] = req.body[field];
    }

    const route = await gw.updateRoute(db, routeId, updates as any);
    if (!route) { res.status(404).json({ error: "Route not found" }); return; }
    res.json({ ...route, health: gw.getRouteHealth(route.id) });
  });

  // ---- Delete route ----
  router.delete("/companies/:companyId/gateway/routes/:routeId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const routeId = req.params.routeId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const existing = await gw.getRoute(db, routeId);
    if (!existing || existing.companyId !== companyId) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    await gw.deleteRoute(db, routeId);
    res.status(204).end();
  });

  // ---- Health overview ----
  router.get("/companies/:companyId/gateway/health", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const health = await gw.getRoutesHealth(db, companyId);
    res.json(health);
  });

  // ---- Reset circuit breaker ----
  router.post("/companies/:companyId/gateway/routes/:routeId/reset-circuit", async (req, res) => {
    const companyId = req.params.companyId as string;
    const routeId = req.params.routeId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const existing = await gw.getRoute(db, routeId);
    if (!existing || existing.companyId !== companyId) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    await gw.resetCircuit(db, routeId);
    res.json({ ok: true, health: gw.getRouteHealth(routeId) });
  });

  return router;
}
