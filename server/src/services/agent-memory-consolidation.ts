import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemories, agentMemoryConsolidationRuns, agents, heartbeatRuns, issueComments } from "@paperclipai/db";
import { buildHeartbeatRunIssueComment } from "./heartbeat-run-summary.js";
import { agentMemoryService } from "./agent-memories.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

// Tunables for the heuristic "dreaming" consolidation. Deliberately conservative.
export const CONSOLIDATION_CADENCE_MS = Math.max(
  60_000,
  Number(process.env.PAPERCLIP_MEMORY_CONSOLIDATION_CADENCE_MS) || 24 * 60 * 60 * 1000,
);
const MAX_AGENTS_PER_TICK = 3;
const INGEST_FALLBACK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INGEST_RUNS = 50;
const MAX_INGEST_COMMENTS = 50;
const DEDUP_JACCARD_THRESHOLD = 0.8;
const STAGED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const PROMOTE_SCORE_THRESHOLD = 1;
const RECUR_MIN_MEMORIES = 2; // a term is "recurring" if it appears in >= N distinct memories

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is", "are",
  "was", "were", "be", "been", "it", "this", "that", "as", "at", "by", "from", "we", "i",
  "you", "they", "he", "she", "has", "have", "had", "do", "did", "not", "no", "yes", "will",
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? text.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

interface Candidate {
  title: string;
  body: string;
  sourceRunId: string | null;
  sourceCommentId: string | null;
}

export interface ConsolidationResult {
  runId: string;
  status: "completed" | "failed";
  ingested: number;
  staged: number;
  promoted: number;
  forgotten: number;
}

