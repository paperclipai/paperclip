// LET-514 — EAOS onboarding Slack endpoints tests.
//
// Verifies:
//   - POST .../slack-install-preview
//       Authorization, preview shape, secret redaction in the response copy,
//       approval-card round-trip with and without an agent.
//   - GET .../slack-connection
//       Truthful state mapping from the capability-apply lifecycle:
//         no plan         → not_connected
//         pending         → pending_approval
//         approval_requested → pending_approval
//         approved        → applying
//         executing       → applying
//         applied         → connected
//         partially_applied → partial
//         cancelled / declined / expired → error
//       Plus auth and the no-raw-secret guarantee.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Test DB stub ──────────────────────────────────────────────────────────────
//
// Two distinct query shapes flow through this route module:
//
//   1. resolveBootstrapAgent: select().from(agents).where().orderBy().limit()
//   2. resolveSlackConnectionState:
//        select().from(plans).innerJoin(steps, eq).where().orderBy().limit()
//
// The stub demultiplexes by inspecting whether `innerJoin` was called on the
// chain since the last terminal `.limit()`. Each fluent method returns the
// same chain object so the call ordering can be inspected at the .limit step.

const mockAgentRow = vi.hoisted(() => ({ value: [] as Array<{ id: string }> }));
const mockConnectionRow = vi.hoisted(() => ({
  value: [] as Array<{
    planId: string;
    planState: string;
    approvalId: string | null;
    updatedAt: Date;
  }>,
}));

const mockDb = vi.hoisted(() => {
  const chain: Record<string, unknown> = {};
  let usingJoin = false;
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => {
    usingJoin = false;
    return chain;
  });
  chain.innerJoin = vi.fn(() => {
    usingJoin = true;
    return chain;
  });
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(async () => {
    if (usingJoin) {
      return mockConnectionRow.value;
    }
    return mockAgentRow.value;
  });
  return chain;
});

async function createTestApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ eaosOnboardingRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/eaos-onboarding.js")>(
      "../routes/eaos-onboarding.js",
    ),
    vi.importActual<typeof import("../middleware/index.js")>(
      "../middleware/index.js",
    ),
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
      memberships: [
        { companyId: "company-1", status: "active", membershipRole: "owner" },
      ],
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", eaosOnboardingRoutes(mockDb as any));
  app.use(errorHandler);
  return app;
}

const COMPANY_ID = "company-1";
const PREVIEW_ENDPOINT = `/api/companies/${COMPANY_ID}/eaos/onboarding/slack-install-preview`;
const CONNECTION_ENDPOINT = `/api/companies/${COMPANY_ID}/eaos/onboarding/slack-connection`;

const SECRET_SHAPE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9._:-]+/i,
  /\bxox[abprs]-[0-9A-Za-z-]{8,}/,
  /\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}/,
  /\bgh[opus]_[A-Za-z0-9]{20,}/,
  /\b(?:authorization|api[_-]?key|password|client[_-]?secret|access[_-]?token)\s*[:=]\s*[^\s,"';)]{4,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

function assertNoSecretShape(body: string) {
  for (const re of SECRET_SHAPE_PATTERNS) {
    expect(body).not.toMatch(re);
  }
}

beforeEach(() => {
  mockAgentRow.value = [];
  mockConnectionRow.value = [];
});

describe("POST /companies/:companyId/eaos/onboarding/slack-install-preview", () => {
  it("returns the canonical Slack install preview with no raw secrets", async () => {
    const app = await createTestApp();
    const res = await request(app).post(PREVIEW_ENDPOINT).send({});
    expect(res.status).toBe(200);
    expect(res.body.allowlistedCatalogId).toBe("verified/slack-app");
    expect(res.body.preview.catalogId).toBe("verified/slack-app");
    expect(res.body.preview.liveApply).toBe(false);
    expect(res.body.liveApplyEnabled).toBe(false);
    expect(res.body.connectionState).toBe("not_connected");
    expect(res.body.preview.requiredSecretNames).toEqual(
      expect.arrayContaining([
        "SLACK_APP_CLIENT_ID",
        "SLACK_APP_CLIENT_SECRET",
        "SLACK_APP_SIGNING_SECRET",
      ]),
    );
    expect(res.body.preview.scopeSummary).toEqual(
      expect.arrayContaining(["chat:write", "channels:read"]),
    );
    assertNoSecretShape(JSON.stringify(res.body));
  });

  it("redaction holds across the full response copy", async () => {
    const app = await createTestApp();
    const res = await request(app).post(PREVIEW_ENDPOINT).send({});
    expect(res.status).toBe(200);
    assertNoSecretShape(res.body.preview.summary);
    for (const name of res.body.preview.requiredSecretNames as string[]) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(name.length).toBeLessThan(64);
    }
  });

  it("includes an approval-card path when the company already has an agent", async () => {
    mockAgentRow.value = [{ id: "agent-xyz" }];
    const app = await createTestApp();
    const res = await request(app).post(PREVIEW_ENDPOINT).send({});
    expect(res.status).toBe(200);
    expect(res.body.approvalCardAgentId).toBe("agent-xyz");
    expect(res.body.approvalCardPath).toBe(
      `/companies/${COMPANY_ID}/agents/agent-xyz/capability-apply`,
    );
  });

  it("returns null approval-card path when no agent exists yet", async () => {
    mockAgentRow.value = [];
    const app = await createTestApp();
    const res = await request(app).post(PREVIEW_ENDPOINT).send({});
    expect(res.status).toBe(200);
    expect(res.body.approvalCardAgentId).toBeNull();
    expect(res.body.approvalCardPath).toBeNull();
  });

  it("forbids cross-company access", async () => {
    const app = await createTestApp({
      companyIds: ["company-other"],
      source: "explicit",
      memberships: [
        { companyId: "company-other", status: "active", membershipRole: "owner" },
      ],
    });
    const res = await request(app).post(PREVIEW_ENDPOINT).send({});
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers", async () => {
    const app = await createTestApp({
      type: "none",
      userId: undefined,
      companyIds: undefined,
      source: undefined,
    });
    const res = await request(app).post(PREVIEW_ENDPOINT).send({});
    expect(res.status).toBe(401);
  });
});

