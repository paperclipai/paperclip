import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPortabilityService = vi.hoisted(() => ({
  previewExport: vi.fn(),
  exportBundle: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockTransferRunService = vi.hoisted(() => ({
  resumeOrCreate: vi.fn(),
  getRunForActor: vi.fn(),
  recordCompletedPart: vi.fn(),
  claimApply: vi.fn(),
  releaseApplyClaim: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({ list: vi.fn().mockResolvedValue([]) }),
  budgetService: () => ({}),
  companyArtifactsService: () => ({}),
  companyPortabilityService: () => mockPortabilityService,
  companyService: () => ({}),
  feedbackService: () => ({}),
  logActivity: mockLogActivity,
  workTimelineService: () => ({}),
}));

vi.mock("../services/company-transfer-runs.js", () => ({
  companyTransferRunService: mockTransferRunService,
}));

const TRANSFER_ID = "6e0a4f6e-6f7d-4a37-9a83-0b8f2f9f2b11";

/**
 * Every route in the company-import surface. The floor must answer all of
 * them, including the read-only polling routes: with imports disabled no job
 * or transfer can exist, so a uniform 403 is clearer than a mixed surface.
 */
const IMPORT_ROUTES: Array<{ method: "get" | "post" | "put"; path: string }> = [
  { method: "post", path: "/api/companies/import/preview" },
  { method: "post", path: "/api/companies/import" },
  { method: "get", path: "/api/companies/import/jobs/some-job" },
  { method: "post", path: "/api/companies/import/transfers" },
  { method: "put", path: `/api/companies/import/transfers/${TRANSFER_ID}/parts/0` },
  { method: "get", path: `/api/companies/import/transfers/${TRANSFER_ID}` },
  { method: "post", path: `/api/companies/import/transfers/${TRANSFER_ID}/preview` },
  { method: "post", path: `/api/companies/import/transfers/${TRANSFER_ID}/apply` },
  { method: "post", path: "/api/companies/11111111-2222-4333-8444-555555555555/imports/preview" },
  { method: "post", path: "/api/companies/11111111-2222-4333-8444-555555555555/imports/apply" },
];

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/companies.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardAdmin = {
  type: "board",
  source: "local_implicit",
  userId: "local-user",
  isInstanceAdmin: true,
};

function expectNoImportWork() {
  expect(mockPortabilityService.previewImport).not.toHaveBeenCalled();
  expect(mockPortabilityService.importBundle).not.toHaveBeenCalled();
  expect(mockTransferRunService.resumeOrCreate).not.toHaveBeenCalled();
  expect(mockTransferRunService.getRunForActor).not.toHaveBeenCalled();
}

describe("company import Cloud floor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
    delete process.env.PAPERCLIP_HIDDEN_SETTINGS;
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
    delete process.env.PAPERCLIP_HIDDEN_SETTINGS;
  });

  it("returns 403 cloud_managed on every import route on a cloud-managed instance", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-secret";
    const app = await createApp(boardAdmin);

    for (const route of IMPORT_ROUTES) {
      const res = await request(app)[route.method](route.path).send({});
      expect(res.status, `${route.method.toUpperCase()} ${route.path}`).toBe(403);
      expect(res.body, `${route.method.toUpperCase()} ${route.path}`).toMatchObject({
        code: "cloud_managed",
      });
    }
    expectNoImportWork();
  });

  it("floors on the managed-config signal alone", async () => {
    process.env.PAPERCLIP_MANAGED_CONFIG = JSON.stringify({ v: 1, mode: "cloud" });
    const app = await createApp(boardAdmin);

    const res = await request(app).post("/api/companies/import").send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "cloud_managed" });
    expectNoImportWork();
  });

  it("applies the floor before auth and request-body validation", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-secret";
    // An agent actor never passes the import routes' own assertBoard, and the
    // body is not schema-valid either — the floor must still answer first so a
    // Cloud caller sees one consistent refusal.
    const app = await createApp({ type: "agent", agentId: "agent-1", companyId: "company-1" });

    const res = await request(app)
      .post("/api/companies/import/transfers")
      .send({ nonsense: true });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "cloud_managed" });
    expectNoImportWork();
  });

  it("floors every import route with settings_operator_managed when company.import is hidden", async () => {
    process.env.PAPERCLIP_HIDDEN_SETTINGS = "company.import";
    const app = await createApp(boardAdmin);

    for (const route of IMPORT_ROUTES) {
      const res = await request(app)[route.method](route.path).send({});
      expect(res.status, `${route.method.toUpperCase()} ${route.path}`).toBe(403);
      expect(res.body, `${route.method.toUpperCase()} ${route.path}`).toMatchObject({
        code: "settings_operator_managed",
      });
    }
    expectNoImportWork();
  });

  it("keeps import open when only other company pages are hidden", async () => {
    process.env.PAPERCLIP_HIDDEN_SETTINGS = "company.secrets,company.members";
    const app = await createApp(boardAdmin);

    const res = await request(app).get("/api/companies/import/jobs/unknown-job");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Import job not found" });
  });

  it("keeps company export open on a cloud-managed instance", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-secret";
    mockPortabilityService.exportBundle.mockResolvedValue({ ok: true });
    const app = await createApp(boardAdmin);

    const res = await request(app)
      .post("/api/companies/11111111-2222-4333-8444-555555555555/exports")
      .send({});

    expect(res.status).toBe(200);
    expect(mockPortabilityService.exportBundle).toHaveBeenCalledTimes(1);
  });

  it("preserves self-hosted import preview", async () => {
    mockPortabilityService.previewImport.mockResolvedValue({ companies: [] });
    const app = await createApp(boardAdmin);

    const res = await request(app)
      .post("/api/companies/import/preview")
      .send({
        source: { type: "github", url: "https://github.com/example/export" },
        target: { mode: "new_company" },
      });

    expect(res.status).toBe(200);
    expect(mockPortabilityService.previewImport).toHaveBeenCalledTimes(1);
  });

  it("preserves self-hosted import job polling", async () => {
    const app = await createApp(boardAdmin);

    const res = await request(app).get("/api/companies/import/jobs/unknown-job");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Import job not found" });
  });
});
