import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { connectionService } from "../services/connections.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import { logActivity } from "../services/index.js";
import { logger } from "../middleware/logger.js";

export function connectionRoutes(db: Db) {
  const router = Router();
  const svc = connectionService(db);

  // ── List connections + available providers ────────────────────────────
  router.get("/companies/:companyId/connections", async (req, res) => {
    assertBoard(req);
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const [conns, providers] = await Promise.all([
      svc.list(companyId),
      Promise.resolve(svc.listProviders()),
    ]);

    res.json({ connections: conns, providers });
  });

  // ── Initiate OAuth flow ───────────────────────────────────────────────
  router.get(
    "/companies/:companyId/connections/:providerId/authorize",
    (req, res) => {
      assertBoard(req);
      const { companyId, providerId } = req.params;
      assertCompanyAccess(req, companyId);

      const url = svc.getAuthorizeUrl(
        companyId,
        providerId,
        req.actor.userId ?? "board",
      );

      res.json({ url });
    },
  );

  // ── OAuth callback (unauthenticated — validated via state token) ──────
  router.get("/connections/callback", async (req, res) => {
    const { state, code, error: oauthError } = req.query;

    if (oauthError) {
      logger.warn({ oauthError }, "OAuth callback received error");
      res.redirect(`${getUiBaseUrl()}/company/connections?error=${encodeURIComponent(String(oauthError))}`);
      return;
    }

    if (!state || !code) {
      res.status(400).json({ error: "Missing state or code parameter" });
      return;
    }

    try {
      const conn = await svc.handleCallback(
        String(state),
        String(code),
      );

      await logActivity(db, {
        companyId: conn.companyId,
        actorType: "user",
        actorId: conn.createdByUserId ?? "board",
        action: "connection.created",
        entityType: "connection",
        entityId: conn.id,
        details: { providerId: conn.providerId, accountLabel: conn.accountLabel },
      });

      // Redirect back to the connections UI with success
      res.redirect(
        `${getUiBaseUrl()}/company/connections?connected=${conn.providerId}`,
      );
    } catch (err) {
      logger.error({ err }, "OAuth callback failed");
      const message = err instanceof Error ? err.message : "Unknown error";
      res.redirect(
        `${getUiBaseUrl()}/company/connections?error=${encodeURIComponent(message)}`,
      );
    }
  });

  // ── Force refresh ─────────────────────────────────────────────────────
  router.post("/connections/:id/refresh", async (req, res) => {
    assertBoard(req);
    const conn = await svc.getById(req.params.id);
    if (!conn || !hasCompanyAccess(req, conn.companyId)) { res.status(404).json({ error: "Connection not found" }); return; }

    const refreshed = await svc.refreshToken(conn.id);

    await logActivity(db, {
      companyId: conn.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "connection.refreshed",
      entityType: "connection",
      entityId: conn.id,
      details: { providerId: conn.providerId },
    });

    res.json(refreshed);
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  router.delete("/connections/:id", async (req, res) => {
    assertBoard(req);
    const conn = await svc.getById(req.params.id);
    if (!conn || !hasCompanyAccess(req, conn.companyId)) { res.status(404).json({ error: "Connection not found" }); return; }

    const removed = await svc.disconnect(conn.id);

    await logActivity(db, {
      companyId: conn.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "connection.disconnected",
      entityType: "connection",
      entityId: removed.id,
      details: { providerId: conn.providerId },
    });

    res.json({ ok: true });
  });

  // ── Report auth failure (agent-callable) ──────────────────────────────
  router.post(
    "/companies/:companyId/connections/auth-failure",
    async (req, res) => {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const { providerId, errorMessage } = req.body as {
        providerId: string;
        errorMessage?: string;
      };

      if (!providerId) {
        res.status(400).json({ error: "providerId is required" });
        return;
      }

      await svc.reportAuthFailure(companyId, providerId, errorMessage);

      await logActivity(db, {
        companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId: (req.actor.type === "agent" ? req.actor.agentId : req.actor.userId) ?? "system",
        action: "connection.auth_failure",
        entityType: "connection",
        entityId: providerId,
        details: { providerId, errorMessage },
      });

      res.json({ ok: true });
    },
  );

  return router;
}

function getUiBaseUrl(): string {
  return process.env.PAPERCLIP_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? "3100"}`;
}
