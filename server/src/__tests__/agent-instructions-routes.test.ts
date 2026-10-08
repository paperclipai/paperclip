import express from "express";
import request from "supertest";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockBuiltInAgentService = vi.hoisted(() => ({
  ensureCompanyDefaultAgentGrants: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockInstructionWorkingCopies = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn(), acknowledgeExplicitSave: vi.fn() }));
vi.mock("../services/agent-instruction-working-copies.js", () => ({ agentInstructionWorkingCopyService: () => mockInstructionWorkingCopies }));

const mockDownloadAgentFile = vi.hoisted(() => vi.fn());
vi.mock("../services/agent-file-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-file-store.js")>();
  return { ...actual, agentFileStore: (...args: Parameters<typeof actual.agentFileStore>) => ({ ...actual.agentFileStore(...args), download: mockDownloadAgentFile }) };
});

const mockInstructionRevisions = vi.hoisted(() => ({ readCurrent: vi.fn(), commit: vi.fn(), restore: vi.fn(), history: vi.fn(), readRevision: vi.fn(), diff: vi.fn(), materializeCurrent: vi.fn() }));
vi.mock("../services/agent-instruction-revisions.js", () => ({ agentInstructionRevisionService: () => mockInstructionRevisions }));

const mockAuthorizeInstructionRead = vi.hoisted(() => vi.fn());
vi.mock("../services/agent-instruction-authorization.js", () => ({ authorizeInstructionRead: mockAuthorizeInstructionRead }));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => mockBuiltInAgentService,
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  environmentService: () => mockEnvironmentService,
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  findActiveServerAdapter: mockFindServerAdapter,
  listAdapterModels: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    builtInAgentService: () => mockBuiltInAgentService,
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: mockFindServerAdapter,
    findActiveServerAdapter: mockFindServerAdapter,
    listAdapterModels: vi.fn(),
  }));
}

function boardActor() {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

async function createApp(actor: Record<string, unknown> = boardActor(), db: Record<string, unknown> = {}) {
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
  app.use("/api", agentRoutes(db as any));
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

function makeAgent() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
  };
}

function makeReflectionCoachAgent(overrides: Record<string, unknown> = {}) {
  return {
    ...makeAgent(),
    id: "22222222-2222-4222-8222-222222222222",
    name: "Reflection Coach",
    metadata: {
      paperclipBuiltInAgent: {
        key: "reflection-coach",
        featureKeys: ["reflection-coach"],
      },
    },
    ...overrides,
  };
}

