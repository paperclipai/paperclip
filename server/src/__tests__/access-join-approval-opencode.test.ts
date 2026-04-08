import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unprocessable } from "../errors.js";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

const mockAccessService = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  canUser: vi.fn(),
  isInstanceAdmin: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
}));

const mockPrepareAdapterConfigForPersistence = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
  deduplicateAgentName: vi.fn((name: string) => name),
  logActivity: mockLogActivity,
  notifyHireApproved: mockNotifyHireApproved,
  prepareAdapterConfigForPersistence: mockPrepareAdapterConfigForPersistence,
  secretService: vi.fn(() => ({
    normalizeAdapterConfigForPersistence: vi.fn(),
    resolveAdapterConfigForRuntime: vi.fn(),
  })),
}));

function createDbStub() {
  const joinRequest = {
    id: "request-1",
    companyId: "company-1",
    inviteId: "invite-1",
    requestType: "agent",
    status: "pending_approval",
    agentName: "OpenCode Agent",
    adapterType: "opencode_local",
    capabilities: null,
    agentDefaultsPayload: {},
    createdAgentId: null,
  };
  const invite = {
    id: "invite-1",
    companyId: "company-1",
    defaultsPayload: null,
  };
  const approved = {
    ...joinRequest,
    status: "approved",
    createdAgentId: "agent-created",
  };

  const selectWhere = vi
    .fn()
    .mockResolvedValueOnce([joinRequest])
    .mockResolvedValueOnce([invite]);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn().mockResolvedValue([approved]);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return { select, update };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(createDbStub() as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("join approval opencode_local validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalGrants.mockResolvedValue(undefined);
    mockAgentService.list.mockResolvedValue([
      { id: "ceo-1", role: "ceo", reportsTo: null, name: "CEO", status: "idle" },
    ]);
    mockAgentService.create.mockResolvedValue({ id: "agent-created" });
    mockPrepareAdapterConfigForPersistence.mockImplementation(async ({ adapterConfig }: { adapterConfig: Record<string, unknown> }) => adapterConfig);
  });

  it("rejects join approval when opencode_local model is missing", async () => {
    mockPrepareAdapterConfigForPersistence.mockRejectedValueOnce(
      unprocessable("OpenCode requires an explicit model in provider/model format."),
    );

    const res = await request(createApp()).post(
      "/api/companies/company-1/join-requests/request-1/approve",
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toContain(
      "OpenCode requires an explicit model in provider/model format.",
    );
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });
});
