import { Router } from "express";
import type { ServerMetricsCollector } from "../services/server-metrics.js";
import { assertInstanceAdmin } from "./authz.js";

export function instanceServerMetricsRoutes(collector: ServerMetricsCollector) {
  const router = Router();

  router.get("/instance/server-metrics", (req, res) => {
    assertInstanceAdmin(req);
    res.set("Cache-Control", "no-store");
    res.json(collector.snapshot());
  });

  return router;
}
