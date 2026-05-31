import { Router } from "express";
import { asNumber } from "@paperclipai/adapter-utils/server-utils";
import { getLocalInferenceHealth } from "@paperclipai/adapter-local/server";

export function localInferenceRoutes() {
  const router = Router();

  router.get("/inference/local/health", async (req, res) => {
    const baseUrl =
      typeof req.query.baseUrl === "string" ? req.query.baseUrl : undefined;
    const timeoutSec =
      typeof req.query.timeoutSec === "string" ? Number(req.query.timeoutSec) : undefined;
    const health = await getLocalInferenceHealth({
      baseUrl,
      timeoutSec: asNumber(timeoutSec, 0),
    });
    res.json(health);
  });

  return router;
}
