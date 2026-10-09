import { Router } from "express";
import { forbidden, HttpError, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { CloudPortfolioError, type CloudPortfolioPhase } from "../services/cloud-portfolio-error.js";
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

    const startedAt = performance.now();
    let phase: CloudPortfolioPhase = "fetch";
    let upstreamStatus: number | null = null;
    let upstreamSignal: AbortSignal | undefined;
    const portfolioError = (kind: "upstream" | "invalid_response", error?: unknown) => {
      const reportableError = new CloudPortfolioError(kind, {
        phase,
        elapsedMs: performance.now() - startedAt,
        upstreamStatus,
        deadlineExceeded: upstreamSignal?.aborted === true,
      }, error);
      // Preserve the route callsite instead of grouping by this helper frame.
      Error.captureStackTrace?.(reportableError, portfolioError);
      return reportableError;
    };

    try {
      upstreamSignal = AbortSignal.timeout(10_000);
      const upstream = await fetchImpl(portfolioUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${tenantToken}`,
          "x-paperclip-cloud-user-id": actorUserId,
          "x-paperclip-cloud-stack-id": context.stackId,
        },
        signal: upstreamSignal,
      });
      phase = "http_response";
      upstreamStatus = upstream.status;
      if (!upstream.ok) {
        const error = portfolioError("upstream");
        logger.warn(
          { cloudPortfolio: error.diagnostics },
          "Paperclip Cloud portfolio request failed",
        );
        throw error;
      }

      phase = "response_body";
      let payload: unknown;
      try {
        payload = await upstream.json();
      } catch (error) {
        throw portfolioError("invalid_response", error);
      }
      phase = "response_write";
      portfolioCache.set(cacheKey, {
        expiresAt: currentTime + cacheTtlMs,
        payload,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(payload);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const reportableError = portfolioError("upstream", error);
      logger.warn(
        { cloudPortfolio: reportableError.diagnostics },
        "Paperclip Cloud portfolio request failed",
      );
      throw reportableError;
    }
  });

  return router;
}
