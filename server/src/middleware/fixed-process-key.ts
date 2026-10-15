import type { Request } from "express";
import { forbidden } from "../errors.js";

/** Opt-in service processes expose a trigger, not a general-purpose agent key. */
export function assertFixedProcessKeyRequest(
  agent: { id: string; adapterType: string; adapterConfig: unknown },
  req: Pick<Request, "method" | "path" | "body" | "query">,
): void {
  const config = agent.adapterConfig;
  if (
    agent.adapterType !== "process" ||
    typeof config !== "object" || config === null ||
    !("fixedCommand" in config) || config.fixedCommand !== true
  ) return;

  // Reconcile an uncertain trigger outcome without replaying a POST. This is
  // the existing redacted agent record, not configuration/history/log access.
  if (req.method === "GET" && req.path === `/api/agents/${agent.id}` &&
      Object.keys(req.query).length === 0) return;

  const ownWakePaths = [
    `/api/agents/${agent.id}/wakeup`,
    `/api/agents/${agent.id}/heartbeat/invoke`,
  ];
  const body = req.body ?? {};
  // Do not forward issue IDs, payloads, debug/retry context, or future route
  // options. In particular, an issue can carry assigneeAdapterOverrides.
  const triggerOnly =
    req.method === "POST" && ownWakePaths.includes(req.path) &&
    Object.keys(req.query).length === 0 &&
    typeof body === "object" && body !== null && !Array.isArray(body) &&
    Object.keys(body).every((key) => key === "idempotencyKey") &&
    (body.idempotencyKey === undefined ||
      (typeof body.idempotencyKey === "string" && body.idempotencyKey.length <= 200));
  if (!triggerOnly) {
    throw forbidden("Fixed process keys may only read their agent status or trigger it without execution parameters.");
  }
}
