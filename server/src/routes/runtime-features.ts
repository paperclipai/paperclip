import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { resolveHostFeatures } from "../services/host-features.js";
import { assertAuthenticated } from "./authz.js";

export function runtimeFeatureRoutes(db: Db) {
  const router = Router();

  router.get("/runtime-features", async (req, res) => {
    assertAuthenticated(req);
    res.json(await resolveHostFeatures(db));
  });

  return router;
}
