import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  approvals,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  issueWorkProducts,
  issues,
  projects,
  rt2QualityScores,
  rt2ReverseDesignRuns,
  rt2RuntimeSkillInjections,
  rt2SearchIndex,
  rt2SearchLog,
  rt2V33ContradictionCandidates,
  rt2V33GraphEdges,
  rt2V33GraphNodes,
  rt2V33SemanticIndexChunks,
  rt2V33TaskProfiles,
  rt2V33WikiPages,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2AutoEvaluationRoutes } from "../routes/rt2-auto-evaluation.js";
import { rt2AdvancedAIRoutes } from "../routes/rt2-advanced-ai.js";
import { rt2HybridSearchRoutes } from "../routes/rt2-hybrid-search.js";
import { rt2JarvisRoutes } from "../routes/rt2-jarvis.js";
import { deterministicSemanticEmbedding } from "../services/rt2-semantic-index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 phase 6 intelligence tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 phase 6 intelligence", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;
  let projectId!: string;
  let taskIssueId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-phase6-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2SearchLog);
    await db.delete(rt2SearchIndex);
    await db.delete(rt2V33ContradictionCandidates);
    await db.delete(rt2V33SemanticIndexChunks);
    await db.delete(approvals);
    await db.delete(rt2RuntimeSkillInjections);
    await db.delete(rt2ReverseDesignRuns);
    await db.delete(rt2QualityScores);
    await db.delete(rt2V33GraphEdges);
    await db.delete(rt2V33GraphNodes);
    await db.delete(rt2V33WikiPages);
    await db.delete(issueWorkProducts);
    await db.delete(rt2V33TaskProfiles);
    await db.delete(issues);
    await db.delete(activityLog);
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
    app.use("/api", rt2JarvisRoutes(db));
    app.use("/api", rt2AutoEvaluationRoutes(db));
    app.use("/api", rt2AdvancedAIRoutes(db));
    app.use("/api", rt2HybridSearchRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedRt2Task() {
    companyId = randomUUID();
    projectId = randomUUID();
    taskIssueId = randomUUID();
    const todoIssueId = randomUUID();
    const deliverableId = randomUUID();
    const nodeId = randomUUID();
    const contradictionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Phase 6 Corp",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Hybrid Project",
      status: "in_progress",
    });
    await db.insert(issues).values([
      {
        id: taskIssueId,
        companyId,
        projectId,
        title: "Launch revenue forecast automation",
        description: "Build the deliverable-backed revenue forecast flow",
        status: "in_progress",
        priority: "high",
        createdByUserId: "board-user",
      },
      {
        id: todoIssueId,
        companyId,
        projectId,
        parentId: taskIssueId,
        title: "Collect forecast assumptions",
        description: "Gather live assumptions",
        status: "todo",
        priority: "medium",
        createdByUserId: "board-user",
      },
    ]);
    await db.insert(rt2V33TaskProfiles).values({
      issueId: taskIssueId,
      companyId,
      projectId,
      taskMode: "collab",
      capacity: 2,
    });
    await db.insert(issueWorkProducts).values({
      id: deliverableId,
      companyId,
      projectId,
      issueId: taskIssueId,
      type: "forecast",
      provider: "paperclip",
      title: "Revenue forecast workbook",
      status: "draft",
      reviewState: "none",
      summary: "Forecast model with assumptions and scenario output",
      metadata: {
        rt2Deliverable: true,
        rt2Type: "forecast",
        rt2BasePrice: 120,
      },
    });
    await db.insert(rt2V33WikiPages).values({
      companyId,
      pageKey: `topics/projects/${projectId}.md`,
      pageType: "topic",
      title: "Hybrid Project",
      markdown: "Revenue forecast automation should reuse live task and deliverable evidence.",
      summary: ["Revenue forecast automation"],
      sourceEventIds: [taskIssueId],
    });
    await db.insert(rt2V33GraphNodes).values({
      id: nodeId,
      companyId,
      projectId,
      nodeKey: `task:${taskIssueId}`,
      nodeType: "task",
      sourceId: taskIssueId,
      label: "revenue forecast task",
    });
    const semanticText = "Revenue forecast automation should reuse live task, deliverable, wiki, and graph evidence before Jarvis answers.";
    const embedding = deterministicSemanticEmbedding(semanticText);
    await db.insert(rt2V33SemanticIndexChunks).values({
      companyId,
      projectId,
      sourceType: "work_artifact",
      sourceId: deliverableId,
      sourceKey: "Revenue forecast workbook",
      chunkKey: "work-artifact:summary",
      chunkText: semanticText,
      contentHash: `hash-${deliverableId}`,
      embedding: embedding.vector,
      embeddingModel: embedding.model,
      embeddingProvider: embedding.provider,
      embeddingDimension: embedding.vector.length,
      sourceUpdatedAt: new Date(),
      freshness: "stale",
      provenance: {
        issueId: taskIssueId,
        confidence: "high",
        contradictionStatus: "unresolved",
      },
    });
    await db.insert(rt2V33ContradictionCandidates).values({
      id: contradictionId,
      companyId,
      projectId,
      status: "open",
      reasonCode: "wiki_embedding_consistency",
      title: "Forecast assumption conflict",
      explanation: "Daily wiki and work artifact disagree on the forecast assumption source.",
      sourceType: "daily_wiki_page",
      sourceId: `daily-${taskIssueId}`,
      sourceKey: "daily/forecast.md",
      conflictingSourceType: "work_artifact",
      conflictingSourceId: deliverableId,
      conflictingSourceKey: "Revenue forecast workbook",
      confidence: "0.91",
      rawEvidence: [{ reason: "test" }],
      deterministicSignals: { issueType: "embedding_consistency" },
    });
  }

  it("returns Jarvis advice from live task, wiki, graph, and deliverable evidence", async () => {
    await seedRt2Task();
    const app = createApp(companyId);

    const response = await request(app)
      .get(`/api/companies/${companyId}/rt2/jarvis/tasks/${taskIssueId}/advice`);

    expect(response.status).toBe(200);
    expect(response.body.evidence).toEqual(expect.objectContaining({
      deliverableCount: 1,
      openTodoCount: 1,
      wikiPageKeys: [`topics/projects/${projectId}.md`],
      graphNodeKeys: [`task:${taskIssueId}`],
    }));
    expect(response.body.nextSteps[0]).toEqual(expect.objectContaining({
      title: "Collect forecast assumptions",
    }));
    expect(response.body.grounding).toEqual(expect.objectContaining({
      retrieval: expect.objectContaining({
        searchType: "hybrid-semantic",
        projectScoped: true,
      }),
    }));
    expect(response.body.grounding.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "work_artifact",
        sourceId: expect.any(String),
        freshness: "stale",
        target: expect.objectContaining({
          kind: "work_object",
          params: expect.objectContaining({ issueId: taskIssueId }),
        }),
      }),
      expect.objectContaining({
        sourceType: "contradiction_item",
        contradictionStatus: "unresolved",
        target: expect.objectContaining({
          kind: "contradiction_item",
        }),
      }),
    ]));
    expect(response.body.grounding.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "stale_evidence" }),
      expect.objectContaining({ type: "unresolved_contradiction", severity: "blocker" }),
    ]));
  });

  it("stores Shadow, Co-Pilot, and Auto quality evaluations with approval boundaries", async () => {
    await seedRt2Task();
    const app = createApp(companyId);

    const shadow = await request(app)
      .post(`/api/companies/${companyId}/rt2/auto-evaluate`)
      .send({ taskIssueId, aiScore: 45, deliverableType: "forecast", mode: "shadow" });
    expect(shadow.status).toBe(200);
    expect(shadow.body.evaluation).toEqual(expect.objectContaining({
      evaluationMode: "shadow",
      isActive: 0,
      isFinalized: 0,
    }));

    const copilot = await request(app)
      .post(`/api/companies/${companyId}/rt2/auto-evaluate`)
      .send({ taskIssueId, aiScore: 99, deliverableType: "forecast", mode: "copilot" });
    expect(copilot.status).toBe(200);
    expect(copilot.body.evaluation).toEqual(expect.objectContaining({
      evaluationMode: "copilot",
      managerDecision: "pending",
    }));
    expect(copilot.body.policyDecision).toEqual(expect.objectContaining({
      decision: "requires_copilot",
      approvalRequired: true,
    }));

    const auto = await request(app)
      .post(`/api/companies/${companyId}/rt2/auto-evaluate`)
      .send({ taskIssueId, aiScore: 100, deliverableType: "forecast", mode: "auto" });
    expect(auto.status).toBe(200);
    expect(auto.body.evaluation).toEqual(expect.objectContaining({
      evaluationMode: "auto",
      managerDecision: "approved",
    }));
    expect(auto.body.policyDecision).toEqual(expect.objectContaining({
      decision: "auto_approved",
      approvalRequired: false,
    }));
  });

  it("exposes Jarvis manager review evidence and decision actions", async () => {
    await seedRt2Task();
    const app = createApp(companyId);

    const pending = await request(app)
      .post(`/api/companies/${companyId}/rt2/auto-evaluate`)
      .send({ taskIssueId, aiScore: 10, deliverableType: "forecast", mode: "auto", rationale: "Low confidence output" });
    expect(pending.status).toBe(200);

    const queue = await request(app)
      .get(`/api/companies/${companyId}/rt2/jarvis/quality-reviews`);
    expect(queue.status).toBe(200);
    expect(queue.body.items[0]).toEqual(expect.objectContaining({
      evaluationId: pending.body.evaluation.id,
      taskTitle: "Launch revenue forecast automation",
      expectedDeltaGold: 5,
      policyDecision: "requires_copilot",
    }));
    expect(queue.body.items[0].evidence).toEqual(expect.objectContaining({
      taskStatus: "in_progress",
    }));

    const approved = await request(app)
      .post(`/api/companies/${companyId}/rt2/jarvis/quality-reviews/${pending.body.evaluation.id}/approve`)
      .send({ feedback: "Accept with manager review" });
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual(expect.objectContaining({
      managerDecision: "approved",
      isFinalized: 1,
      isActive: 1,
    }));
  });

  it("reverse-designs traceable tasks from an expected deliverable", async () => {
    await seedRt2Task();
    const app = createApp(companyId);

    const response = await request(app)
      .post(`/api/companies/${companyId}/rt2/jarvis/reverse-design-tasks`)
      .send({
        title: "월간 영업 KPI 대시보드",
        type: "dashboard",
        description: "경영진 보고용 KPI 산출물",
        projectId,
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({
      companyId,
      rationale: expect.stringContaining("reverse-designed"),
    }));
    expect(response.body.tasks[0]).toEqual(expect.objectContaining({
      deliverableType: "dashboard",
      confidence: expect.any(Number),
    }));
    expect(response.body.runId).toEqual(expect.any(String));
  });

  it("registers runtime skill attachment as a governed Jarvis capability", async () => {
    await seedRt2Task();
    const app = createApp(companyId);
    const agentId = randomUUID();

    const created = await request(app)
      .post(`/api/companies/${companyId}/rt2/jarvis/skill-capabilities`)
      .send({
        agentId,
        skillKey: "rt2.monthly-kpi-summarizer",
        injectionType: "system_message",
        context: { projectId },
      });

    expect(created.status).toBe(201);
    expect(created.body).toEqual(expect.objectContaining({
      agentId,
      skillKey: "rt2.monthly-kpi-summarizer",
      approvalStatus: "pending",
    }));
    expect(created.body.policy).toEqual(expect.objectContaining({
      governed: true,
    }));

    const list = await request(app)
      .get(`/api/companies/${companyId}/rt2/jarvis/skill-capabilities`)
      .query({ agentId });
    expect(list.status).toBe(200);
    expect(list.body[0]).toEqual(expect.objectContaining({
      injectionId: created.body.injectionId,
      approvalId: created.body.approvalId,
    }));
  });

  it("hybrid search returns ranked wiki, graph, task, and deliverable evidence", async () => {
    await seedRt2Task();
    const app = createApp(companyId);

    const response = await request(app)
      .get(`/api/companies/${companyId}/rt2/search`)
      .query({ q: "forecast", limit: 10 });

    expect(response.status).toBe(200);
    expect(response.body.searchType).toBe("hybrid");
    expect(response.body.results.map((result: { type: string }) => result.type)).toEqual(
      expect.arrayContaining(["wiki_page", "task", "deliverable", "graph_node"]),
    );
    expect(response.body.results[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.stringMatching(/^(semantic-index|lexical-fallback)$/),
        }),
      ]),
    );
  });
});
