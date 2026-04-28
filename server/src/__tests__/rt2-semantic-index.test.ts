import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  issueWorkProducts,
  issues,
  projects,
  rt2V33DailyWikiPages,
  rt2V33GraphEdges,
  rt2V33GraphNodes,
  rt2V33SemanticIndexChunks,
  rt2V33SemanticIndexRuns,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { deterministicSemanticEmbedding, rt2SemanticIndexService } from "../services/rt2-semantic-index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 semantic index tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("rt2 semantic index fallback embedding", () => {
  it("is deterministic without provider credentials", () => {
    const first = deterministicSemanticEmbedding("Billing migration completed for ACME");
    const second = deterministicSemanticEmbedding("Billing migration completed for ACME");

    expect(first).toEqual(second);
    expect(first.provider).toBe("local_fallback");
    expect(first.model).toBe("rt2-deterministic-tokenhash-v1");
    expect(first.vector).toHaveLength(32);
  });
});

describeEmbeddedPostgres("rt2 semantic index", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-semantic-index-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2V33SemanticIndexChunks);
    await db.delete(rt2V33SemanticIndexRuns);
    await db.delete(rt2V33GraphEdges);
    await db.delete(rt2V33GraphNodes);
    await db.delete(issueWorkProducts);
    await db.delete(rt2V33DailyWikiPages);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `${name} Semantic Project`,
      status: "in_progress",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: `${name} Migration Task`,
      status: "in_progress",
      identifier: `${name.slice(0, 3).toUpperCase()}-${companyId.slice(0, 4)}`,
    });

    return { companyId, projectId, issueId };
  }

  it("indexes daily wiki, graph, and work artifact sources with provenance", async () => {
    const { companyId, projectId, issueId } = await seedCompany("Semantic Corp");

    await db.insert(rt2V33DailyWikiPages).values({
      companyId,
      projectId,
      userId: "operator-1",
      reportDate: "2026-04-28",
      pageKey: "daily/2026-04-28.md",
      shortSummary: ["Billing migration completed."],
      markdown: "ACME billing migration was completed and approved.",
      history: [],
      sourceEventIds: ["event-1"],
    });

    const [sourceNode, targetNode] = await db.insert(rt2V33GraphNodes).values([
      {
        companyId,
        projectId,
        nodeKey: "task:billing",
        nodeType: "task",
        sourceId: issueId,
        label: "Billing Migration",
        metadata: { status: "done" },
      },
      {
        companyId,
        projectId,
        nodeKey: "actor:operator-1",
        nodeType: "actor",
        sourceId: "operator-1",
        label: "Operator 1",
        metadata: {},
      },
    ]).returning();

    await db.insert(rt2V33GraphEdges).values({
      companyId,
      projectId,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      edgeType: "actor_task",
      confidence: "EXTRACTED",
      confidenceScore: "1.00",
      rationale: "Operator completed the billing migration task.",
      evidence: [{ sourceEventId: "event-1" }],
    });

    await db.insert(issueWorkProducts).values({
      companyId,
      projectId,
      issueId,
      type: "deliverable",
      provider: "local",
      title: "Billing migration PR",
      status: "ready",
      reviewState: "approved",
      healthStatus: "healthy",
      summary: "Implementation and verification evidence for billing migration.",
    });

    const result = await rt2SemanticIndexService(db).reindexCompany(companyId, { mode: "full" });
    const chunks = await db.select().from(rt2V33SemanticIndexChunks);

    expect(result).toEqual(expect.objectContaining({
      status: "completed",
      providerMode: "fallback",
      sourcesScanned: 5,
      chunksRefreshed: 5,
    }));
    expect(chunks).toHaveLength(5);
    expect(chunks.map((chunk) => chunk.sourceType).sort()).toEqual([
      "daily_wiki_page",
      "graph_edge",
      "graph_node",
      "graph_node",
      "work_artifact",
    ].sort());
    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId,
        sourceType: "daily_wiki_page",
        sourceKey: "daily/2026-04-28.md",
        embeddingProvider: "local_fallback",
        provenance: expect.objectContaining({ sourceEventIds: ["event-1"] }),
      }),
      expect.objectContaining({
        companyId,
        sourceType: "work_artifact",
        sourceKey: expect.any(String),
        provenance: expect.objectContaining({ issueId }),
      }),
    ]));
  });

  it("skips unchanged chunks and keeps company boundaries", async () => {
    const first = await seedCompany("First Corp");
    const second = await seedCompany("Second Corp");

    await db.insert(rt2V33DailyWikiPages).values([
      {
        companyId: first.companyId,
        projectId: first.projectId,
        userId: "operator-1",
        reportDate: "2026-04-28",
        pageKey: "daily/2026-04-28.md",
        shortSummary: ["First company semantic evidence."],
        markdown: "Only first company evidence should be indexed for first company.",
        history: [],
        sourceEventIds: ["first-event"],
      },
      {
        companyId: second.companyId,
        projectId: second.projectId,
        userId: "operator-2",
        reportDate: "2026-04-28",
        pageKey: "daily/2026-04-28.md",
        shortSummary: ["Second company semantic evidence."],
        markdown: "Second company evidence must not leak into first company index.",
        history: [],
        sourceEventIds: ["second-event"],
      },
    ]);

    const service = rt2SemanticIndexService(db);
    const initial = await service.reindexCompany(first.companyId, { mode: "changed" });
    const unchanged = await service.reindexCompany(first.companyId, { mode: "changed" });
    const chunks = await db.select().from(rt2V33SemanticIndexChunks);
    const status = await service.getStatus(first.companyId);

    expect(initial.chunksRefreshed).toBe(1);
    expect(unchanged.chunksRefreshed).toBe(0);
    expect(unchanged.chunksSkipped).toBe(1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].companyId).toBe(first.companyId);
    expect(status).toEqual(expect.objectContaining({
      companyId: first.companyId,
      indexedChunks: 1,
      sourceCount: 1,
      providerMode: "fallback",
    }));
  });
});
