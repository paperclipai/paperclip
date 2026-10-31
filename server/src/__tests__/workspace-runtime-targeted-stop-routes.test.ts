import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selectConfiguredRuntimeServiceRows } from "../services/workspace-runtime-read-model.js";

// A restart or stop that names one service must stop only that service. These
// tests drive the project and execution workspace routes with two configured
// services, both running, and check which runtime service the stop call targets.

vi.mock("../services/authorization.js", async () => ({
  ...(await vi.importActual<typeof import("../services/authorization.js")>("../services/authorization.js")),
  executionWorkspaceReadSqlCondition: async () => sql<boolean>`true`,
  canActorReadExecutionWorkspace: async () => true,
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
}));
const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({
  createRecorder: vi.fn(() => ({
    attachExecutionWorkspaceId: vi.fn(),
    recordOperation: async (input: { run: () => Promise<unknown> }) => {
      await input.run();
      return { id: "operation-1", status: "succeeded" };
    },
  })),
  assertRuntimeControlAvailable: vi.fn(async () => undefined),
  reconcileStaleRuntimeControlOperations: vi.fn(async () => ({ reconciled: 0, operationIds: [] })),
  listForExecutionWorkspace: vi.fn(async () => []),
}));
const mockWorkspaceRuntimeLeaseService = vi.hoisted(() => ({
  claim: vi.fn(async () => null),
  release: vi.fn(async () => ({ released: false, ownerKey: null })),
  get: vi.fn(async () => null),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(async () => ({ allowed: true, action: "runtime:manage", reason: "allow_test", explanation: "" })),
}));
const mockStartRuntimeServices = vi.hoisted(() => vi.fn(async () => []));
const mockStopProjectRuntimeServices = vi.hoisted(() => vi.fn(async () => undefined));
const mockStopExecutionRuntimeServices = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({ getTelemetryClient: vi.fn() }));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => ({ getById: vi.fn(async () => null) }),
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  heartbeatService: () => ({}),
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => ({ normalizeEnvBindingsForPersistence: vi.fn() }),
  workspaceOperationService: () => mockWorkspaceOperationService,
  workspaceRuntimeLeaseService: () => mockWorkspaceRuntimeLeaseService,
  LEASED_WORKSPACE_RUNTIME_ACTIONS: ["start", "stop", "restart", "repair"],
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({ destroyReusableSandboxLeases: vi.fn() }),
}));

vi.mock("../services/workspace-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../services/workspace-runtime.js")>("../services/workspace-runtime.js")),
  ensurePersistedExecutionWorkspaceAvailable: vi.fn(async () => ({ cwd: "/tmp/targeted-stop-workspace" })),
  startRuntimeServicesForWorkspaceControl: mockStartRuntimeServices,
  stopRuntimeServicesForExecutionWorkspace: mockStopExecutionRuntimeServices,
  stopRuntimeServicesForProjectWorkspace: mockStopProjectRuntimeServices,
}));

