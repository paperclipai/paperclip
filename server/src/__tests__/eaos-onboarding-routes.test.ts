// LET-514 — Slack safe install preview route tests.
//
// Verifies:
//   - Authorization: cross-company access is refused.
//   - Response shape: preview includes the verified Slack catalog id, only
//     env-style secret *names*, OAuth scope identifiers, and `liveApply` is
//     hard-coded to false.
//   - Secret redaction: response body contains no secret-shaped strings
//     (tokens, Bearer-prefixed values, sk-/xox- prefixes, JWTs).
//   - Approval-card link round-trip: when an agent exists the response
//     points at `/companies/:cid/agents/:aid/capability-apply`; when not,
//     `approvalCardPath` is null but the preview is still returned.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentRow = vi.hoisted(() => ({ value: [] as Array<{ id: string }> }));

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockImplementation(async () => mockAgentRow.value),
};

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
const ENDPOINT = `/api/companies/${COMPANY_ID}/eaos/onboarding/slack-install-preview`;

// A property-grade rejection of common secret shapes — kept inline so the
// secret-redaction guarantee is part of the test, not the implementation.
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

describe("POST /companies/:companyId/eaos/onboarding/slack-install-preview", () => {
  beforeEach(() => {
    mockAgentRow.value = [];
  });

  it("returns the canonical Slack install preview with no raw secrets", async () => {
    const app = await createTestApp();
    const res = await request(app).post(ENDPOINT).send({});
    expect(res.status).toBe(200);
    expect(res.body.allowlistedCatalogId).toBe("verified/slack-app");
    expect(res.body.preview.catalogId).toBe("verified/slack-app");
    expect(res.body.preview.liveApply).toBe(false);
    expect(res.body.liveApplyEnabled).toBe(false);
    expect(res.body.preview.requiredSecretNames).toEqual(
      expect.arrayContaining([
        "SLACK_APP_CLIENT_ID",
        "SLACK_APP_CLIENT_SECRET",
        "SLACK_APP_SIGNING_SECRET",
      ]),
    );
    // Scope identifiers are advisory labels, not secrets.
    expect(res.body.preview.scopeSummary).toEqual(
      expect.arrayContaining(["chat:write", "channels:read"]),
    );
    assertNoSecretShape(JSON.stringify(res.body));
  });

  it("redaction holds across the full response copy", async () => {
    const app = await createTestApp();
    const res = await request(app).post(ENDPOINT).send({});
    expect(res.status).toBe(200);
    // No secret-shaped token must appear in the customer-visible `summary`.
    assertNoSecretShape(res.body.preview.summary);
    // And the list of required secret names must surface only env-style
    // identifiers — never values.
    for (const name of res.body.preview.requiredSecretNames as string[]) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(name.length).toBeLessThan(64);
    }
  });

  it("includes an approval-card path when the company already has an agent", async () => {
    mockAgentRow.value = [{ id: "agent-xyz" }];
    const app = await createTestApp();
    const res = await request(app).post(ENDPOINT).send({});
    expect(res.status).toBe(200);
    expect(res.body.approvalCardAgentId).toBe("agent-xyz");
    expect(res.body.approvalCardPath).toBe(
      `/companies/${COMPANY_ID}/agents/agent-xyz/capability-apply`,
    );
  });

  it("returns null approval-card path when no agent exists yet", async () => {
    mockAgentRow.value = [];
    const app = await createTestApp();
    const res = await request(app).post(ENDPOINT).send({});
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
    const res = await request(app).post(ENDPOINT).send({});
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers", async () => {
    const app = await createTestApp({
      type: "none",
      userId: undefined,
      companyIds: undefined,
      source: undefined,
    });
    const res = await request(app).post(ENDPOINT).send({});
    expect(res.status).toBe(401);
  });
});
