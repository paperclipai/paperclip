import { timingSafeEqual } from "node:crypto";
import type { Db } from "@ironworksai/db";
import { messagingBridges } from "@ironworksai/db";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { getCompanyEmailAddress, handleInboundEmail } from "../bridges/email.js";
import {
  isTelegramBridgeRunning,
  startTelegramBridge,
  stopTelegramBridge,
  testTelegramToken,
} from "../bridges/telegram.js";
import { verifyHmacSha256, verifySendgridSignature, warnIfWebhookSigningDisabledOnce } from "../lib/webhook-signatures.js";
import { logger } from "../middleware/logger.js";
import { companyService, logActivity, secretService } from "../services/index.js";
import { messagingBridgeService } from "../services/messaging-bridges.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

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

    // Also include email info — derive actual status from runtime config so
    // the UI doesn't lie about whether email actually works. Two gates must
    // both be set: webhook secret env var AND inbound MX records on the
    // domain. We can only check the env var server-side; the MX status is
    // surfaced as a follow-up note for the operator.
    const company = await companySvc.getById(companyId);
    const emailAddress = company ? getCompanyEmailAddress(company.name) : null;
    const webhookSecretConfigured = Boolean(process.env.IRONWORKS_EMAIL_WEBHOOK_SECRET);
    const emailStatus = webhookSecretConfigured ? "ready" : "inactive";
    const emailNote = webhookSecretConfigured
      ? "Webhook secret configured. Inbound mail must also have MX records on the domain pointing to a parser (Mailgun/SendGrid/Postmark) that POSTs to /api/webhooks/email."
      : "Email bridge is disabled. To enable: set IRONWORKS_EMAIL_WEBHOOK_SECRET in the server env, configure a parser (Mailgun/SendGrid/Postmark) to POST to /api/webhooks/email, and add MX records on the domain.";

    res.json({
      bridges: enriched,
      email: {
        address: emailAddress,
        status: emailStatus,
        note: emailNote,
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
    let secret: Awaited<ReturnType<typeof secretSvc.rotate>>;
    const existingSecret = await secretSvc.getByName(companyId, "TELEGRAM_BOT_TOKEN");
    if (existingSecret) {
      secret = await secretSvc.rotate(existingSecret.id, {
        value: token.trim(),
      });
    } else {
      secret = await secretSvc.create(
        companyId,
        {
          name: "TELEGRAM_BOT_TOKEN",
          provider: "local_encrypted",
          value: token.trim(),
          description: `Telegram bot token (@${botUsername})`,
        },
        { userId: req.actor.userId ?? "board", agentId: null },
      );
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

  // ── Reset Telegram owner ──
  // Clears ownerChatId on the bridge config so the next /start claims ownership.
  // Used when transferring the bot to a different operator without re-running
  // setup (the bot token + persona stay; only the owner gets reset).

  router.post("/companies/:companyId/messaging/telegram/reset-owner", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const bridge = await bridgeSvc.getByPlatform(companyId, "telegram");
    if (!bridge) {
      res.status(404).json({ error: "No Telegram bridge configured" });
      return;
    }

    const config = { ...((bridge.config as Record<string, unknown> | null) ?? {}) };
    const previousOwner = (config.ownerChatId as string | undefined) ?? null;
    delete config.ownerChatId;

    await db.update(messagingBridges).set({ config, updatedAt: new Date() }).where(eq(messagingBridges.id, bridge.id));

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "messaging.telegram.owner_reset",
      entityType: "messaging_bridge",
      entityId: bridge.id,
      details: { previousOwner },
    });

    res.json({ ok: true });
  });

  // ── Update Telegram allowed chat IDs ──
  // SEC-CHAOS-002 fix #1: pre-registered allowlist of Telegram chatIds. When
  // non-empty, only listed chatIds can interact with the bot — closing the
  // first-claimer ownership race. Empty list preserves legacy single-owner mode.
  router.put("/companies/:companyId/messaging/telegram/allowed-chat-ids", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const body = req.body as { allowedChatIds?: unknown };
    const raw = body.allowedChatIds;
    if (!Array.isArray(raw)) {
      res.status(400).json({ error: "allowedChatIds must be an array of strings" });
      return;
    }
    const cleaned = raw
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0 && /^-?\d+$/.test(v));
    if (cleaned.length !== raw.length) {
      res.status(400).json({ error: "Each chat ID must be a non-empty integer string" });
      return;
    }

    const bridge = await bridgeSvc.getByPlatform(companyId, "telegram");
    if (!bridge) {
      res.status(404).json({ error: "No Telegram bridge configured" });
      return;
    }

    const config = { ...((bridge.config as Record<string, unknown> | null) ?? {}) };
    config.allowedChatIds = cleaned;
    await db.update(messagingBridges).set({ config, updatedAt: new Date() }).where(eq(messagingBridges.id, bridge.id));

    // Restart the bot so the new allowlist is picked up by the in-memory
    // BotInstance immediately rather than waiting for the next process restart.
    if (bridge.secretId) {
      try {
        const token = await secretSvc.resolveSecretValue(companyId, bridge.secretId, "latest");
        if (token) {
          await stopTelegramBridge(companyId);
          await startTelegramBridge(db, companyId, token);
        }
      } catch (err) {
        logger.warn({ err, companyId }, "[messaging] failed to restart bot after allowlist update");
      }
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "messaging.telegram.allowed_chat_ids_updated",
      entityType: "messaging_bridge",
      entityId: bridge.id,
      details: { count: cleaned.length },
    });

    res.json({ ok: true, allowedChatIds: cleaned });
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

  // Surface a single boot-time warning if signing keys are unset (backward-compat
  // for existing deploys that lean on the static webhook-secret token only).
  warnIfWebhookSigningDisabledOnce(logger);

  router.post("/webhooks/email", async (req, res) => {
    // SEC-WEBHOOK-002: When provider signature headers are present, verify
    // them BEFORE the static-token check so a leaked token alone can't be
    // replayed against a Mailgun/SendGrid-protected deployment.
    const rawBody: Buffer = (req as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

    const mailgunSig = (req.headers["x-mailgun-signature-256"] as string | undefined) ?? null;
    const sendgridSig = (req.headers["x-twilio-email-event-webhook-signature"] as string | undefined) ?? null;
    const sendgridTs = (req.headers["x-twilio-email-event-webhook-timestamp"] as string | undefined) ?? null;

    const mailgunKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    const sendgridKey = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
    let providerSignatureVerified = false;

    // Mailgun: enforce when either the env var OR header is present.
    if (mailgunKey || mailgunSig) {
      if (!mailgunKey) {
        logger.warn("[email-bridge] Mailgun signature header present but MAILGUN_WEBHOOK_SIGNING_KEY unset");
        res.status(401).json({ ok: false, error: "Mailgun signature verification unavailable" });
        return;
      }
      if (!verifyHmacSha256(rawBody, mailgunSig, mailgunKey)) {
        res.status(401).json({ ok: false, error: "Invalid Mailgun signature" });
        return;
      }
      providerSignatureVerified = true;
    }

    // SendGrid: same logic — present env or header triggers enforcement.
    if (sendgridKey || sendgridSig || sendgridTs) {
      if (!sendgridKey) {
        logger.warn("[email-bridge] SendGrid signature header present but SENDGRID_WEBHOOK_PUBLIC_KEY unset");
        res.status(401).json({ ok: false, error: "SendGrid signature verification unavailable" });
        return;
      }
      if (!verifySendgridSignature(rawBody, sendgridTs, sendgridSig, sendgridKey)) {
        res.status(401).json({ ok: false, error: "Invalid SendGrid signature" });
        return;
      }
      providerSignatureVerified = true;
    }

    // SEC-INTEG-002: Validate webhook secret to prevent unauthorized issue creation.
    // Mailgun/SendGrid should be configured to include this token as a query param
    // or header. Without it, anyone can POST fake emails to create issues.
    // SEC-ADV-002: Webhook secret is mandatory in authenticated deployment mode.
    // Without it, anyone on the internet can create issues in any company.
    // If a provider signature already passed, the request is authenticated and
    // the static-token gate is unnecessary. Otherwise fall back to the legacy
    // shared-token check for unsigned (or non-Mailgun/SendGrid) parsers.
    if (!providerSignatureVerified) {
      const webhookSecret = process.env.IRONWORKS_EMAIL_WEBHOOK_SECRET;
      if (!webhookSecret) {
        console.warn("[email-bridge] IRONWORKS_EMAIL_WEBHOOK_SECRET not set — rejecting all email webhooks");
        res.status(503).json({ ok: false, error: "Email bridge not configured" });
        return;
      }
      // SEC-WEBHOOK-001: timing-safe comparison to prevent webhook-secret oracle.
      const tokenRaw = req.query.token ?? req.headers["x-webhook-secret"];
      const token = typeof tokenRaw === "string" ? tokenRaw : "";
      const tokenBuf = Buffer.from(token);
      const secretBuf = Buffer.from(webhookSecret);
      if (tokenBuf.length !== secretBuf.length || !timingSafeEqual(tokenBuf, secretBuf)) {
        res.status(401).json({ ok: false, error: "Invalid webhook secret" });
        return;
      }
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
      logger.error({ err }, "[email-bridge] Webhook error");
      // Return 200 to prevent retries
      res.json({ ok: false, error: "Internal error processing email" });
    }
  });

  return router;
}
