import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { messagingBridgeService } from "../services/messaging-bridges.js";
import {
  testTelegramToken,
  startTelegramBridge,
  stopTelegramBridge,
  isTelegramBridgeRunning,
} from "../bridges/telegram.js";
import { handleInboundEmail, getCompanyEmailAddress } from "../bridges/email.js";
import { companyService } from "../services/index.js";

export function messagingRoutes(db: Db) {
  const router = Router();
  const bridgeSvc = messagingBridgeService(db);
  const secretSvc = secretService(db);
  const companySvc = companyService(db);

  // ── List all configured bridges for a company ──

  router.get("/companies/:companyId/messaging/bridges", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const bridges = await bridgeSvc.list(companyId);

    // Enrich with runtime status for Telegram
    const enriched = bridges.map((b) => ({
      ...b,
      running: b.platform === "telegram" ? isTelegramBridgeRunning(companyId) : undefined,
    }));

    // Also include email info
    const company = await companySvc.getById(companyId);
    const emailAddress = company ? getCompanyEmailAddress(company.name) : null;

    res.json({
      bridges: enriched,
      email: {
        address: emailAddress,
        status: "auto_configured",
        note: "Requires DNS configuration on ironworksapp.ai (MX records)",
      },
      platforms: bridgeSvc.getSupportedPlatforms(),
    });
  });

  // ── Configure Telegram bridge ──

  router.post("/companies/:companyId/messaging/telegram", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { token } = req.body as { token?: string };
    if (!token || typeof token !== "string" || token.trim().length < 10) {
      res.status(400).json({ error: "A valid Telegram bot token is required" });
      return;
    }

    // Validate the token
    let botUsername: string;
    try {
      botUsername = await testTelegramToken(token.trim());
    } catch (err) {
      res.status(400).json({ error: `Invalid bot token: ${(err as Error).message}` });
      return;
    }

    // Store token as a company secret
    let secret;
    const existingSecret = await secretSvc.getByName(companyId, "TELEGRAM_BOT_TOKEN");
    if (existingSecret) {
      secret = await secretSvc.rotate(existingSecret.id, {
        value: token.trim(),
      });
    } else {
      secret = await secretSvc.create(companyId, {
        name: "TELEGRAM_BOT_TOKEN",
        provider: "local_encrypted",
        value: token.trim(),
        description: `Telegram bot token (@${botUsername})`,
      }, { userId: req.actor.userId ?? "board", agentId: null });
    }

    // Upsert bridge config
    const bridge = await bridgeSvc.upsert(companyId, "telegram", {
      status: "connected",
      secretId: secret.id,
      config: { botUsername },
    });

    // Start the bridge
    try {
      await startTelegramBridge(db, companyId, token.trim());
    } catch (err) {
      await bridgeSvc.updateStatus(companyId, "telegram", "error", (err as Error).message);
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "messaging.telegram.configured",
      entityType: "messaging_bridge",
      entityId: bridge.id,
      details: { botUsername },
    });

    res.json({ ...bridge, botUsername, running: isTelegramBridgeRunning(companyId) });
  });

  // ── Remove Telegram bridge ──

  router.delete("/companies/:companyId/messaging/telegram", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // Stop the bot
    await stopTelegramBridge(companyId);

    // Remove the bridge config
    try {
      await bridgeSvc.remove(companyId, "telegram");
    } catch {
      // Already removed, that's fine
    }

    // Remove the secret
    const existingSecret = await secretSvc.getByName(companyId, "TELEGRAM_BOT_TOKEN");
    if (existingSecret) {
      await secretSvc.remove(existingSecret.id);
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "messaging.telegram.removed",
      entityType: "messaging_bridge",
      entityId: companyId,
    });

    res.json({ ok: true });
  });

  // ── Test Telegram connection ──

  router.post("/companies/:companyId/messaging/telegram/test", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const bridge = await bridgeSvc.getByPlatform(companyId, "telegram");
    if (!bridge?.secretId) {
      res.status(404).json({ error: "No Telegram bridge configured" });
      return;
    }

    try {
      const token = await secretSvc.resolveSecretValue(companyId, bridge.secretId, "latest");
      if (!token) {
        res.status(500).json({ error: "Could not resolve bot token" });
        return;
      }
      const botUsername = await testTelegramToken(token);
      const running = isTelegramBridgeRunning(companyId);

      // If not running, try to start
      if (!running) {
        await startTelegramBridge(db, companyId, token);
        await bridgeSvc.updateStatus(companyId, "telegram", "connected");
      }

      res.json({
        ok: true,
        botUsername,
        running: isTelegramBridgeRunning(companyId),
        status: "connected",
      });
    } catch (err) {
      await bridgeSvc.updateStatus(companyId, "telegram", "error", (err as Error).message);
      res.status(500).json({ error: (err as Error).message, status: "error" });
    }
  });

  // ── Email inbound webhook (public — no auth required) ──
  // This will be mounted separately outside the auth middleware

  return router;
}

/**
 * Public email webhook routes (no auth — called by Mailgun/SendGrid).
 * Mount on the public Express app, not behind the auth middleware.
 */
export function emailWebhookRoutes(db: Db) {
  const router = Router();

  router.post("/webhooks/email", async (req, res) => {
    // SEC-INTEG-002: Validate webhook secret to prevent unauthorized issue creation.
    // Mailgun/SendGrid should be configured to include this token as a query param
    // or header. Without it, anyone can POST fake emails to create issues.
    // SEC-ADV-002: Webhook secret is mandatory in authenticated deployment mode.
    // Without it, anyone on the internet can create issues in any company.
    const webhookSecret = process.env.IRONWORKS_EMAIL_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.warn("[email-bridge] IRONWORKS_EMAIL_WEBHOOK_SECRET not set — rejecting all email webhooks");
      res.status(503).json({ ok: false, error: "Email bridge not configured" });
      return;
    }
    const token = req.query.token ?? req.headers["x-webhook-secret"];
    if (token !== webhookSecret) {
      res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      return;
    }
    try {
      const result = await handleInboundEmail(db, req.body as Record<string, unknown>);
      if (result.ok) {
        res.json({ ok: true, issueId: result.issueId });
      } else {
        // Return 200 anyway to prevent webhook retries
        res.json({ ok: false, error: result.error });
      }
    } catch (err) {
      console.error("[email-bridge] Webhook error:", (err as Error).message);
      // Return 200 to prevent retries
      res.json({ ok: false, error: "Internal error processing email" });
    }
  });

  return router;
}
