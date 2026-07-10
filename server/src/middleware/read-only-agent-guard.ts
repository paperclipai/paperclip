import type { RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function readOnlyAgentMutationGuard(): RequestHandler {
  return (req, res, next) => {
    if (
      req.actor.type === "agent"
      && req.actor.readOnly === true
      && !SAFE_METHODS.has(req.method.toUpperCase())
    ) {
      res.status(403).json({
        error: "This agent is read-only and cannot mutate Paperclip data",
        code: "agent_read_only",
      });
      return;
    }
    next();
  };
}
