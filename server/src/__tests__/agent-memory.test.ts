import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock data ───────────────────────────────────────────────────────────────

const COMPANY_ID = randomUUID();
const USER_ID = randomUUID();
const AGENT_ID = randomUUID();
const ENTRY_ID = randomUUID();

const MOCK_MEMORY_ENTRY = {
  id: ENTRY_ID,
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
  memoryType: "semantic",
  category: "test-category",
  content: "Test memory content",
  sourceIssueId: null,
  sourceProjectId: null,
  confidence: 80,
  accessCount: 0,
  lastAccessedAt: null,
  expiresAt: null,
  archivedAt: null,
  createdAt: new Date(),
};

// ── DB mock ─────────────────────────────────────────────────────────────────

function buildChainableQuery(defaultResult: unknown = []) {
  const chain: Record<string, any> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.values = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockReturnValue(chain);
  chain.then = vi.fn().mockImplementation((resolve: any) => resolve(defaultResult));
  return chain;
}

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCreateAgentDocument = vi.hoisted(() => {
  // Inline UUID to avoid referencing `randomUUID` before import is available during hoisting.
  return vi.fn().mockResolvedValue("00000000-0000-0000-0000-000000000000");
});

vi.mock("../services/index.js", () => ({
  logActivity: mockLogActivity,
  createAgentDocument: mockCreateAgentDocument,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ── App builder ─────────────────────────────────────────────────────────────

async function createApp(actor: Record<string, unknown>, dbOverrides?: Record<string, any>) {
  const { agentMemoryRoutes } = await import("../routes/agent-memory.js");
  const { errorHandler } = await import("../middleware/error-handler.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });

  // Build a fake DB
  const selectChain = buildChainableQuery([{ id: AGENT_ID }]);
  const insertChain = buildChainableQuery([MOCK_MEMORY_ENTRY]);
  const updateChain = buildChainableQuery([MOCK_MEMORY_ENTRY]);
  const listChain = buildChainableQuery([MOCK_MEMORY_ENTRY]);

  const fakeDb = {
    select: vi.fn().mockImplementation(() => {
      const chain = buildChainableQuery([{ id: AGENT_ID }]);
      return chain;
    }),
    insert: vi.fn().mockImplementation(() => {
      const chain = buildChainableQuery([MOCK_MEMORY_ENTRY]);
      return chain;
    }),
    update: vi.fn().mockImplementation(() => {
      const chain = buildChainableQuery([MOCK_MEMORY_ENTRY]);
      return chain;
    }),
    ...dbOverrides,
  } as any;

  app.use("/api", agentMemoryRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

function boardUser(userId: string, companyIds: string[]) {
  return { type: "board", userId, companyIds, isInstanceAdmin: false, source: "session" };
}

function noActor() {
  return { type: "none" };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("agent memory routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/companies/:companyId/agents/:agentId/memory", () => {
    it("returns memory entries for authorized user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(
        `/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory`,
      );

      expect(res.status).toBe(200);
    });

    it("rejects unauthenticated requests with 401", async () => {
      const app = await createApp(noActor());
      const res = await request(app).get(
        `/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory`,
      );
      expect(res.status).toBe(401);
    });

    it("rejects cross-company access with 403", async () => {
      const otherCompany = randomUUID();
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(
        `/api/companies/${otherCompany}/agents/${AGENT_ID}/memory`,
      );
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/companies/:companyId/agents/:agentId/memory", () => {
    it("creates a memory entry with valid data", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory`)
        .send({
          content: "Learned that deployment requires 2 approvals",
          memoryType: "semantic",
          category: "deployment",
          confidence: 90,
        });

      expect(res.status).toBe(201);
    });

    it("rejects missing content with 400", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory`)
        .send({ memoryType: "semantic" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("content is required");
    });

    it("defaults memoryType to semantic when invalid type given", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory`)
        .send({ content: "test", memoryType: "invalid_type" });

      // Should still succeed (defaults to semantic)
      expect(res.status).toBe(201);
    });
  });

  describe("PATCH /api/companies/:companyId/agents/:agentId/memory/:entryId", () => {
    it("updates a memory entry", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .patch(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory/${ENTRY_ID}`)
        .send({ content: "Updated content", confidence: 95 });

      expect(res.status).toBe(200);
    });
  });

  describe("DELETE /api/companies/:companyId/agents/:agentId/memory/:entryId", () => {
    it("soft-archives a memory entry", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).delete(
        `/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory/${ENTRY_ID}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("POST /api/companies/:companyId/agents/:agentId/memory/:entryId/promote", () => {
    it("promotes memory entry to knowledge page", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).post(
        `/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory/${ENTRY_ID}/promote`,
      );

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("title");
      expect(res.body).toHaveProperty("slug");
    });
  });

  describe("POST /api/companies/:companyId/agents/:agentId/memory/:entryId/share", () => {
    it("shares memory entry with other agents", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory/${ENTRY_ID}/share`)
        .send({ companyWide: true });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body).toHaveProperty("sharedCount");
      expect(res.body.companyWide).toBe(true);
    });
  });
});
