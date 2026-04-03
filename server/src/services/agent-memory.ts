import { and, asc, eq, isNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agentMemoryEntries } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

// ── Agent Memory Services ───────────────────────────────────────────────────
//
// Memory lifecycle for FTE agents:
//   - extractMemoriesFromIssue: creates episodic entries when an issue completes
//   - consolidateMemories: weekly merge of episodic entries into semantic
//   - decayStaleMemories: daily confidence reduction on unaccessed entries
//   - enforceMemoryCap: keeps active entries per agent under a configurable cap

const DEFAULT_MEMORY_CAP = 500;

/**
 * Extract memories from a completed issue and store as episodic entries.
 *
 * Creates 1-2 entries:
 *   - One entry summarizing the task outcome (category: task_history)
 *   - One entry for technical decisions (category: technical_decision),
 *     only when the issue description contains technical terms
 */
export async function extractMemoriesFromIssue(
  db: Db,
  agentId: string,
  companyId: string,
  issueId: string,
  issueTitle: string,
  issueOutcome: string,
): Promise<void> {
  const now = new Date();

  // Always create a task history entry
  await db.insert(agentMemoryEntries).values({
    agentId,
    companyId,
    memoryType: "episodic",
    category: "task_history",
    content: `Completed: ${issueTitle}. Outcome: ${issueOutcome}`,
    sourceIssueId: issueId,
    confidence: 80,
    lastAccessedAt: now,
  });

  // Create a technical decision entry if the description suggests technical work
  const technicalTerms = [
    "api", "database", "migration", "schema", "deploy", "config",
    "endpoint", "query", "index", "cache", "auth", "token",
    "service", "middleware", "webhook", "cron", "pipeline",
    "refactor", "performance", "security", "test", "ci/cd",
  ];

  const lowerOutcome = (issueOutcome ?? "").toLowerCase();
  const lowerTitle = (issueTitle ?? "").toLowerCase();
  const hasTechnicalContent = technicalTerms.some(
    (term) => lowerOutcome.includes(term) || lowerTitle.includes(term),
  );

  if (hasTechnicalContent) {
    await db.insert(agentMemoryEntries).values({
      agentId,
      companyId,
      memoryType: "episodic",
      category: "technical_decision",
      content: `Technical work on: ${issueTitle}. Details: ${issueOutcome}`,
      sourceIssueId: issueId,
      confidence: 75,
      lastAccessedAt: now,
    });
  }

  logger.info(
    { agentId, issueId, hasTechnicalContent },
    "extracted memories from completed issue",
  );
}

/**
 * Consolidate episodic memories older than 7 days into semantic summaries.
 *
 * Groups episodic entries by category, creates a single semantic entry per
 * category summarizing the group, then archives the originals.
 *
 * NOTE: This currently uses a simple concatenation approach. A future version
 * should use an AI call to generate proper summaries.
 * TODO: Replace concatenation with AI-powered summarization.
 */
export async function consolidateMemories(db: Db, agentId: string): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const now = new Date();

  // Find episodic entries older than 7 days
  const oldEpisodic = await db
    .select({
      id: agentMemoryEntries.id,
      companyId: agentMemoryEntries.companyId,
      category: agentMemoryEntries.category,
      content: agentMemoryEntries.content,
    })
    .from(agentMemoryEntries)
    .where(
      and(
        eq(agentMemoryEntries.agentId, agentId),
        eq(agentMemoryEntries.memoryType, "episodic"),
        isNull(agentMemoryEntries.archivedAt),
        lt(agentMemoryEntries.createdAt, sevenDaysAgo),
      ),
    );

  if (oldEpisodic.length === 0) return;

  // Group by category
  const groups = new Map<string, typeof oldEpisodic>();
  for (const entry of oldEpisodic) {
    const cat = entry.category ?? "uncategorized";
    const group = groups.get(cat) ?? [];
    group.push(entry);
    groups.set(cat, group);
  }

  const companyId = oldEpisodic[0]!.companyId;

  await db.transaction(async (tx) => {
    for (const [category, entries] of groups) {
      if (entries.length === 0) continue;

      // Create consolidated semantic entry
      const summary = entries.map((e) => e.content).join(" | ");
      const truncatedSummary = summary.length > 2000 ? summary.slice(0, 2000) + "..." : summary;

      await tx.insert(agentMemoryEntries).values({
        agentId,
        companyId,
        memoryType: "semantic",
        category,
        content: `[Consolidated from ${entries.length} entries] ${truncatedSummary}`,
        confidence: 70,
        lastAccessedAt: now,
      });

      // Archive the originals
      const entryIds = entries.map((e) => e.id);
      for (const entryId of entryIds) {
        await tx
          .update(agentMemoryEntries)
          .set({ archivedAt: now })
          .where(eq(agentMemoryEntries.id, entryId));
      }
    }
  });

  logger.info(
    { agentId, consolidatedCategories: groups.size, totalEntries: oldEpisodic.length },
    "consolidated episodic memories into semantic entries",
  );
}

