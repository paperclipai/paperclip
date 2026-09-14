import type { RequestHandler } from "express";
import { logger } from "./logger.js";
import {
  CLOUD_CONTROL_HEADER,
  verifyCloudControlAssertion,
  type CloudControlAction,
} from "../services/cloud-runtime-identity.js";

/** Method → the one action a control assertion must name to take it. */
const ACTION_BY_METHOD: Record<string, CloudControlAction> = {
  GET: "task-drain:read",
  POST: "task-drain:start",
  DELETE: "task-drain:stop",
};

/**
 * Accepts Cloud's signed control assertion only on the task-drain endpoint,
 * so the Cloud control plane can hold new agent work and wait for quiescence
 * before restarting the container for a deploy. The JWS is the entire
 * authorization: a valid assertion installs a synthetic instance-admin board
 * actor (replacing whatever weaker actor the request carried), each assertion
 * is bound to exactly one method's action, and the header is rejected loudly
 * anywhere else so it can never become an ambient credential. Instances
 * without a Cloud stack identity reject every assertion. The browser-facing
 * Cloud proxy strips this header, and possession of the shared tenant-session
 * token cannot mint it.
 */
export function cloudControlMiddleware(): RequestHandler {
  return (req, res, next) => {
    const assertion = req.get(CLOUD_CONTROL_HEADER)?.trim();
    if (!assertion) {
      next();
      return;
    }
    const expectedAction = ACTION_BY_METHOD[req.method];
    // Express's non-strict routing treats a trailing slash as the same
    // route; the endpoint check must agree with it.
    const normalizedPath = req.path.length > 1 && req.path.endsWith("/") ? req.path.slice(0, -1) : req.path;
    if (normalizedPath !== "/api/instance/task-drain" || !expectedAction) {
      res.status(400).json({ error: "cloud_control_wrong_endpoint" });
      return;
    }
    try {
      verifyCloudControlAssertion({ compactJws: assertion, expectedAction });
    } catch (error) {
      logger.warn({ err: error }, "Rejected Cloud control assertion");
      res.status(401).json({ error: "invalid_cloud_control_assertion" });
      return;
    }
    req.actor = {
      type: "board",
      userId: "paperclip-cloud",
      userName: "Paperclip Cloud",
      userEmail: null,
      isInstanceAdmin: true,
      source: "cloud_control",
    };
    next();
  };
}
