import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { tailscaleConnectionService } from "../services/connectors/tailscale/connections.js";
import { paperclipCloudConnectorConfigFromEnv } from "../services/paperclip-cloud-connector.js";
import { startPaperclipCloudConnectorEnrollment } from "../services/paperclip-cloud-connector-enrollment.js";
import { paperclipCloudEnrollmentPrincipal } from "../services/paperclip-cloud-connector-principal.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function operator(req: Request) {
  assertBoard(req);
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) throw forbidden("Instance admin access required");
  return getActorInfo(req).actorId;
}

export function tailscaleConnectionRoutes(db: Db) {
  const router = Router();
  const service = tailscaleConnectionService(db);
  router.get("/companies/:companyId/tailscale-connections", async (req, res) => {
    operator(req);
    assertCompanyAccess(req, z.string().uuid().parse(req.params.companyId));
    res.json(await service.list(z.string().uuid().parse(req.params.companyId)));
  });
  router.post("/companies/:companyId/tailscale-connections", validate(z.object({ name: z.string().trim().min(1).max(100).default("My tailnet"), connectionId: z.string().uuid().optional() }).strict()), async (req, res) => {
    const userId = operator(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const origin = loadConfig().authPublicBaseUrl;
    if (!origin) throw unprocessable("Set this instance's public URL before connecting Tailscale.");
    if (!paperclipCloudConnectorConfigFromEnv()) {
      const enrollment = await startPaperclipCloudConnectorEnrollment({ origin, companyId, initiatedBy: paperclipCloudEnrollmentPrincipal(req.actor),
        returnTo: "/apps/tailscale",
      });
      await logActivity(db, {
        companyId, actorType: "user", actorId: userId,
        action: "paperclip_cloud_connector.enrollment_started",
        entityType: "connector_instance", entityId: enrollment.instanceId ?? "pending",
        details: { environment: enrollment.environment, status: enrollment.status },
      });
      res.status(201).json({ authorizationUrl: enrollment.verificationUrl, expiresAt: enrollment.expiresAt });
      return;
    }
    const result = await service.start({ companyId, userId, ...req.body, returnUri: new URL("/api/tools/oauth/tailscale/callback", origin).toString() });
    await logActivity(db, { companyId, actorType: "user", actorId: userId, action: "tailscale.authorization_started", entityType: "tailscale_connection", entityId: result.connection.id });
    res.status(201).json(result);
  });
  router.get("/companies/:companyId/tailscale-connections/:connectionId/devices", async (req, res) => {
    operator(req);
    assertCompanyAccess(req, z.string().uuid().parse(req.params.companyId));
    const id = z.string().uuid().parse(req.params.connectionId);
    res.json(await service.devices(z.string().uuid().parse(req.params.companyId), id));
  });
  router.delete("/companies/:companyId/tailscale-connections/:connectionId", async (req, res) => {
    const userId = operator(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const result = await service.disconnect(companyId, z.string().uuid().parse(req.params.connectionId));
    await logActivity(db, { companyId, actorType: "user", actorId: userId, action: "tailscale.disconnected", entityType: "tailscale_connection", entityId: result.id });
    res.json(result);
  });
  router.post("/companies/:companyId/tailscale-connections/:connectionId/pairing", validate(z.object({ deviceId: z.string().min(1).max(256), port: z.number().int().min(1).max(65535).default(22) }).strict()), async (req, res) => {
    const userId = operator(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const id = z.string().uuid().parse(req.params.connectionId);
    const result = await service.pairing(companyId, id, req.body.deviceId, req.body.port, userId);
    await logActivity(db, { companyId, actorType: "user", actorId: userId, action: "tailscale.pairing_prepared", entityType: "tailscale_connection", entityId: id });
    res.json(result);
  });
  router.get("/tools/oauth/tailscale/callback", async (req, res) => {
    const userId = operator(req);
    const query = z.object({ state: z.string().min(1).max(128), claim_id: z.string().max(256).optional(), error: z.string().max(128).optional() }).parse(req.query);
    const result = await service.complete({ state: query.state, claimId: query.claim_id, error: query.error, userId,
      authorizeCompany: companyId => assertCompanyAccess(req, companyId),
    });
    await logActivity(db, { companyId: result.companyId, actorType: "user", actorId: userId, action: "tailscale.connected", entityType: "tailscale_connection", entityId: result.id });
    const [company] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, result.companyId));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.redirect(303, `/${encodeURIComponent(company!.prefix)}/apps/tailscale?tailscale_connection=${encodeURIComponent(result.id)}`);
  });
  return router;
}
