import type { ServerOptions } from "node:http";
import { Router, type RequestHandler } from "express";
import type { CloudWarmStandby } from "../services/cloud-warm-standby.js";

/** Mount after signed identity handoff and before session or tenant resolution. */
export function cloudWarmStandbyMiddleware(
  isStandby: CloudWarmStandby,
  health: RequestHandler,
  staticUi: RequestHandler = Router(),
) {
  const router = Router();
  router.use("/api/health", (req, res, next) => {
    if (isStandby() && !req.headers.upgrade && (req.method === "GET" || req.method === "HEAD") && req.path === "/") {
      req.actor = { type: "none", source: "none" };
      health(req, res, next);
      return;
    }
    next();
  });
  router.use((req, res, next) => {
    if (!isStandby()) return next();
    req.actor = { type: "none", source: "none" };
    const unavailable = () => res.status(503).json({ error: "workspace_unclaimed" });
    if (/^\/api(?:\/|$)/i.test(req.path) || req.headers.upgrade || (req.method !== "GET" && req.method !== "HEAD")) {
      unavailable();
      return;
    }
    // Serve only the UI router, never fall through to session, tenant, bearer,
    // MCP, or other dynamic handlers, even when the request carries credentials.
    staticUi(req, res, (error?: unknown) => {
      if (error) next(error);
      else unavailable();
    });
  });
  return router;
}

/** Node 24.9+ routes rejected upgrades through the guarded HTTP request path. */
export function cloudWarmStandbyServerOptions(isStandby: CloudWarmStandby): ServerOptions {
  return { shouldUpgradeCallback: () => !isStandby() };
}
