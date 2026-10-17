import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => ({}),
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => ({}),
  workspaceOperationService: () => ({}),
}));
vi.mock("../services/environments.js", () => ({ environmentService: () => ({}) }));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({}) }));
vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: vi.fn() }));

const { projectRoutes } = await import("../routes/projects.js");
const { errorHandler } = await import("../middleware/index.js");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    companyId: "company-1",
    urlKey: "project-1",
    defaultExecutionPolicy: null,
    workspaces: [],
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
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

describe("GET /projects/:id/default-execution-policy authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.getById.mockResolvedValue(buildProject());
  });

  it("denies a same-company agent whose project:read is scoped out", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "project:read",
      reason: "deny_low_trust_boundary",
      explanation: "Project is outside this low-trust boundary.",
    });
    const app = createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1" });

    const res = await request(app).get(`/api/projects/${PROJECT_ID}/default-execution-policy`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Project not found");
  });

  it("returns the policy for an actor whose project:read is allowed", async () => {
    mockProjectService.getById.mockResolvedValue(
      buildProject({
        defaultExecutionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              type: "approval",
              approvalsNeeded: 1,
              participants: [
                { id: "33333333-3333-4333-8333-333333333333", type: "user", userId: "reviewer-1" },
              ],
            },
          ],
        },
      }),
    );
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_company_agent",
      explanation: "Allowed by default same-company agent visibility.",
    });
    const app = createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1" });

    const res = await request(app).get(`/api/projects/${PROJECT_ID}/default-execution-policy`);

    expect(res.status).toBe(200);
    expect(res.body.defaultExecutionPolicy.stages[0].participants[0]).toMatchObject({
      type: "user",
      userId: "reviewer-1",
    });
  });

  it("redacts the monitor externalRef on the stored policy", async () => {
    mockProjectService.getById.mockResolvedValue(
      buildProject({
        defaultExecutionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: {
            nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
            kind: "external_service",
            serviceName: "github",
            externalRef: "https://example.com/webhook?token=super-secret",
          },
        },
      }),
    );
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_company_agent",
      explanation: "Allowed by default same-company agent visibility.",
    });
    const app = createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1" });

    const res = await request(app).get(`/api/projects/${PROJECT_ID}/default-execution-policy`);

    expect(res.status).toBe(200);
    expect(res.body.defaultExecutionPolicy.monitor.externalRef).toBe("[redacted]");
  });
});

describe("PUT /projects/:id/default-execution-policy authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.getById.mockResolvedValue(buildProject());
  });

  it("denies a board actor with company access but no project:read on a private project, before the board-actor write check runs", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "project:read",
      reason: "deny_low_trust_boundary",
      explanation: "Project is outside this low-trust boundary.",
    });
    const app = createApp({ type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true });

    const res = await request(app)
      .put(`/api/projects/${PROJECT_ID}/default-execution-policy`)
      .send({ defaultExecutionPolicy: null });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Project not found");
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("denies a non-board actor whose project:read is allowed", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_company_agent",
      explanation: "Allowed by default same-company agent visibility.",
    });
    const app = createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1" });

    const res = await request(app)
      .put(`/api/projects/${PROJECT_ID}/default-execution-policy`)
      .send({ defaultExecutionPolicy: null });

    expect(res.status).toBe(403);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("writes the policy for a board actor whose project:read is allowed", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_company_agent",
      explanation: "Allowed by default same-company agent visibility.",
    });
    const policyWithStage = {
      mode: "normal" as const,
      commentRequired: true,
      stages: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "approval" as const,
          approvalsNeeded: 1 as const,
          participants: [
            { id: "33333333-3333-4333-8333-333333333333", type: "user" as const, userId: "reviewer-1" },
          ],
        },
      ],
    };
    mockProjectService.update.mockResolvedValue(
      buildProject({ defaultExecutionPolicy: policyWithStage }),
    );
    const app = createApp({ type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true });

    const res = await request(app)
      .put(`/api/projects/${PROJECT_ID}/default-execution-policy`)
      .send({ defaultExecutionPolicy: policyWithStage });

    expect(res.status).toBe(200);
    expect(res.body.defaultExecutionPolicy.stages[0].participants[0]).toMatchObject({
      type: "user",
      userId: "reviewer-1",
    });
    expect(mockProjectService.update).toHaveBeenCalledTimes(1);
  });

  it("redacts the monitor externalRef in its own write response", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_company_agent",
      explanation: "Allowed by default same-company agent visibility.",
    });
    const policyWithMonitor = {
      mode: "normal" as const,
      commentRequired: true,
      stages: [],
      monitor: {
        nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
        kind: "external_service" as const,
        serviceName: "github",
        externalRef: "https://example.com/webhook?token=super-secret",
      },
    };
    mockProjectService.update.mockResolvedValue(
      buildProject({ defaultExecutionPolicy: policyWithMonitor }),
    );
    const app = createApp({ type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true });

    const res = await request(app)
      .put(`/api/projects/${PROJECT_ID}/default-execution-policy`)
      .send({ defaultExecutionPolicy: policyWithMonitor });

    expect(res.status).toBe(200);
    expect(res.body.defaultExecutionPolicy.monitor.externalRef).toBe("[redacted]");
  });
});
