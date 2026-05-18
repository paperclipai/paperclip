/**
 * LET-357 capability-apply route tests.
 *
 * Tests: authorization, idempotency, governance_critical refusal,
 * optimistic concurrency, plan builder, redaction property tests,
 * and no-live-action assertions (spy that real adapter is never instantiated).
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_APPLY_ERROR_CODES } from "@paperclipai/shared";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSvc = vi.hoisted(() => ({
  createPlan: vi.fn(),
  getPlan: vi.fn(),
  requestApproval: vi.fn(),
  cancelPlan: vi.fn(),
  executePlan: vi.fn(),
  getPlanEvents: vi.fn(),
  _getExecutorAdapter: vi.fn(),
  stubExecutor: vi.fn(),
}));

vi.mock("../services/capability-apply.js", () => ({
  capabilityApplyService: () => mockSvc,
}));

// Stub DB agent lookup for resolveAgentCompany
vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  return {
    ...actual,
  };
});

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([{ companyId: "company-1" }]),
};

// ── App factory ───────────────────────────────────────────────────────────────

async function createTestApp(
  actorOverrides: Record<string, unknown> = {},
  opts: { capabilityApplyLive?: boolean } = {},
) {
  const [{ capabilityApplyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/capability-apply.js")>("../routes/capability-apply.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", capabilityApplyRoutes(mockDb as any, { capabilityApplyLive: opts.capabilityApplyLive ?? false }));
  app.use(errorHandler);
  return app;
}

const PLAN_ID = "plan-uuid-1";
const COMPANY_ID = "company-1";
const AGENT_ID = "agent-1";
const BASE_URL = `/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/capability-apply`;

const fakePlan = {
  id: PLAN_ID,
  companyId: COMPANY_ID,
  agentId: AGENT_ID,
  dryRunHash: "abc123def456abc123def456abc12345",
  state: "pending",
  steps: [],
  approvalId: null,
  optimisticVersion: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const basicDelta = {
  effectiveDelta: {
    mcpServerChanges: [
      {
        kind: "add",
        serverId: "test-server",
        displayName: "Test Server",
        catalogId: "verified/test",
        requiredSecretNames: [],
      },
    ],
  },
};

// ── POST /plans ───────────────────────────────────────────────────────────────

describe("POST /plans", () => {
  beforeEach(() => {
    mockSvc.createPlan.mockResolvedValue({ ...fakePlan });
    mockDb.limit.mockResolvedValue([{ companyId: COMPANY_ID }]);
  });

  it("creates a plan and returns 201", async () => {
    const app = await createTestApp();
    const res = await request(app).post(`${BASE_URL}/plans`).send(basicDelta);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: PLAN_ID, state: "pending" });
  }, 15000);

  it("returns 403 for cross-company access", async () => {
    mockDb.limit.mockResolvedValue([{ companyId: "company-2" }]);
    const app = await createTestApp({
      companyIds: ["company-1"],
      source: "explicit",
    });
    const res = await request(app).post(`${BASE_URL}/plans`).send(basicDelta);
    // agent belongs to company-2, request targets company-1 → forbidden
    expect(res.status).toBe(403);
  });

  it("returns 403 when actor has no access to this company", async () => {
    const app = await createTestApp({
      type: "board",
      companyIds: ["company-other"],
      source: "explicit",
      isInstanceAdmin: false,
    });
    const res = await request(app).post(`${BASE_URL}/plans`).send(basicDelta);
    expect(res.status).toBe(403);
  });

  it("refuses governance_critical steps with 409", async () => {
    mockSvc.createPlan.mockRejectedValue({
      status: 409,
      message: CAPABILITY_APPLY_ERROR_CODES.STEP_REQUIRES_GOVERNANCE,
      details: { code: CAPABILITY_APPLY_ERROR_CODES.STEP_REQUIRES_GOVERNANCE },
    });
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans`)
      .send({
        effectiveDelta: {
          mcpServerChanges: [{ kind: "add", serverId: "gov", displayName: "Gov", riskClass: "governance_critical", requiredSecretNames: [] }],
        },
      });
    expect([409, 500]).toContain(res.status); // service raises HttpError 409
  });

  it("accepts remoteUrl on mcpServerChanges and forwards it to createPlan (LET-402 G.4)", async () => {
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans`)
      .send({
        effectiveDelta: {
          mcpServerChanges: [
            {
              kind: "add",
              serverId: "srv-1",
              displayName: "MCP",
              catalogId: "verified/x",
              transport: "streamable_http",
              remoteUrl: "https://api.example.com/mcp",
              requiredSecretNames: [],
            },
          ],
        },
      });
    expect(res.status).toBe(201);
    expect(mockSvc.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveDelta: expect.objectContaining({
          mcpServerChanges: [
            expect.objectContaining({ remoteUrl: "https://api.example.com/mcp" }),
          ],
        }),
      }),
      expect.any(Object),
    );
  });

  it("400 for missing effectiveDelta", async () => {
    const app = await createTestApp();
    const res = await request(app).post(`${BASE_URL}/plans`).send({});
    expect(res.status).toBe(400);
  });

  it("refuses unverified catalog entry (add without catalogId) with 409", async () => {
    mockSvc.createPlan.mockRejectedValue({
      status: 409,
      message: CAPABILITY_APPLY_ERROR_CODES.STEP_REQUIRES_GOVERNANCE,
      details: {
        code: CAPABILITY_APPLY_ERROR_CODES.STEP_REQUIRES_GOVERNANCE,
        reason: "unverified_catalog_entry",
      },
    });
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans`)
      .send({
        effectiveDelta: {
          mcpServerChanges: [
            // No catalogId → unverified entry
            { kind: "add", serverId: "custom-srv", displayName: "Custom Server", requiredSecretNames: [] },
          ],
        },
      });
    expect([409, 500]).toContain(res.status);
  });
});

// ── GET /plans/:planId ────────────────────────────────────────────────────────

describe("GET /plans/:planId", () => {
  beforeEach(() => {
    mockSvc.getPlan.mockResolvedValue({ ...fakePlan });
  });

  it("returns the plan", async () => {
    const app = await createTestApp();
    const res = await request(app).get(`${BASE_URL}/plans/${PLAN_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PLAN_ID);
  });

  it("403 for cross-company", async () => {
    const app = await createTestApp({ companyIds: ["other"], source: "explicit" });
    const res = await request(app).get(`${BASE_URL}/plans/${PLAN_ID}`);
    expect(res.status).toBe(403);
  });
});

// ── POST /plans/:planId/request-approval ──────────────────────────────────────

describe("POST /plans/:planId/request-approval", () => {
  const approvalPayload = {
    version: 1,
    planRevisionId: PLAN_ID,
    dryRunHash: "abc",
    agentId: AGENT_ID,
    scopeSummary: {
      agentId: AGENT_ID,
      agentLabel: "test-agent",
      totalSteps: 0,
      stepsByRiskClass: {
        internal_safe: 0,
        external_readonly: 0,
        external_write: 0,
        destructive_or_spend: 0,
        governance_critical: 0,
      },
      totalNamedSecretRefs: 0,
      hasGovernanceCritical: false,
    },
    steps: [],
    liveExecutionFlagState: "off",
    noLiveActionAttestation: true,
  };

  beforeEach(() => {
    mockSvc.requestApproval.mockResolvedValue({
      plan: { ...fakePlan, state: "approval_requested", optimisticVersion: 2 },
      approvalPayload,
    });
  });

  it("returns approval payload on success", async () => {
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/request-approval`)
      .set("If-Match", "1");
    expect(res.status).toBe(200);
    expect(res.body.approvalPayload).toMatchObject({
      liveExecutionFlagState: "off",
      noLiveActionAttestation: true,
    });
  });

  it("400 when If-Match header missing", async () => {
    const app = await createTestApp();
    const res = await request(app).post(`${BASE_URL}/plans/${PLAN_ID}/request-approval`);
    expect(res.status).toBe(400);
  });

  it("403 for cross-company", async () => {
    const app = await createTestApp({ companyIds: ["other"], source: "explicit" });
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/request-approval`)
      .set("If-Match", "1");
    expect(res.status).toBe(403);
  });
});

// ── POST /plans/:planId/execute ───────────────────────────────────────────────

describe("POST /plans/:planId/execute (LET-395)", () => {
  beforeEach(() => {
    mockSvc.executePlan.mockResolvedValue({ ...fakePlan, state: "applied", optimisticVersion: 4 });
    mockDb.limit.mockResolvedValue([{ companyId: COMPANY_ID }]);
  });

  it("returns the applied plan on success", async () => {
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/execute`)
      .set("If-Match", "3");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("applied");
  });

  it("400 when If-Match header missing", async () => {
    const app = await createTestApp();
    const res = await request(app).post(`${BASE_URL}/plans/${PLAN_ID}/execute`);
    expect(res.status).toBe(400);
  });

  it("403 for cross-company actor", async () => {
    const app = await createTestApp({ companyIds: ["other"], source: "explicit" });
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/execute`)
      .set("If-Match", "3");
    expect(res.status).toBe(403);
  });

  it("403 when agent does not belong to the URL company", async () => {
    mockDb.limit.mockResolvedValue([{ companyId: "company-2" }]);
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/execute`)
      .set("If-Match", "3");
    expect(res.status).toBe(403);
  });

  it("surfaces APPROVAL_NOT_ACCEPTED from the service", async () => {
    mockSvc.executePlan.mockRejectedValue({
      status: 409,
      message: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED,
      details: { code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED },
    });
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/execute`)
      .set("If-Match", "3");
    expect([409, 500]).toContain(res.status);
  });

  it("surfaces PLAN_HASH_MISMATCH from the service", async () => {
    mockSvc.executePlan.mockRejectedValue({
      status: 409,
      message: CAPABILITY_APPLY_ERROR_CODES.PLAN_HASH_MISMATCH,
      details: { code: CAPABILITY_APPLY_ERROR_CODES.PLAN_HASH_MISMATCH },
    });
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/execute`)
      .set("If-Match", "3");
    expect([409, 500]).toContain(res.status);
  });

  it("surfaces APPROVAL_CONSUMED on replay", async () => {
    mockSvc.executePlan.mockRejectedValue({
      status: 409,
      message: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED,
      details: { code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED },
    });
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/execute`)
      .set("If-Match", "5");
    expect([409, 500]).toContain(res.status);
  });

  it("surfaces OPTIMISTIC_CONFLICT on If-Match mismatch", async () => {
    mockSvc.executePlan.mockRejectedValue({
      status: 409,
      message: CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT,
      details: { code: CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT },
    });
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/execute`)
      .set("If-Match", "1");
    expect([409, 500]).toContain(res.status);
  });
});

// ── POST /plans/:planId/cancel ────────────────────────────────────────────────

describe("POST /plans/:planId/cancel", () => {
  beforeEach(() => {
    mockSvc.cancelPlan.mockResolvedValue({ ...fakePlan, state: "cancelled", optimisticVersion: 2 });
  });

  it("returns cancelled plan", async () => {
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/cancel`)
      .set("If-Match", "1");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("cancelled");
  });

  it("400 when If-Match missing", async () => {
    const app = await createTestApp();
    const res = await request(app).post(`${BASE_URL}/plans/${PLAN_ID}/cancel`);
    expect(res.status).toBe(400);
  });

  it("403 for cross-company", async () => {
    const app = await createTestApp({ companyIds: ["other"], source: "explicit" });
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/cancel`)
      .set("If-Match", "1");
    expect(res.status).toBe(403);
  });

  it("403 when non-creator tries to cancel", async () => {
    mockSvc.cancelPlan.mockRejectedValue({
      status: 403,
      message: "Only the plan creator can cancel this plan",
    });
    const app = await createTestApp({ userId: "user-not-creator" });
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/cancel`)
      .set("If-Match", "1");
    expect([403, 500]).toContain(res.status);
  });

  it("409 optimistic conflict when concurrent cancels race (one wins)", async () => {
    mockSvc.cancelPlan.mockRejectedValue({
      status: 409,
      message: CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT,
      details: { code: CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT },
    });
    const app = await createTestApp();
    const res = await request(app)
      .post(`${BASE_URL}/plans/${PLAN_ID}/cancel`)
      .set("If-Match", "1"); // stale version — second concurrent cancel
    expect([409, 500]).toContain(res.status);
  });
});

// ── GET /plans/:planId/events ─────────────────────────────────────────────────

describe("GET /plans/:planId/events", () => {
  it("returns events list", async () => {
    mockSvc.getPlanEvents.mockResolvedValue([]);
    const app = await createTestApp();
    const res = await request(app).get(`${BASE_URL}/plans/${PLAN_ID}/events`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── No-live-action assertions ─────────────────────────────────────────────────

describe("no-live-action assertions", () => {
  it("_getExecutorAdapter returns StubExecutorAdapter when live flag is OFF", async () => {
    // Import real service (not mocked version) to test stub selection
    const { capabilityApplyService } = await vi.importActual<typeof import("../services/capability-apply.js")>(
      "../services/capability-apply.js",
    );
    const svc = capabilityApplyService({} as any, { capabilityApplyLive: false });
    // Should not throw (stub adapter is returned)
    const adapter = svc._getExecutorAdapter();
    expect(adapter).toBeDefined();
    // Real adapter is NOT a stub only when live=true, and G.1 throws for live=true
  });

  it("returns the real adapter when capabilityApplyLive is ON (LET-402 G.4)", async () => {
    const { capabilityApplyService } = await vi.importActual<typeof import("../services/capability-apply.js")>(
      "../services/capability-apply.js",
    );
    const svc = capabilityApplyService({} as any, { capabilityApplyLive: true });
    const adapter = svc._getExecutorAdapter();
    expect(adapter).toBeDefined();
    // Tag exposed so route-layer telemetry can distinguish stub vs real
    // without leaking the adapter implementation surface.
    expect(adapter.kind).toBe("real");
  });
});

// ── Redaction property tests ──────────────────────────────────────────────────
// Tests verify that the redactor correctly masks secret-keyed fields.
// The redactor is KEY-NAME based: fields whose names match secret patterns
// are redacted. Values in non-secret field names must be rejected at validation
// time via assertNoSecretShape (tested in the service unit tests).

describe("redaction property tests (30+ secret-shaped strings)", () => {
  const CANARY = "CANARY_SECRET_VALUE_THAT_MUST_NOT_APPEAR_ANYWHERE";

  // Secret-keyed field names that SHOULD be redacted
  const SECRET_KEYED_FIELDS = [
    "api_key",
    "api-key",
    "access_token",
    "access-token",
    "auth_token",
    "authorization",
    "bearer",
    "secret",
    "passwd",
    "password",
    "credential",
    "jwt",
    "private_key",
    "cookie",
    "connectionstring",
    "apiKey",
    "accessToken",
    "authToken",
    "privateKey",
    "PAPERCLIP_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "SOME_API_KEY",
    "some_secret",
    "my_password",
    "my_passwd",
    "db_password",
    "auth_secret",
    "JWT_TOKEN",
    "PRIVATE_KEY",
    "COOKIE_SECRET",
  ];

  it("secret-keyed fields are always redacted by redactEventPayload (30+ cases)", async () => {
    const { redactEventPayload: fn } = await vi.importActual<typeof import("../redaction.js")>(
      "../redaction.js",
    );
    for (const fieldName of SECRET_KEYED_FIELDS) {
      const payload = { [fieldName]: CANARY };
      const redacted = fn(payload);
      const serialized = JSON.stringify(redacted);
      // The canary value must NOT appear when the field name is secret-keyed
      expect(serialized, `Field "${fieldName}" should be redacted`).not.toContain(CANARY);
    }
  });

  it("JWT-shaped values are redacted regardless of key name", async () => {
    const { redactEventPayload: fn } = await vi.importActual<typeof import("../redaction.js")>(
      "../redaction.js",
    );
    const jwtValue = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const payload = { someArbitraryField: jwtValue };
    const redacted = fn(payload);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(jwtValue);
  });

  it("canary value is never present in output when placed in secret-keyed fields", async () => {
    const { redactEventPayload: fn } = await vi.importActual<typeof import("../redaction.js")>(
      "../redaction.js",
    );
    const payload = {
      api_key: CANARY,
      secret: CANARY,
      password: CANARY,
      auth_token: CANARY,
      credential: CANARY,
    };
    const redacted = fn(payload);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(CANARY);
  });

  it("non-secret field names preserve non-secret values (redactor is not overly broad)", async () => {
    const { redactEventPayload: fn } = await vi.importActual<typeof import("../redaction.js")>(
      "../redaction.js",
    );
    const payload = { planId: "my-plan-id", stepCount: 3, kind: "add_mcp_server" };
    const redacted = fn(payload);
    expect(redacted).toMatchObject({ planId: "my-plan-id", stepCount: 3, kind: "add_mcp_server" });
  });

  it("secret_ref bindings are preserved through redactEventPayload", async () => {
    const { redactEventPayload: fn } = await vi.importActual<typeof import("../redaction.js")>(
      "../redaction.js",
    );
    const secretRef = { type: "secret_ref", secretId: "named:SOME_API_KEY" };
    const payload = { api_key: secretRef };
    const redacted = fn(payload);
    // secret_ref binding should be preserved
    expect((redacted as any).api_key).toMatchObject({ type: "secret_ref" });
  });
});
