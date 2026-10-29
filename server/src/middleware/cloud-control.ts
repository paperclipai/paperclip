import type { RequestHandler } from "express";
import { logger } from "./logger.js";
import {
  CLOUD_CONTROL_HEADER,
  verifyCloudControlAssertion,
  type CloudControlAction,
} from "../services/cloud-runtime-identity.js";

/** Endpoint → method → the one action a control assertion must name to take it. */
const ACTIONS_BY_ENDPOINT: Record<string, Record<string, CloudControlAction>> = {
  "/api/instance/task-drain": {
    GET: "task-drain:read",
    POST: "task-drain:start",
    DELETE: "task-drain:stop",
  },
  "/api/instance/lifecycle": {
    GET: "lifecycle:read",
  },
  "/api/instance/lifecycle/unarchive-primary": {
    POST: "lifecycle:unarchive-primary",
  },
};

/**
 * Accepts Cloud's signed control assertion only on the closed endpoint set
 * above — the task-drain hold the deploy path uses, and the lifecycle
 * read-back/unarchive pair behind the Cloud archive sync. The JWS is the entire
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
    // Express's non-strict routing treats a trailing slash as the same
    // route; the endpoint check must agree with it.
    const normalizedPath = req.path.length > 1 && req.path.endsWith("/") ? req.path.slice(0, -1) : req.path;
    const expectedAction = ACTIONS_BY_ENDPOINT[normalizedPath]?.[req.method];
    if (!expectedAction) {
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
