import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  GITHUB_WEBHOOK_ALLOWED_EVENTS,
  processGitHubWebhook,
  readGitHubWebhookConfig,
  verifyGitHubWebhookSignature,
  type GitHubWebhookIssueStore,
} from "../services/github-webhook.js";

type GithubWebhookRouteDeps = {
  issueStore?: GitHubWebhookIssueStore;
};

function readRawBody(req: Request) {
  const rawBody = (req as { rawBody?: Buffer }).rawBody;
  if (rawBody) return rawBody;
  return Buffer.from(JSON.stringify(req.body ?? {}));
}

function parseEventHeader(req: Request) {
  const event = req.header("x-github-event")?.trim() ?? "";
  return (GITHUB_WEBHOOK_ALLOWED_EVENTS as readonly string[]).includes(event) ? (event as (typeof GITHUB_WEBHOOK_ALLOWED_EVENTS)[number]) : null;
}

function parseDeliveryId(req: Request) {
  return req.header("x-github-delivery")?.trim() ?? null;
}

export async function handleGithubWebhookRequest(
  db: Db,
  req: Request,
  res: Response,
  deps: GithubWebhookRouteDeps = {},
) {
  try {
    const config = readGitHubWebhookConfig();
    if (!config.secret || !config.companyId) {
      res.status(500).json({
        error: "GitHub webhook is not configured",
        details: "GITHUB_WEBHOOK_SECRET and GITHUB_WEBHOOK_COMPANY_ID are required",
      });
      return;
    }

    const event = parseEventHeader(req);
    if (!event) {
      const rawBody = readRawBody(req);
      const signature = req.header("x-hub-signature-256");
      if (!verifyGitHubWebhookSignature({ secret: config.secret, rawBody, signature })) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
      res.status(200).json({ ok: true, ignored: true, reason: "Unsupported GitHub event" });
      return;
    }

    const result = await processGitHubWebhook({
      db,
      config,
      event,
      deliveryId: parseDeliveryId(req),
      rawBody: readRawBody(req),
      payload: req.body,
      signature: req.header("x-hub-signature-256"),
      issueStore: deps.issueStore,
    });

    if (result.kind === "ignored") {
      if (result.reason === "Invalid signature") {
        res.status(401).json({ error: result.reason });
        return;
      }

      res.status(200).json({ ok: true, ignored: true, reason: result.reason });
      return;
    }

    if (result.kind === "completed") {
      res.status(200).json({
        ok: true,
        processed: true,
        kind: result.kind,
        disposition: result.normalized.disposition,
        originId: result.normalized.originId,
        message: result.normalized.dispositionReason,
      });
      return;
    }

    res.status(result.kind === "created" ? 201 : 200).json({
      ok: true,
      processed: true,
      kind: result.kind,
      issueId: result.issueId,
      disposition: result.normalized.disposition,
      originId: result.normalized.originId,
    });
  } catch {
    console.error("GitHub webhook processing failed");
    res.status(500).json({ error: "Internal error while processing the GitHub webhook" });
  }
}

export function githubWebhookRoutes(db: Db, deps: GithubWebhookRouteDeps = {}) {
  const router = Router();
  router.post("/github/webhook", (req, res) => {
    void handleGithubWebhookRequest(db, req, res, deps);
  });
  return router;
}
