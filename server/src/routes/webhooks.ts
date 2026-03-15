import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createEventRoutingRuleSchema,
  createWebhookEndpointSchema,
  updateEventRoutingRuleSchema,
  updateWebhookEndpointSchema,
} from "@paperclipai/shared";
import { eventRoutingService, logActivity } from "../services/index.js";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { conflict, notFound, unprocessable } from "../errors.js";

function parseLimit(value: unknown, fallback = 100) {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, parsed));
}

export function webhookRoutes(db: Db) {
  const router = Router();
  const svc = eventRoutingService(db);

  router.post("/webhooks/:slug/receive", async (req, res) => {
    const slug = (req.params.slug as string).trim();
    const payload =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const rawBody = req.rawBody?.toString("utf8") ?? JSON.stringify(payload);
    const result = await svc.processIncomingWebhook({
      slug,
      headers: req.headers,
      payload,
      rawBody,
    });

    if ("error" in result) {
      res.status(result.code).json({ error: result.error });
      return;
    }
    if ("skipped" in result) {
      res.status(result.code).json({ status: "skipped", reason: result.skipped });
      return;
    }

    res.status(result.code).json({
      status: result.status,
      eventId: result.eventId,
      matchedRuleId: result.matchedRuleId,
    });
  });

  router.get("/companies/:companyId/webhooks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.listEndpoints(companyId);
    res.json(rows);
  });

  router.post("/companies/:companyId/webhooks", validate(createWebhookEndpointSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const body = req.body as {
      name: string;
      slug: string;
      provider?: "github" | "slack" | "email" | "generic";
      secret?: string;
      status?: "active" | "paused" | "disabled";
      metadata?: Record<string, unknown> | null;
    };

    const existing = (await svc.listEndpoints(companyId)).find((row) => row.slug === body.slug.trim());
    if (existing) throw conflict(`Webhook endpoint slug "${body.slug}" already exists`);

    const created = await svc.createEndpoint(companyId, {
      name: body.name.trim(),
      slug: body.slug.trim(),
      provider: body.provider ?? "generic",
      secret: body.secret ?? null,
      status: body.status ?? "active",
      metadata: body.metadata ?? null,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "webhook.endpoint_created",
      entityType: "webhook_endpoint",
      entityId: created.id,
      details: { name: created.name, slug: created.slug, provider: created.provider },
    });

    res.status(201).json(created);
  });

  router.get("/webhooks/:id", async (req, res) => {
    const id = req.params.id as string;
    const endpoint = await svc.getEndpointById(id);
    if (!endpoint) throw notFound("Webhook endpoint not found");
    assertCompanyAccess(req, endpoint.companyId);
    res.json(endpoint);
  });

  router.patch("/webhooks/:id", validate(updateWebhookEndpointSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getEndpointById(id);
    if (!existing) throw notFound("Webhook endpoint not found");
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);

    const patch = req.body as {
      name?: string;
      slug?: string;
      provider?: "github" | "slack" | "email" | "generic";
      secret?: string | null;
      status?: "active" | "paused" | "disabled";
      metadata?: Record<string, unknown> | null;
    };

    if (patch.slug && patch.slug !== existing.slug) {
      const dup = (await svc.listEndpoints(existing.companyId)).find((row) => row.slug === patch.slug);
      if (dup) throw conflict(`Webhook endpoint slug "${patch.slug}" already exists`);
    }

    const updated = await svc.updateEndpoint(id, patch);
    if (!updated) throw notFound("Webhook endpoint not found");

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "webhook.endpoint_updated",
      entityType: "webhook_endpoint",
      entityId: existing.id,
      details: patch,
    });

    res.json(updated);
  });

  router.delete("/webhooks/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getEndpointById(id);
    if (!existing) throw notFound("Webhook endpoint not found");
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);

    const removed = await svc.deleteEndpoint(id);
    if (!removed) throw notFound("Webhook endpoint not found");

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "webhook.endpoint_deleted",
      entityType: "webhook_endpoint",
      entityId: existing.id,
      details: { slug: existing.slug, name: existing.name },
    });

    res.json({ ok: true });
  });

  router.get("/webhooks/:id/rules", async (req, res) => {
    const endpointId = req.params.id as string;
    const endpoint = await svc.getEndpointById(endpointId);
    if (!endpoint) throw notFound("Webhook endpoint not found");
    assertCompanyAccess(req, endpoint.companyId);
    const rules = await svc.listRules(endpoint.companyId, endpointId);
    res.json(rules);
  });

  router.post("/webhooks/:id/rules", validate(createEventRoutingRuleSchema), async (req, res) => {
    const endpointId = req.params.id as string;
    const endpoint = await svc.getEndpointById(endpointId);
    if (!endpoint) throw notFound("Webhook endpoint not found");
    assertBoard(req);
    assertCompanyAccess(req, endpoint.companyId);

    const body = req.body as {
      source?: "webhook" | "internal";
      name: string;
      priority?: number;
      condition: Record<string, unknown>;
      action: Record<string, unknown>;
      cooldownSec?: number;
      enabled?: boolean;
    };

    const created = await svc.createRule(endpoint.companyId, {
      endpointId,
      source: body.source ?? "webhook",
      name: body.name,
      priority: body.priority ?? 100,
      condition: body.condition,
      action: body.action,
      cooldownSec: body.cooldownSec ?? 0,
      enabled: body.enabled ?? true,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: endpoint.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "webhook.rule_created",
      entityType: "event_routing_rule",
      entityId: created.id,
      details: { endpointId, name: created.name, source: created.source },
    });

    res.status(201).json(created);
  });

  router.get("/companies/:companyId/webhook-rules", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rules = await svc.listRules(companyId);
    res.json(rules);
  });

  router.post("/companies/:companyId/webhook-rules", validate(createEventRoutingRuleSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const body = req.body as {
      endpointId?: string | null;
      source?: "webhook" | "internal";
      name: string;
      priority?: number;
      condition: Record<string, unknown>;
      action: Record<string, unknown>;
      cooldownSec?: number;
      enabled?: boolean;
    };

    if (body.source === "webhook" && !body.endpointId) {
      throw unprocessable("endpointId is required for webhook-sourced rules");
    }
    if (body.endpointId) {
      const endpointExists = await svc.endpointExistsInCompany(body.endpointId, companyId);
      if (!endpointExists) throw notFound("Webhook endpoint not found in company");
    }
    const actionType = typeof body.action?.type === "string" ? body.action.type : null;
    if ((actionType === "wake_agent" || actionType === "create_and_assign") && typeof body.action.agentId === "string") {
      const exists = await svc.agentExistsInCompany(body.action.agentId, companyId);
      if (!exists) throw unprocessable("Rule action agentId is not part of this company");
    }

    const created = await svc.createRule(companyId, {
      endpointId: body.source === "internal" ? null : (body.endpointId ?? null),
      source: body.source ?? (body.endpointId ? "webhook" : "internal"),
      name: body.name,
      priority: body.priority ?? 100,
      condition: body.condition,
      action: body.action,
      cooldownSec: body.cooldownSec ?? 0,
      enabled: body.enabled ?? true,
    });

    res.status(201).json(created);
  });

  router.patch("/webhook-rules/:id", validate(updateEventRoutingRuleSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getRuleById(id);
    if (!existing) throw notFound("Routing rule not found");
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);

    const patch = req.body as {
      endpointId?: string | null;
      source?: "webhook" | "internal";
      name?: string;
      priority?: number;
      condition?: Record<string, unknown>;
      action?: Record<string, unknown>;
      cooldownSec?: number;
      enabled?: boolean;
    };

    if (patch.endpointId) {
      const endpointExists = await svc.endpointExistsInCompany(patch.endpointId, existing.companyId);
      if (!endpointExists) throw notFound("Webhook endpoint not found in company");
    }
    const updated = await svc.updateRule(id, patch);
    if (!updated) throw notFound("Routing rule not found");
    res.json(updated);
  });

  router.delete("/webhook-rules/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getRuleById(id);
    if (!existing) throw notFound("Routing rule not found");
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);
    await svc.deleteRule(id);
    res.json({ ok: true });
  });

  router.get("/webhooks/:id/events", async (req, res) => {
    const endpointId = req.params.id as string;
    const endpoint = await svc.getEndpointById(endpointId);
    if (!endpoint) throw notFound("Webhook endpoint not found");
    assertCompanyAccess(req, endpoint.companyId);
    const rows = await svc.listEvents(endpoint.companyId, { endpointId, limit: parseLimit(req.query.limit) });
    res.json(rows);
  });

  router.get("/companies/:companyId/webhook-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const endpointId = typeof req.query.endpointId === "string" ? req.query.endpointId : undefined;
    const rows = await svc.listEvents(companyId, { endpointId, limit: parseLimit(req.query.limit) });
    res.json(rows);
  });

  return router;
}
