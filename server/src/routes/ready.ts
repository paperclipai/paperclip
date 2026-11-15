import { Router, type RequestHandler } from "express";
import { getStartupRecoveryState } from "../startup-recovery-state.js";

/** Deployment admission, distinct from process liveness and diagnostic health.
 * Bootstrap has already verified its dependencies before publishing ready. This
 * endpoint neither authenticates nor opens SQL connections on an idle server. */
export function readinessRoutes() {
  const router = Router();
  const reply: RequestHandler = (_req, res) => {
    const { phase } = getStartupRecoveryState();
    res.set("Cache-Control", "no-store");
    if (phase !== "ready") res.set("Retry-After", "1");
    res.status(phase === "ready" ? 200 : 503).json({ status: phase });
  };
  router.head("/", reply);
  router.get("/", reply);
  return router;
}
