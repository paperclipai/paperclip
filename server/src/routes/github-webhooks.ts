/**
 * GitHub webhook route — `POST /api/companies/:companyId/webhooks/github`.
 *
 * Phase 5.2d — ingests `pull_request` events and forwards them to the
 * `githubWebhookService`. See the service file for design notes.
 *
 * Authentication:
 *   1. The request MUST include `X-Hub-Signature-256`, GitHub's
 *      standard HMAC header (`sha256=<hex>`).
 *   2. We verify against the first of:
 *        a. Per-company secret stored in `company_secrets` with name
 *           `github_webhook` (for production).
 *        b. Env var `GITHUB_WEBHOOK_SECRET` (for local smoke tests).
 *   3. `express.json()` already captures `req.rawBody` via the global
 *      `verify` hook so we use that exact byte sequence for HMAC.
 *
 * Response:
 *   - 202 Accepted on success, with a JSON summary of matched issues.
 *   - 400 on malformed payload (no pull_request / unsupported event).
 *   - 401 on signature mismatch OR when no secret is configured.
 *   - 404 if the company id is unknown.
 *
 * We deliberately do NOT surface which issues existed/didn't — the
 * response summary only counts identifiers and echoes unknowns, which
 * is fine because the caller already knew the identifiers (they wrote
 * them in the PR body).
 */

import type { Request, Response, Router as ExpressRouter } from "express";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/activity-log.js";
import {
  githubWebhookService,
  verifyGithubSignature,
  type PullRequestEventPayload,
} from "../services/github-webhooks.js";
import { secretService } from "../services/secrets.js";

export function githubWebhookRoutes(db: Db): ExpressRouter {
  const router = Router();
  const svc = githubWebhookService(db);
  const secretsSvc = secretService(db);

  /**
   * Resolve the webhook HMAC secret for a company. Preference order:
   *   1. `company_secrets` row named `github_webhook`
   *   2. `GITHUB_WEBHOOK_SECRET` env var (local dev fallback)
   *
   * Returns null if neither is set. Callers must treat null as
   * "reject the request".
   */
  async function resolveSecret(companyId: string): Promise<string | null> {
    try {
      const all = await secretsSvc.list(companyId);
      const found = all.find((s) => s.name === "github_webhook");
      if (found) {
        const value = await secretsSvc.resolveSecretValue(companyId, found.id, "latest");
        if (typeof value === "string" && value.length > 0) return value;
      }
    } catch (err) {
      logger.warn({ err, companyId }, "github webhook: secrets lookup failed; falling back to env");
    }
    const envSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (envSecret && envSecret.length > 0) return envSecret;
    return null;
  }

  router.post("/companies/:companyId/webhooks/github", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;

    // 1. Company existence check. We don't use assertCompanyAccess
    // because this route is unauthenticated (HMAC is the auth).
    const company = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    // 2. Signature verification using the raw request body captured
    // by express.json's verify hook in app.ts.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: "Missing raw body for signature verification" });
      return;
    }
    const secret = await resolveSecret(companyId);
    if (!secret) {
      res.status(401).json({ error: "Webhook secret not configured for this company" });
      return;
    }
    const signatureHeader =
      (req.header("x-hub-signature-256") as string | undefined) ??
      (req.header("X-Hub-Signature-256") as string | undefined) ??
      null;
    if (!verifyGithubSignature(rawBody, signatureHeader, secret)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    // 3. Parse the event. GitHub sends the event name in
    // `X-GitHub-Event` and the JSON body in req.body. For this MVP we
    // only handle `pull_request`; others get a polite 202 no-op.
    const eventName = req.header("x-github-event") ?? req.header("X-GitHub-Event") ?? "";
    if (eventName !== "pull_request") {
      res.status(202).json({ ignored: true, reason: `Unsupported event: ${eventName || "(none)"}` });
      return;
    }

    const payload = req.body as PullRequestEventPayload | null;
    if (!payload || typeof payload !== "object" || !payload.pull_request) {
      res.status(400).json({ error: "Malformed pull_request payload" });
      return;
    }

    // Reviewer P1 finding J — validate required PR fields before we
    // hand the payload to the service. A minimal `{ pull_request: {} }`
    // from a malicious caller would otherwise reach `upsertWorkProduct`
    // and insert NULL into NOT NULL columns, 500ing the process.
    const pr = payload.pull_request;
    if (
      typeof pr.title !== "string" ||
      typeof pr.html_url !== "string" ||
      typeof pr.number !== "number"
    ) {
      res.status(400).json({ error: "pull_request missing required fields (title, html_url, number)" });
      return;
    }

    // Reviewer P1 finding G — enforce https URL scheme so a
    // `javascript:alert(1)` payload can't reach the DB and then the UI
    // href renderer. `new URL()` also validates the general shape.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(pr.html_url);
    } catch {
      res.status(400).json({ error: "pull_request.html_url is not a valid URL" });
      return;
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      res.status(400).json({
        error: `pull_request.html_url must be http(s), got ${parsedUrl.protocol}`,
      });
      return;
    }

    // 4. Apply.
    const result = await svc.applyPullRequestEvent(companyId, payload);

    // 5. Activity log per matched issue — nice for auditing, scoped to
    // the company bus.
    if (result.upserted > 0 || result.transitioned > 0) {
      try {
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "github-webhook",
          action: "github.pr_event",
          entityType: "system",
          entityId: payload.pull_request.html_url,
          details: {
            action: payload.action,
            prNumber: payload.pull_request.number,
            merged: payload.pull_request.merged,
            matchedIdentifiers: result.matchedIdentifiers,
            upserted: result.upserted,
            transitioned: result.transitioned,
          },
        });
      } catch (err) {
        logger.warn({ err }, "github webhook: activity log failed (non-fatal)");
      }
    }

    res.status(202).json({
      ok: true,
      action: payload.action,
      matchedIdentifiers: result.matchedIdentifiers,
      upserted: result.upserted,
      transitioned: result.transitioned,
      unknownIdentifiers: result.unknownIdentifiers,
    });
  });

  return router;
}
