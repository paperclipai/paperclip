import { Router } from "express";
import { vaultService } from "../services/index.js";

export function vaultRoutes() {
  const router = Router();
  const svc = vaultService();

  // Get vault backbone health status
  router.get("/vault/health", async (_req, res) => {
    const status = await svc.health();
    const httpStatus = status.healthy ? 200 : status.configured ? 503 : 200;
    res.status(httpStatus).json(status);
  });

  return router;
}
