import express from "express";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { agentRoutes } from "../routes/agents.js";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  getChainOfCommand: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
  listConfigRevisions: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  update: vi.fn(),
  listTaskSessions: vi.fn(),
  getRuntimeState: vi.fn(),
  resetRuntimeSession: vi.fn(),
  orgForCompany: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockApprovalsService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRuntimeState: vi.fn(),
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalsService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  secretService: () => mockSecretService,
  logActivity: mockLogActivity,
}));

function createDbStub(projectPrimaryWorkspaceCwd: string) {
  return createQueuedDbStub([
    [{ projectId: "11111111-1111-4111-8111-111111111111", cwd: projectPrimaryWorkspaceCwd }],
  ]);
}

function createQueuedDbStub(results: unknown[][]) {
  const queue = [...results];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const nextResult = queue.shift() ?? [];
          const query = {
            orderBy: vi.fn().mockResolvedValue(nextResult),
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(nextResult)),
          };
          return query;
        }),
      })),
    })),
  };
}

function createApp(db: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/agents workspace normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockLogActivity.mockResolvedValue(undefined);
    mockAgentService.create.mockImplementation(async (_companyId, payload) => ({
      id: "agent-1",
      companyId: "company-1",
      ...payload,
    }));
  });

  it("prefers the project primary workspace over a wrapper cwd during agent creation", async () => {
    const wrapperWorkspaceCwd = path.resolve(
      resolvePaperclipInstanceRoot(),
      "workspaces",
      "wrapper-workspace",
    );
    const projectPrimaryWorkspaceCwd = "/Users/test/code/polybot";
    const app = createApp(createDbStub(projectPrimaryWorkspaceCwd));

    const res = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "CTO",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {
          cwd: wrapperWorkspaceCwd,
          instructionsFilePath: "agents/founding-engineer/AGENTS.md",
        },
      });

    expect(res.status).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          cwd: projectPrimaryWorkspaceCwd,
          instructionsFilePath: path.resolve(
            wrapperWorkspaceCwd,
            "agents/founding-engineer/AGENTS.md",
          ),
        }),
      }),
    );
  });

  it("does not rewrite wrapper cwd during agent creation when the company has multiple project primaries", async () => {
    const wrapperWorkspaceCwd = path.resolve(
      resolvePaperclipInstanceRoot(),
      "workspaces",
      "wrapper-workspace",
    );
    const app = createApp(
      createQueuedDbStub([
        [
          { projectId: "11111111-1111-4111-8111-111111111111", cwd: "/Users/test/code/alpha" },
          { projectId: "22222222-2222-4222-8222-222222222222", cwd: "/Users/test/code/beta" },
        ],
      ]),
    );

    const res = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "CTO",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {
          cwd: wrapperWorkspaceCwd,
        },
      });

    expect(res.status).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          cwd: wrapperWorkspaceCwd,
        }),
      }),
    );
  });

  it("does not rewrite wrapper cwd when another primary project is repo-only", async () => {
    const wrapperWorkspaceCwd = path.resolve(
      resolvePaperclipInstanceRoot(),
      "workspaces",
      "wrapper-workspace",
    );
    const app = createApp(
      createQueuedDbStub([
        [
          { projectId: "11111111-1111-4111-8111-111111111111", cwd: "/Users/test/code/alpha" },
          { projectId: "22222222-2222-4222-8222-222222222222", cwd: "/__paperclip_repo_only__" },
        ],
      ]),
    );

    const res = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "CTO",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {
          cwd: wrapperWorkspaceCwd,
        },
      });

    expect(res.status).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          cwd: wrapperWorkspaceCwd,
        }),
      }),
    );
  });

  it("uses the source issue project primary workspace during agent hire", async () => {
    const wrapperWorkspaceCwd = path.resolve(
      resolvePaperclipInstanceRoot(),
      "workspaces",
      "wrapper-workspace",
    );
    const projectPrimaryWorkspaceCwd = "/Users/test/code/polybot-beta";
    const app = createApp(
      createQueuedDbStub([
        [{ projectId: "22222222-2222-4222-8222-222222222222" }],
        [{ cwd: projectPrimaryWorkspaceCwd }],
        [{ id: "company-1", requireBoardApprovalForNewAgents: false }],
      ]),
    );

    const res = await request(app)
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "CTO",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {
          cwd: wrapperWorkspaceCwd,
        },
        sourceIssueIds: ["33333333-3333-4333-8333-333333333333"],
      });

    expect(res.status).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          cwd: projectPrimaryWorkspaceCwd,
        }),
      }),
    );
  });

  it("keeps update normalization pinned to the agent's existing project workspace", async () => {
    const wrapperWorkspaceCwd = path.resolve(
      resolvePaperclipInstanceRoot(),
      "workspaces",
      "wrapper-workspace",
    );
    mockAgentService.getById.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      companyId: "company-1",
      name: "CTO",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        cwd: "/Users/test/code/project-beta",
      },
    });
    mockAgentService.update.mockImplementation(async (_id, patch) => ({
      id: "44444444-4444-4444-8444-444444444444",
      companyId: "company-1",
      ...patch,
    }));
    const app = createApp(
      createQueuedDbStub([
        [{ projectId: "22222222-2222-4222-8222-222222222222" }],
        [{ cwd: "/Users/test/code/project-beta" }],
      ]),
    );

    const res = await request(app)
      .patch("/api/agents/44444444-4444-4444-8444-444444444444")
      .send({
        adapterConfig: {
          cwd: wrapperWorkspaceCwd,
        },
      });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          cwd: "/Users/test/code/project-beta",
        }),
      }),
      expect.anything(),
    );
  });
});
