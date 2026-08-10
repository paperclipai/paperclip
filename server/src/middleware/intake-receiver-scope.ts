import type { RequestHandler } from "express";

const CREATE_FIELDS = new Set([
  "title",
  "description",
  "status",
  "priority",
  "projectId",
  "assigneeAgentId",
  "idempotencyKey",
]);

function deny(res: Parameters<RequestHandler>[1]) {
  res.status(403).json({
    error: "Intake receiver key cannot use this API operation",
    code: "intake_receiver_scope_denied",
  });
}

export function intakeReceiverScopeGuard(): RequestHandler {
  return (req, res, next) => {
    const scope = req.actor.type === "agent" && req.actor.source === "agent_key"
      ? req.actor.keyScope
      : null;
    if (scope?.kind !== "intake_receiver") {
      next();
      return;
    }

    const createMatch = req.path.match(/^\/api\/companies\/([^/]+)\/issues$/);
    if (req.method === "POST" && createMatch) {
      const keys = Object.keys(req.body ?? {});
      const body = req.body as Record<string, unknown>;
      if (
        createMatch[1] === req.actor.companyId &&
        keys.length === CREATE_FIELDS.size &&
        keys.every((key) => CREATE_FIELDS.has(key)) &&
        body.projectId === scope.projectId &&
        body.assigneeAgentId === scope.assigneeAgentId &&
        body.priority === scope.priority &&
        body.status === "todo" &&
        typeof body.title === "string" &&
        typeof body.description === "string" &&
        typeof body.idempotencyKey === "string" &&
        body.idempotencyKey.startsWith("uptime-failure-intake:")
      ) {
        next();
        return;
      }
      deny(res);
      return;
    }

    if (/^\/api\/issues\/[^/]+\/comments$/.test(req.path)) {
      if (req.method === "GET" && Object.keys(req.query).length === 0) {
        next();
        return;
      }
      if (
        req.method === "POST" &&
        Object.keys(req.body ?? {}).length === 1 &&
        typeof req.body?.body === "string"
      ) {
        next();
        return;
      }
    }

    deny(res);
  };
}
