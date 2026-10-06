import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  MCP_CONNECTOR_ENROLL_PATH,
  MCP_CONNECTOR_ROTATE_PATH,
  createMcpConnectorSchema,
  enrollMcpConnectorSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { forbidden, tooManyRequests, unauthorized } from "../errors.js";
import { createInviteRateLimiter, type InviteRateLimiter } from "../services/invite-rate-limit.js";
import { accessService, logActivity } from "../services/index.js";
import { mcpConnectorService } from "../services/mcp-connectors.js";
import type { McpConnectorHub } from "../services/mcp-connector-hub.js";

function bearerToken(req: Request): string | null {
  const value = req.headers.authorization;
  if (!value || !value.toLowerCase().startsWith("bearer ")) return null;
  return value.slice("bearer ".length).trim() || null;
}

/**
 * Outbound MCP connectors (issue #14280). Board routes manage connectors for a
 * company; the enroll/rotate routes are called by the connector process itself
 * and authenticate with its one-time token or long-lived credential.
 * Token and credential values appear only in these responses, never in
 * activity details or logs.
 */
export function mcpConnectorRoutes(db: Db, options: { hub?: McpConnectorHub; enrollRateLimiter?: InviteRateLimiter } = {}) {
  const router = Router();
  // The enroll route is unauthenticated and does a DB write per well-formed
  // token, so bound attempts per client IP (req.ip honors TRUST_PROXY).
  const enrollRateLimiter = options.enrollRateLimiter ?? createInviteRateLimiter();
  const connectors = mcpConnectorService(db, { hub: options.hub });
  const access = accessService(db);

  /** Connectors decide which private-network servers Paperclip can reach, so managing them needs connection-manager rights. */
  async function assertConnectorManager(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const membership = Array.isArray(req.actor.memberships)
      ? req.actor.memberships.find((item) => item.companyId === companyId)
      : null;
    if (!membership || membership.status !== "active" || membership.membershipRole === "viewer") {
      throw forbidden("Managing MCP connectors requires active, non-viewer company access");
    }
    if (req.actor.userId && await access.hasPermission(companyId, "user", req.actor.userId, "tools:manage_connections")) return;
    throw forbidden("Missing permission: tools:manage_connections");
  }

  router.get("/companies/:companyId/tools/mcp-connectors", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json({ connectors: await connectors.list(companyId) });
  });

  router.post(
    "/companies/:companyId/tools/mcp-connectors",
    validate(createMcpConnectorSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertConnectorManager(req, companyId);
      const enrollment = await connectors.create(companyId, req.body, req.actor.userId ?? null);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_mcp_connector.created",
        entityType: "tool_mcp_connector",
        entityId: enrollment.connector.id,
        details: { name: enrollment.connector.name, enrollmentExpiresAt: enrollment.enrollmentExpiresAt },
      });
      res.set("Cache-Control", "no-store");
      res.status(201).json(enrollment);
    },
  );

  router.post("/companies/:companyId/tools/mcp-connectors/:connectorId/reenroll", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertConnectorManager(req, companyId);
    const enrollment = await connectors.reenroll(companyId, req.params.connectorId as string);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_mcp_connector.reenrolled",
      entityType: "tool_mcp_connector",
      entityId: enrollment.connector.id,
      details: { name: enrollment.connector.name, enrollmentExpiresAt: enrollment.enrollmentExpiresAt },
    });
    res.set("Cache-Control", "no-store");
    res.json(enrollment);
  });

  router.post("/companies/:companyId/tools/mcp-connectors/:connectorId/revoke", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertConnectorManager(req, companyId);
    const connectorId = req.params.connectorId as string;
    const connector = await connectors.revoke(companyId, connectorId);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_mcp_connector.revoked",
      entityType: "tool_mcp_connector",
      entityId: connector.id,
      details: { name: connector.name, affectedConnections: await connectors.connectionCount(companyId, connectorId) },
    });
    res.json(connector);
  });

  router.post(MCP_CONNECTOR_ENROLL_PATH.replace(/^\/api/, ""), (req, res, next) => {
    const result = enrollRateLimiter.consume(req.ip || req.socket?.remoteAddress || "unknown");
    if (result.allowed) return next();
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    next(tooManyRequests("Too many enrollment attempts", { retryAfterSeconds: result.retryAfterSeconds }));
  }, validate(enrollMcpConnectorSchema), async (req, res) => {
    const result = await connectors.enroll(req.body.token, req.body.version);
    await logActivity(db, {
      companyId: result.companyId,
      actorType: "system",
      actorId: `mcp_connector:${result.connectorId}`,
      action: "tool_mcp_connector.enrolled",
      entityType: "tool_mcp_connector",
      entityId: result.connectorId,
      details: { version: req.body.version ?? null },
    });
    res.set("Cache-Control", "no-store");
    res.json(result);
  });

  router.post(MCP_CONNECTOR_ROTATE_PATH.replace(/^\/api/, ""), async (req, res) => {
    const credential = bearerToken(req);
    if (!credential) throw unauthorized();
    const current = await connectors.authenticate(credential);
    if (!current) throw unauthorized("The connector credential is invalid or revoked.");
    const result = await connectors.rotateCredential(credential);
    await logActivity(db, {
      companyId: current.companyId,
      actorType: "system",
      actorId: `mcp_connector:${current.id}`,
      action: "tool_mcp_connector.credential_rotated",
      entityType: "tool_mcp_connector",
      entityId: current.id,
      details: {},
    });
    res.set("Cache-Control", "no-store");
    res.json(result);
  });

  return router;
}
