import type { Request } from "express";
import { forbidden } from "../errors.js";
import { assertFixedProcessKeyRequest } from "./fixed-process-key.js";

// Administrative configuration must not be self-issued, including through
// nested hire/import/config payloads. Removing it through replacement is
// covered separately by the persisted target check.
export function assertNoAgentFixedProcessConfiguration(req: Pick<Request, "actor" | "body">): void {
  if (req.actor.type !== "agent") return;
  const pending: unknown[] = [req.body];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === "fixedCommand" || key === "watchdogService") {
        throw forbidden("Only an administrator may establish fixed process service configuration.");
      }
      pending.push(child);
    }
  }
}

export function assertAgentFixedProcessTarget(
  req: Pick<Request, "actor" | "method" | "path" | "body" | "query">,
  target: { id: string; adapterType: string; adapterConfig: unknown },
): void {
  if (req.actor.type !== "agent") return;
  const config = target.adapterConfig;
  if (!config || typeof config !== "object" || !("fixedCommand" in config) || config.fixedCommand !== true) return;
  if (req.method === "GET") return;
  if (req.actor.agentId !== target.id) {
    throw forbidden("Agents cannot mutate or trigger another fixed process service.");
  }
  // A fixed process cannot remove its restrictions, change adapter type,
  // restore an old revision, or use a different mutation route with a run JWT.
  assertFixedProcessKeyRequest({ ...target, adapterType: "process" }, req);
}
