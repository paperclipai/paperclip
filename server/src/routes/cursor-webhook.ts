import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  dedupeCursorWebhook,
  normalizeCursorWebhookPayload,
  verifyCursorWebhookSignature,
} from "../services/cursor-webhook-ingest.js";

export function cursorWebhookRoutes(db: Db) {
  const router = Router();

  router.post("/cursor/webhook", async (req, res) => {
    const secret = process.env.CURSOR_WEBHOOK_SECRET?.trim();
    if (!secret) {
      res.status(503).json({ error: "cursor_webhook_not_configured" });
      return;
    }

    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const signature = req.header("X-Cursor-Signature") ?? req.header("X-Webhook-Signature") ?? undefined;
    if (!verifyCursorWebhookSignature({ rawBody, signatureHeader: signature, secret })) {
      res.status(401).json({ error: "invalid_signature" });
      return;
    }

    const webhookId = req.header("X-Webhook-ID") ?? undefined;
    if (dedupeCursorWebhook(webhookId)) {
      res.status(200).json({ ok: true, deduped: true });
      return;
    }

    const payload = normalizeCursorWebhookPayload(
      typeof req.body === "object" ? req.body : JSON.parse(rawBody),
    );
    if (!payload) {
      res.status(400).json({ error: "invalid_payload" });
      return;
    }

    logger.info(
      {
        webhookId,
        cursorAgentId: payload.agentId,
        cursorRunId: payload.runId,
        type: payload.type,
      },
      "cursor cloud webhook ingested (v0 bridge)",
    );

    // Forward-compatible: v1 webhooks will enrich run_events once Cursor ships them.
    void db;

    res.status(200).json({ ok: true });
  });

  return router;
}