describe("GET /companies/:companyId/eaos/onboarding/slack-connection", () => {
  it("returns not_connected when no Slack capability-apply plan exists", async () => {
    mockConnectionRow.value = [];
    mockAgentRow.value = [];
    const app = await createTestApp();
    const res = await request(app).get(CONNECTION_ENDPOINT);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("not_connected");
    expect(res.body.planId).toBeNull();
    expect(res.body.approvalId).toBeNull();
    expect(res.body.lastUpdatedAt).toBeNull();
    expect(res.body.liveApplyEnabled).toBe(false);
    // Required secret names always surface as env-style identifiers — never values.
    for (const name of res.body.requiredSecretNames as string[]) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
    assertNoSecretShape(JSON.stringify(res.body));
  });

  // Each row exercises the canonical CapabilityApplyPlanState → onboarding-state
  // mapping in isolation. The mapping is the load-bearing safety property here:
  // the UI never paints a "Connected" pill from anything weaker than `applied`.
  it.each([
    { planState: "pending", expected: "pending_approval" },
    { planState: "approval_requested", expected: "pending_approval" },
    { planState: "approved", expected: "applying" },
    { planState: "executing", expected: "applying" },
    { planState: "applied", expected: "connected" },
    { planState: "partially_applied", expected: "partial" },
    { planState: "cancelled", expected: "error" },
    { planState: "declined", expected: "error" },
    { planState: "expired", expected: "error" },
  ])(
    "maps plan state $planState → onboarding state $expected",
    async ({ planState, expected }) => {
      mockConnectionRow.value = [
        {
          planId: "plan-123",
          planState,
          approvalId: "approval-1",
          updatedAt: new Date("2026-05-20T10:00:00Z"),
        },
      ];
      mockAgentRow.value = [{ id: "agent-xyz" }];
      const app = await createTestApp();
      const res = await request(app).get(CONNECTION_ENDPOINT);
      expect(res.status).toBe(200);
      expect(res.body.state).toBe(expected);
      expect(res.body.planId).toBe("plan-123");
      expect(res.body.approvalId).toBe("approval-1");
      expect(res.body.lastUpdatedAt).toBe("2026-05-20T10:00:00.000Z");
      expect(res.body.approvalCardPath).toBe(
        `/companies/${COMPANY_ID}/agents/agent-xyz/capability-apply`,
      );
      assertNoSecretShape(JSON.stringify(res.body));
    },
  );

  it("never produces 'connected' from a non-applied plan state", async () => {
    // Defense-in-depth: enumerate every non-`applied` plan state and prove
    // the response state never reads "connected". This is the single most
    // important invariant — fake-connected copy is the Andrii directive.
    const nonAppliedStates = [
      "pending",
      "approval_requested",
      "approved",
      "executing",
      "partially_applied",
      "cancelled",
      "declined",
      "expired",
    ];
    for (const planState of nonAppliedStates) {
      mockConnectionRow.value = [
        {
          planId: "plan-x",
          planState,
          approvalId: null,
          updatedAt: new Date("2026-05-20T10:00:00Z"),
        },
      ];
      mockAgentRow.value = [];
      const app = await createTestApp();
      const res = await request(app).get(CONNECTION_ENDPOINT);
      expect(res.status).toBe(200);
      expect(res.body.state).not.toBe("connected");
    }
  });

  it("forbids cross-company access", async () => {
    const app = await createTestApp({
      companyIds: ["company-other"],
      source: "explicit",
      memberships: [
        { companyId: "company-other", status: "active", membershipRole: "owner" },
      ],
    });
    const res = await request(app).get(CONNECTION_ENDPOINT);
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers", async () => {
    const app = await createTestApp({
      type: "none",
      userId: undefined,
      companyIds: undefined,
      source: undefined,
    });
    const res = await request(app).get(CONNECTION_ENDPOINT);
    expect(res.status).toBe(401);
  });
});
