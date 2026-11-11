import { Router, type RequestHandler } from "express";
import { getServerInfoSnapshot, type ServerInfoSnapshot } from "../server-info.js";
import { getStartupRecoveryState } from "../startup-recovery-state.js";

/** Routine probes report process readiness without auth, SQL, or provider I/O.
 * Database readiness and signed bootstrap remain on /api/health. */
export function livenessRoutes(serverInfo: ServerInfoSnapshot = getServerInfoSnapshot()) {
  const router = Router();
  const commit = serverInfo.git.available ? serverInfo.git.fullSha : null;
  const respond: RequestHandler = (_req, res) => {
    const ready = getStartupRecoveryState().phase === "ready";
    res.set("Cache-Control", "no-store").status(ready ? 200 : 503).json({
      status: ready ? "ok" : "starting",
      commit,
    });
  };
  router.head("/", respond);
  router.get("/", respond);
  return router;
}