export function agentMemoryConsolidationService(db: Db) {
  const memories = agentMemoryService(db);

  async function getLastConsolidationAt(companyId: string, agentId: string): Promise<Date | null> {
    const row = await db
      .select({ startedAt: agentMemoryConsolidationRuns.startedAt })
      .from(agentMemoryConsolidationRuns)
      .where(and(eq(agentMemoryConsolidationRuns.companyId, companyId), eq(agentMemoryConsolidationRuns.agentId, agentId)))
      .orderBy(desc(agentMemoryConsolidationRuns.startedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.startedAt ?? null;
  }

  /**
   * Light sleep: gather recent run summaries + agent-authored comments since the last
   * consolidation, dedupe against existing active memories and within the batch.
   */
  async function gatherCandidates(companyId: string, agentId: string, since: Date): Promise<Candidate[]> {
    const runs = await db
      .select({ id: heartbeatRuns.id, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          isNotNull(heartbeatRuns.finishedAt),
          gt(heartbeatRuns.finishedAt, since),
        ),
      )
      .orderBy(desc(heartbeatRuns.finishedAt))
      .limit(MAX_INGEST_RUNS);

    const comments = await db
      .select({ id: issueComments.id, body: issueComments.body, runId: issueComments.createdByRunId })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.authorAgentId, agentId),
          isNull(issueComments.deletedAt),
          gt(issueComments.createdAt, since),
        ),
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(MAX_INGEST_COMMENTS);

    const candidates: Candidate[] = [];
    for (const run of runs) {
      const snippet = buildHeartbeatRunIssueComment(run.resultJson);
      if (!snippet) continue;
      candidates.push({ title: firstLine(snippet), body: snippet, sourceRunId: run.id, sourceCommentId: null });
    }
    for (const c of comments) {
      const body = c.body?.trim();
      if (!body) continue;
      candidates.push({ title: firstLine(body), body, sourceRunId: c.runId ?? null, sourceCommentId: c.id });
    }
    return candidates;
  }

  /**
   * REM (heuristic seam). Detect tokens that recur across multiple memories. This is the
   * single replaceable point: a future "wake a dreaming agent" dispatch would synthesize
   * lessons here instead of counting term frequency.
   */
  function extractRecurringTerms(texts: string[]): Set<string> {
    const docFreq = new Map<string, number>();
    for (const text of texts) {
      for (const term of tokenize(text)) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
    const recurring = new Set<string>();
    for (const [term, freq] of docFreq) {
      if (freq >= RECUR_MIN_MEMORIES) recurring.add(term);
    }
    return recurring;
  }

  async function consolidateAgentMemories(
    companyId: string,
    agentId: string,
    now: Date = new Date(),
  ): Promise<ConsolidationResult> {
    // Read the previous consolidation time BEFORE inserting this run's row, otherwise
    // getLastConsolidationAt would return the row we just inserted and `since` would
    // always fall back to the lookback window.
    const lastAt = await getLastConsolidationAt(companyId, agentId);
    const since = lastAt && lastAt < now ? lastAt : new Date(now.getTime() - INGEST_FALLBACK_LOOKBACK_MS);

    const [run] = await db
      .insert(agentMemoryConsolidationRuns)
      .values({ companyId, agentId, status: "running", startedAt: now })
      .returning();

    let ingested = 0;
    let staged = 0;
    let promoted = 0;
    let forgotten = 0;

    try {

      // Existing active memories: dedup target + recurrence corpus.
      const existing = await memories.list(companyId, agentId);
      const activeExisting = existing.filter((m) => m.status === "active");
      const existingTokens = activeExisting.map((m) => tokenize(`${m.title} ${m.body}`));

      // Light sleep: gather + dedupe.
      const candidates = await gatherCandidates(companyId, agentId, since);
      ingested = candidates.length;
      const stagedTokenSets: Set<string>[] = [];
      for (const cand of candidates) {
        const tokens = tokenize(`${cand.title} ${cand.body}`);
        const dupExisting = existingTokens.some((t) => jaccard(tokens, t) >= DEDUP_JACCARD_THRESHOLD);
        const dupBatch = stagedTokenSets.some((t) => jaccard(tokens, t) >= DEDUP_JACCARD_THRESHOLD);
        if (dupExisting || dupBatch) continue;
        await memories.write(
          companyId,
          agentId,
          {
            type: "episodic",
            title: cand.title,
            body: cand.body,
            tags: [],
            confidence: 0,
            sourceRunId: cand.sourceRunId,
            sourceIssueId: null,
            sourceCommentId: cand.sourceCommentId,
          },
          { actorType: "system", actorId: "memory-consolidation" },
          "staged",
        );
        staged += 1;
        stagedTokenSets.push(tokens);
      }

      // Reload staged rows for this agent (includes older staged candidates too).
      const stagedRows = await db
        .select()
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.companyId, companyId),
            eq(agentMemories.agentId, agentId),
            eq(agentMemories.status, "staged"),
          ),
        );

      // REM: recurrence corpus = active memories + staged candidates.
      const corpus = [
        ...activeExisting.map((m) => `${m.title} ${m.body}`),
        ...stagedRows.map((m) => `${m.title} ${m.body}`),
      ];
      const recurringTerms = extractRecurringTerms(corpus);

      // Deep sleep: score each staged candidate, promote or forget.
      const toPromote: string[] = [];
      const toForget: string[] = [];
      for (const m of stagedRows) {
        const tokens = tokenize(`${m.title} ${m.body}`);
        let recurrenceScore = 0;
        for (const t of tokens) if (recurringTerms.has(t)) recurrenceScore += 1;
        // Promotion requires a recurring theme or prior recall, not mere freshness, so a
        // one-off observation stays staged until it actually recurs.
        const score = recurrenceScore + m.recallCount;
        const ageMs = now.getTime() - new Date(m.createdAt).getTime();
        if (score >= PROMOTE_SCORE_THRESHOLD) {
          toPromote.push(m.id);
        } else if (ageMs > STAGED_MAX_AGE_MS) {
          toForget.push(m.id);
        }
      }

      if (toPromote.length > 0) {
        await db
          .update(agentMemories)
          .set({ status: "active", confidence: sql`greatest(${agentMemories.confidence}, 40)`, updatedAt: now })
          .where(and(eq(agentMemories.companyId, companyId), inArray(agentMemories.id, toPromote)));
        promoted = toPromote.length;
      }
      if (toForget.length > 0) {
        await db
          .update(agentMemories)
          .set({ status: "forgotten", forgottenAt: now, updatedAt: now })
          .where(and(eq(agentMemories.companyId, companyId), inArray(agentMemories.id, toForget)));
        forgotten = toForget.length;
      }

      await db
        .update(agentMemoryConsolidationRuns)
        .set({ status: "completed", ingested, staged, promoted, forgotten, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentMemoryConsolidationRuns.id, run.id));

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "memory-consolidation",
        action: "agent_memory_consolidated",
        entityType: "agent_memory_consolidation_run",
        entityId: run.id,
        agentId,
        details: { ingested, staged, promoted, forgotten },
      });

      return { runId: run.id, status: "completed", ingested, staged, promoted, forgotten };
    } catch (err) {
      await db
        .update(agentMemoryConsolidationRuns)
        .set({ status: "failed", error: String(err), finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentMemoryConsolidationRuns.id, run.id));
      logger.error({ err, companyId, agentId }, "memory consolidation failed");
      return { runId: run.id, status: "failed", ingested, staged, promoted, forgotten };
    }
  }

  /**
   * Scheduler tick: pick up to MAX_AGENTS_PER_TICK active agents whose last consolidation
   * is older than the cadence (or never), and consolidate them. Reuses the existing
   * in-process scheduler; no queue, no user-facing routine row.
   */
  async function tickMemoryConsolidation(now: Date = new Date()): Promise<{ processed: number; promoted: number; forgotten: number }> {
    const cutoff = new Date(now.getTime() - CONSOLIDATION_CADENCE_MS);

    // Select due agents entirely in SQL: most-overdue first (never-consolidated
    // agents sort first via NULLS FIRST), limited to MAX_AGENTS_PER_TICK. This has
    // no fixed prefilter cap, so no agent can be starved regardless of fleet size.
    const lastRun = db
      .select({
        agentId: agentMemoryConsolidationRuns.agentId,
        lastAt: sql<Date | null>`max(${agentMemoryConsolidationRuns.startedAt})`.as("last_at"),
      })
      .from(agentMemoryConsolidationRuns)
      .groupBy(agentMemoryConsolidationRuns.agentId)
      .as("last_run");

    const due = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .leftJoin(lastRun, eq(lastRun.agentId, agents.id))
      .where(
        and(
          eq(agents.status, "active"),
          // Cast the cutoff explicitly: the aliased max() column has no Drizzle type
          // mapper, so a raw Date param cannot be encoded by the driver.
          sql`(last_run.last_at is null or last_run.last_at < ${cutoff.toISOString()}::timestamptz)`,
        ),
      )
      .orderBy(sql`last_run.last_at asc nulls first`)
      .limit(MAX_AGENTS_PER_TICK);

    let processed = 0;
    let promoted = 0;
    let forgotten = 0;
    for (const a of due) {
      const result = await consolidateAgentMemories(a.companyId, a.id, now);
      processed += 1;
      promoted += result.promoted;
      forgotten += result.forgotten;
    }
    return { processed, promoted, forgotten };
  }

  return { consolidateAgentMemories, tickMemoryConsolidation, getLastConsolidationAt };
}
