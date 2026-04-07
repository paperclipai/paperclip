import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agentPromptVersions, agents } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

// ── Prompt Version History ────────────────────────────────────────────────
//
// Tracks changes to agent system_prompt and agent_instructions fields.
// Each update creates a version snapshot before the change is applied.

export type PromptVersion = typeof agentPromptVersions.$inferSelect;

/**
 * Snapshot the current prompt values before an update.
 * Automatically increments the version number.
 */
export async function snapshotPromptVersion(
  db: Db,
  opts: {
    agentId: string;
    companyId: string;
    currentSystemPrompt: string | null;
    currentAgentInstructions: string | null;
    changedByUserId?: string | null;
    changeSummary?: string | null;
  },
): Promise<PromptVersion> {
  // Get the current max version number for this agent
  const [maxRow] = await db
    .select({ maxVersion: sql<number>`coalesce(max(${agentPromptVersions.versionNumber}), 0)::int` })
    .from(agentPromptVersions)
    .where(eq(agentPromptVersions.agentId, opts.agentId));

  const nextVersion = (maxRow?.maxVersion ?? 0) + 1;

  const [version] = await db
    .insert(agentPromptVersions)
    .values({
      agentId: opts.agentId,
      companyId: opts.companyId,
      versionNumber: nextVersion,
      systemPrompt: opts.currentSystemPrompt,
      agentInstructions: opts.currentAgentInstructions,
      changedByUserId: opts.changedByUserId ?? null,
      changeSummary: opts.changeSummary ?? null,
    })
    .returning();

  logger.info(
    { agentId: opts.agentId, version: nextVersion },
    "created prompt version snapshot",
  );

  return version;
}

/**
 * List all prompt versions for an agent, newest first.
 */
export async function listVersions(
  db: Db,
  agentId: string,
): Promise<PromptVersion[]> {
  return db
    .select()
    .from(agentPromptVersions)
    .where(eq(agentPromptVersions.agentId, agentId))
    .orderBy(desc(agentPromptVersions.versionNumber));
}

/**
 * Rollback an agent's prompts to a specific version number.
 * Restores system_prompt and agent_instructions from the version,
 * then creates a new version snapshot recording the rollback.
 */
export async function rollback(
  db: Db,
  agentId: string,
  versionNumber: number,
  userId?: string,
): Promise<{ success: boolean; error?: string }> {
  // Find the target version
  const [targetVersion] = await db
    .select()
    .from(agentPromptVersions)
    .where(
      and(
        eq(agentPromptVersions.agentId, agentId),
        eq(agentPromptVersions.versionNumber, versionNumber),
      ),
    )
    .limit(1);

  if (!targetVersion) {
    return { success: false, error: `Version ${versionNumber} not found for agent ${agentId}` };
  }

  // Get current agent prompts before rollback (to snapshot)
  const [currentAgent] = await db
    .select({
      companyId: agents.companyId,
      systemPrompt: agents.systemPrompt,
      agentInstructions: agents.agentInstructions,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!currentAgent) {
    return { success: false, error: "Agent not found" };
  }

  // Snapshot current state before rollback
  await snapshotPromptVersion(db, {
    agentId,
    companyId: currentAgent.companyId,
    currentSystemPrompt: currentAgent.systemPrompt,
    currentAgentInstructions: currentAgent.agentInstructions,
    changedByUserId: userId,
    changeSummary: `Rollback to version ${versionNumber}`,
  });

  // Apply the rollback
  await db
    .update(agents)
    .set({
      systemPrompt: targetVersion.systemPrompt,
      agentInstructions: targetVersion.agentInstructions,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId));

  logger.info(
    { agentId, targetVersion: versionNumber },
    "rolled back agent prompts to previous version",
  );

  return { success: true };
}
