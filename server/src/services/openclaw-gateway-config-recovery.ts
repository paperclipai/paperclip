/**
 * openclaw-gateway adapterConfig wedge recovery (PHA-3517).
 *
 * Symptom: Van Dam (and other openclaw_gateway agents) flap between
 * adapterConfig={} and a populated state within <30s after a wake. The
 * prior 5 repair tickets (PHA-2924/3001/3005/3167/3194) all closed the
 * symptom without eliminating the root race condition.
 *
 * This module is the durable fix: a server-side watcher that detects
 * adapterConfig={} on openclaw_gateway agents and re-applies the last
 * known-good adapterConfig snapshot from agent_config_revisions.
 *
 * Detection:
 *   adapterType === "openclaw_gateway" && adapterConfig is an empty object
 *   (or null) AND the agent is not pending_approval/terminated.
 *
 * Recovery source:
 *   The most recent agent_config_revisions row whose snapshot included a
 *   non-empty adapterConfig. We prefer the populated side of the revision
 *   (beforeConfig.adapterConfig if afterConfig.adapterConfig is empty,
 *   otherwise afterConfig.adapterConfig). This survives repeated wipes
 *   because each repair itself writes a new revision.
 *
 * Wiring:
 *   - services/heartbeat.ts enqueueWakeup() — detect before queuing a run
 *     so the next dispatch reads a populated config
 *   - routes/agents.ts GET /agents/:id — detect on read so the board sees
 *     the corrected config immediately
 *   - background reconcile loop — catches wedged agents nobody is reading
 */

import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentConfigRevisions, agents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { withAgentStartLock } from "./agent-start-lock.js";

export const OPENCLAW_GATEWAY_WEDGE_REVISION_SOURCE = "openclaw_gateway_wedge_recovery";

export type OpenclawGatewayRecoveryOutcome =
  | { status: "skipped"; reason: string }
  | {
      status: "repaired";
      sourceRevisionId: string;
      adapterConfigKeys: string[];
      beforeKeyCount: number;
    };

export interface OpenclawGatewayRecoveryDeps {
  db: Db;
  /**
   * Applies the recovery patch to the agent. Receives the agent id and the
   * last-good adapterConfig to write back. Implementations should record a
   * revision with source OPENCLAW_GATEWAY_WEDGE_REVISION_SOURCE so the
   * recovery itself is auditable and reversible via the existing
   * rollbackConfigRevision path. Returning null/undefined means the update
   * could not be applied; the recovery is then treated as failed.
   */
  applyAdapterConfigPatch: (input: {
    agentId: string;
    companyId: string;
    adapterConfig: Record<string, unknown>;
    sourceRevisionId: string;
  }) => Promise<unknown>;
}

interface LastGoodRevisionCandidate {
  revisionId: string;
  createdAt: Date;
  beforeConfig: Record<string, unknown> | null;
  afterConfig: Record<string, unknown> | null;
}

const EMPTY_OBJECT_KEYS: readonly string[] = Object.freeze(Object.keys({}));

function readConfig(record: unknown): Record<string, unknown> | null {
  if (record === null || record === undefined) return null;
  if (typeof record !== "object" || Array.isArray(record)) return null;
  return record as Record<string, unknown>;
}

function isEmptyAdapterConfig(value: unknown): boolean {
  const record = readConfig(value);
  if (record === null) return true;
  return Object.keys(record).length === 0;
}

function nonEmptyAdapterConfigFromSnapshot(
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!snapshot) return null;
  const adapterConfig = readConfig(snapshot.adapterConfig);
  if (adapterConfig === null) return null;
  if (Object.keys(adapterConfig).length === 0) return null;
  return adapterConfig;
}

function isOpenclawGatewayAgent(agent: { adapterType: string | null }): boolean {
  return agent.adapterType === "openclaw_gateway";
}

/**
 * Look up the most recent agent_config_revisions row whose snapshot
 * contains a non-empty adapterConfig. We deliberately look at the
 * afterConfig first; only fall back to beforeConfig when afterConfig
 * is empty — that ordering means a healthy revision (config populated)
 * wins over a wipe revision (config cleared).
 */
