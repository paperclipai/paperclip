import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const inviteId = "33333333-3333-4333-8333-333333333333";
const joinRequestId = "44444444-4444-4444-8444-444444444444";
const agentId = "55555555-5555-4555-8555-555555555555";
const missingAdapterType = "invite_missing_adapter_validation_test";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  const adaptersIndexMock = async () => {
    const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
      "../adapters/index.ts",
    );
    return {
      ...actual,
      findServerAdapter: (type: string) =>
        type === missingAdapterType ? null : actual.findServerAdapter(type),
    };
  };
  vi.doMock("../adapters/index.js", adaptersIndexMock);
  vi.doMock("../adapters/index.ts", adaptersIndexMock);
  vi.doMock("../routes/access.js", async () =>
    vi.importActual<typeof import("../routes/access.ts")>("../routes/access.ts"),
  );
  vi.doMock("../routes/access.ts", async () =>
    vi.importActual<typeof import("../routes/access.ts")>("../routes/access.ts"),
  );
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../middleware/index.js", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/index.ts", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/validate.ts", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => ({}),
    deduplicateAgentName: (candidate: string) => candidate,
    logActivity: mockLogActivity,
    notifyHireApproved: mockNotifyHireApproved,
  }));
  vi.doMock("../services/index.ts", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => ({}),
    deduplicateAgentName: (candidate: string) => candidate,
    logActivity: mockLogActivity,
    notifyHireApproved: mockNotifyHireApproved,
  }));
}

type Row = Record<string, unknown>;

function thenableRows(rows: Row[]) {
  return {
    then: (resolve: (rows: Row[]) => unknown) => Promise.resolve(resolve(rows)),
  };
}

function updateBuilder(rows: Row[]) {
  return {
    set: () => ({
      where: () => ({
        returning: () => thenableRows(rows),
      }),
    }),
  };
}

function insertBuilder(rows: Row[]) {
  return {
    values: () => ({
      returning: () => thenableRows(rows),
    }),
  };
}

function createDbStub(input: {
  selectRows?: Row[][];
  insertRows?: Row[][];
  updateRows?: Row[][];
}) {
  const selectRows = [...(input.selectRows ?? [])];
  const insertRows = [...(input.insertRows ?? [])];
  const updateRows = [...(input.updateRows ?? [])];
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => thenableRows(selectRows.shift() ?? []),
      }),
    })),
    update: vi.fn(() => updateBuilder(updateRows.shift() ?? [])),
    insert: vi.fn(() => insertBuilder(insertRows.shift() ?? [])),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return db;
}