describe("agent instructions bundle routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAuthorizeInstructionRead.mockImplementation(async (_db, actor) => actor);
    mockInstructionRevisions.readCurrent.mockResolvedValue(null);
    mockInstructionRevisions.commit.mockResolvedValue({ revision: { id: "33333333-3333-4333-8333-333333333333", entryFile: "AGENTS.md", byteLength: 18 }, content: "# Updated Agent\n", changed: true, materialization: "current" });
    mockBuiltInAgentService.ensureCompanyDefaultAgentGrants.mockResolvedValue(0);
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockFindServerAdapter.mockImplementation((_type: string) => ({ type: _type }));
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent(),
      adapterConfig: patch.adapterConfig ?? {},
    }));
    mockAgentInstructionsService.getBundle.mockResolvedValue({
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
      resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
      editable: true,
      warnings: [],
      legacyPromptTemplateActive: false,
      legacyBootstrapPromptTemplateActive: false,
      files: [{
        path: "AGENTS.md",
        size: 12,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
      }],
    });
    mockAgentInstructionsService.readFile.mockResolvedValue({
      path: "AGENTS.md",
      size: 12,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      editable: true,
      deprecated: false,
      virtual: false,
      content: "# Agent\n",
    });
    mockAgentInstructionsService.writeFile.mockResolvedValue({
      bundle: null,
      file: {
        path: "AGENTS.md",
        size: 18,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
        content: "# Updated Agent\n",
      },
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
      },
    });
    // Cold route compilation belongs to fixture setup. Timing it as a request
    // let a timed-out import resume under the next case's reset mocks.
    await Promise.all([
      vi.importActual("../routes/agents.js"),
      vi.importActual("../middleware/index.js"),
    ]);
  }, 60_000);

  it("returns bundle metadata", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
    });
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
    expect(mockAuthorizeInstructionRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "board" }),
      expect.objectContaining({ companyId: "company-1", id: "11111111-1111-4111-8111-111111111111" }));
  });

  it("requires instance-admin access for every external instruction entry point", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/paperclip/external-agent",
        instructionsEntryFile: "AGENTS.md",
      },
    });
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });
    const requests = [
      () => request(app).get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
      () => request(app)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle")
        .send({ entryFile: "AGENTS.md" }),
      () => request(app)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .query({ path: "AGENTS.md" }),
      () => request(app)
        .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .send({ path: "AGENTS.md", content: "# changed" }),
      () => request(app)
        .delete("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .query({ path: "AGENTS.md" }),
    ];

    for (const perform of requests) {
      const res = await perform();
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("Instance admin");
    }
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.updateBundle).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.deleteFile).not.toHaveBeenCalled();
    expect(mockAuthorizeInstructionRead).not.toHaveBeenCalled();
  });

  it("treats a host root mislabeled as managed as external", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/private/host/instructions",
        instructionsEntryFile: "AGENTS.md",
      },
    });
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle");

    expect(res.status).toBe(403);
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
  });

  it("allows an instance admin to read an external instruction bundle", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/paperclip/external-agent",
        instructionsEntryFile: "AGENTS.md",
      },
    });

    const res = await requestApp(
      await createApp({
        type: "board",
        userId: "instance-admin",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
        source: "session",
        isInstanceAdmin: true,
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
    expect(mockAuthorizeInstructionRead).not.toHaveBeenCalled();
  });

  it("rejects a company admin that requests a new external instruction root", async () => {
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => ({
      ...config,
      instructionsBundleMode: "external",
      instructionsRootPath: "/srv/paperclip/external-agent",
      instructionsEntryFile: "AGENTS.md",
    }));
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });

    const compatibilityRes = await request(app)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-path")
      .send({ path: "/srv/paperclip/external-agent/AGENTS.md" });
    expect(compatibilityRes.status, JSON.stringify(compatibilityRes.body)).toBe(403);

    const bundleRes = await request(app)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle")
      .send({ mode: "external", rootPath: "/srv/paperclip/external-agent" });
    expect(bundleRes.status, JSON.stringify(bundleRes.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.updateBundle).not.toHaveBeenCalled();
  });

  it("rejects external instruction roots through the generic agent patch", async () => {
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: {
          instructionsBundleMode: "external",
          instructionsRootPath: "/srv/paperclip/external-agent",
          instructionsEntryFile: "AGENTS.md",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects external instruction roots during both hire and direct creation", async () => {
    const actor = {
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{
            id: "company-1",
            requireBoardApprovalForNewAgents: false,
          }]),
        })),
      })),
    };
    const app = await createApp(actor, db);
    const body = {
      name: "External agent",
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/paperclip/external-agent",
        instructionsEntryFile: "AGENTS.md",
      },
    };

    const hireRes = await request(app)
      .post("/api/companies/company-1/agent-hires")
      .send(body);
    expect(hireRes.status, JSON.stringify(hireRes.body)).toBe(403);
    expect(hireRes.body.error).toContain("Instance admin");

    const createRes = await request(app)
      .post("/api/companies/company-1/agents")
      .send(body);
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(403);
    expect(createRes.body.error).toContain("Instance admin");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it.each(["", "/file?path=AGENTS.md", "/file?path=private-support.md"])(
    "denies peer instruction reads before any data dispatch: %s", async (suffix) => {
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-reader") {
        return {
          ...makeAgent(),
          id: "agent-reader",
          name: "Reader",
          permissions: { canCreateAgents: false },
        };
      }
      return makeAgent();
    });
    // General agent visibility is allowed. It must not authorize instruction
    // metadata, canonical entry bytes, or supporting files from a peer.
    const { forbidden } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockAuthorizeInstructionRead.mockRejectedValue(forbidden("Missing permission to read peer instructions"));

    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "agent-reader",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get(`/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle${suffix}`),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Missing permission");
    expect(mockAuthorizeInstructionRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "agent", agentId: "agent-reader",
    }), { companyId: "company-1", id: "11111111-1111-4111-8111-111111111111" });
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
    expect(mockInstructionRevisions.readCurrent).not.toHaveBeenCalled();
    expect(mockInstructionRevisions.materializeCurrent).not.toHaveBeenCalled();
  });

  it("allows agents to read their own instructions bundles", async () => {
    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
    expect(mockAuthorizeInstructionRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "agent", agentId: "11111111-1111-4111-8111-111111111111",
    }), { companyId: "company-1", id: "11111111-1111-4111-8111-111111111111" });
  });

  it.each(["AGENTS.md", "private-support.md"])("allows an authorized peer to read instruction file %s", async (filePath) => {
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by explicit grant agents:suggest-changes.",
      grant: {
        principalType: "agent",
        principalId: "coach-agent",
        permissionKey: "agents:suggest-changes",
        scope: null,
      },
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "coach-agent") {
        return makeReflectionCoachAgent({ id: "coach-agent" });
      }
      return makeAgent();
    });

    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "coach-agent",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .query({ path: filePath }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAuthorizeInstructionRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "agent", agentId: "coach-agent",
    }), { companyId: "company-1", id: "11111111-1111-4111-8111-111111111111" });
    expect(mockAgentInstructionsService.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      filePath,
    );
  });

  it("commits entry bytes through the canonical service with the authenticated actor", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1")
      .send({ path: "AGENTS.md", content: "# Updated Agent\n", baseRevisionId: null }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockInstructionRevisions.commit).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "11111111-1111-4111-8111-111111111111", entryFile: "AGENTS.md", content: "# Updated Agent\n", baseRevisionId: null, source: "board",
    }), expect.objectContaining({ type: "board" }));
    expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
    expect(res.body.receipt.revision.id).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("returns committed entry content independently of its disk copy", async () => {
    mockInstructionRevisions.readCurrent.mockResolvedValue({ revision: { id: "33333333-3333-4333-8333-333333333333", entryFile: "AGENTS.md", byteLength: 9 }, content: "committed" });
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?path=AGENTS.md"));
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("committed");
    expect(res.body.revision.id).toBe("33333333-3333-4333-8333-333333333333");
    expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
  });

  it.each([Buffer.from([0, 255, 128, 17]), Buffer.alloc(0)])("streams an authorized binary download without text conversion (%j)", async bytes => {
    mockAgentService.getById.mockResolvedValue({ ...makeAgent(), adapterConfig: { instructionsBundleMode: "managed" } });
    mockDownloadAgentFile.mockResolvedValue({ size: bytes.length, stream: Readable.from(bytes.length ? [bytes] : []) });
    const res = await requestApp(await createApp(), url => request(url)
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
      .query({ path: "notes/data.bin", download: "true" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(bytes);
    expect(res.headers["content-length"]).toBe(String(bytes.length));
    expect(res.headers["content-disposition"]).toContain('filename="data.bin"');
    expect(mockDownloadAgentFile).toHaveBeenCalledWith("company-1", "11111111-1111-4111-8111-111111111111", "notes/data.bin", expect.objectContaining({ type: "board" }));
    expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
  });

  it("lists and resolves preserved edits with server scope, actor, and explicit revision", async () => {
    const app = await createApp();
    const runId = "55555555-5555-4555-8555-555555555555";
    const baseRevisionId = "44444444-4444-4444-8444-444444444444";
    const prefix = "/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/candidates";
    mockInstructionWorkingCopies.list.mockResolvedValue([{ runId, entryFile: "AGENTS.md", state: "conflict", content: "preserved" }]);
    mockInstructionWorkingCopies.resolve.mockResolvedValue({ revision: { id: baseRevisionId, entryFile: "AGENTS.md", byteLength: 8 }, content: "resolved", changed: true, materialization: "current" });
    const listed = await requestApp(app, (url) => request(url).get(prefix));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([{ runId, entryFile: "AGENTS.md", state: "conflict", content: "preserved" }]);
    expect(mockInstructionWorkingCopies.list).toHaveBeenCalledWith("company-1", "11111111-1111-4111-8111-111111111111", expect.objectContaining({ type: "board", userId: "local-board" }));
    const resolved = await requestApp(app, (url) => request(url).post(`${prefix}/${runId}/resolve`).send({ baseRevisionId, content: "resolved" }));
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ content: "resolved", receipt: { changed: true } });
    expect(mockInstructionWorkingCopies.resolve).toHaveBeenCalledWith({ companyId: "company-1", agentId: "11111111-1111-4111-8111-111111111111", runId, baseRevisionId, content: "resolved" }, expect.objectContaining({ type: "board", userId: "local-board" }));
    for (const body of [{ content: "missing base" }, { baseRevisionId, content: "forged", responsibleUserId: "other" }, { baseRevisionId, content: "forged", entryFile: "other.md" }]) {
      expect((await requestApp(app, (url) => request(url).post(`${prefix}/${runId}/resolve`).send(body))).status).toBe(400);
    }
    expect(mockInstructionWorkingCopies.resolve).toHaveBeenCalledOnce();
  });

  it("exposes scoped history, diff and restore with the server actor", async () => {
    const app = await createApp();
    const revisionId = "33333333-3333-4333-8333-333333333333";
    const baseRevisionId = "44444444-4444-4444-8444-444444444444";
    const prefix = "/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle";
    mockInstructionRevisions.history.mockResolvedValue({ revisions: [], nextCursor: null });
    mockInstructionRevisions.diff.mockResolvedValue({ removed: "old", added: "new" });
    mockInstructionRevisions.restore.mockResolvedValue({ revision: { id: revisionId, entryFile: "AGENTS.md", byteLength: 3 }, content: "old", changed: true, materialization: "current" });
    expect((await requestApp(app, (url) => request(url).get(`${prefix}/history?path=AGENTS.md`))).status).toBe(200);
    expect((await requestApp(app, (url) => request(url).get(`${prefix}/diff?path=AGENTS.md&from=${revisionId}&to=${baseRevisionId}`))).status).toBe(200);
    const restored = await requestApp(app, (url) => request(url).post(`${prefix}/restore`).send({ path: "AGENTS.md", revisionId, baseRevisionId }));
    expect(restored.status).toBe(200);
    expect(restored.body.receipt.changed).toBe(true);
    expect(mockInstructionRevisions.restore).toHaveBeenCalledWith({ companyId: "company-1", agentId: "11111111-1111-4111-8111-111111111111", entryFile: "AGENTS.md", revisionId, baseRevisionId }, expect.objectContaining({ type: "board", userId: "local-board" }));
  });

  it("requires a base revision and rejects client-supplied responsible identity", async () => {
    const app = await createApp();
    for (const body of [ { path: "AGENTS.md", content: "stale" }, { path: "AGENTS.md", content: "forged", baseRevisionId: null, responsibleUserId: "forged" } ]) {
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file").send(body));
      expect([400, 422]).toContain(res.status);
    }
    expect(mockInstructionRevisions.commit).not.toHaveBeenCalled();
  });

  it("preserves managed instructions config when switching adapters", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-sonnet-4",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterType: "claude_local",
        adapterConfig: expect.objectContaining({
          model: "claude-sonnet-4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("preserves paperclip skill-sync selections when switching adapters", async () => {
    // Desired skills live inside the per-adapter config under
    // `paperclipSkillSync`, yet they are adapter-agnostic company-level
    // selections. Switching adapter type must not silently wipe them — the
    // server carries them over from the existing config the same way it
    // preserves env/cwd and the instructions bundle.
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-sonnet-4",
        paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterType: "codex_local",
        replaceAdapterConfig: true,
        adapterConfig: {
          model: "gpt-5.4",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterType: "codex_local",
        adapterConfig: expect.objectContaining({
          model: "gpt-5.4",
          paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
        }),
      }),
      expect.any(Object),
    );
  });

  it("merges same-adapter config patches so instructions metadata is not dropped", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterConfig: {
          command: "codex --profile engineer",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          command: "codex --profile engineer",
          model: "gpt-5.4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("replaces adapter config when replaceAdapterConfig is true", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        replaceAdapterConfig: true,
        adapterConfig: {
          command: "codex --profile engineer",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.adapterConfig).toMatchObject({
      command: "codex --profile engineer",
    });
    expect(res.body.adapterConfig.instructionsBundleMode).toBeUndefined();
    expect(res.body.adapterConfig.instructionsRootPath).toBeUndefined();
    expect(res.body.adapterConfig.instructionsEntryFile).toBeUndefined();
    expect(res.body.adapterConfig.instructionsFilePath).toBeUndefined();
  });
});
