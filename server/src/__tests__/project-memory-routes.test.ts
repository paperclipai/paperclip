import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

vi.unmock("http");
vi.unmock("node:http");

const projectId = "44444444-4444-4444-8444-444444444444";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockProjectMemoryService = vi.hoisted(() => ({
  getManifest: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  projectService: () => mockProjectService,
  projectMemoryService: () => mockProjectMemoryService,
  logActivity: vi.fn(),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/workspace-runtime.js", () => ({
  buildWorkspaceRuntimeDesiredStatePatch: vi.fn(),
  listConfiguredRuntimeServiceEntries: vi.fn(),
  runWorkspaceJobForControl: vi.fn(),
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => ({ getById: vi.fn() }),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(async (_c: string, cfg: Record<string, unknown>) => cfg),
    normalizeEnvBindingsForPersistence: vi.fn(async (_c: string, env: unknown) => env),
  }),
}));

function makeProject() {
  return {
    id: projectId,
    companyId,
    name: "Onboarding",
    status: "in_progress",
    codebase: { effectiveLocalFolder: "/Users/me/projects/foo" },
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectRoutes({} as any));
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

describe("project memory routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.getById.mockResolvedValue(makeProject());
    mockProjectMemoryService.getManifest.mockResolvedValue({
      projectId,
      companyId,
      resolvedCwd: "/Users/me/projects/foo",
      slug: "-Users-me-projects-foo",
      root: "/home/.claude/projects/-Users-me-projects-foo/memory",
      exists: true,
      files: [{ path: "MEMORY.md", size: 12, mtime: "2026-05-07T00:00:00.000Z" }],
    });
    mockProjectMemoryService.readFile.mockResolvedValue({
      path: "MEMORY.md",
      size: 12,
      mtime: "2026-05-07T00:00:00.000Z",
      content: "- index entry",
    });
  });

  it("GET /projects/:id/memory returns the manifest for board callers", async () => {
    const res = await withApp(boardActor, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${projectId}/memory`),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(mockProjectMemoryService.getManifest).toHaveBeenCalledWith(expect.objectContaining({ id: projectId }));
  });

  it("GET /projects/:id/memory returns 404 when the project does not exist", async () => {
    mockProjectService.getById.mockResolvedValueOnce(null);
    const res = await withApp(boardActor, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${projectId}/memory`),
    );
    expect(res.status).toBe(404);
    expect(mockProjectMemoryService.getManifest).not.toHaveBeenCalled();
  });

  it("GET /projects/:id/memory returns 403 when called by an agent from another company", async () => {
    const res = await withApp(otherCompanyAgentActor, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${projectId}/memory`),
    );
    expect(res.status).toBe(403);
    expect(mockProjectMemoryService.getManifest).not.toHaveBeenCalled();
  });

  it("GET /projects/:id/memory/file returns 422 when path is missing", async () => {
    mockProjectMemoryService.readFile.mockImplementationOnce(async () => {
      throw new HttpError(422, "Query parameter 'path' is required");
    });
    const res = await withApp(boardActor, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${projectId}/memory/file`),
    );
    expect(res.status).toBe(422);
  });

  it("GET /projects/:id/memory/file forwards the path query", async () => {
    const res = await withApp(boardActor, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${projectId}/memory/file?path=MEMORY.md`),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.content).toBe("- index entry");
    expect(mockProjectMemoryService.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: projectId }),
      "MEMORY.md",
    );
  });

  it("GET /projects/:id/memory/file returns 403 when called by an agent from another company", async () => {
    const res = await withApp(otherCompanyAgentActor, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${projectId}/memory/file?path=MEMORY.md`),
    );
    expect(res.status).toBe(403);
    expect(mockProjectMemoryService.readFile).not.toHaveBeenCalled();
  });
});
