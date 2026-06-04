import { Router } from "express";
import { asNumber } from "@paperclipai/adapter-utils/server-utils";
import { getLocalInferenceHealth } from "@paperclipai/adapter-local/server";

export function localInferenceRoutes() {
  const router = Router();

  router.get("/inference/local/health", async (req, res) => {
    const timeoutSec =
      typeof req.query.timeoutSec === "string" ? Number(req.query.timeoutSec) : undefined;
    const health = await getLocalInferenceHealth({
      timeoutSec: asNumber(timeoutSec, 0),
    });
    res.json(health);
  });

  return router;
}
