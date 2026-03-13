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
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue([{ cwd: projectPrimaryWorkspaceCwd }]),
        })),
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
});
