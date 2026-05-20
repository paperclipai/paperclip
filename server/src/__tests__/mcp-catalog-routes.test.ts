// LET-515 — canonical MCP catalog read + safe-install preview route tests.
//
// Verifies the three contract points the issue calls out:
//   1) Catalog allowlist gate — only `verified/`-prefixed ids surface in the
//      list, and the preview endpoint refuses any `catalogId` that is not on
//      the allowlist (mirrors `DefaultCatalogAllowlist`).
//   2) Preview-only behaviour — no apply, no mutation; response is the
//      `McpInstallPreview` shape with `applyPath: "preview_only"`.
//   3) Secret-reference validation — only env-style names are accepted; any
//      value that looks like a raw secret is rejected with a generic error
//      that DOES NOT echo the offending value (so a stray paste cannot leak
//      through the response body or logs).

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

async function createTestApp(actorOverrides: Record<string, unknown> = {}, catalogOverride?: unknown) {
  const [{ mcpCatalogRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/mcp-catalog.js")>("../routes/mcp-catalog.js"),
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
      memberships: [
        { companyId: "company-1", status: "active", membershipRole: "owner" },
      ],
      ...actorOverrides,
    };
    next();
  });
  app.use(
    "/api",
    mcpCatalogRoutes(
      catalogOverride
        ? ({ catalog: catalogOverride } as unknown as Parameters<typeof mcpCatalogRoutes>[0])
        : undefined,
    ),
  );
  app.use(errorHandler);
  return app;
}

const COMPANY_ID = "company-1";
const LIST_ENDPOINT = `/api/companies/${COMPANY_ID}/mcp-catalog`;
const PREVIEW_ENDPOINT = `/api/companies/${COMPANY_ID}/mcp-catalog/preview`;

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

describe("GET /companies/:companyId/mcp-catalog", () => {
  it("lists only verified/ entries from the canonical catalog", async () => {
    const app = await createTestApp();
    const res = await request(app).get(LIST_ENDPOINT);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBeGreaterThan(0);
    for (const entry of res.body.entries as Array<{ catalogId: string; server: { catalogId: string } }>) {
      expect(entry.catalogId.startsWith("verified/")).toBe(true);
      expect(entry.server.catalogId.startsWith("verified/")).toBe(true);
    }
    assertNoSecretShape(JSON.stringify(res.body));
  });

  it("forbids cross-company access", async () => {
    const app = await createTestApp({
      companyIds: ["company-other"],
      source: "explicit",
      memberships: [
        { companyId: "company-other", status: "active", membershipRole: "owner" },
      ],
    });
    const res = await request(app).get(LIST_ENDPOINT);
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers", async () => {
    const app = await createTestApp({
      type: "none",
      userId: undefined,
      companyIds: undefined,
      source: undefined,
    });
    const res = await request(app).get(LIST_ENDPOINT);
    expect(res.status).toBe(401);
  });

  it("surfaces only allowlist-accepting entries when the catalog mixes verified and unverified", async () => {
    const { mcpCatalogService } = await vi.importActual<typeof import("../services/mcp-catalog.js")>(
      "../services/mcp-catalog.js",
    );
    const svc = mcpCatalogService({
      entries: [
        {
          provider: "official_registry",
          id: "verified/safe",
          name: "Safe MCP",
          transport: "stdio",
          requiredEnv: [],
          tools: [],
        },
        {
          provider: "smithery",
          id: "smithery/random",
          name: "Random MCP",
          transport: "stdio",
          requiredEnv: [],
          tools: [],
        },
      ],
    });
    const app = await createTestApp({}, svc);
    const res = await request(app).get(LIST_ENDPOINT);
    expect(res.status).toBe(200);
    const ids = (res.body.entries as Array<{ catalogId: string }>).map((e) => e.catalogId);
    expect(ids).toEqual(["verified/safe"]);
  });
});

