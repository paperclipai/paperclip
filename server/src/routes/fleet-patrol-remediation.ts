import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  auditMalformedFleetPatrolRequest,
  fleetPatrolRemediationService,
  type FleetPatrolActor,
} from "../services/fleet-patrol-remediation.js";

const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("clear_agent_error"),
    targetId: z.string().uuid(),
  }).strict(),
  z.object({
    operation: z.literal("release_issue_lock"),
    targetId: z.string().uuid(),
  }).strict(),
  z.object({
    operation: z.literal("reset_workspace_pin"),
    targetId: z.string().uuid(),
  }).strict(),
]);

const AUDITABLE_OPERATIONS = new Set([
  "clear_agent_error",
  "release_issue_lock",
  "reset_workspace_pin",
]);

function safeAuditOperation(value: unknown) {
  return typeof value === "string" && AUDITABLE_OPERATIONS.has(value)
    ? value
    : "schema_invalid";
}

function safeAuditTargetId(value: unknown) {
  return typeof value === "string" && z.string().uuid().safeParse(value).success
    ? value
    : "unknown";
}

function fleetPatrolActor(req: Express.Request): FleetPatrolActor | null {
  if (
    req.actor.type !== "agent"
    || !req.actor.agentId
    || !req.actor.companyId
    || !req.actor.runId
  ) {
    return null;
  }
  return {
    agentId: req.actor.agentId,
    companyId: req.actor.companyId,
    runId: req.actor.runId,
    apiKeyId: req.actor.keyId ?? req.actor.credentialId ?? null,
    credentialId: req.actor.credentialId ?? `unidentified:${req.actor.source ?? "unknown"}`,
    source: req.actor.source ?? "unknown",
  };
}

export function fleetPatrolRemediationRoutes(db: Db) {
  const router = Router();
  const service = fleetPatrolRemediationService(db);

  router.post("/fleet-patrol/remediation", async (req, res, next) => {
    try {
      const actor = fleetPatrolActor(req);
      if (!actor) {
        res.status(403).json({ error: "Fleet patrol run-scoped authentication required" });
        return;
      }

      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) {
        await auditMalformedFleetPatrolRequest(db, actor, {
          operation: safeAuditOperation(req.body?.operation),
          targetId: safeAuditTargetId(req.body?.targetId),
        });
        res.status(422).json({
          error: "Invalid fleet patrol remediation request",
          code: "fleet_patrol_schema_invalid",
        });
        return;
      }

      const result = await service.execute(actor, parsed.data);
      res.status(result.status).json({
        allowed: result.allowed,
        operation: parsed.data.operation,
        targetId: parsed.data.targetId,
        reasonCode: result.reasonCode,
        ...(result.allowed ? { before: result.before, after: result.after } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