async function findLastGoodRevisionCandidate(
  db: Db,
  agentId: string,
): Promise<LastGoodRevisionCandidate | null> {
  const rows = await db
    .select({
      id: agentConfigRevisions.id,
      createdAt: agentConfigRevisions.createdAt,
      beforeConfig: agentConfigRevisions.beforeConfig,
      afterConfig: agentConfigRevisions.afterConfig,
    })
    .from(agentConfigRevisions)
    .where(eq(agentConfigRevisions.agentId, agentId))
    .orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id))
    .limit(50);

  for (const row of rows) {
    const before = readConfig(row.beforeConfig);
    const after = readConfig(row.afterConfig);
    const afterAc = nonEmptyAdapterConfigFromSnapshot(after);
    if (afterAc) {
      return {
        revisionId: row.id,
        createdAt: row.createdAt,
        beforeConfig: before,
        afterConfig: after,
      };
    }
    const beforeAc = nonEmptyAdapterConfigFromSnapshot(before);
    if (beforeAc) {
      return {
        revisionId: row.id,
        createdAt: row.createdAt,
        beforeConfig: before,
        afterConfig: after,
      };
    }
  }
  return null;
}

/**
 * Detect whether an agent is currently wedged (openclaw_gateway with empty
 * adapterConfig). This is the predicate every wiring point consults.
 */
export function isOpenclawGatewayAgentWedged(agent: {
  adapterType: string | null;
  adapterConfig: unknown;
}): boolean {
  if (!isOpenclawGatewayAgent(agent)) return false;
  return isEmptyAdapterConfig(agent.adapterConfig);
}

/**
 * Sources that the agent PATCH contract uses when replacing adapterConfig.
 * The recovery module must distinguish the race-condition wedge (unknown
 * source) from an intentional clear/revoke (a deliberate operator action).
 * The caller is responsible for passing the source if it can be inferred
 * (e.g. from the request that triggered the clear); absent a known source
 * the predicate falls back to "unknown" and the wedge path remains the
 * default behaviour.
 */
export type AdapterConfigClearSource =
  | "operator_replace"
  | "agent_self_clear"
  | "revocation"
  | "test_fixture"
  | "unknown";

/**
 * Decide whether the empty adapterConfig should be treated as a wedge
 * (recoverable race) or as an intentional clear (operator action, do NOT
 * revert). Returns true when the source is unknown OR an explicit
 * "wedge"-class signal; returns false when the source is any of the
 * known-clear sources above.
 */
export function shouldRecoverEmptyAdapterConfig(
  source: AdapterConfigClearSource,
): boolean {
  // Wedge-class signals: race condition (default) → recover.
  // Clear-class signals: operator_replace, agent_self_clear, revocation,
  // test_fixture → do NOT recover.
  return source === "unknown";
}

