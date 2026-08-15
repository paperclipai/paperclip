import type { RequestHandler } from "express";
import { forbidden } from "../errors.js";

const PROJECTION_PATH = /^\/api\/v1\/companies\/([^/]+)\/work-projection\/?$/;

/**
 * A projection credential is a capability, not an agent role. It is rejected
 * everywhere except the one company-bound GET route.
 */
export function companyWorkProjectionCredentialGuard(): RequestHandler {
  return (req, _res, next) => {
    if (req.actor?.type !== "none" || !req.actor.credentialId) {
      next();
      return;
    }

    const match = PROJECTION_PATH.exec(req.path);
    const companyId = match?.[1];
    const allowedMethod = req.method === "GET";
    if (
      !allowedMethod ||
      !companyId ||
      companyId !== req.actor.companyId
    ) {
      next(forbidden("Projection credential cannot access this resource", {
        code: "WORK_PROJECTION_FORBIDDEN",
      }));
      return;
    }

    next();
  };
}
