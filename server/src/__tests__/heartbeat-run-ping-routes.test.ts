import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  buildRunOutputSilence: vi.fn(),
  getRunIssueSummary: vi.fn(),
  getRunLogAccess: vi.fn(),
  readLog: vi.fn(),
  getRetryExhaustedReason: vi.fn(),
  listEvents: vi.fn(),
  cancelRun: vi.fn(),
  wakeup: vi.fn(),
  getActiveRunIssueSummaryForAgent: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));

function registerMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => ({}),
    approvalService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: vi.fn(),
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_ID = "rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr";
const OTHER_RUN_ID = "00000000-0000-4000-8000-000000000000";

function makeJwt(overrides: { sub?: string; company_id?: string; run_id?: string } = {}) {
  // Override process.env for token creation
  const origSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret-for-ping";
  const token = createLocalAgentJwt(
    overrides.sub ?? AGENT_ID,
    overrides.company_id ?? COMPANY_ID,
    "claude_local",
    overrides.run_id ?? RUN_ID,
  );
  process.env.PAPERCLIP_AGENT_JWT_SECRET = origSecret;
  return token;
}

function makeRunRow(overrides: Partial<{ status: string; agentId: string; companyId: string }> = {}) {
  return {
    id: RUN_ID,
    companyId: overrides.companyId ?? COMPANY_ID,
    agentId: overrides.agentId ?? AGENT_ID,
    status: overrides.status ?? "running",
  };
}

/** Returns a minimal drizzle-shaped db stub for the ping route SELECT + UPDATE path. */
function makeDbStub(runRow: ReturnType<typeof makeRunRow> | null, updateSpy = vi.fn()) {
  const orderBy = vi.fn().mockResolvedValue([]);
  const limit = vi.fn().mockResolvedValue(runRow ? [runRow] : []);
  const where = vi.fn().mockReturnValue({ then: (cb: (v: unknown[]) => unknown) => Promise.resolve(cb(runRow ? [runRow] : [])) });
  const from = vi.fn().mockReturnValue({ where });

  // for UPDATE
  const set = vi.fn().mockReturnValue({ where: updateSpy });

  return {
    select: vi.fn().mockReturnValue({ from }),
    update: vi.fn().mockReturnValue({ set }),
    _updateSpy: updateSpy,
    _whereForSelect: where,
    _set: set,
  };
}

let agentRoutes: typeof import("../routes/agents.js").agentRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;

async function createApp(db: Record<string, unknown>, actorOverride?: Partial<Express.Request["actor"]>) {
  if (!agentRoutes || !errorHandler) throw new Error("routes not loaded");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "none",
      source: "none",
      ...actorOverride,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/heartbeat-runs/:runId/ping", () => {
  const origSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeEach(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret-for-ping";
    vi.resetModules();
    registerMocks();
    [{ agentRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
  });

  afterEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = origSecret;
    vi.clearAllMocks();
  });

  it("200 — ping on running run with valid JWT updates last_ping_at", async () => {
    const runRow = makeRunRow({ status: "running" });
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const db = makeDbStub(runRow, updateWhere);
    const app = await createApp(db);
    const token = makeJwt();

    const res = await request(app)
      .post(`/api/heartbeat-runs/${RUN_ID}/ping`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.pingedAt).toBe("string");
    expect(new Date(res.body.pingedAt).getTime()).toBeGreaterThan(0);
    // update was called
    expect(db.update).toHaveBeenCalledWith(expect.anything());
    expect(updateWhere).toHaveBeenCalled();
  });

  it("403 — no Authorization header", async () => {
    const db = makeDbStub(makeRunRow());
    const app = await createApp(db);

    const res = await request(app)
      .post(`/api/heartbeat-runs/${RUN_ID}/ping`);

    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("403 — invalid/expired token", async () => {
    const db = makeDbStub(makeRunRow());
    const app = await createApp(db);

    const res = await request(app)
      .post(`/api/heartbeat-runs/${RUN_ID}/ping`)
      .set("Authorization", "Bearer invalid.token.here");

    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("403 — params.runId !== claims.run_id (direct mismatch)", async () => {
    const db = makeDbStub(makeRunRow());
    const app = await createApp(db);
    const token = makeJwt({ run_id: OTHER_RUN_ID }); // token claims OTHER_RUN_ID but URL has RUN_ID

    const res = await request(app)
      .post(`/api/heartbeat-runs/${RUN_ID}/ping`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("run_id mismatch");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("403 — X-Paperclip-Run-Id spoof attempt: header differs from claims.run_id → 403, no update on any row", async () => {
    const runRow = makeRunRow({ status: "running" });
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const db = makeDbStub(runRow, updateWhere);
    const app = await createApp(db);
    // JWT claims RUN_ID but URL has OTHER_RUN_ID — a classic spoof via path
    const token = makeJwt({ run_id: RUN_ID });

    const res = await request(app)
      .post(`/api/heartbeat-runs/${OTHER_RUN_ID}/ping`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", OTHER_RUN_ID); // header tries to spoof

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("run_id mismatch");
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it("403 — agent_id mismatch between JWT claims and run row", async () => {
    const runRow = makeRunRow({ agentId: "different-agent-id" });
    const db = makeDbStub(runRow);
    const app = await createApp(db);
    const token = makeJwt(); // AGENT_ID != "different-agent-id"

    const res = await request(app)
      .post(`/api/heartbeat-runs/${RUN_ID}/ping`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("agent_id or company_id mismatch");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("403 — company_id mismatch between JWT claims and run row", async () => {
    const runRow = makeRunRow({ companyId: "different-company-id" });
    const db = makeDbStub(runRow);
    const app = await createApp(db);
    const token = makeJwt(); // COMPANY_ID != "different-company-id"

    const res = await request(app)
      .post(`/api/heartbeat-runs/${RUN_ID}/ping`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("agent_id or company_id mismatch");
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "abandoned",
  ] as const)("409 run_terminal — status=%s, no last_ping_at update", async (status) => {
    const runRow = makeRunRow({ status });
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const db = makeDbStub(runRow, updateWhere);
    const app = await createApp(db);
    const token = makeJwt();

    const res = await request(app)
      .post(`/api/heartbeat-runs/${RUN_ID}/ping`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("run_terminal");
    expect(res.body.status).toBe(status);
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it("200 idempotence — 5 consecutive pings on running run all succeed with monotonically advancing pingedAt", async () => {
    const runRow = makeRunRow({ status: "running" });
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const db = makeDbStub(runRow, updateWhere);
    const app = await createApp(db);
    const token = makeJwt();

    let prev = 0;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1)); // tiny delay to ensure different timestamps
      const res = await request(app)
        .post(`/api/heartbeat-runs/${RUN_ID}/ping`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      const ts = new Date(res.body.pingedAt).getTime();
      expect(ts).toBeGreaterThanOrEqual(prev);
      prev = ts;
    }

    expect(db.update).toHaveBeenCalledTimes(5);
  });
});