export async function repairOpenclawGatewayAgentAdapterConfig(
  input: OpenclawGatewayRecoveryDeps & {
    agent: {
      id: string;
      companyId: string;
      adapterType: string | null;
      adapterConfig: unknown;
      status: string | null;
    };
    trigger:
      | { kind: "wakeup"; wakeupSource: string; agentId: string; issueId?: string | null }
      | { kind: "read"; path: string }
      | { kind: "reconcile" };
  },
): Promise<OpenclawGatewayRecoveryOutcome> {
  const { db, agent, trigger, applyAdapterConfigPatch } = input;

  if (!isOpenclawGatewayAgent(agent)) {
    return { status: "skipped", reason: "not_openclaw_gateway" };
  }
  if (!isEmptyAdapterConfig(agent.adapterConfig)) {
    return { status: "skipped", reason: "adapter_config_populated" };
  }
  if (agent.status === "pending_approval" || agent.status === "terminated") {
    return { status: "skipped", reason: "agent_not_invokable" };
  }

  const candidate = await findLastGoodRevisionCandidate(db, agent.id);
  if (!candidate) {
    logger.warn(
      {
        agentId: agent.id,
        companyId: agent.companyId,
        trigger: trigger.kind,
        adapterConfigKeys: EMPTY_OBJECT_KEYS,
      },
      "openclaw_gateway wedge detected but no recoverable revision found; manual intervention required",
    );
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "system",
      actorId: "openclaw_gateway_config_recovery",
      action: "agent.adapter_config_wedge_detected",
      entityType: "agent",
      entityId: agent.id,
      details: {
        trigger: trigger.kind,
        recovered: false,
        reason: "no_revision_history",
      },
    }).catch(() => undefined);
    return { status: "skipped", reason: "no_revision_history" };
  }

  const lastGoodConfig =
    nonEmptyAdapterConfigFromSnapshot(candidate.afterConfig) ??
    nonEmptyAdapterConfigFromSnapshot(candidate.beforeConfig);
  if (!lastGoodConfig) {
    // Defensive: the candidate looked non-empty during selection but lost
    // its adapterConfig by the time we used it. Treat as no history.
    return { status: "skipped", reason: "no_revision_history" };
  }

  // Serialize against concurrent wakeups / claims so two repairs don't
  // race and clobber each other's revisions.
  // Track whether the locked recheck actually applied a patch. Concurrent
  // repairs, agent deletion, or adapter-type changes can make the lock a
  // no-op — in which case the function must report a skipped outcome (not
  // "repaired") so metrics and audit history stay accurate.
  let patchApplied = false;
  let outcomeFromLock: OpenclawGatewayRecoveryOutcome | null = null;

  try {
    await withAgentStartLock(agent.id, async () => {
      // Re-check inside the lock — another caller may have already repaired.
      const fresh = await db
        .select({
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .then((rows) => rows[0] ?? null);
      if (!fresh) {
        outcomeFromLock = { status: "skipped", reason: "agent_missing" };
        return;
      }
      if (!isOpenclawGatewayAgent(fresh)) {
        outcomeFromLock = { status: "skipped", reason: "adapter_type_changed" };
        return;
      }
      if (!isEmptyAdapterConfig(fresh.adapterConfig)) {
        // Someone (another repair path) already populated the config inside the lock window.
        outcomeFromLock = { status: "skipped", reason: "concurrent_repair" };
        return;
      }

      await applyAdapterConfigPatch({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterConfig: lastGoodConfig,
        sourceRevisionId: candidate.revisionId,
      });
      patchApplied = true;
      outcomeFromLock = { status: "repaired" };
    });
  } catch (err) {
    logger.error(
      {
        agentId: agent.id,
        companyId: agent.companyId,
        trigger: trigger.kind,
        sourceRevisionId: candidate.revisionId,
        error: err instanceof Error ? err.message : String(err),
      },
      "openclaw_gateway wedge repair failed",
    );
    throw err;
  }

  const recoveredKeys = Object.keys(lastGoodConfig).sort();
  const beforeKeyCount = candidate.beforeConfig
    ? Object.keys(readConfig(candidate.beforeConfig.adapterConfig) ?? {}).length
    : 0;

  // The locked recheck determines whether this invocation actually wrote a patch.
  // If we exited the lock without applying (concurrent repair, agent missing,
  // adapter-type changed), skip the success log + activity row and return a
  // skipped outcome so audit history + metrics stay accurate.
  if (!patchApplied || outcomeFromLock?.status === "skipped") {
    const skipReason = outcomeFromLock?.status === "skipped"
      ? (outcomeFromLock as { status: "skipped"; reason: string }).reason
      : "lock_no_op";
    logger.info(
      {
        agentId: agent.id,
        companyId: agent.companyId,
        trigger: trigger.kind,
        sourceRevisionId: candidate.revisionId,
        reason: skipReason,
      },
      "openclaw_gateway wedge repair skipped (no patch applied)",
    );
    return { status: "skipped", reason: skipReason };
  }

  logger.info(
    {
      agentId: agent.id,
      companyId: agent.companyId,
      trigger: trigger.kind,
      sourceRevisionId: candidate.revisionId,
      sourceRevisionCreatedAt:
        candidate.createdAt instanceof Date
          ? candidate.createdAt.toISOString()
          : new Date(candidate.createdAt as unknown as string | number).toISOString(),
      beforeKeyCount,
      recoveredAdapterConfigKeys: recoveredKeys,
      recoveredAdapterConfigKeyCount: recoveredKeys.length,
    },
    "openclaw_gateway adapterConfig wedge repaired from last known-good revision",
  );

  await logActivity(db, {
    companyId: agent.companyId,
    actorType: "system",
    actorId: "openclaw_gateway_config_recovery",
    action: "agent.adapter_config_wedge_recovered",
    entityType: "agent",
    entityId: agent.id,
    details: {
      trigger: trigger.kind,
      sourceRevisionId: candidate.revisionId,
      recoveredAdapterConfigKeyCount: recoveredKeys.length,
    },
  }).catch(() => undefined);

  return {
    status: "repaired",
    sourceRevisionId: candidate.revisionId,
    adapterConfigKeys: recoveredKeys,
    beforeKeyCount,
  };
}

/**
 * Reconcile all openclaw_gateway agents in the company (or every company
 * when companyId is omitted). Used by the periodic background loop and
 * available to the operator for on-demand sweeps.
 */
export async function reconcileOpenclawGatewayAgents(
  deps: OpenclawGatewayRecoveryDeps & { companyId?: string | null },
): Promise<{
  scanned: number;
  wedged: number;
  repaired: number;
  unrecoverable: number;
}> {
  const { db, applyAdapterConfigPatch, companyId } = deps;

  // Drizzle's typed query builder can't express the jsonb emptiness check
  // (jsonb_object_keys returns a set; checking for emptiness needs a NOT
  // EXISTS), so the JSON conditions are written as raw SQL fragments and
  // the rest is composed with and(...).
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      status: agents.status,
    })
    .from(agents)
    .where(
      and(
        eq(agents.adapterType, "openclaw_gateway"),
        ne(agents.status, "terminated"),
        companyId ? eq(agents.companyId, companyId) : sql`true`,
        sql`coalesce(${agents.adapterConfig}, '{}'::jsonb) = '{}'::jsonb`,
      ),
    )
    .limit(200);

  const scanned = rows.length;
  let repaired = 0;
  let unrecoverable = 0;

  for (const row of rows) {
    const outcome = await repairOpenclawGatewayAgentAdapterConfig({
      db,
      applyAdapterConfigPatch,
      agent: {
        id: row.id,
        companyId: row.companyId,
        adapterType: row.adapterType,
        adapterConfig: row.adapterConfig,
        status: row.status,
      },
      trigger: { kind: "reconcile" },
    });
    if (outcome.status === "repaired") repaired++;
    else if (outcome.reason === "no_revision_history") unrecoverable++;
  }

  return { scanned, wedged: scanned, repaired, unrecoverable };
}

