import type { RequestHandler } from "express";
import { isSafeMethod, requestHasTrustedBoardOrigin } from "./board-origin.js";

export function boardMutationGuard(): RequestHandler {
  return (req, res, next) => {
    if (isSafeMethod(req.method)) {
      next();
      return;
    }

    if (req.actor.type !== "board") {
      next();
      return;
    }

    // Local-trusted mode, board bearer keys, and trusted Cloud tenant calls are
    // not browser-session requests.
    // In these modes, origin/referer headers can be absent; do not block those mutations.
    if (
      req.actor.source === "local_implicit"
      || req.actor.source === "board_key"
      || req.actor.source === "cloud_tenant"
    ) {
      next();
      return;
    }

    if (!requestHasTrustedBoardOrigin(req)) {
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
