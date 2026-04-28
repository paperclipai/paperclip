import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  rt2V33ContradictionCandidates,
  rt2V33ContradictionResolutions,
  rt2V33DailyWikiPages,
  rt2V33SemanticIndexChunks,
  type Rt2ContradictionResolutionDecision,
} from "@paperclipai/db";
import { rt2WikiLintService, type Rt2WikiLintIssue } from "./rt2-wiki-lint.js";

export type Rt2ContradictionResolutionInput = {
  decision: Rt2ContradictionResolutionDecision;
  reason: string;
  followUpIssueId?: string | null;
};

export function rt2ContradictionReviewService(db: Db) {
  const lint = rt2WikiLintService(db);

  async function generateCandidates(companyId: string, input: { projectId: string }) {
    const lintResult = await lint.lintWikiPages(companyId, input.projectId);
    const issues = lintResult.issues.filter((issue) => issue.issueType === "embedding_consistency");
    const candidates = [];

    for (const issue of issues) {
      const candidate = await upsertCandidateFromIssue(companyId, input.projectId, issue);
      if (candidate) candidates.push(candidate);
    }

    if (candidates.length > 0) {
      const sourceIds = candidates.flatMap((candidate) => [candidate.sourceId, candidate.conflictingSourceId]);
      await markSemanticFreshness(companyId, sourceIds, "stale");
    }

    return {
      companyId,
      projectId: input.projectId,
      checkedPages: lintResult.checkedPages,
      semanticComparisons: lintResult.semanticComparisons,
      candidatesCreated: candidates.length,
      candidates,
    };
  }

  async function listCandidates(companyId: string, input: { status?: "open" | "resolved" | "all"; projectId?: string } = {}) {
    const conditions = [eq(rt2V33ContradictionCandidates.companyId, companyId)];
    if (input.status && input.status !== "all") conditions.push(eq(rt2V33ContradictionCandidates.status, input.status));
    if (input.projectId) conditions.push(eq(rt2V33ContradictionCandidates.projectId, input.projectId));

    const candidates = await db
      .select()
      .from(rt2V33ContradictionCandidates)
      .where(and(...conditions))
      .orderBy(desc(rt2V33ContradictionCandidates.updatedAt));

    return { companyId, candidates };
  }

  async function resolveCandidate(companyId: string, candidateId: string, input: Rt2ContradictionResolutionInput, resolvedBy: string) {
    const candidate = await db
      .select()
      .from(rt2V33ContradictionCandidates)
      .where(and(eq(rt2V33ContradictionCandidates.companyId, companyId), eq(rt2V33ContradictionCandidates.id, candidateId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!candidate) {
      const error = new Error("Contradiction candidate not found");
      (error as Error & { status?: number }).status = 404;
      throw error;
    }

    const auditEventId = `rt2.contradiction.${candidateId}.${Date.now()}`;
    const [resolution] = await db.insert(rt2V33ContradictionResolutions).values({
      candidateId,
      companyId,
      decision: input.decision,
      reason: input.reason,
      followUpIssueId: input.followUpIssueId ?? null,
      resolvedBy,
      auditEventId,
    }).returning();

    const [updated] = await db.update(rt2V33ContradictionCandidates).set({
      status: "resolved",
      resolvedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(rt2V33ContradictionCandidates.id, candidateId)).returning();

    await markSemanticFreshness(companyId, [candidate.sourceId, candidate.conflictingSourceId], "fresh");

    return { candidate: updated, resolution };
  }

  async function upsertCandidateFromIssue(companyId: string, projectId: string, issue: Rt2WikiLintIssue) {
    if (!issue.relatedPageId || !issue.relatedPageKey) return null;
    const title = `Knowledge conflict: ${issue.pageKey} ↔ ${issue.relatedPageKey}`;
    const values = {
      companyId,
      projectId,
      status: "open" as const,
      reasonCode: "wiki_embedding_consistency",
      title,
      explanation: issue.message,
      sourceType: "daily_wiki_page",
      sourceId: issue.pageId,
      sourceKey: issue.pageKey,
      conflictingSourceType: "daily_wiki_page",
      conflictingSourceId: issue.relatedPageId,
      conflictingSourceKey: issue.relatedPageKey,
      confidence: issue.confidence === undefined ? "unknown" : String(issue.confidence),
      rawEvidence: issue.evidence ?? [],
      deterministicSignals: {
        issueType: issue.issueType,
        severity: issue.severity,
        reasonCode: "wiki_embedding_consistency",
      },
      updatedAt: new Date(),
    };

    const [candidate] = await db.insert(rt2V33ContradictionCandidates).values(values).onConflictDoUpdate({
      target: [
        rt2V33ContradictionCandidates.companyId,
        rt2V33ContradictionCandidates.reasonCode,
        rt2V33ContradictionCandidates.sourceType,
        rt2V33ContradictionCandidates.sourceId,
        rt2V33ContradictionCandidates.conflictingSourceType,
        rt2V33ContradictionCandidates.conflictingSourceId,
      ],
      set: values,
    }).returning();
    return candidate;
  }

  async function markSemanticFreshness(companyId: string, sourceIds: string[], freshness: "fresh" | "stale") {
    const uniqueSourceIds = [...new Set(sourceIds)].filter(Boolean);
    if (uniqueSourceIds.length === 0) return;
    await db.update(rt2V33SemanticIndexChunks).set({
      freshness,
      updatedAt: new Date(),
    }).where(and(
      eq(rt2V33SemanticIndexChunks.companyId, companyId),
      inArray(rt2V33SemanticIndexChunks.sourceId, uniqueSourceIds),
    ));
  }

  async function listProjectsWithDailyWiki(companyId: string) {
    const rows = await db.select({ projectId: rt2V33DailyWikiPages.projectId })
      .from(rt2V33DailyWikiPages)
      .where(eq(rt2V33DailyWikiPages.companyId, companyId));
    return [...new Set(rows.map((row) => row.projectId))];
  }

  return { generateCandidates, listCandidates, resolveCandidate, listProjectsWithDailyWiki };
}
