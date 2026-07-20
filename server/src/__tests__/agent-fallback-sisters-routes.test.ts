import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const primaryAgentId = "11111111-1111-4111-8111-111111111111";
const sisterAgentId = "33333333-3333-4333-8333-333333333333";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => ({ wakeup: vi.fn() }),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: vi.fn(),
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../adapters/index.js", () => ({
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    listAdapterModelProfiles: vi.fn(),
    refreshAdapterModels: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

function createSelectQuery(rows: Array<Record<string, unknown>>) {
  const query = {
    from: vi.fn(() => query),
    innerJoin: vi.fn(() => query),
    leftJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: (resolve: (value: Array<Record<string, unknown>>) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return query;
}

function createDbStub(options: {
  selectRows?: Array<Array<Record<string, unknown>>>;
  returningRows?: Array<Record<string, unknown>>;
  updateReturningRows?: Array<Array<Record<string, unknown>>>;
} = {}) {
  const selectRows = [...(options.selectRows ?? [])];
  const returningRows = [...(options.returningRows ?? [])];
  const updateReturningRows = [...(options.updateReturningRows ?? [])];
  const insertChain = {
    values: vi.fn(() => insertChain),
    onConflictDoUpdate: vi.fn(() => insertChain),
    returning: vi.fn(async () => {
      const row = returningRows.shift();
      return row ? [row] : [];
    }),
  };
  const insertValues = insertChain.values;
  const onConflictDoUpdate = insertChain.onConflictDoUpdate;
  const updateChain = {
    set: vi.fn(() => updateChain),
    where: vi.fn(async () => updateReturningRows.shift() ?? []),
  };

  const db: Record<string, unknown> = {
    select: vi.fn(() => createSelectQuery(selectRows.shift() ?? [])),
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => updateChain),
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));

  return {
    db,
    insertValues,
    onConflictDoUpdate,
    transaction: db.transaction as ReturnType<typeof vi.fn>,
    updateSet: updateChain.set,
    updateWhere: updateChain.where,
  };
}

