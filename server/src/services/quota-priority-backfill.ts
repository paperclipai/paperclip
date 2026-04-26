// Backfills `agents.metadata.priorityTier` for any agent that does not yet
// have a valid value. Runs once at server bootstrap so the existing 5-agent
// MVP (CEO / Engineer / PRDWriter / InsightAnalyst / TechResearcher) gets
// tier values without requiring a SQL migration. Idempotent: agents that
// already carry a valid tier are skipped.
//
// PMSA-17 / [PMSA-11] §3.2 — applies the role/name defaults defined in
// shared/constants.ts (AGENT_PRIORITY_TIER_DEFAULTS_BY_ROLE plus the small
// AGENT_PRIORITY_TIER_NAME_OVERRIDES map).

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  type AgentPriorityTier,
  isAgentPriorityTier,
  resolveDefaultAgentPriorityTier,
} from "@paperclipai/shared";

export interface QuotaPriorityBackfillRow {
  agentId: string;
  companyId: string;
  name: string;
  role: string;
  priorityTier: AgentPriorityTier;
}

export interface QuotaPriorityBackfillResult {
  scanned: number;
  updated: QuotaPriorityBackfillRow[];
  skipped: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function backfillAgentPriorityTiers(
  db: Db,
): Promise<QuotaPriorityBackfillResult> {
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      metadata: agents.metadata,
      status: agents.status,
    })
    .from(agents);

  const updates: QuotaPriorityBackfillRow[] = [];
  let skipped = 0;

  for (const row of rows) {
    // Terminated agents stay as-is — no need to dirty their config.
    if (row.status === "terminated") {
      skipped++;
      continue;
    }

    const metadata = isPlainRecord(row.metadata) ? row.metadata : null;
    if (metadata && isAgentPriorityTier(metadata.priorityTier)) {
      skipped++;
      continue;
    }

    const tier = resolveDefaultAgentPriorityTier({
      role: row.role,
      name: row.name,
    });
    const nextMetadata = { ...(metadata ?? {}), priorityTier: tier };

    await db
      .update(agents)
      .set({ metadata: nextMetadata, updatedAt: new Date() })
      .where(eq(agents.id, row.id));

    updates.push({
      agentId: row.id,
      companyId: row.companyId,
      name: row.name,
      role: row.role,
      priorityTier: tier,
    });
  }

  return { scanned: rows.length, updated: updates, skipped };
}
