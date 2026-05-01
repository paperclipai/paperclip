import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  rt2V33CorpusGraphCommunities,
  rt2V33CorpusGraphEdges,
  rt2V33CorpusGraphNodes,
  rt2V33CorpusGraphReports,
  rt2V33CorpusGraphSources,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2CorpusGraphRoutes } from "../routes/rt2-corpus-graph.js";
import { rt2CorpusGraphService } from "../services/rt2-corpus-graph.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 corpus graph tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 corpus graph sidecar", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-corpus-graph-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2V33CorpusGraphReports);
    await db.delete(rt2V33CorpusGraphCommunities);
    await db.delete(rt2V33CorpusGraphEdges);
    await db.delete(rt2V33CorpusGraphNodes);
    await db.delete(rt2V33CorpusGraphSources);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Corpus Graph Corp") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function buildApp(actorCompanyId: string) {
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
    app.use("/api", rt2CorpusGraphRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const sampleSources = [
    {
      sourceKey: "doc/jarvis-memory.md",
      sourceType: "doc_file" as const,
      title: "Jarvis Memory",
      content: "# Jarvis Memory\n\nJarvis uses graphify corpus memory for runtime decisions.\n\n## Evidence\n\nGraphify links Jarvis to sidecar reports.",
      sourceLocation: { path: "doc/jarvis-memory.md" },
    },
    {
      sourceKey: "server/src/jarvis-memory.ts",
      sourceType: "repo_file" as const,
      title: "Jarvis Memory Service",
      content: "import { graphifySidecar } from './graphify-sidecar';\nexport function buildJarvisMemory() {\n  const jarvisGraphifyRuntime = graphifySidecar('jarvis');\n  return jarvisGraphifyRuntime;\n}\n",
      sourceLocation: { path: "server/src/jarvis-memory.ts" },
    },
  ];

  it("ingests sources incrementally and exposes graph query/report data", async () => {
    const companyId = await seedCompany();
    const svc = rt2CorpusGraphService(db);

    const initial = await svc.ingestSources(companyId, { sources: sampleSources });
    expect(initial).toEqual(expect.objectContaining({
      companyId,
      processedSources: 2,
      insertedSources: 2,
      updatedSources: 0,
      skippedSources: 0,
    }));
    expect(initial.graph.nodeCount).toBeGreaterThanOrEqual(6);
    expect(initial.graph.edgeCount).toBeGreaterThanOrEqual(6);
    expect(initial.graph.clusteringAlgorithm).toBe("connected_components_fallback");
    expect(initial.report.markdown).toContain("## Corpus Graph");
    expect(initial.report.markdown).toContain("## Product Graph");

    const unchanged = await svc.ingestSources(companyId, { sources: sampleSources });
    expect(unchanged.insertedSources).toBe(0);
    expect(unchanged.updatedSources).toBe(0);
    expect(unchanged.skippedSources).toBe(2);

    const node = await svc.getNode(companyId, "source:doc/jarvis-memory.md");
    expect(node.node).toEqual(expect.objectContaining({
      nodeKey: "source:doc/jarvis-memory.md",
      nodeType: "source_file",
    }));
    expect(node.source).toEqual(expect.objectContaining({
      sourceKey: "doc/jarvis-memory.md",
      sha256: expect.any(String),
      sourceLocation: expect.objectContaining({ path: "doc/jarvis-memory.md" }),
    }));
    expect(node.outgoingEdges.length + node.incomingEdges.length).toBeGreaterThan(0);

    const neighbors = await svc.getNeighbors(companyId, "source:doc/jarvis-memory.md", 20);
    expect(neighbors.neighbors.map((neighbor) => neighbor.node.nodeType)).toContain("term");

    const path = await svc.getShortestPath(
      companyId,
      "source:doc/jarvis-memory.md",
      "source:server/src/jarvis-memory.ts",
      6,
    );
    expect(path.found).toBe(true);
    expect(path.nodes[0].nodeKey).toBe("source:doc/jarvis-memory.md");
    expect(path.nodes.at(-1)?.nodeKey).toBe("source:server/src/jarvis-memory.ts");

    const stats = await svc.getStats(companyId);
    expect(stats.productGraph).toEqual({ nodeCount: 0, edgeCount: 0 });
    expect(stats.communities.length).toBeGreaterThan(0);

    const community = await svc.getCommunity(companyId, stats.communities[0].communityKey);
    expect(community.community.algorithm).toBe("connected_components_fallback");
    expect(community.nodes.length).toBeGreaterThan(0);

    const godNodes = await svc.getGodNodes(companyId, 10);
    expect(godNodes.length).toBeGreaterThan(0);
    expect(godNodes[0].isGodNode).toBe(true);
  });

  it("serves corpus graph routes with company access checks", async () => {
    const companyId = await seedCompany("Corpus Routes Corp");
    const app = buildApp(companyId);

    const ingestResponse = await request(app)
      .post(`/api/companies/${companyId}/rt2/corpus-graph/ingest`)
      .send({ sources: sampleSources });
    expect(ingestResponse.status).toBe(200);
    expect(ingestResponse.body.insertedSources).toBe(2);

    const statsResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/corpus-graph/stats`);
    expect(statsResponse.status).toBe(200);
    expect(statsResponse.body).toEqual(expect.objectContaining({
      companyId,
      clusteringAlgorithm: "connected_components_fallback",
      productGraph: { nodeCount: 0, edgeCount: 0 },
    }));

    const nodeResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/corpus-graph/node`)
      .query({ nodeKey: "source:doc/jarvis-memory.md" });
    expect(nodeResponse.status).toBe(200);
    expect(nodeResponse.body.node.nodeKey).toBe("source:doc/jarvis-memory.md");

    const neighborsResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/corpus-graph/neighbors`)
      .query({ nodeKey: "source:doc/jarvis-memory.md", limit: 10 });
    expect(neighborsResponse.status).toBe(200);
    expect(neighborsResponse.body.neighbors.length).toBeGreaterThan(0);

    const pathResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/corpus-graph/shortest-path`)
      .query({
        fromNodeKey: "source:doc/jarvis-memory.md",
        toNodeKey: "source:server/src/jarvis-memory.ts",
      });
    expect(pathResponse.status).toBe(200);
    expect(pathResponse.body.found).toBe(true);

    const godNodesResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/corpus-graph/god-nodes`);
    expect(godNodesResponse.status).toBe(200);
    expect(godNodesResponse.body.nodes.length).toBeGreaterThan(0);

    const communityKey = statsResponse.body.communities[0].communityKey;
    const communityResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/corpus-graph/community`)
      .query({ communityKey });
    expect(communityResponse.status).toBe(200);
    expect(communityResponse.body.community.communityKey).toBe(communityKey);

    const reportResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/corpus-graph/report`);
    expect(reportResponse.status).toBe(200);
    expect(reportResponse.body.markdown).toContain("## Product Graph");
  });
});
