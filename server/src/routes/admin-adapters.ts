import { Buffer } from "node:buffer";
import { agents, type Db } from "@paperclipai/db";
import type { Request, Response } from "express";
import { Router } from "express";
import { getActorInfo, assertBoardOrgAccess, assertInstanceAdmin } from "./authz.js";
import { heartbeatService } from "../services/heartbeat.js";
import { logActivity } from "../services/activity-log.js";
import {
  buildCircuitKey,
  getCircuitState,
  resetCircuit,
  type CircuitState,
} from "../adapters/circuit-breaker.js";
import { isOverridePaused, setOverridePaused } from "../adapters/registry.js";

const AGENT_ACTOR_RELEASE_ERROR = "Agent actors cannot manually release adapter quarantine";

type MatchingCircuitTarget = {
  companyId: string;
  adapterType: string;
};

type AuditOutcome = "applied" | "rejected_agent_actor";
type AdminCircuitAction = "reset" | "override_pause";

type ResetRequestShape = {
  reason?: unknown;
};

function decodeRouteKey(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8").trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function readRequiredString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function findMatchingCircuitTargets(db: Db, routeKey: string): Promise<{
  circuitKey: string | null;
  targets: MatchingCircuitTarget[];
}> {
  const routeTarget = decodeRouteKey(routeKey);
  if (!routeTarget) {
    return { circuitKey: null, targets: [] };
  }
  const adapterTypeTarget = routeTarget.startsWith("adapter:") ? routeTarget.slice("adapter:".length) : null;

  const rows = await db
    .select({
      companyId: agents.companyId,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents);

  const targetMap = new Map<string, MatchingCircuitTarget>();
  let matchedCircuitKey: string | null = adapterTypeTarget ? null : routeTarget;
  for (const row of rows) {
    const rowCircuitKey = buildCircuitKey({
      adapterType: row.adapterType,
      adapterConfig: row.adapterConfig,
    });
    const matches = adapterTypeTarget
      ? row.adapterType === adapterTypeTarget
      : rowCircuitKey === routeTarget;
    if (!matches) {
      continue;
    }
    matchedCircuitKey ??= rowCircuitKey;

    targetMap.set(`${row.companyId}:${row.adapterType}`, {
      companyId: row.companyId,
      adapterType: row.adapterType,
    });
  }

  return {
    circuitKey: matchedCircuitKey,
    targets: [...targetMap.values()],
  };
}

function readResetRequest(body: unknown): { reason: string | null } {
  const parsed = (body ?? {}) as ResetRequestShape;
  return {
    reason: readRequiredString(parsed.reason),
  };
}

async function handleCircuitReset(
  db: Db,
  req: Request,
  res: Response,
  key: string,
  reason: string,
) {
  const matched = await findMatchingCircuitTargets(db, key);
  if (!matched.circuitKey) {
    res.status(400).json({ error: "Invalid circuit key" });
    return;
  }
  if (matched.targets.length === 0) {
    res.status(404).json({ error: "Adapter circuit not found" });
    return;
  }

  if (req.actor.type === "agent") {
    const actor = getActorInfo(req);
    await writeCircuitAuditRows(db, {
      actor,
      reqActor: req.actor,
      targets: matched.targets,
      action: "reset",
      activityAction: "circuit_reset",
      key: matched.circuitKey,
      reason,
      oldState: null,
      newState: null,
      outcome: "rejected_agent_actor",
    });
    res.status(403).json({ error: AGENT_ACTOR_RELEASE_ERROR });
    return;
  }

  assertBoardOrgAccess(req);
  assertInstanceAdmin(req);
  const actor = getActorInfo(req);
  const oldState = getCircuitState(matched.circuitKey);
  const newState = resetCircuit(matched.circuitKey);
  if (!newState) {
    res.status(404).json({ error: "Adapter circuit not found" });
    return;
  }

  const heartbeat = heartbeatService(db);
  await heartbeat.reconcileCircuitQuarantine({ circuitKey: matched.circuitKey });
  await writeCircuitAuditRows(db, {
    actor,
    reqActor: req.actor,
    targets: matched.targets,
    action: "reset",
    activityAction: "circuit_reset",
    key: matched.circuitKey,
    reason,
    oldState,
    newState,
    outcome: "applied",
  });

  res.json({ ok: true, circuitKey: matched.circuitKey, state: newState.state });
}

async function writeCircuitAuditRows(
  db: Db,
  input: {
    actor: ReturnType<typeof getActorInfo>;
    reqActor: Request["actor"];
    targets: MatchingCircuitTarget[];
    action: AdminCircuitAction;
    activityAction: string;
    key: string;
    reason: string;
    oldState: CircuitState | null;
    newState: CircuitState | null;
    outcome: AuditOutcome;
  },
) {
  const at = new Date().toISOString();
  await Promise.all(
    input.targets.map((target) =>
      logActivity(db, {
        companyId: target.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: input.activityAction,
        entityType: "adapter_circuit",
        entityId: input.key,
        details: {
          actor: {
            kind: input.reqActor.type,
            userId: input.reqActor.userId ?? null,
            agentId: input.reqActor.agentId ?? null,
            runId: input.reqActor.runId ?? null,
          },
          action: input.action,
          key: input.key,
          reason: input.reason,
          oldState: input.oldState,
          newState: input.newState,
          expiresAt: null,
          at,
          outcome: input.outcome,
        },
      }),
    ),
  );
}

export function adminAdapterRoutes(db: Db) {
  const router = Router();

  router.post("/:key/override-pause", async (req, res) => {
    const reason = readRequiredString(req.body?.reason);
    if (!reason) {
      res.status(400).json({ error: "Request body must include a non-empty \"reason\" string." });
      return;
    }
    const matched = await findMatchingCircuitTargets(db, req.params.key);
    if (!matched.circuitKey) {
      res.status(400).json({ error: "Invalid circuit key" });
      return;
    }
    if (matched.targets.length === 0) {
      res.status(404).json({ error: "Adapter circuit not found" });
      return;
    }

    if (req.actor.type === "agent") {
      const actor = getActorInfo(req);
      await writeCircuitAuditRows(db, {
        actor,
        reqActor: req.actor,
        targets: matched.targets,
        action: "override_pause",
        activityAction: "adapter_override_pause",
        key: matched.circuitKey,
        reason,
        oldState: null,
        newState: null,
        outcome: "rejected_agent_actor",
      });
      res.status(403).json({ error: AGENT_ACTOR_RELEASE_ERROR });
      return;
    }

    assertBoardOrgAccess(req);
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    const oldState = getCircuitState(matched.circuitKey);
    if (!oldState) {
      res.status(404).json({ error: "Adapter circuit not found" });
      return;
    }

    const adapterType = matched.targets[0]!.adapterType;
    const wasPaused = isOverridePaused(adapterType);
    const changed = setOverridePaused(adapterType, true);
    if (!changed && !wasPaused) {
      res.status(404).json({ error: "Adapter override not found" });
      return;
    }

    const newState = resetCircuit(matched.circuitKey);
    if (!newState) {
      res.status(404).json({ error: "Adapter circuit not found" });
      return;
    }

    const heartbeat = heartbeatService(db);
    await heartbeat.reconcileCircuitQuarantine({ circuitKey: matched.circuitKey });
    await writeCircuitAuditRows(db, {
      actor,
      reqActor: req.actor,
      targets: matched.targets,
      action: "override_pause",
      activityAction: "adapter_override_pause",
      key: matched.circuitKey,
      reason,
      oldState,
      newState,
      outcome: "applied",
    });

    res.json({
      ok: true,
      adapterType,
      circuitKey: matched.circuitKey,
      overridePaused: true,
      changed,
      state: newState.state,
    });
  });

  router.post("/:key/reset", async (req, res) => {
    const { reason } = readResetRequest(req.body);
    if (!reason) {
      res.status(400).json({ error: "Request body must include a non-empty \"reason\" string." });
      return;
    }

    await handleCircuitReset(db, req, res, req.params.key, reason);
  });

  return router;
}

export function adapterQuarantineRoutes(db: Db) {
  const router = Router();

  router.post("/adapters/quarantine/:key/reset", async (req, res) => {
    const { reason } = readResetRequest(req.body);
    if (!reason) {
      res.status(400).json({ error: "Request body must include a non-empty \"reason\" string." });
      return;
    }

    await handleCircuitReset(db, req, res, req.params.key, reason);
  });

  return router;
}
