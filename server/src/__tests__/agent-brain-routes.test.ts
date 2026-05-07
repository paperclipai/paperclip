import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

vi.unmock("http");
vi.unmock("node:http");

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentBrainService = vi.hoisted(() => ({
  getManifest: vi.fn(),
  readFile: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentBrainService: () => mockAgentBrainService,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  environmentService: () => ({ getById: vi.fn() }),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(async (_c: string, cfg: Record<string, unknown>) => cfg),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_a, c) => c),
  workspaceOperationService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn((type: string) => ({ type })),
  findActiveServerAdapter: vi.fn(() => null),
  listAdapterModels: vi.fn(),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

function makeAgent() {
  return {
    id: agentId,
    companyId,
    name: "Brainy",
    role: "engineer",
    title: "Brainy",
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: { canCreateAgents: false },
    updatedAt: new Date(),
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function withApp(
  actor: Record<string, unknown>,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const app = await createApp(actor);
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
}

const boardActor = {
  type: "board",
  userId: "local-board",
  companyIds: [companyId],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const otherCompanyAgentActor = {
  type: "agent",
  agentId: "99999999-9999-4999-8999-999999999999",
  companyId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};

describe("agent brain routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentBrainService.getManifest.mockResolvedValue({
      agentId,
      companyId,
      agentHome: "/tmp/agent-home",
      sections: [
        { key: "life", root: "/tmp/agent-home/life", exists: false, isFile: false, files: [] },
        { key: "memory", root: "/tmp/agent-home/memory", exists: true, isFile: false, files: [{ path: "a.md", size: 5, mtime: "2026-05-07T00:00:00.000Z" }] },
        { key: "MEMORY.md", root: "/tmp/agent-home/MEMORY.md", exists: false, isFile: true, files: [] },
      ],
    });
    mockAgentBrainService.readFile.mockResolvedValue({
      section: "memory",
      path: "a.md",
      size: 5,
      mtime: "2026-05-07T00:00:00.000Z",
      content: "alpha",
    });
  });

  it("GET /agents/:id/brain returns the manifest for board callers", async () => {
    const res = await withApp(boardActor, (baseUrl) =>
      request(baseUrl).get(`/api/agents/${agentId}/brain`),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sections.map((s: { key: string }) => s.key)).toEqual(["life", "memory", "MEMORY.md"]);
    expect(mockAgentBrainService.getManifest).toHaveBeenCalledWith(expect.objectContaining({ id: agentId }));
  });

  it("GET /agents/:id/brain returns 404 when the agent does not exist", async () => {
    mockAgentService.getById.mockResolvedValueOnce(null);
    const res = await withApp(boardActor, (baseUrl) =>
      request(baseUrl).get(`/api/agents/${agentId}/brain`),
    );
    expect(res.status).toBe(404);
    expect(mockAgentBrainService.getManifest).not.toHaveBeenCalled();
  });

  it("GET /agents/:id/brain returns 403 when called by an agent from another company", async () => {
    const res = await withApp(otherCompanyAgentActor, (baseUrl) =>
      request(baseUrl).get(`/api/agents/${agentId}/brain`),
    );
    expect(res.status).toBe(403);
    expect(mockAgentBrainService.getManifest).not.toHaveBeenCalled();
  });

  it("GET /agents/:id/brain/file returns 422 when path is missing", async () => {
    mockAgentBrainService.readFile.mockImplementationOnce(async () => {
      throw new HttpError(422, "Query parameter 'path' is required");
    });
    const res = await withApp(boardActor, (baseUrl) =>
      request(baseUrl).get(`/api/agents/${agentId}/brain/file`),
    );
    expect(res.status).toBe(422);
  });

  it("GET /agents/:id/brain/file forwards path query and returns the file detail", async () => {
    const res = await withApp(boardActor, (baseUrl) =>
      request(baseUrl).get(`/api/agents/${agentId}/brain/file?path=memory/a.md`),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.content).toBe("alpha");
    expect(mockAgentBrainService.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: agentId }),
      "memory/a.md",
    );
  });

  it("GET /agents/:id/brain/file returns 403 when called by an agent from another company", async () => {
    const res = await withApp(otherCompanyAgentActor, (baseUrl) =>
      request(baseUrl).get(`/api/agents/${agentId}/brain/file?path=memory/a.md`),
    );
    expect(res.status).toBe(403);
    expect(mockAgentBrainService.readFile).not.toHaveBeenCalled();
  });
});
