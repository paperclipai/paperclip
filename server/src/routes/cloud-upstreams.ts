import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, notFound } from "../errors.js";
import { assertBoardOrgAccess, getActorInfo } from "./authz.js";
import { cloudUpstreamService, instanceSettingsService, logActivity } from "../services/index.js";

export function cloudUpstreamRoutes(db: Db, options: { instanceId?: string } = {}) {
  const router = Router();
  const service = cloudUpstreamService(db, options);
  const settings = instanceSettingsService(db);

  async function assertEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableCloudSync !== true) {
      throw notFound("Cloud sync is not enabled");
    }
  }

  // Cloud-upstream control and push-runs move company data off the instance;
  // every mutation is recorded in the owning company's audit stream with the
  // authenticated board user's attribution (G3/P17).
  async function logCloudUpstreamActivity(
    req: Parameters<typeof getActorInfo>[0],
    input: {
      companyId: string;
      action: string;
      entityType: string;
      entityId: string;
      details?: Record<string, unknown>;
    },
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      details: input.details ?? null,
    });
  }

  router.get("/cloud-upstreams", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const companyId = stringQuery(req.query.companyId, "companyId");
    res.json(await service.list(companyId));
  });

  router.post("/cloud-upstreams/connect/start", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const companyId = stringBody(req.body, "companyId");
    const remoteUrl = stringBody(req.body, "remoteUrl");
    const redirectUri = stringBody(req.body, "redirectUri");
    const started = await service.startConnect({ companyId, remoteUrl, redirectUri });
    await logCloudUpstreamActivity(req, {
      companyId,
      action: "cloud_upstream.connect_started",
      entityType: "cloud_upstream_connection",
      entityId: started.connection?.id ?? companyId,
      details: { remoteUrl },
    });
    res.json(started);
  });

  router.post("/cloud-upstreams/connect/finish", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const connection = await service.finishConnect({
      pendingConnectionId: stringBody(req.body, "pendingConnectionId"),
      code: stringBody(req.body, "code"),
      state: stringBody(req.body, "state"),
    });
    await logCloudUpstreamActivity(req, {
      companyId: connection.companyId,
      action: "cloud_upstream.connected",
      entityType: "cloud_upstream_connection",
      entityId: connection.id,
      details: { remoteUrl: connection.remoteUrl ?? null },
    });
    res.json(connection);
  });

  router.post("/cloud-upstreams/:connectionId/push-runs/preview", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const previewCompanyId = stringBody(req.body, "companyId");
    const preview = await service.preview(req.params.connectionId, previewCompanyId);
    await logCloudUpstreamActivity(req, {
      companyId: previewCompanyId,
      action: "cloud_upstream.push_run_previewed",
      entityType: "cloud_upstream_connection",
      entityId: req.params.connectionId,
    });
    res.json(preview);
  });

  router.post("/cloud-upstreams/:connectionId/push-runs", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const run = await service.createRun({
      connectionId: req.params.connectionId,
      companyId: stringBody(req.body, "companyId"),
      retryOfRunId: optionalString(req.body?.retryOfRunId),
    });
    await logCloudUpstreamActivity(req, {
      companyId: run.companyId,
      action: "cloud_upstream.push_run_created",
      entityType: "cloud_upstream_run",
      entityId: run.id,
      details: {
        connectionId: req.params.connectionId,
        status: run.status,
        retryOfRunId: optionalString(req.body?.retryOfRunId),
      },
    });
    res.json(run);
  });

  router.get("/cloud-upstreams/:connectionId/push-runs/:runId", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    res.json(await service.readRun(req.params.connectionId, req.params.runId, stringQuery(req.query.companyId, "companyId")));
  });

  router.post("/cloud-upstreams/:connectionId/push-runs/:runId/cancel", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const cancelled = await service.cancelRun(req.params.connectionId, req.params.runId, stringBody(req.body, "companyId"));
    await logCloudUpstreamActivity(req, {
      companyId: cancelled.companyId,
      action: "cloud_upstream.push_run_cancelled",
      entityType: "cloud_upstream_run",
      entityId: cancelled.id,
      details: { connectionId: req.params.connectionId, status: cancelled.status },
    });
    res.json(cancelled);
  });

  router.post("/cloud-upstreams/:connectionId/push-runs/:runId/activation", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const activationEntityType = activationEntityTypeBody(req.body);
    const activated = await service.activateRunEntities({
      connectionId: req.params.connectionId,
      runId: req.params.runId,
      companyId: stringBody(req.body, "companyId"),
      entityType: activationEntityType,
    });
    await logCloudUpstreamActivity(req, {
      companyId: activated.companyId,
      action: "cloud_upstream.push_run_activated",
      entityType: "cloud_upstream_run",
      entityId: activated.id,
      details: { connectionId: req.params.connectionId, entityType: activationEntityType },
    });
    res.json(activated);
  });

  return router;
}

function stringQuery(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`${label} is required`);
  }
  return value;
}

function stringBody(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest(`${key} is required`);
  }
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`${key} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function activationEntityTypeBody(body: unknown): "agents" | "routines" | "monitors" {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("entityType is required");
  }
  const value = (body as Record<string, unknown>).entityType;
  if (value !== "agents" && value !== "routines" && value !== "monitors") {
    throw badRequest("entityType must be agents, routines, or monitors");
  }
  return value;
}