/**
 * Decay confidence on stale memory entries.
 *
 * Runs daily across all agents:
 *   - Entries not accessed in 30+ days: confidence reduced by 10 (minimum 10)
 *   - Entries not accessed in 90+ days: confidence reduced by 20 (minimum 5)
 */
export async function decayStaleMemories(db: Db): Promise<void> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // 90+ day decay first (stronger reduction, lower floor)
  const ninetyDayResult = await db
    .update(agentMemoryEntries)
    .set({
      confidence: sql`greatest(5, ${agentMemoryEntries.confidence} - 20)`,
    })
    .where(
      and(
        isNull(agentMemoryEntries.archivedAt),
        lte(agentMemoryEntries.lastAccessedAt, ninetyDaysAgo),
      ),
    )
    .returning({ id: agentMemoryEntries.id });

  // 30-90 day decay (milder reduction)
  const thirtyDayResult = await db
    .update(agentMemoryEntries)
    .set({
      confidence: sql`greatest(10, ${agentMemoryEntries.confidence} - 10)`,
    })
    .where(
      and(
        isNull(agentMemoryEntries.archivedAt),
        lte(agentMemoryEntries.lastAccessedAt, thirtyDaysAgo),
        // Exclude entries already decayed in the 90-day pass above
        sql`${agentMemoryEntries.lastAccessedAt} > ${ninetyDaysAgo}`,
      ),
    )
    .returning({ id: agentMemoryEntries.id });

  const totalDecayed = ninetyDayResult.length + thirtyDayResult.length;
  if (totalDecayed > 0) {
    logger.info(
      {
        decayed30d: thirtyDayResult.length,
        decayed90d: ninetyDayResult.length,
        totalDecayed,
      },
      "decayed stale memory entries",
    );
  }
}

/**
 * Enforce a cap on active (non-archived) memory entries per agent.
 *
 * If the agent has more than `maxEntries` active entries, the entries with
 * the lowest confidence and oldest last_accessed_at are archived first.
 */
export async function enforceMemoryCap(
  db: Db,
  agentId: string,
  maxEntries: number = DEFAULT_MEMORY_CAP,
): Promise<void> {
  // Count active entries
  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentMemoryEntries)
    .where(
      and(
        eq(agentMemoryEntries.agentId, agentId),
        isNull(agentMemoryEntries.archivedAt),
      ),
    );

  const activeCount = Number(countResult[0]?.count ?? 0);
  if (activeCount <= maxEntries) return;

  const excess = activeCount - maxEntries;
  const now = new Date();

  // Find the entries to archive: lowest confidence, then oldest access
  const toArchive = await db
    .select({ id: agentMemoryEntries.id })
    .from(agentMemoryEntries)
    .where(
      and(
        eq(agentMemoryEntries.agentId, agentId),
        isNull(agentMemoryEntries.archivedAt),
      ),
    )
    .orderBy(
      asc(agentMemoryEntries.confidence),
      asc(agentMemoryEntries.lastAccessedAt),
    )
    .limit(excess);

  if (toArchive.length > 0) {
    for (const entry of toArchive) {
      await db
        .update(agentMemoryEntries)
        .set({ archivedAt: now })
        .where(eq(agentMemoryEntries.id, entry.id));
    }

    logger.info(
      { agentId, archived: toArchive.length, activeCount, maxEntries },
      "enforced memory cap by archiving low-confidence entries",
    );
  }
}
