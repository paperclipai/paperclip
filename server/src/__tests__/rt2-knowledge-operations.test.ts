import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  issues,
  projects,
  rt2JarvisRewriteProposals,
  rt2V33ContradictionCandidates,
  rt2V33SemanticIndexChunks,
  rt2V33SemanticIndexRuns,
  rt2V33TaskProfiles,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2KnowledgeOperationsRoutes } from "../routes/rt2-knowledge-operations.js";
import { deterministicSemanticEmbedding } from "../services/rt2-semantic-index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 knowledge operations tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 knowledge operations health", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;
  let projectId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-ops-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2V33ContradictionCandidates);
    await db.delete(rt2JarvisRewriteProposals);
    await db.delete(rt2V33SemanticIndexChunks);
    await db.delete(rt2V33SemanticIndexRuns);
    await db.delete(rt2V33TaskProfiles);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actorCompanyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user",
        source: "session",
        isInstanceAdmin: false,
        companyIds: [actorCompanyId],
      };
      next();
    });
    app.use("/api", rt2KnowledgeOperationsRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    companyId = randomUUID();
    projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Ops Corp",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Knowledge Ops",
      status: "in_progress",
    });
  }

  async function seedTask() {
    const taskIssueId = randomUUID();
    await db.insert(issues).values({
      id: taskIssueId,
      companyId,
      projectId,
      title: "Investigate semantic operations",
      status: "in_progress",
      priority: "medium",
      createdByUserId: "board-user",
    });
    await db.insert(rt2V33TaskProfiles).values({
      issueId: taskIssueId,
      companyId,
      projectId,
      taskMode: "solo",
      capacity: 1,
    });
    return taskIssueId;
  }

  async function seedSemanticIndex(input: { stale?: boolean; latestStatus?: "completed" | "running" | "error" } = {}) {
    const status = input.latestStatus ?? "completed";
    const completedAt = status === "running" ? null : new Date();
    await db.insert(rt2V33SemanticIndexRuns).values({
      companyId,
      mode: "changed",
      status,
      providerMode: "fallback",
      embeddingModel: "rt2-deterministic-tokenhash-v1",
      sourcesScanned: 1,
      chunksRefreshed: 1,
      chunksSkipped: 0,
      errorMessage: status === "error" ? "test failure" : null,
      completedAt,
    });

    if (status !== "completed") {
      await db.insert(rt2V33SemanticIndexRuns).values({
        companyId,
        mode: "changed",
        status: "completed",
        providerMode: "fallback",
        embeddingModel: "rt2-deterministic-tokenhash-v1",
        sourcesScanned: 1,
        chunksRefreshed: 1,
        chunksSkipped: 0,
        completedAt: new Date(Date.now() - 60_000),
      });
    }

    const text = "Semantic knowledge operations should cite deterministic fallback evidence.";
    const embedding = deterministicSemanticEmbedding(text);
    await db.insert(rt2V33SemanticIndexChunks).values({
      companyId,
      projectId,
      sourceType: "work_artifact",
      sourceId: randomUUID(),
      sourceKey: "ops-artifact",
      chunkKey: "ops-artifact:0",
      chunkText: text,
      contentHash: `hash-${randomUUID()}`,
      embedding: embedding.vector,
      embeddingModel: embedding.model,
      embeddingProvider: embedding.provider,
      embeddingDimension: embedding.vector.length,
      sourceUpdatedAt: new Date(),
      freshness: input.stale ? "stale" : "fresh",
      provenance: { test: true },
    });
  }

  it("fails clearly when tasks exist but no semantic index evidence exists", async () => {
    await seedCompany();
    await seedTask();
    const app = createApp(companyId);

    const response = await request(app)
      .get(`/api/companies/${companyId}/rt2/knowledge/operations/health`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("failed");
    expect(response.body.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "semantic_index_missing", severity: "failed" }),
      expect.objectContaining({ code: "jarvis_grounding_unavailable", severity: "failed" }),
    ]));
  });

  it("reports degraded health for stale chunks and open contradictions", async () => {
    await seedCompany();
    await seedTask();
    await seedSemanticIndex({ stale: true });
    await db.insert(rt2V33ContradictionCandidates).values({
      companyId,
      projectId,
      status: "open",
      reasonCode: "wiki_embedding_consistency",
      title: "Ops contradiction",
      sourceType: "daily_wiki_page",
      sourceId: randomUUID(),
      sourceKey: "daily/ops.md",
      conflictingSourceType: "work_artifact",
      conflictingSourceId: randomUUID(),
      conflictingSourceKey: "ops-artifact",
      confidence: "0.8",
      rawEvidence: [{ reason: "test" }],
      deterministicSignals: { issueType: "embedding_consistency" },
    });
    const app = createApp(companyId);

    const response = await request(app)
      .get(`/api/companies/${companyId}/rt2/knowledge/operations/health`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("degraded");
    expect(response.body.semanticIndex.lastSuccessfulRun).toEqual(expect.objectContaining({
      providerMode: "fallback",
    }));
    expect(response.body.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "semantic_index_stale_chunks" }),
      expect.objectContaining({ code: "contradictions_open" }),
      expect.objectContaining({ code: "jarvis_grounding_at_risk" }),
    ]));
  });

  it("reports Jarvis rewrite proposal eval guardrail risks", async () => {
    await seedCompany();
    await seedTask();
    await seedSemanticIndex();
    await db.insert(rt2JarvisRewriteProposals).values({
      companyId,
      projectId,
      targetType: "wiki_page",
      targetId: "wiki-ops",
      targetKey: "daily/ops.md",
      title: "Rewrite ops note",
      status: "blocked",
      riskLevel: "high",
      proposedDiff: { before: "old", after: "new", summary: "test" },
      citations: [],
      contradictionIds: [],
      latestEval: {
        providerStatus: "unavailable",
        fallbackStatus: "completed",
        disagreement: true,
        lowConfidence: true,
        finalRecommendation: "block",
        finalConfidence: 0.42,
        reasonCodes: ["provider_unavailable", "provider_fallback_disagreement", "low_confidence"],
      },
      createdBy: "test",
    });
    const app = createApp(companyId);

    const response = await request(app)
      .get(`/api/companies/${companyId}/rt2/knowledge/operations/health`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("degraded");
    expect(response.body.jarvisGrounding.rewriteProposals).toEqual(expect.objectContaining({
      total: 1,
      blocked: 1,
      highRisk: 1,
      providerUnavailable: 1,
      disagreement: 1,
      lowConfidence: 1,
    }));
    expect(response.body.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "jarvis_rewrite_provider_unavailable" }),
      expect.objectContaining({ code: "jarvis_rewrite_eval_disagreement" }),
      expect.objectContaining({ code: "jarvis_rewrite_low_confidence" }),
      expect.objectContaining({ code: "jarvis_rewrite_blocked" }),
    ]));
  });

  it("keeps the route company-scoped", async () => {
    await seedCompany();
    const otherCompanyId = randomUUID();
    const app = createApp(otherCompanyId);

    const response = await request(app)
      .get(`/api/companies/${companyId}/rt2/knowledge/operations/health`);

    expect(response.status).toBe(403);
  });
});
