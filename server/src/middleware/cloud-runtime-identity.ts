import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "./logger.js";
import {
  applyCloudRuntimeIdentityAssertion,
  CLOUD_RUNTIME_IDENTITY_HEADER,
} from "../services/cloud-runtime-identity.js";

/**
 * Accepts Cloud's signed identity only on the existing bootstrap health call.
 * The JWS is sufficient authorization; the browser-facing proxy strips this
 * header, and possession of the shared tenant-session token cannot mint it.
 */
export function cloudRuntimeIdentityMiddleware(db: Db): RequestHandler {
  return async (req, res, next) => {
    const assertion = req.get(CLOUD_RUNTIME_IDENTITY_HEADER)?.trim();
    if (!assertion) {
      next();
      return;
    }
    if (req.method !== "GET" || req.path !== "/api/health") {
      res.status(400).json({ error: "cloud_runtime_identity_wrong_endpoint" });
      return;
    }
    try {
      await applyCloudRuntimeIdentityAssertion({ db, compactJws: assertion });
      next();
    } catch (error) {
      logger.warn({ err: error }, "Rejected Cloud runtime identity assertion");
      res.status(401).json({ error: "invalid_cloud_runtime_identity" });
    }
  };
}
