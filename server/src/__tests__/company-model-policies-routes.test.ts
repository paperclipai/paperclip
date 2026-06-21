import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockCompanyModelPolicyService = vi.hoisted(() => ({
  getCompanyPolicy: vi.fn(),
  setCompanyPolicy: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  companyModelPolicyService: () => mockCompanyModelPolicyService,
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  logActivity: mockLogActivity,
}));

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { companyModelPolicyRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/company-model-policies.js") as Promise<
      typeof import("../routes/company-model-policies.js")
    >,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", companyModelPolicyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.sequential("company model policy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyModelPolicyService.getCompanyPolicy.mockReset();
    mockCompanyModelPolicyService.setCompanyPolicy.mockReset();
    for (const mock of Object.values(mockAccessService)) mock.mockReset();
    mockAgentService.getById.mockReset();
    mockLogActivity.mockReset();

    // Default: empty policy, access allowed
    mockCompanyModelPolicyService.getCompanyPolicy.mockResolvedValue([]);
    mockCompanyModelPolicyService.setCompanyPolicy.mockImplementation(
      async (_companyId: string, rules: unknown) => rules,
    );
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
  });

  it("GET returns empty rules initially", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/model-policies"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ rules: [] });
  });

  it("PUT with valid rules saves and returns them; subsequent GET returns updated rules", async () => {
    const validRules = [
      { when: { agentRole: ["engineer"] }, modelProfile: "cheap" },
    ];

    let storedRules: unknown[] = [];
    mockCompanyModelPolicyService.setCompanyPolicy.mockImplementation(
      async (_companyId: string, rules: unknown) => {
        storedRules = rules as unknown[];
        return rules;
      },
    );
    mockCompanyModelPolicyService.getCompanyPolicy.mockImplementation(async () => storedRules);

    const app = await createApp();

    const putRes = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .put("/api/companies/company-1/model-policies")
        .send({ rules: validRules }),
    );

    expect(putRes.status, JSON.stringify(putRes.body)).toBe(200);
    expect(putRes.body).toEqual({ rules: validRules });

    const getRes = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/model-policies"),
    );

    expect(getRes.status, JSON.stringify(getRes.body)).toBe(200);
    expect(getRes.body).toEqual({ rules: validRules });
  });

  it("PUT with invalid modelProfile returns 400", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .put("/api/companies/company-1/model-policies")
        .send({ rules: [{ when: {}, modelProfile: "not-a-valid-profile" }] }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it("access to another company's policies is forbidden (403)", async () => {
    // Actor only has access to company-1; requests company-2
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-2/model-policies"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });
});