function baseInvite(overrides: Row = {}) {
  return {
    id: inviteId,
    companyId,
    inviteType: "company_join",
    allowedJoinTypes: "agent",
    defaultsPayload: null,
    tokenHash: "hash",
    acceptedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

function baseJoinRequest(overrides: Row = {}) {
  return {
    id: joinRequestId,
    inviteId,
    companyId,
    requestType: "agent",
    status: "pending_approval",
    requestIp: "127.0.0.1",
    requestingUserId: null,
    requestEmailSnapshot: null,
    agentName: "Joiner",
    adapterType: "codex_local",
    capabilities: null,
    agentDefaultsPayload: null,
    claimSecretHash: "hash",
    claimSecretExpiresAt: new Date(Date.now() + 60_000),
    createdAgentId: null,
    approvedByUserId: null,
    approvedAt: null,
    rejectedByUserId: null,
    rejectedAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

let accessRouteImportSeq = 0;

async function createApp(db: unknown) {
  vi.resetModules();
  vi.doUnmock("@paperclipai/db");
  vi.doUnmock("@paperclipai/shared");
  vi.doUnmock("../adapters/index.js");
  vi.doUnmock("../adapters/index.ts");
  vi.doUnmock("../routes/access.js");
  vi.doUnmock("../routes/access.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../middleware/validate.ts");
  vi.doUnmock("../middleware/logger.js");
  vi.doUnmock("../middleware/logger.ts");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
  registerModuleMocks();
  accessRouteImportSeq += 1;
  const routeModulePath = `../routes/access.ts?invite-adapter-validation-routes-${accessRouteImportSeq}`;
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/access.ts")>,
    import("../middleware/index.ts"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      companyIds: [companyId],
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", accessRoutes(db as never, {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use(errorHandler);
  return app;
}

describe("invite adapter validation routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/db");
    vi.doUnmock("@paperclipai/shared");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../adapters/index.ts");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../routes/access.ts");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/authz.ts");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/index.ts");
    vi.doUnmock("../middleware/validate.js");
    vi.doUnmock("../middleware/validate.ts");
    vi.doUnmock("../middleware/logger.js");
    vi.doUnmock("../middleware/logger.ts");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/index.ts");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalGrants.mockResolvedValue(undefined);
    mockAgentService.list.mockResolvedValue([{
      id: "ceo-1",
      name: "CEO",
      role: "ceo",
      status: "idle",
    }]);
    mockAgentService.create.mockResolvedValue({ id: agentId });
    mockNotifyHireApproved.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("accepts an agent invite with a known local adapter", async () => {
    const db = createDbStub({
      selectRows: [[baseInvite()], [{ name: "Paperclip" }]],
      insertRows: [[baseJoinRequest({ adapterType: "codex_local" })]],
    });

    const res = await request(await createApp(db))
      .post("/api/invites/pcp_invite_known/accept")
      .send({
        requestType: "agent",
        agentName: "Joiner",
        adapterType: "codex_local",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.adapterType).toBe("codex_local");
    expect(db.transaction).toHaveBeenCalled();
  });

  it("rejects an agent invite with an unknown adapter", async () => {
    const db = createDbStub({
      selectRows: [[baseInvite()]],
    });

    const res = await request(await createApp(db))
      .post("/api/invites/pcp_invite_unknown/accept")
      .send({
        requestType: "agent",
        agentName: "Joiner",
        adapterType: missingAdapterType,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(String(res.body.error ?? "")).toContain(`Unknown adapter type: ${missingAdapterType}`);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("preserves openclaw_gateway invite acceptance", async () => {
    const defaults = {
      url: "ws://localhost:4317",
      headers: { "x-openclaw-token": "1234567890123456" },
      disableDeviceAuth: true,
    };
    const db = createDbStub({
      selectRows: [[baseInvite()], [{ name: "Paperclip" }]],
      insertRows: [[baseJoinRequest({
        adapterType: "openclaw_gateway",
        agentDefaultsPayload: defaults,
      })]],
    });

    const res = await request(await createApp(db))
      .post("/api/invites/pcp_invite_openclaw/accept")
      .send({
        requestType: "agent",
        agentName: "Gateway",
        adapterType: "openclaw_gateway",
        agentDefaultsPayload: defaults,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.adapterType).toBe("openclaw_gateway");
  });

  it("creates an agent from an approved known-adapter join request", async () => {
    const approved = baseJoinRequest({
      adapterType: "codex_local",
      status: "approved",
      createdAgentId: agentId,
    });
    const db = createDbStub({
      selectRows: [[baseJoinRequest({ adapterType: "codex_local" })], [baseInvite()]],
      updateRows: [[approved]],
    });

    const res = await request(await createApp(db))
      .post(`/api/companies/${companyId}/join-requests/${joinRequestId}/approve`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ adapterType: "codex_local" }),
    );
  });

  it("rejects approval for a join request with an unknown adapter", async () => {
    const db = createDbStub({
      selectRows: [[baseJoinRequest({ adapterType: missingAdapterType })], [baseInvite()]],
    });

    const res = await request(await createApp(db))
      .post(`/api/companies/${companyId}/join-requests/${joinRequestId}/approve`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(String(res.body.error ?? "")).toContain(
      `Join request has unknown adapter type: ${missingAdapterType}`,
    );
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });
});