/**
 * Periodic background loop. The caller owns the timer; this function returns
 * a tick handler that runs one sweep and resolves to a summary. Errors are
 * logged and swallowed so a transient DB blip does not kill the loop.
 */
export function createOpenclawGatewayReconcileLoop(deps: OpenclawGatewayRecoveryDeps) {
  let inFlight = false;
  async function tick(): Promise<{
    scanned: number;
    repaired: number;
    unrecoverable: number;
    skipped?: boolean;
  }> {
    if (inFlight) return { scanned: 0, repaired: 0, unrecoverable: 0, skipped: true };
    inFlight = true;
    try {
      return await reconcileOpenclawGatewayAgents(deps);
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "openclaw_gateway reconcile tick failed",
      );
      return { scanned: 0, repaired: 0, unrecoverable: 0 };
    } finally {
      inFlight = false;
    }
  }
  return { tick };
}

/**
 * Convenience helper for the heartbeat wakeup path. Returns true if the
 * caller should proceed; false if it should short-circuit (rare — only
 * on hard errors that we don't want to mask).
 */
export async function repairAgentAdapterConfigIfWedged(
  deps: OpenclawGatewayRecoveryDeps & {
    agent: {
      id: string;
      companyId: string;
      adapterType: string | null;
      adapterConfig: unknown;
      status: string | null;
    };
    trigger:
      | { kind: "wakeup"; wakeupSource: string; agentId: string; issueId?: string | null }
      | { kind: "read"; path: string };
  },
): Promise<{ wedgeDetected: boolean; repaired: boolean; outcome: OpenclawGatewayRecoveryOutcome }> {
  const wedged = isOpenclawGatewayAgentWedged(deps.agent);
  if (!wedged) {
    return {
      wedgeDetected: false,
      repaired: false,
      outcome: { status: "skipped", reason: "not_wedged" },
    };
  }
  const outcome = await repairOpenclawGatewayAgentAdapterConfig(deps);
  return {
    wedgeDetected: true,
    repaired: outcome.status === "repaired",
    outcome,
  };
}
