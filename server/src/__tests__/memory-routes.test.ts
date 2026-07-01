import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMemoryService = vi.hoisted(() => ({
  ingest: vi.fn(),
  search: vi.fn(),
  get: vi.fn(),
  browse: vi.fn(),
  forget: vi.fn(),
  usage: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: () => mockMemoryService,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/index.js", () => ({
  memoryService: () => mockMemoryService,
  agentService: () => mockAgentService,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { memoryRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/memory.js") as Promise<typeof import("../routes/memory.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", memoryRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe.sequential("memory routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockMemoryService)) mock.mockReset();
    mockAgentService.getById.mockReset();
  });

  it("ingests a memory entry", async () => {
    mockMemoryService.ingest.mockResolvedValue({
      id: "entry-1",
      companyId: "company-1",
      key: "context",
      title: "Context",
      body: "Body",
      tags: [],
      source: null,
      projectId: null,
      goalId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/memory")
        .send({ key: "context", body: "Body text" }),
    );

    expect(res.status).toBe(201);
    expect(mockMemoryService.ingest).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ key: "context", body: "Body text" }),
      expect.objectContaining({ actorType: "user", actorId: "user-1" }),
    );
  });

  it("rejects ingest for a company the actor cannot access", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-2/memory")
        .send({ key: "context", body: "Body text" }),
    );

    expect(res.status).toBe(403);
    expect(mockMemoryService.ingest).not.toHaveBeenCalled();
  });

  it("browses memory entries with query filters", async () => {
    mockMemoryService.browse.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/memory?key=context&limit=10"),
    );

    expect(res.status).toBe(200);
    expect(mockMemoryService.browse).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "company-1", key: "context", limit: 10 }),
    );
  });

  it("searches memory entries by query text", async () => {
    mockMemoryService.search.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/memory/search?query=deploy"),
    );

    expect(res.status).toBe(200);
    expect(mockMemoryService.search).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ query: "deploy" }),
    );
  });

  it("returns a memory entry by id", async () => {
    mockMemoryService.get.mockResolvedValue({
      id: "entry-1",
      companyId: "company-1",
      key: "context",
      title: null,
      body: "Body",
      tags: [],
      source: null,
      projectId: null,
      goalId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/memory/entry-1"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "entry-1" });
  });

  it("returns 404 when a memory entry is missing", async () => {
    mockMemoryService.get.mockResolvedValue(null);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/memory/missing-entry"),
    );

    expect(res.status).toBe(404);
  });

  it("forgets a memory entry", async () => {
    mockMemoryService.get.mockResolvedValue({
      id: "entry-1",
      companyId: "company-1",
      key: "context",
      title: null,
      body: "Body",
      tags: [],
      source: null,
      projectId: null,
      goalId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    mockMemoryService.forget.mockResolvedValue(undefined);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).delete("/api/companies/company-1/memory/entry-1"),
    );

    expect(res.status).toBe(204);
    expect(mockMemoryService.forget).toHaveBeenCalledWith(
      "company-1",
      "entry-1",
      expect.objectContaining({ actorType: "user", actorId: "user-1" }),
    );
  });

  it("returns 404 when forgetting a missing memory entry", async () => {
    mockMemoryService.get.mockResolvedValue(null);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).delete("/api/companies/company-1/memory/missing-entry"),
    );

    expect(res.status).toBe(404);
    expect(mockMemoryService.forget).not.toHaveBeenCalled();
  });

  it("allows a standard-trust agent actor to ingest memory", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });
    mockMemoryService.ingest.mockResolvedValue({
      id: "entry-1",
      companyId: "company-1",
      key: "context",
      title: null,
      body: "Body",
      tags: [],
      source: null,
      projectId: null,
      goalId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "agent_key",
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/memory")
        .send({ key: "context", body: "Body text" }),
    );

    expect(res.status).toBe(201);
    expect(mockMemoryService.ingest).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ key: "context", body: "Body text" }),
      expect.objectContaining({ actorType: "agent", actorId: "agent-1" }),
    );
  });

  it("denies a low-trust agent actor from writing memory via the raw route", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { trustPreset: "low_trust_review" },
    });

    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "agent_key",
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/memory")
        .send({ key: "context", body: "Body text" }),
    );

    expect(res.status).toBe(403);
    expect(mockMemoryService.ingest).not.toHaveBeenCalled();
  });

  it("denies a low-trust agent actor from deleting memory via the raw route", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { trustPreset: "low_trust_review" },
    });

    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "agent_key",
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).delete("/api/companies/company-1/memory/entry-1"),
    );

    expect(res.status).toBe(403);
    expect(mockMemoryService.forget).not.toHaveBeenCalled();
  });

  it("allows a standard-trust agent actor to read memory", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });
    mockMemoryService.browse.mockResolvedValue([]);

    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "agent_key",
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/memory"),
    );

    expect(res.status).toBe(200);
  });
});