describe("POST /companies/:companyId/mcp-catalog/preview", () => {
  it("returns a preview-only response for an allowlisted catalogId", async () => {
    const app = await createTestApp();
    const res = await request(app)
      .post(PREVIEW_ENDPOINT)
      .send({ catalogId: "verified/paperclip-kernel" });
    expect(res.status).toBe(200);
    expect(res.body.applyPath).toBe("preview_only");
    expect(res.body.catalogId).toBe("verified/paperclip-kernel");
    expect(res.body.server.catalogId).toBe("verified/paperclip-kernel");
    expect(res.body.preview).toBeDefined();
    expect(Array.isArray(res.body.preview.blockers)).toBe(true);
    expect(res.body).not.toHaveProperty("planId");
    expect(res.body).not.toHaveProperty("approvalId");
    assertNoSecretShape(JSON.stringify(res.body));
  });

  it("refuses a non-allowlisted catalogId with 422 capability_apply_catalog_not_allowlisted", async () => {
    const { mcpCatalogService } = await vi.importActual<typeof import("../services/mcp-catalog.js")>(
      "../services/mcp-catalog.js",
    );
    const svc = mcpCatalogService({
      entries: [],
      allowlist: { isAllowed: () => false },
    });
    const app = await createTestApp({}, svc);
    const res = await request(app)
      .post(PREVIEW_ENDPOINT)
      .send({ catalogId: "smithery/random" });
    expect(res.status).toBe(422);
    expect(res.body.details?.code).toBe("capability_apply_catalog_not_allowlisted");
  });

  it("returns 404 when the catalogId is allowlisted but not in the canonical set", async () => {
    const app = await createTestApp();
    const res = await request(app)
      .post(PREVIEW_ENDPOINT)
      .send({ catalogId: "verified/does-not-exist" });
    expect(res.status).toBe(404);
    expect(res.body.details?.code).toBe("MCP_CATALOG_NOT_FOUND");
  });

  it("surfaces missing required secret refs when none are supplied", async () => {
    const app = await createTestApp();
    const res = await request(app)
      .post(PREVIEW_ENDPOINT)
      .send({ catalogId: "verified/github-readonly" });
    expect(res.status).toBe(200);
    expect(res.body.missingRequiredSecretRefs).toEqual(
      expect.arrayContaining(["GITHUB_TOKEN"]),
    );
    expect(res.body.suppliedSecretRefs).toEqual([]);
  });

  it("accepts a well-formed named secret reference", async () => {
    const app = await createTestApp();
    const res = await request(app)
      .post(PREVIEW_ENDPOINT)
      .send({
        catalogId: "verified/github-readonly",
        namedSecretRefs: ["GITHUB_TOKEN"],
      });
    expect(res.status).toBe(200);
    expect(res.body.suppliedSecretRefs).toEqual(["GITHUB_TOKEN"]);
    expect(res.body.missingRequiredSecretRefs).toEqual([]);
    assertNoSecretShape(JSON.stringify(res.body));
  });

  it("rejects a value that looks like a raw secret WITHOUT echoing it", async () => {
    const app = await createTestApp();
    const RAW_LIKE = "ghp_fakeFakeFakeFakeFakeFakeFakeFakeFAKE";
    const res = await request(app)
      .post(PREVIEW_ENDPOINT)
      .send({
        catalogId: "verified/github-readonly",
        namedSecretRefs: [RAW_LIKE],
      });
    expect(res.status).toBe(400);
    expect(res.body.details?.code).toBe("MCP_CATALOG_RAW_SECRET_REJECTED");
    expect(JSON.stringify(res.body)).not.toContain(RAW_LIKE);
    assertNoSecretShape(JSON.stringify(res.body));
  });

  it("rejects names that don't match the env-style identifier shape", async () => {
    const app = await createTestApp();
    const res = await request(app)
      .post(PREVIEW_ENDPOINT)
      .send({
        catalogId: "verified/github-readonly",
        namedSecretRefs: ["lowercase-name"],
      });
    expect(res.status).toBe(400);
    expect(["MCP_CATALOG_INVALID_SECRET_REF", "MCP_CATALOG_RAW_SECRET_REJECTED"]).toContain(
      res.body.details?.code,
    );
  });

  it("rejects more than 16 supplied secret references", async () => {
    const app = await createTestApp();
    const refs = Array.from({ length: 17 }, (_, i) => `REF_${i}`);
    const res = await request(app)
      .post(PREVIEW_ENDPOINT)
      .send({ catalogId: "verified/github-readonly", namedSecretRefs: refs });
    expect(res.status).toBe(400);
  });

  it("validates the catalogId field shape (400 on empty body)", async () => {
    const app = await createTestApp();
    const res = await request(app).post(PREVIEW_ENDPOINT).send({});
    expect(res.status).toBe(400);
  });

  it("forbids cross-company access", async () => {
    const app = await createTestApp({
      companyIds: ["company-other"],
      source: "explicit",
      memberships: [
        { companyId: "company-other", status: "active", membershipRole: "owner" },
      ],
    });
    const res = await request(app)
      .post(PREVIEW_ENDPOINT)
      .send({ catalogId: "verified/paperclip-kernel" });
    expect(res.status).toBe(403);
  });
});
