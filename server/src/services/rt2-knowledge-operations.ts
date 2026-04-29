import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  rt2V33ContradictionCandidates,
  rt2JarvisRewriteProposals,
  rt2V33ContradictionResolutions,
  rt2V33SemanticIndexChunks,
  rt2V33SemanticIndexRuns,
  rt2V33TaskProfiles,
} from "@paperclipai/db";
import type {
  Rt2KnowledgeOperationsHealth,
  Rt2KnowledgeOperationsHealthStatus,
  Rt2KnowledgeOperationsReason,
} from "@paperclipai/shared";
import { rt2SemanticIndexService } from "./rt2-semantic-index.js";

export function rt2KnowledgeOperationsService(db: Db) {
  const semanticIndex = rt2SemanticIndexService(db);

  async function getHealth(companyId: string): Promise<Rt2KnowledgeOperationsHealth> {
    const [
      semanticStatus,
      lastSuccessfulRun,
      openCandidates,
      resolvedCandidates,
      recentlyResolved,
      taskCount,
      rewriteProposalRows,
    ] = await Promise.all([
      semanticIndex.getStatus(companyId),
      db.select()
        .from(rt2V33SemanticIndexRuns)
        .where(and(
          eq(rt2V33SemanticIndexRuns.companyId, companyId),
          eq(rt2V33SemanticIndexRuns.status, "completed"),
        ))
        .orderBy(desc(rt2V33SemanticIndexRuns.completedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      countRows(db.select({ count: sql<number>`count(*)::int` })
        .from(rt2V33ContradictionCandidates)
        .where(and(
          eq(rt2V33ContradictionCandidates.companyId, companyId),
          eq(rt2V33ContradictionCandidates.status, "open"),
        ))),
      countRows(db.select({ count: sql<number>`count(*)::int` })
        .from(rt2V33ContradictionCandidates)
        .where(and(
          eq(rt2V33ContradictionCandidates.companyId, companyId),
          eq(rt2V33ContradictionCandidates.status, "resolved"),
        ))),
      countRows(db.select({ count: sql<number>`count(*)::int` })
        .from(rt2V33ContradictionResolutions)
        .where(and(
          eq(rt2V33ContradictionResolutions.companyId, companyId),
          gte(rt2V33ContradictionResolutions.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
        ))),
      countRows(db.select({ count: sql<number>`count(*)::int` })
        .from(rt2V33TaskProfiles)
        .where(eq(rt2V33TaskProfiles.companyId, companyId))),
      db.select({
        status: rt2JarvisRewriteProposals.status,
        riskLevel: rt2JarvisRewriteProposals.riskLevel,
        latestEval: rt2JarvisRewriteProposals.latestEval,
      })
        .from(rt2JarvisRewriteProposals)
        .where(eq(rt2JarvisRewriteProposals.companyId, companyId)),
    ]);

    const rewriteStats = summarizeRewriteHealth(rewriteProposalRows);

    const reasons: Rt2KnowledgeOperationsReason[] = [];

    if (!semanticStatus.lastRun || semanticStatus.indexedChunks === 0) {
      reasons.push({
        code: "semantic_index_missing",
        severity: "failed",
        message: "Semantic index has no completed evidence to support search or Jarvis grounding.",
      });
    }
    if (semanticStatus.lastRun?.status === "error") {
      reasons.push({
        code: "semantic_index_last_run_failed",
        severity: "failed",
        message: semanticStatus.lastRun.errorMessage
          ? `Latest semantic index run failed: ${semanticStatus.lastRun.errorMessage}`
          : "Latest semantic index run failed.",
      });
    }
    if (semanticStatus.lastRun?.status === "running") {
      reasons.push({
        code: "semantic_index_running",
        severity: "degraded",
        message: "Semantic index run is currently in progress.",
      });
    }
    if (semanticStatus.staleChunks > 0) {
      reasons.push({
        code: "semantic_index_stale_chunks",
        severity: "degraded",
        message: "Semantic index contains stale chunks that should be refreshed or resolved.",
        count: semanticStatus.staleChunks,
      });
    }
    if (openCandidates > 0) {
      reasons.push({
        code: "contradictions_open",
        severity: "degraded",
        message: "Open contradiction candidates can affect search freshness and Jarvis answers.",
        count: openCandidates,
      });
    }
    if (taskCount > 0 && semanticStatus.indexedChunks === 0) {
      reasons.push({
        code: "jarvis_grounding_unavailable",
        severity: "failed",
        message: "Jarvis has RT2 tasks but no semantic index evidence for grounded citations.",
        count: taskCount,
      });
    } else if (taskCount > 0 && (semanticStatus.staleChunks > 0 || openCandidates > 0)) {
      reasons.push({
        code: "jarvis_grounding_at_risk",
        severity: "degraded",
        message: "Jarvis grounding is available, but stale evidence or open contradictions may produce warnings.",
      });
    }
    if (rewriteStats.providerUnavailable > 0) {
      reasons.push({
        code: "jarvis_rewrite_provider_unavailable",
        severity: "degraded",
        message: "Some Jarvis rewrite evals fell back because provider eval was unavailable or errored.",
        count: rewriteStats.providerUnavailable,
      });
    }
    if (rewriteStats.disagreement > 0) {
      reasons.push({
        code: "jarvis_rewrite_eval_disagreement",
        severity: "degraded",
        message: "Provider and deterministic fallback eval disagreed for rewrite proposals.",
        count: rewriteStats.disagreement,
      });
    }
    if (rewriteStats.lowConfidence > 0) {
      reasons.push({
        code: "jarvis_rewrite_low_confidence",
        severity: "degraded",
        message: "Low-confidence rewrite proposals need operator review before approval.",
        count: rewriteStats.lowConfidence,
      });
    }
    if (rewriteStats.blocked > 0) {
      reasons.push({
        code: "jarvis_rewrite_blocked",
        severity: "degraded",
        message: "Blocked Jarvis rewrite proposals cannot be applied and require review or rejection.",
        count: rewriteStats.blocked,
      });
    }

    const semanticHealth = worstStatus(reasons.filter((reason) => reason.code.startsWith("semantic_index")));
    const contradictionHealth = worstStatus(reasons.filter((reason) => reason.code.startsWith("contradictions")));
    const jarvisHealth = worstStatus(reasons.filter((reason) => reason.code.startsWith("jarvis")));

    return {
      companyId,
      status: worstStatus(reasons),
      generatedAt: new Date().toISOString(),
      semanticIndex: {
        status: semanticHealth,
        indexedChunks: semanticStatus.indexedChunks,
        sourceCount: semanticStatus.sourceCount,
        staleChunks: semanticStatus.staleChunks,
        providerMode: semanticStatus.providerMode,
        embeddingModel: semanticStatus.embeddingModel,
        latestRun: semanticStatus.lastRun ? {
          ...semanticStatus.lastRun,
          startedAt: semanticStatus.lastRun.startedAt.toISOString(),
          completedAt: semanticStatus.lastRun.completedAt?.toISOString() ?? null,
        } : null,
        lastSuccessfulRun: lastSuccessfulRun && lastSuccessfulRun.completedAt ? {
          id: lastSuccessfulRun.id,
          mode: lastSuccessfulRun.mode,
          providerMode: lastSuccessfulRun.providerMode,
          embeddingModel: lastSuccessfulRun.embeddingModel,
          sourcesScanned: lastSuccessfulRun.sourcesScanned,
          chunksRefreshed: lastSuccessfulRun.chunksRefreshed,
          chunksSkipped: lastSuccessfulRun.chunksSkipped,
          startedAt: lastSuccessfulRun.startedAt.toISOString(),
          completedAt: lastSuccessfulRun.completedAt.toISOString(),
        } : null,
      },
      contradictionReview: {
        status: contradictionHealth,
        openCandidates,
        resolvedCandidates,
        recentlyResolved,
      },
      jarvisGrounding: {
        status: jarvisHealth,
        taskCount,
        groundingAvailable: semanticStatus.indexedChunks > 0,
        warningSources: {
          staleChunks: semanticStatus.staleChunks,
          openContradictions: openCandidates,
        },
        rewriteProposals: rewriteStats,
      },
      reasons,
      flowLinks: [
        { label: "Semantic search", target: "search", path: "/rt2/knowledge?tab=search" },
        { label: "Contradiction review", target: "bridge", path: "/rt2/knowledge?tab=bridge" },
        { label: "Jarvis task advice", target: "jarvis", path: "/rt2/jarvis" },
        { label: "Jarvis rewrite proposals", target: "jarvis", path: "/rt2/jarvis?tab=rewrite-proposals" },
        { label: "Semantic index", target: "semantic-index", path: "/rt2/knowledge?tab=operations" },
      ],
    };
  }

  return { getHealth };
}

function worstStatus(reasons: Rt2KnowledgeOperationsReason[]): Rt2KnowledgeOperationsHealthStatus {
  if (reasons.some((reason) => reason.severity === "failed")) return "failed";
  if (reasons.some((reason) => reason.severity === "degraded")) return "degraded";
  return "healthy";
}

async function countRows(query: Promise<Array<{ count: number }>>): Promise<number> {
  const rows = await query;
  return rows[0]?.count ?? 0;
}

function summarizeRewriteHealth(rows: Array<{ status: string; riskLevel: string; latestEval: Record<string, unknown> | null }>) {
  return {
    total: rows.length,
    blocked: rows.filter((row) => row.status === "blocked").length,
    highRisk: rows.filter((row) => row.riskLevel === "high").length,
    providerUnavailable: rows.filter((row) => hasReason(row.latestEval, "provider_unavailable")).length,
    disagreement: rows.filter((row) => row.latestEval?.disagreement === true).length,
    lowConfidence: rows.filter((row) => row.latestEval?.lowConfidence === true).length,
  };
}

function hasReason(evalSummary: Record<string, unknown> | null, reason: string): boolean {
  return Array.isArray(evalSummary?.reasonCodes) && evalSummary.reasonCodes.includes(reason);
}