async function createApp(
  db: Record<string, unknown>,
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
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

describe("agent fallback sister routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockAgentService.getById.mockResolvedValue({
      id: primaryAgentId,
      companyId,
      role: "cto",
      permissions: { canCreateAgents: true },
    });
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "agents:manage_fallback",
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
  });

  it("lists active fallback sister relationships", async () => {
    const db = createDbStub({
      selectRows: [[{
        id: "44444444-4444-4444-8444-444444444444",
        companyId,
        primaryAgentId,
        sisterAgentId,
        priority: 0,
        createdBy: "seed-fallback-sisters.py",
        createdAt: new Date("2026-06-29T20:00:00.000Z"),
        revokedAt: null,
      }]],
    });

    const res = await request(await createApp(db.db)).get(
      `/api/companies/${companyId}/agent-fallback-sisters`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject([{
      companyId,
      primaryAgentId,
      sisterAgentId,
      priority: 0,
      createdBy: "seed-fallback-sisters.py",
      revokedAt: null,
    }]);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "agents:manage_fallback",
      resource: { type: "company", companyId },
    }));
  });

  it("creates or reactivates a fallback sister relationship idempotently", async () => {
    const createdRow = {
      id: "55555555-5555-4555-8555-555555555555",
      companyId,
      primaryAgentId,
      sisterAgentId,
      priority: 2,
      createdBy: "seed-fallback-sisters.py",
      createdAt: new Date("2026-06-29T20:05:00.000Z"),
      revokedAt: null,
    };
    const db = createDbStub({
      selectRows: [[
        { id: primaryAgentId },
        { id: sisterAgentId },
      ]],
      returningRows: [createdRow],
    });

    const res = await request(await createApp(db.db))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({
        primaryAgentId,
        sisterAgentId,
        priority: 2,
        createdBy: "seed-fallback-sisters.py",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      primaryAgentId,
      sisterAgentId,
      priority: 2,
      createdBy: "seed-fallback-sisters.py",
      revokedAt: null,
    });
    expect(db.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      primaryAgentId,
      sisterAgentId,
      priority: 2,
      createdBy: "seed-fallback-sisters.py",
      revokedAt: null,
    }));
    expect(db.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("clears sister-only ignoreActivityWindow from a promoted windowed primary and enables it for the sister", async () => {
    const createdRow = {
      id: "77777777-7777-4777-8777-777777777777",
      companyId,
      primaryAgentId,
      sisterAgentId,
      priority: 1,
      createdBy: "agent:test-agent",
      createdAt: new Date("2026-07-16T13:10:00.000Z"),
      revokedAt: null,
    };
    const db = createDbStub({
      selectRows: [
        [
          { id: primaryAgentId },
          { id: sisterAgentId },
        ],
        [{ activityWindow: { timezone: "Europe/Dublin", startHour: 17, endHour: 3 } }],
        [
          { id: primaryAgentId, runtimeConfig: { ignoreActivityWindow: true } },
          { id: sisterAgentId, runtimeConfig: {} },
        ],
      ],
      returningRows: [createdRow],
    });

    const res = await request(await createApp(db.db))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({
        primaryAgentId,
        sisterAgentId,
        priority: 1,
      });

    expect(res.status).toBe(201);
    expect(db.updateSet).toHaveBeenNthCalledWith(1, expect.objectContaining({
      runtimeConfig: { ignoreActivityWindow: true },
    }));
    expect(db.updateSet).toHaveBeenNthCalledWith(2, expect.objectContaining({
      runtimeConfig: {},
    }));
  });

  it("retains ignoreActivityWindow for an explicit audited primary exception", async () => {
    const createdRow = {
      id: "88888888-8888-4888-8888-888888888888",
      companyId,
      primaryAgentId,
      sisterAgentId,
      priority: 0,
      createdBy: "agent:test-agent",
      createdAt: new Date("2026-07-16T13:15:00.000Z"),
      revokedAt: null,
    };
    const db = createDbStub({
      selectRows: [
        [
          { id: primaryAgentId },
          { id: sisterAgentId },
        ],
        [{ activityWindow: { timezone: "Europe/Dublin", startHour: 17, endHour: 3 } }],
        [
          { id: primaryAgentId, runtimeConfig: { ignoreActivityWindow: true } },
          { id: sisterAgentId, runtimeConfig: { ignoreActivityWindow: true } },
        ],
      ],
      returningRows: [createdRow],
    });

    const res = await request(await createApp(db.db))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({
        primaryAgentId,
        sisterAgentId,
        retainPrimaryIgnoreActivityWindow: true,
        primaryIgnoreActivityWindowExceptionClass: "window_flipped_cto",
        primaryIgnoreActivityWindowExceptionReason: "Window-flipped CTO primary stays always-on outside the company sprint.",
      });

    expect(res.status).toBe(201);
    expect(db.updateSet).toHaveBeenCalledTimes(1);
    expect(db.updateSet).toHaveBeenCalledWith(expect.objectContaining({
      runtimeConfig: expect.objectContaining({
        ignoreActivityWindow: true,
        ignoreActivityWindowException: expect.objectContaining({
          class: "window_flipped_cto",
          reason: "Window-flipped CTO primary stays always-on outside the company sprint.",
          source: "agent-fallback-sisters",
          recordedBy: "user:local-board",
        }),
      }),
    }));
  });

  it("preserves an audited primary exception when a re-registration does not mention the flag", async () => {
    const auditedException = {
      class: "window_flipped_cto",
      reason: "Window-flipped CTO primary stays always-on outside the company sprint.",
      source: "agent-fallback-sisters",
      recordedAt: "2026-07-16T13:15:00.000Z",
      recordedBy: "user:local-board",
    };
    const db = createDbStub({
      selectRows: [
        [
          { id: primaryAgentId },
          { id: sisterAgentId },
        ],
        [{ activityWindow: { timezone: "Europe/Dublin", startHour: 17, endHour: 3 } }],
        [
          {
            id: primaryAgentId,
            runtimeConfig: { ignoreActivityWindow: true, ignoreActivityWindowException: auditedException },
          },
          { id: sisterAgentId, runtimeConfig: { ignoreActivityWindow: true } },
        ],
      ],
      returningRows: [{
        id: "99999999-9999-4999-8999-999999999999",
        companyId,
        primaryAgentId,
        sisterAgentId,
        priority: 0,
        createdBy: "agent:test-agent",
        createdAt: new Date("2026-07-20T09:00:00.000Z"),
        revokedAt: null,
      }],
    });

    const res = await request(await createApp(db.db))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({ primaryAgentId, sisterAgentId });

    expect(res.status).toBe(201);
    expect(db.updateSet).not.toHaveBeenCalled();
  });

  it("revokes an audited primary exception when the caller explicitly sends retain=false", async () => {
    const db = createDbStub({
      selectRows: [
        [
          { id: primaryAgentId },
          { id: sisterAgentId },
        ],
        [{ activityWindow: { timezone: "Europe/Dublin", startHour: 17, endHour: 3 } }],
        [
          {
            id: primaryAgentId,
            runtimeConfig: {
              ignoreActivityWindow: true,
              ignoreActivityWindowException: { class: "window_flipped_cto", source: "agent-fallback-sisters" },
            },
          },
          { id: sisterAgentId, runtimeConfig: { ignoreActivityWindow: true } },
        ],
      ],
      returningRows: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId,
        primaryAgentId,
        sisterAgentId,
        priority: 0,
        createdBy: "agent:test-agent",
        createdAt: new Date("2026-07-20T09:05:00.000Z"),
        revokedAt: null,
      }],
    });

    const res = await request(await createApp(db.db))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({ primaryAgentId, sisterAgentId, retainPrimaryIgnoreActivityWindow: false });

    expect(res.status).toBe(201);
    expect(db.updateSet).toHaveBeenCalledTimes(1);
    expect(db.updateSet).toHaveBeenCalledWith(expect.objectContaining({ runtimeConfig: {} }));
  });

  it("leaves both lane sides untouched when the company has no activity window", async () => {
    const db = createDbStub({
      selectRows: [
        [
          { id: primaryAgentId },
          { id: sisterAgentId },
        ],
        [{ activityWindow: null }],
        [
          { id: primaryAgentId, runtimeConfig: { ignoreActivityWindow: true } },
          { id: sisterAgentId, runtimeConfig: {} },
        ],
      ],
      returningRows: [{
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId,
        primaryAgentId,
        sisterAgentId,
        priority: 0,
        createdBy: "agent:test-agent",
        createdAt: new Date("2026-07-20T09:10:00.000Z"),
        revokedAt: null,
      }],
    });

    const res = await request(await createApp(db.db))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({ primaryAgentId, sisterAgentId });

    expect(res.status).toBe(201);
    expect(db.updateSet).not.toHaveBeenCalled();
  });

  it("still returns 201 when the activity-window reconciliation fails", async () => {
    const db = createDbStub({
      selectRows: [[
        { id: primaryAgentId },
        { id: sisterAgentId },
      ]],
      returningRows: [{
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        companyId,
        primaryAgentId,
        sisterAgentId,
        priority: 0,
        createdBy: "agent:test-agent",
        createdAt: new Date("2026-07-20T09:15:00.000Z"),
        revokedAt: null,
      }],
    });
    db.transaction.mockRejectedValue(new Error("reconciliation exploded"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(await createApp(db.db))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({ primaryAgentId, sisterAgentId });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ companyId, primaryAgentId, sisterAgentId });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rejects an exception class without retainPrimaryIgnoreActivityWindow=true", async () => {
    const db = createDbStub();

    const res = await request(await createApp(db.db))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({
        primaryAgentId,
        sisterAgentId,
        primaryIgnoreActivityWindowExceptionClass: "window_flipped_cto",
      });

    expect(res.status).toBe(400);
    expect(db.db.insert).not.toHaveBeenCalled();
  });

  it("rejects retainPrimaryIgnoreActivityWindow=true without a class and reason", async () => {
    const db = createDbStub();

    const res = await request(await createApp(db.db))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({
        primaryAgentId,
        sisterAgentId,
        retainPrimaryIgnoreActivityWindow: true,
      });

    expect(res.status).toBe(400);
    expect(db.db.insert).not.toHaveBeenCalled();
  });

  it("allows cto lanes to seed the registry without an explicit fallback grant", async () => {
    const createdRow = {
      id: "66666666-6666-4666-8666-666666666666",
      companyId,
      primaryAgentId,
      sisterAgentId,
      priority: 0,
      createdBy: "agent:test-agent",
      createdAt: new Date("2026-06-29T20:10:00.000Z"),
      revokedAt: null,
    };
    const db = createDbStub({
      selectRows: [[
        { id: primaryAgentId },
        { id: sisterAgentId },
      ]],
      returningRows: [createdRow],
    });
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "agents:manage_fallback",
      reason: "deny_missing_grant",
      explanation: "Missing explicit fallback grant.",
    });
    mockAgentService.getById.mockResolvedValue({
      id: "test-agent",
      companyId,
      role: "cto",
      permissions: { canCreateAgents: false },
    });

    const res = await request(await createApp(db.db, {
      type: "agent",
      agentId: "test-agent",
      companyId,
      source: "agent_jwt",
      runId: "run-1",
    }))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({
        primaryAgentId,
        sisterAgentId,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      primaryAgentId,
      sisterAgentId,
      createdBy: "agent:test-agent",
    });
  });

  it("rejects callers without fallback registry authority", async () => {
    const db = createDbStub();
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "agents:manage_fallback",
      reason: "deny_missing_grant",
      explanation: "Missing explicit fallback grant.",
    });

    const res = await request(await createApp(db.db, {
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    })).get(`/api/companies/${companyId}/agent-fallback-sisters`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Missing explicit fallback grant." });
  });
});
