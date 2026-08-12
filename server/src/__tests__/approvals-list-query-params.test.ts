import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

function createRouteDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
        })),
      })),
    })),
  } as any;
}

async function createApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
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
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "generic",
    status: "pending",
    payload: { dedupKey: "issue:ENG-1234" },
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

const LIST_PATH = "/api/companies/company-1/approvals";

describe("GET /companies/:companyId/approvals query params", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.list.mockReset();
    mockApprovalService.list.mockResolvedValue([approvalRow()]);
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
  });

  describe("unknown params fail loud instead of returning the full set", () => {
    // The regression this endpoint is being fixed for: an unimplemented filter
    // silently returned every row, so a caller could not tell "filter matched
    // nothing" from "filter never ran".
    it.each([
      ["q", `${LIST_PATH}?q=anything`],
      ["search", `${LIST_PATH}?search=anything`],
      ["page", `${LIST_PATH}?page=2`],
      ["dedupkey", `${LIST_PATH}?dedupkey=wrong-case`],
    ])("rejects ?%s with 400", async (param, path) => {
      const app = await createApp();
      const res = await request(app).get(path);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain(param);
      expect(res.body.unsupported).toEqual([param]);
      expect(mockApprovalService.list).not.toHaveBeenCalled();
      // Generous: the first case in the file pays the route module-graph import.
    }, 30_000);

    it("names every unsupported param and advertises the supported set", async () => {
      const app = await createApp();
      const res = await request(app).get(`${LIST_PATH}?search=x&nonsense=y`);

      expect(res.status).toBe(400);
      expect(res.body.unsupported).toEqual(["nonsense", "search"]);
      expect(res.body.supported).toEqual(["dedupKey", "limit", "offset", "status"]);
      // The hint is what lets an agent self-correct rather than retry blindly.
      expect(res.body.error).toContain("status=");
    });
  });

  describe("supported filters reach the service", () => {
    it("forwards status", async () => {
      const app = await createApp();
      const res = await request(app).get(`${LIST_PATH}?status=pending`);

      expect(res.status).toBe(200);
      expect(mockApprovalService.list).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ status: "pending" }),
      );
    });

    it("forwards dedupKey", async () => {
      const app = await createApp();
      const res = await request(app).get(`${LIST_PATH}?dedupKey=issue%3AENG-1234`);

      expect(res.status).toBe(200);
      expect(mockApprovalService.list).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ dedupKey: "issue:ENG-1234" }),
      );
    });

    it("returns an empty list — not the full set — when dedupKey matches nothing", async () => {
      mockApprovalService.list.mockResolvedValue([]);
      const app = await createApp();
      const res = await request(app).get(`${LIST_PATH}?dedupKey=zzzznonsense`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("forwards limit and offset together", async () => {
      const app = await createApp();
      const res = await request(app).get(`${LIST_PATH}?limit=5&offset=10`);

      expect(res.status).toBe(200);
      expect(mockApprovalService.list).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ limit: 5, offset: 10 }),
      );
    });

    it("leaves limit undefined when unset so the full set is returned", async () => {
      const app = await createApp();
      const res = await request(app).get(LIST_PATH);

      expect(res.status).toBe(200);
      expect(mockApprovalService.list).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ limit: undefined, offset: undefined }),
      );
    });
  });

  describe("malformed pagination values are rejected, not coerced", () => {
    it.each([
      ["limit=0", "limit must be"],
      ["limit=-1", "limit must be"],
      ["limit=abc", "limit must be"],
      ["limit=100000", "limit must be"],
      ["offset=abc&limit=5", "offset must be"],
      // Digit-only but past Number.MAX_SAFE_INTEGER: parseInt yields an imprecise
      // float that Postgres rejects outright, so an unguarded value 500s instead of
      // returning the documented 400.
      ["offset=99999999999999999999&limit=5", "offset must be"],
    ])("rejects ?%s", async (query, expectedError) => {
      const app = await createApp();
      const res = await request(app).get(`${LIST_PATH}?${query}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain(expectedError);
      expect(mockApprovalService.list).not.toHaveBeenCalled();
    });

    it("rejects offset without limit rather than silently ignoring it", async () => {
      const app = await createApp();
      const res = await request(app).get(`${LIST_PATH}?offset=100`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("offset requires limit");
      expect(mockApprovalService.list).not.toHaveBeenCalled();
    });

    it("rejects a repeated dedupKey instead of picking one arbitrarily", async () => {
      const app = await createApp();
      const res = await request(app).get(`${LIST_PATH}?dedupKey=a&dedupKey=b`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("dedupKey must be a single string value");
      expect(mockApprovalService.list).not.toHaveBeenCalled();
    });

    // Express parses a repeated key into an array, which `eq()` cannot filter
    // on. This endpoint has never supported repeated values (unlike issues,
    // where `status` is legitimately CSV-or-repeated).
    it("rejects a repeated status rather than building a bad query", async () => {
      const app = await createApp();
      const res = await request(app).get(`${LIST_PATH}?status=pending&status=approved`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("status must be a single string value");
      expect(mockApprovalService.list).not.toHaveBeenCalled();
    });

    // Bracket syntax needs no special handling: the app uses Express's simple
    // query parser, so `status[]` arrives as a literal key the allow-list
    // already rejects.
    it("rejects bracketed status[] as an unsupported parameter name", async () => {
      const app = await createApp();
      const res = await request(app).get(`${LIST_PATH}?status[]=pending`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("status[]");
      expect(mockApprovalService.list).not.toHaveBeenCalled();
    });
  });
});