vi.mock("../routes/workspace-runtime-service-authz.js", () => ({
  assertCanManageProjectWorkspaceRuntimeServices: vi.fn(async () => undefined),
  assertCanManageExecutionWorkspaceRuntimeServices: vi.fn(async () => ({
    actorType: "board",
    agentId: null,
    runId: null,
    issueId: null,
  })),
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const executionWorkspaceId = "33333333-3333-4333-8333-333333333333";

const workspaceRuntime = {
  services: [
    { name: "web", command: "pnpm dev" },
    { name: "worker", command: "pnpm worker" },
  ],
};

function buildRuntimeService(id: string, serviceName: string, command: string) {
  return {
    id,
    serviceName,
    command,
    cwd: "/tmp/targeted-stop-workspace",
    port: null,
    status: "running",
    healthStatus: "healthy",
  };
}

const runningServices = [
  buildRuntimeService("runtime-web", "web", "pnpm dev"),
  buildRuntimeService("runtime-worker", "worker", "pnpm worker"),
];

function buildProjectWorkspace(runtimeServices: unknown[]) {
  return {
    id: workspaceId,
    companyId: "company-1",
    projectId,
    name: "Primary",
    cwd: "/tmp/targeted-stop-workspace",
    repoUrl: null,
    repoRef: null,
    defaultRef: null,
    sharedWorkspaceKey: null,
    runtimeConfig: { workspaceRuntime, desiredState: "running", serviceStates: null },
    runtimeServices,
  };
}

function buildProject(runtimeServices: unknown[]) {
  const workspace = buildProjectWorkspace(runtimeServices);
  return {
    id: projectId,
    companyId: "company-1",
    name: "Project",
    workspaces: [workspace],
    primaryWorkspace: workspace,
  };
}

function buildExecutionWorkspace(runtimeServices: unknown[]) {
  return {
    id: executionWorkspaceId,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Workspace",
    status: "active",
    cwd: "/tmp/targeted-stop-workspace",
    repoUrl: null,
    baseRef: "main",
    branchName: "feature/test",
    providerType: "git_worktree",
    providerRef: null,
    config: { workspaceRuntime },
    metadata: null,
    runtimeServices,
  };
}

const boardActor = {
  type: "board",
  userId: "board-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

async function createApp() {
  const [{ projectRoutes }, { executionWorkspaceRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/projects.js"),
    import("../routes/execution-workspaces.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = boardActor;
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("targeted runtime service stop and restart", () => {
  let app: express.Express;

  // Importing the route modules is slow, so build the app once.
  beforeAll(async () => {
    app = await createApp();
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockStartRuntimeServices.mockResolvedValue([]);
    mockProjectService.updateWorkspace.mockResolvedValue(null);
    mockExecutionWorkspaceService.update.mockResolvedValue({ id: executionWorkspaceId });
  });

  describe("project workspace", () => {
    function useProject(runtimeServices: unknown[]) {
      const project = buildProject(runtimeServices);
      mockProjectService.getById.mockResolvedValue(project);
      mockProjectService.listWorkspaces.mockResolvedValue(project.workspaces);
    }

    const url = `/api/projects/${projectId}/workspaces/${workspaceId}/runtime-services`;

    it("restarts the service at the given index without stopping the other one", async () => {
      useProject(runningServices);
      const res = await request(app).post(`${url}/restart`).send({ serviceIndex: 1 });

      expect(res.status).toBe(200);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledTimes(1);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ projectWorkspaceId: workspaceId, runtimeServiceId: "runtime-worker" }),
      );
      expect(mockStartRuntimeServices).toHaveBeenCalledWith(expect.objectContaining({ serviceIndex: 1 }));
    });

    it("stops only the service at the given index", async () => {
      useProject(runningServices);
      const res = await request(app).post(`${url}/stop`).send({ serviceIndex: 0 });

      expect(res.status).toBe(200);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledTimes(1);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeServiceId: "runtime-web" }),
      );
      expect(res.body.operation).toBeTruthy();
    });

    it("stops nothing when the service at the given index is not running", async () => {
      useProject([runningServices[0]]);
      const res = await request(app).post(`${url}/restart`).send({ serviceIndex: 1 });

      expect(res.status).toBe(200);
      expect(mockStopProjectRuntimeServices).not.toHaveBeenCalled();
      expect(mockStartRuntimeServices).toHaveBeenCalledWith(expect.objectContaining({ serviceIndex: 1 }));
    });

    it("does not stop another running service that only shares the command", async () => {
      const project = buildProject([buildRuntimeService("runtime-api", "api", "node server.js")]);
      project.workspaces[0]!.runtimeConfig.workspaceRuntime = {
        services: [
          { name: "api", command: "node server.js" },
          { name: "admin", command: "node server.js" },
        ],
      } as never;
      mockProjectService.getById.mockResolvedValue(project);
      mockProjectService.listWorkspaces.mockResolvedValue(project.workspaces);
      const res = await request(app).post(`${url}/stop`).send({ serviceIndex: 1 });

      expect(res.status).toBe(200);
      expect(mockStopProjectRuntimeServices).not.toHaveBeenCalled();
    });

    it("stops an unnamed service by its index", async () => {
      const project = buildProject([buildRuntimeService("runtime-dev", "service", "pnpm dev")]);
      project.workspaces[0]!.runtimeConfig.workspaceRuntime = {
        services: [{ command: "pnpm dev" }],
      } as never;
      mockProjectService.getById.mockResolvedValue(project);
      mockProjectService.listWorkspaces.mockResolvedValue(project.workspaces);
      const res = await request(app).post(`${url}/stop`).send({ serviceIndex: 0 });

      expect(res.status).toBe(200);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeServiceId: "runtime-dev" }),
      );
    });

    it("does not stop an unnamed service in a subfolder for an unnamed service at the workspace root", async () => {
      const project = buildProject([
        { ...buildRuntimeService("runtime-api", "service", "node server.js"), cwd: "/tmp/targeted-stop-workspace/api" },
      ]);
      project.workspaces[0]!.runtimeConfig.workspaceRuntime = {
        services: [
          { command: "node server.js", cwd: "api" },
          { command: "node server.js" },
        ],
      } as never;
      mockProjectService.getById.mockResolvedValue(project);
      mockProjectService.listWorkspaces.mockResolvedValue(project.workspaces);
      const res = await request(app).post(`${url}/restart`).send({ serviceIndex: 1 });

      expect(res.status).toBe(200);
      expect(mockStopProjectRuntimeServices).not.toHaveBeenCalled();
    });

    function useProjectWithSharedName(services: unknown[], runtimeServices: unknown[]) {
      const project = buildProject(runtimeServices);
      project.workspaces[0]!.runtimeConfig.workspaceRuntime = { services } as never;
      mockProjectService.getById.mockResolvedValue(project);
      mockProjectService.listWorkspaces.mockResolvedValue(project.workspaces);
    }

    it("tells apart services that share a name by their home-relative cwd", async () => {
      useProjectWithSharedName(
        [
          { name: "web", command: "pnpm dev", cwd: "~/site" },
          { name: "web", command: "pnpm dev", cwd: "~/docs" },
        ],
        [{ ...buildRuntimeService("runtime-site", "web", "pnpm dev"), cwd: path.join(os.homedir(), "site") }],
      );

      const otherRes = await request(app).post(`${url}/stop`).send({ serviceIndex: 1 });
      expect(otherRes.status).toBe(200);
      expect(mockStopProjectRuntimeServices).not.toHaveBeenCalled();

      const res = await request(app).post(`${url}/stop`).send({ serviceIndex: 0 });
      expect(res.status).toBe(200);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeServiceId: "runtime-site" }),
      );
    });

    it("tells apart services that share a name by their templated cwd", async () => {
      useProjectWithSharedName(
        [
          { name: "web", command: "pnpm dev", cwd: "{{workspace.cwd}}/site" },
          { name: "web", command: "pnpm dev", cwd: "{{workspace.cwd}}/docs" },
        ],
        [{ ...buildRuntimeService("runtime-docs", "web", "pnpm dev"), cwd: "/tmp/targeted-stop-workspace/docs" }],
      );

      const otherRes = await request(app).post(`${url}/stop`).send({ serviceIndex: 0 });
      expect(otherRes.status).toBe(200);
      expect(mockStopProjectRuntimeServices).not.toHaveBeenCalled();

      const res = await request(app).post(`${url}/stop`).send({ serviceIndex: 1 });
      expect(res.status).toBe(200);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeServiceId: "runtime-docs" }),
      );
    });

    it("resolves a cwd that uses the assigned port with the running service's port", async () => {
      useProjectWithSharedName(
        [
          { name: "web", command: "pnpm dev", port: { type: "auto" }, cwd: "{{workspace.cwd}}/{{port}}" },
          { name: "web", command: "pnpm dev" },
        ],
        [
          { ...buildRuntimeService("runtime-auto", "web", "pnpm dev"), cwd: "/tmp/targeted-stop-workspace/41234", port: 41234 },
          buildRuntimeService("runtime-root", "web", "pnpm dev"),
        ],
      );

      const res = await request(app).post(`${url}/stop`).send({ serviceIndex: 0 });
      expect(res.status).toBe(200);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledTimes(1);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeServiceId: "runtime-auto" }),
      );

      mockStopProjectRuntimeServices.mockClear();
      const rootRes = await request(app).post(`${url}/stop`).send({ serviceIndex: 1 });
      expect(rootRes.status).toBe(200);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledTimes(1);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeServiceId: "runtime-root" }),
      );
    });

    it("does not stop an instance that another service with the same name could have started", async () => {
      useProjectWithSharedName(
        [
          { name: "web", command: "pnpm dev", port: { type: "auto" }, cwd: "{{workspace.cwd}}/{{port}}", env: { MODE: "a" } },
          { name: "web", command: "pnpm dev", port: { type: "auto" }, cwd: "{{workspace.cwd}}/{{port}}", env: { MODE: "b" } },
        ],
        [{ ...buildRuntimeService("runtime-b", "web", "pnpm dev"), cwd: "/tmp/targeted-stop-workspace/41235", port: 41235 }],
      );

      for (const serviceIndex of [0, 1]) {
        const res = await request(app).post(`${url}/restart`).send({ serviceIndex });
        expect(res.status).toBe(200);
      }
      expect(mockStopProjectRuntimeServices).not.toHaveBeenCalled();
    });

    it("counts only the services still running after a targeted stop", async () => {
      useProject([...runningServices, { ...buildRuntimeService("runtime-old", "old", "pnpm old"), status: "stopped" }]);
      const res = await request(app).post(`${url}/stop`).send({ serviceIndex: 0 });

      expect(res.status).toBe(200);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeServiceId: "runtime-web" }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "project.workspace_runtime_stop",
          details: expect.objectContaining({ runtimeServiceCount: 1 }),
        }),
      );
    });

    it("restarts every service when the request names no target", async () => {
      useProject(runningServices);
      const res = await request(app).post(`${url}/restart`).send({});

      expect(res.status).toBe(200);
      expect(mockStopProjectRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ projectWorkspaceId: workspaceId, runtimeServiceId: null }),
      );
    });
  });

  describe("execution workspace", () => {
    const url = `/api/execution-workspaces/${executionWorkspaceId}/runtime-services`;

    it("restarts the service at the given index without stopping the other one", async () => {
      mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace(runningServices));
      const res = await request(app).post(`${url}/restart`).send({ serviceIndex: 1 });

      expect(res.status).toBe(200);
      expect(mockStopExecutionRuntimeServices).toHaveBeenCalledTimes(1);
      expect(mockStopExecutionRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ executionWorkspaceId, runtimeServiceId: "runtime-worker" }),
      );
      expect(mockStartRuntimeServices).toHaveBeenCalledWith(expect.objectContaining({ serviceIndex: 1 }));
    });

    it("stops only the service at the given index", async () => {
      mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace(runningServices));
      const res = await request(app).post(`${url}/stop`).send({ serviceIndex: 0 });

      expect(res.status).toBe(200);
      expect(mockStopExecutionRuntimeServices).toHaveBeenCalledTimes(1);
      expect(mockStopExecutionRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeServiceId: "runtime-web" }),
      );
    });

    it("stops nothing when the service at the given index is not running", async () => {
      mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace([runningServices[0]]));
      const res = await request(app).post(`${url}/restart`).send({ serviceIndex: 1 });

      expect(res.status).toBe(200);
      expect(mockStopExecutionRuntimeServices).not.toHaveBeenCalled();
      expect(mockStartRuntimeServices).toHaveBeenCalledWith(expect.objectContaining({ serviceIndex: 1 }));
    });

    it("tells apart services that share a name by their home-relative cwd", async () => {
      const workspace = buildExecutionWorkspace([
        { ...buildRuntimeService("runtime-site", "web", "pnpm dev"), cwd: path.join(os.homedir(), "site") },
      ]);
      workspace.config = {
        workspaceRuntime: {
          services: [
            { name: "web", command: "pnpm dev", cwd: "~/site" },
            { name: "web", command: "pnpm dev", cwd: "~/docs" },
          ],
        },
      } as never;
      mockExecutionWorkspaceService.getById.mockResolvedValue(workspace);

      const otherRes = await request(app).post(`${url}/restart`).send({ serviceIndex: 1 });
      expect(otherRes.status).toBe(200);
      expect(mockStopExecutionRuntimeServices).not.toHaveBeenCalled();

      const res = await request(app).post(`${url}/restart`).send({ serviceIndex: 0 });
      expect(res.status).toBe(200);
      expect(mockStopExecutionRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeServiceId: "runtime-site" }),
      );
    });

    it("does not trust the config index the read model infers from a shared command", async () => {
      const sharedCommandRuntime = {
        services: [
          { name: "api", command: "node server.js" },
          { name: "admin", command: "node server.js" },
        ],
      };
      // Only `admin` runs. The read model matches it to `api` by command alone
      // and gives it config index 0.
      const runtimeServices = selectConfiguredRuntimeServiceRows(
        [{
          ...buildRuntimeService("runtime-admin", "admin", "node server.js"),
          scopeType: "project_workspace",
          scopeId: null,
          reuseKey: null,
          projectWorkspaceId: null,
          executionWorkspaceId,
        }] as never,
        sharedCommandRuntime,
      );
      expect(runtimeServices).toEqual([expect.objectContaining({ id: "runtime-admin", configIndex: 0 })]);
      const workspace = buildExecutionWorkspace(runtimeServices);
      workspace.config = { workspaceRuntime: sharedCommandRuntime } as never;
      mockExecutionWorkspaceService.getById.mockResolvedValue(workspace);

      const apiRes = await request(app).post(`${url}/restart`).send({ serviceIndex: 0 });
      expect(apiRes.status).toBe(200);
      expect(mockStopExecutionRuntimeServices).not.toHaveBeenCalled();

      const res = await request(app).post(`${url}/restart`).send({ serviceIndex: 1 });
      expect(res.status).toBe(200);
      expect(mockStopExecutionRuntimeServices).toHaveBeenCalledTimes(1);
      expect(mockStopExecutionRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeServiceId: "runtime-admin" }),
      );
    });

    it("restarts every service when the request names no target", async () => {
      mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace(runningServices));
      const res = await request(app).post(`${url}/restart`).send({});

      expect(res.status).toBe(200);
      expect(mockStopExecutionRuntimeServices).toHaveBeenCalledWith(
        expect.objectContaining({ executionWorkspaceId, runtimeServiceId: null }),
      );
    });
  });
});
