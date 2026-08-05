import { Router } from "express";
import { forbidden, HttpError, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  getCloudStackContext,
  type CloudInstanceEnv,
} from "../services/cloud-instance.js";

const DEFAULT_PORTFOLIO_CACHE_TTL_MS = 30_000;
const CLOUD_PORTFOLIO_PATH = "/v1/tenant/portfolio";

type PortfolioCacheEntry = {
  expiresAt: number;
  payload: unknown;
};

export function cloudRoutes(opts: {
  runtimeEnv?: CloudInstanceEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
} = {}) {
  const router = Router();
  const runtimeEnv = opts.runtimeEnv ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_PORTFOLIO_CACHE_TTL_MS;
  const portfolioCache = new Map<string, PortfolioCacheEntry>();

  router.get("/stacks", async (req, res) => {
    const context = getCloudStackContext(runtimeEnv);
    if (!context) {
      throw notFound("Cloud stack portfolio is unavailable");
    }
    if (req.actor.source !== "cloud_tenant" || !req.actor.userId?.trim()) {
      throw forbidden("Trusted Cloud tenant access required", {
        code: "cloud_tenant_required",
      });
    }

    const tenantToken = runtimeEnv.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim();
    if (!context.cloudOrigin || !context.stackId || !tenantToken) {
      throw new HttpError(503, "Paperclip Cloud portfolio is not configured", {
        code: "cloud_portfolio_not_configured",
      });
    }

    const actorUserId = req.actor.userId.trim();
    const cacheKey = `${context.cloudOrigin}\n${context.stackId}\n${actorUserId}`;
    const currentTime = now();
    for (const [key, entry] of portfolioCache) {
      if (entry.expiresAt <= currentTime) portfolioCache.delete(key);
    }
    const cached = portfolioCache.get(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "no-store");
      res.json(cached.payload);
      return;
    }

    let portfolioUrl: URL;
    try {
      portfolioUrl = new URL(CLOUD_PORTFOLIO_PATH, context.cloudOrigin);
    } catch {
      throw new HttpError(503, "Paperclip Cloud portfolio is not configured", {
        code: "cloud_portfolio_not_configured",
      });
    }

    try {
      const upstream = await fetchImpl(portfolioUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${tenantToken}`,
          "x-paperclip-cloud-user-id": actorUserId,
          "x-paperclip-cloud-stack-id": context.stackId,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!upstream.ok) {
        logger.warn(
          { status: upstream.status, stackId: context.stackId },
          "Paperclip Cloud portfolio request failed",
        );
        throw new HttpError(502, "Paperclip Cloud portfolio request failed", {
          code: "cloud_portfolio_upstream_error",
        });
      }

      let payload: unknown;
      try {
        payload = await upstream.json();
      } catch {
        throw new HttpError(502, "Paperclip Cloud portfolio returned invalid JSON", {
          code: "cloud_portfolio_invalid_response",
        });
      }
      portfolioCache.set(cacheKey, {
        expiresAt: currentTime + cacheTtlMs,
        payload,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(payload);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      logger.warn(
        { err: error, stackId: context.stackId },
        "Paperclip Cloud portfolio request failed",
      );
      throw new HttpError(502, "Paperclip Cloud portfolio request failed", {
        code: "cloud_portfolio_upstream_error",
      });
    }
  });

  return router;
}
