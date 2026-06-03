import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentConfigRevisions, agents, heartbeatRuns } from "@paperclipai/db";
import { hasActiveJobForAgent } from "./k8s-job-liveness.js";
import { logger } from "../middleware/logger.js";

export const ELIGIBLE_ADAPTER_TYPES = ["claude_k8s", "opencode_k8s"] as const;

export interface EligibleAgent {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  currentImage: string;
}

export async function selectEligibleAgentsForImageBump(
  db: Db,
  input: { companyId: string; targetImage: string },
): Promise<EligibleAgent[]> {
  const { companyId, targetImage } = input;
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      adapterType: agents.adapterType,
      currentImage: sql<string>`${agents.adapterConfig} ->> 'image'`,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        inArray(agents.adapterType, [...ELIGIBLE_ADAPTER_TYPES]),
        sql`${agents.adapterConfig} ->> 'image' IS NOT NULL`,
        sql`${agents.adapterConfig} ->> 'image' != ${targetImage}`,
      ),
    );
}

// A pending image bump is deferred only while the agent is *actively
// executing* — a heartbeat run is `running`, or (when the DB lags) the agent
// still has a live k8s Job. Queued runs are intentionally NOT counted:
// BLO-8746/BLO-8827 — a maxConcurrentRuns=1 agent under steady automation is
// perpetually backlogged, so gating on queued runs let a pending bump starve
// forever and pinned the agent to a stale (possibly broken) image. The image
// field only affects newly-created Job pods, so applying it between runs is
// always safe: the next dispatched run picks up the new image.
const EXECUTING_RUN_STATUSES = ["running"] as const;

export async function isAgentExecuting(db: Db, agentId: string): Promise<boolean> {
  const [dbHit] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, [...EXECUTING_RUN_STATUSES]),
      ),
    )
    .limit(1);
  if (dbHit) return true;
  return hasActiveJobForAgent(agentId);
}

export interface ApplyResult {
  agentId: string;
  outcome: "bumped" | "skipped";
}

/**
 * Bump an agent's container image, or defer if the agent is mid-run.
 *
 * - Not actively executing (no `running` heartbeat_run, no active k8s Job;
 *   queued runs are fine): PATCH adapter_config.image in a transaction that
 *   also writes an agent_config_revisions audit row. Clears any prior
 *   pending_image_bump.
 * - Actively executing: stash the target in agents.pending_image_bump
 *   (last-write-wins) and skip the PATCH. The heartbeat run-completion hook and
 *   the queued-run dispatcher both retry it the next time the agent is idle
 *   between runs (so a queued backlog no longer starves the bump).
 *
 * Mirrors the partial-patch semantics of PATCH /agents/:id without going
 * through HTTP, so the same audit trail lands either way.
 */
export async function applyImageBumpToAgent(
  db: Db,
  args: {
    agentId: string;
    targetImage: string;
    /** Free-form source tag for the audit log, e.g. "ci:docker-agent.yml" or "auto-retry-on-completion". */
    source: string;
  },
): Promise<ApplyResult> {
  const executing = await isAgentExecuting(db, args.agentId);
  if (executing) {
    await db
      .update(agents)
      .set({ pendingImageBump: args.targetImage, updatedAt: new Date() })
      .where(eq(agents.id, args.agentId));
    logger.info(
      { agentId: args.agentId, targetImage: args.targetImage, source: args.source },
      "agent actively executing; pending_image_bump set",
    );
    return { outcome: "skipped", agentId: args.agentId };
  }

  await patchAgentImage(db, args.agentId, args.targetImage, args.source);
  return { outcome: "bumped", agentId: args.agentId };
}

async function patchAgentImage(
  db: Db,
  agentId: string,
  targetImage: string,
  source: string,
): Promise<void> {
  const [row] = await db
    .select({ companyId: agents.companyId, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!row) throw new Error(`agent ${agentId} not found`);
  const existing = (row.adapterConfig as Record<string, unknown>) ?? {};
  const next = { ...existing, image: targetImage };

  await db.transaction(async (tx) => {
    await tx
      .update(agents)
      .set({ adapterConfig: next, pendingImageBump: null, updatedAt: new Date() })
      .where(eq(agents.id, agentId));
    await tx.insert(agentConfigRevisions).values({
      companyId: row.companyId,
      agentId,
      source,
      changedKeys: ["adapterConfig"],
      beforeConfig: { adapter_config: existing },
      afterConfig: { adapter_config: next },
    });
  });

  logger.info({ agentId, targetImage, source }, "agent image PATCHed");
}

export interface BumpBatchSummary {
  bumped: string[];
  skipped: string[];
  unchanged: string[];
}

/**
 * Bump every eligible agent in `companyId` to `targetImage`.
 *
 * Returns a per-bucket summary so callers (the admin route, CI logs, etc.)
 * can report exactly which agents took the bump, which were deferred, and
 * which were already on the target image.
 */
export async function bumpAgentImagesForCompany(
  db: Db,
  args: { companyId: string; targetImage: string; source: string },
): Promise<BumpBatchSummary> {
  // Identify already-on-target agents BEFORE the eligibility filter strips
  // them, so the response can call them out explicitly.
  const unchangedRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, args.companyId),
        inArray(agents.adapterType, [...ELIGIBLE_ADAPTER_TYPES]),
        sql`${agents.adapterConfig} ->> 'image' = ${args.targetImage}`,
      ),
    );

  const candidates = await selectEligibleAgentsForImageBump(db, {
    companyId: args.companyId,
    targetImage: args.targetImage,
  });

  const bumped: string[] = [];
  const skipped: string[] = [];

  for (const candidate of candidates) {
    const result = await applyImageBumpToAgent(db, {
      agentId: candidate.id,
      targetImage: args.targetImage,
      source: args.source,
    });
    if (result.outcome === "bumped") bumped.push(result.agentId);
    else skipped.push(result.agentId);
  }

  return { bumped, skipped, unchanged: unchangedRows.map((r) => r.id) };
}

/**
 * Retry the pending image bump for an agent if it's set + the agent is now idle.
 *
 * Called by the heartbeat run-completion hook (Task 7). Safe to call
 * unconditionally on every terminal-status transition — short-circuits when
 * there's nothing pending, and re-defers when another run snuck in between
 * the original skip and now (self-healing — gets retried on the next
 * completion).
 */
export async function processPendingImageBumpForAgent(
  db: Db,
  agentId: string,
): Promise<void> {
  const [row] = await db
    .select({ pending: agents.pendingImageBump, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.id, agentId));

  if (!row || !row.pending) return;

  // If the agent's current image already matches the pending target, just
  // clear the column. Happens if the same image was applied via another
  // path (operator PATCH) between the original skip and the retry.
  const currentImage = (row.adapterConfig as Record<string, unknown>).image;
  if (currentImage === row.pending) {
    await db.update(agents).set({ pendingImageBump: null }).where(eq(agents.id, agentId));
    return;
  }

  if (await isAgentExecuting(db, agentId)) {
    logger.info({ agentId }, "pending image bump deferred; a run is actively executing");
    return;
  }

  await patchAgentImage(db, agentId, row.pending, "auto-retry-on-completion");
}
