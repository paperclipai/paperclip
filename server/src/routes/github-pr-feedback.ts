import { Router } from "express";
import { badRequest, notFound, tooManyRequests, unauthorized } from "../errors.js";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";
import type { GithubPrFeedbackService } from "../services/github-pr-feedback.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The chat ingress's budget: generous for GitHub's delivery rate, bounded for
// anyone else, since every request costs a secret lookup and an HMAC.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 600;

function header(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * `POST /api/chat-webhooks/github-pr-feedback/:companyId`, GitHub's signed
 * webhook for pull request reviews and comments. It sits under the public
 * `/api/chat-webhooks/` prefix on purpose: everything mounted there is a POST
 * that verifies the provider's signature against the raw body, which is what
 * this route does before it reads anything. The body arrives as the raw Buffer
 * (chatWebhookBodyParser), so the signature is checked over GitHub's exact bytes.
 *
 * Mount it BEFORE chatWebhookRoutes: its path has the chat route's two-segment
 * `/:publicId/:provider` shape and would otherwise be refused there as an
 * unsupported provider.
 */
export function githubPrFeedbackRoutes(
  service: Pick<GithubPrFeedbackService, "handleDelivery">,
  options: { rateLimiter?: ReturnType<typeof createInviteRateLimiter> } = {},
) {
  const router = Router();
  const rateLimiter =
    options.rateLimiter ??
    createInviteRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_MAX_REQUESTS });
  router.post("/api/chat-webhooks/github-pr-feedback/:companyId", async (req, res) => {
    const companyId = String(req.params.companyId ?? "");
    if (!UUID_RE.test(companyId)) throw notFound();
    const limit = rateLimiter.consume(`github-pr-feedback:${companyId}:${req.ip || req.socket?.remoteAddress || "unknown"}`);
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      throw tooManyRequests("Too many GitHub feedback deliveries", { retryAfterSeconds: limit.retryAfterSeconds });
    }
    if (!Buffer.isBuffer(req.body)) throw badRequest("Raw webhook body required");
    const result = await service.handleDelivery({
      companyId,
      event: header(req.headers["x-github-event"]) ?? "",
      signature: header(req.headers["x-hub-signature-256"]),
      rawBody: req.body,
    });
    // Not enabled for the company reads as a missing route; a bad signature is
    // a 401, which is what GitHub's delivery log shows the operator.
    if (result.status === "not_enabled") throw notFound();
    if (result.status === "unauthorized") throw unauthorized();
    res.status(202).json(result);
  });
  return router;
}
