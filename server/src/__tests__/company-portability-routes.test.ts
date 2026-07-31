import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockCompanyArtifactsService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: () => mockBudgetService,
}));

vi.mock("../services/companies.js", () => ({
  companyService: () => mockCompanyService,
}));

vi.mock("../services/company-portability.js", () => ({
  companyPortabilityService: () => mockCompanyPortabilityService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyArtifactsService: () => mockCompanyArtifactsService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
}));

function registerCompanyRouteMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    budgetService: () => mockBudgetService,
    companyArtifactsService: () => mockCompanyArtifactsService,
    companyPortabilityService: () => mockCompanyPortabilityService,
    companyService: () => mockCompanyService,
    feedbackService: () => mockFeedbackService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  }));
}

let appImportCounter = 0;

async function createApp(actor: Record<string, unknown>) {
  registerCompanyRouteMocks();
  appImportCounter += 1;
  const routeModulePath = `../routes/companies.js?company-portability-routes-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?company-portability-routes-${appImportCounter}`;
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/companies.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
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

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const ceoAgentId = "ceo-agent";
const engineerAgentId = "engineer-agent";

const exportRequest = {
  include: { company: true, agents: true, projects: true },
};

function createExportResult() {
  return {
    rootPath: "paperclip",
    manifest: {
      agents: [],
      skills: [],
      projects: [],
      issues: [],
      envInputs: [],
      includes: { company: true, agents: true, projects: true, issues: false, skills: false },
      company: null,
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      source: null,
    },
    files: {},
    warnings: [],
  };
}

const importRequest = {
  source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
  include: { company: true, agents: true, projects: false, issues: false },
  target: { mode: "existing_company", companyId },
  collisionStrategy: "rename",
};

const cloudHeaders = {
  "x-paperclip-cloud-stack-id": "stack-alpha",
  "x-paperclip-cloud-paperclip-company-id": companyId,
};

function cloudTenantActor() {
  return {
    type: "board",
    userId: "cloud-user-1",
    userName: "Cloud User",
    userEmail: "cloud-user@example.com",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
    source: "cloud_tenant",
  };
}

function createImportResult(action = "updated") {
  return {
    company: { id: companyId, action },
    agents: [{ id: "agent-1" }],
    warnings: [],
  };
}

async function waitForImportJobStatus(app: express.Express, statusUrl: string, status: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const res = await request(app).get(statusUrl).set(cloudHeaders);
    if (res.body.job?.status === status) {
      return res;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for import job to reach ${status}`);
}

async function waitForCondition(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const TEST_USER_HEADER = "x-test-user-id";

function boardActor(userId: string) {
  return {
    type: "board",
    userId,
    userName: "Board User",
    userEmail: `${userId}@example.com`,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
    source: "session",
  };
}

// A single companyRoutes instance (one shared in-memory job map) whose board
// actor is chosen per request from the `x-test-user-id` header. This lets one
// app exercise cross-user isolation and the per-user duplicate guard.
async function createBoardApp() {
  registerCompanyRouteMocks();
  appImportCounter += 1;
  const routeModulePath = `../routes/companies.js?company-portability-routes-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?company-portability-routes-${appImportCounter}`;
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/companies.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const header = req.headers[TEST_USER_HEADER];
    const userId = typeof header === "string" && header.length > 0 ? header : "board-user-a";
    (req as any).actor = boardActor(userId);
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function waitForImportJobStatusAs(
  app: express.Express,
  statusUrl: string,
  status: string,
  headers: Record<string, string>,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const res = await request(app).get(statusUrl).set(headers);
    if (res.body.job?.status === status) {
      return res;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for import job to reach ${status}`);
}

// A minimal STORE-only zip writer so the multipart/zip upload path can be
// exercised end-to-end: the route unzips this into the same inline bundle an
// application/json caller would send. Layout matches ui/src/lib/zip.ts (local
// file headers, central directory, end-of-central-directory).
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoreZip(files: Record<string, string>, rootPath: string): Buffer {
  const encoder = new TextEncoder();
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let localOffset = 0;
  const entries = Object.entries(files);

  for (const [relativePath, content] of entries) {
    const fileName = encoder.encode(`${rootPath}/${relativePath}`);
    const body = Buffer.from(encoder.encode(content));
    const checksum = crc32(body);

    const localHeader = Buffer.alloc(30 + fileName.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    Buffer.from(fileName).copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + fileName.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(body.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    Buffer.from(fileName).copy(centralHeader, 46);

    localChunks.push(localHeader, body);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + body.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

// The import fields a multipart caller ships as the JSON `meta` field: the same
// object an inline caller sends, minus `source` (the source is the uploaded zip).
const importMeta = {
  include: importRequest.include,
  target: importRequest.target,
  collisionStrategy: importRequest.collisionStrategy,
};

describe.sequential("company portability routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockImplementation(async (id: string) => ({
      id,
      companyId,
      role: id === ceoAgentId ? "ceo" : "engineer",
    }));
    mockCompanyPortabilityService.exportBundle.mockResolvedValue(createExportResult());
    mockCompanyPortabilityService.previewExport.mockResolvedValue({
      rootPath: "paperclip",
      manifest: { agents: [], skills: [], projects: [], issues: [], envInputs: [], includes: { company: true, agents: true, projects: true, issues: false, skills: false }, company: null, schemaVersion: 1, generatedAt: new Date().toISOString(), source: null },
      files: {},
      fileInventory: [],
      counts: { files: 0, agents: 0, skills: 0, projects: 0, issues: 0 },
      warnings: [],
      paperclipExtensionPath: ".paperclip.yaml",
    });
    mockCompanyPortabilityService.previewImport.mockResolvedValue({ ok: true });
    mockCompanyPortabilityService.importBundle.mockResolvedValue({
      company: { id: companyId, action: "created" },
      agents: [],
      warnings: [],
    });
  });

  it.sequential("rejects non-CEO agents from CEO-safe export preview routes", async () => {
    const app = await createApp({
      type: "agent",
      agentId: engineerAgentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/exports/preview`)
      .send(exportRequest);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
  });

  it.sequential("rejects non-CEO export preview callers before validating request shape", async () => {
    const app = await createApp({
      type: "agent",
      agentId: engineerAgentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/exports/preview`)
      .send({ agents: [123] });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
  });

  it.sequential("rejects non-CEO agents from legacy and CEO-safe export bundle routes", async () => {
    const app = await createApp({
      type: "agent",
      agentId: engineerAgentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    for (const path of [`/api/companies/${companyId}/export`, `/api/companies/${companyId}/exports`]) {
      const res = await request(app).post(path).send(exportRequest);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only CEO agents");
    }
    expect(mockCompanyPortabilityService.exportBundle).not.toHaveBeenCalled();
  });

  it.sequential("allows CEO agents to use company-scoped export preview routes", async () => {
    mockCompanyPortabilityService.previewExport.mockResolvedValue({
      rootPath: "paperclip",
      manifest: { agents: [], skills: [], projects: [], issues: [], envInputs: [], includes: { company: true, agents: true, projects: true, issues: false, skills: false }, company: null, schemaVersion: 1, generatedAt: new Date().toISOString(), source: null },
      files: {},
      fileInventory: [],
      counts: { files: 0, agents: 0, skills: 0, projects: 0, issues: 0 },
      warnings: [],
      paperclipExtensionPath: ".paperclip.yaml",
    });
    const app = await createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/exports/preview`)
      .send(exportRequest);

    expect(res.status).toBe(200);
    expect(res.body.rootPath).toBe("paperclip");
  });

  it.sequential("allows CEO agents to export through legacy and CEO-safe bundle routes", async () => {
    mockCompanyPortabilityService.exportBundle.mockResolvedValue(createExportResult());
    const app = await createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    for (const path of [`/api/companies/${companyId}/export`, `/api/companies/${companyId}/exports`]) {
      const res = await request(app).post(path).send(exportRequest);

      expect(res.status).toBe(200);
      expect(res.body.rootPath).toBe("paperclip");
    }
    expect(mockCompanyPortabilityService.exportBundle).toHaveBeenCalledTimes(2);
    expect(mockCompanyPortabilityService.exportBundle).toHaveBeenNthCalledWith(1, companyId, exportRequest);
    expect(mockCompanyPortabilityService.exportBundle).toHaveBeenNthCalledWith(2, companyId, exportRequest);
  });

  it.sequential("allows board users to export through legacy and CEO-safe bundle routes", async () => {
    mockCompanyPortabilityService.exportBundle.mockResolvedValue(createExportResult());
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    for (const path of [`/api/companies/${companyId}/export`, `/api/companies/${companyId}/exports`]) {
      const res = await request(app).post(path).send(exportRequest);

      expect(res.status).toBe(200);
      expect(res.body.rootPath).toBe("paperclip");
    }
    expect(mockCompanyPortabilityService.exportBundle).toHaveBeenCalledTimes(2);
  });

  it.sequential("rejects CEO agents from exporting another company before services run", async () => {
    const app = await createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    for (const path of [
      `/api/companies/${otherCompanyId}/export`,
      `/api/companies/${otherCompanyId}/exports`,
      `/api/companies/${otherCompanyId}/exports/preview`,
    ]) {
      const res = await request(app).post(path).send(exportRequest);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("another company");
    }
    expect(mockCompanyPortabilityService.exportBundle).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it.sequential("rejects replace collision strategy on CEO-safe import routes", async () => {
    const app = await createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "replace",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("does not allow replace");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it.sequential("rejects CEO agents from previewing or applying imports against another route company", async () => {
    const app = await createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    for (const path of [
      `/api/companies/${otherCompanyId}/imports/preview`,
      `/api/companies/${otherCompanyId}/imports/apply`,
    ]) {
      const res = await request(app).post(path).send({
        ...importRequest,
        target: { mode: "existing_company", companyId: otherCompanyId },
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("another company");
    }
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it.sequential("rejects CEO-safe import bodies that target a different company than the route", async () => {
    const app = await createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    for (const path of [
      `/api/companies/${companyId}/imports/preview`,
      `/api/companies/${companyId}/imports/apply`,
    ]) {
      const res = await request(app).post(path).send({
        ...importRequest,
        target: { mode: "existing_company", companyId: otherCompanyId },
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("only target the route company");
    }
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it.sequential("keeps global import preview routes board-only", async () => {
    const app = await createApp({
      type: "agent",
      agentId: engineerAgentId,
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/import/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });

  it.sequential("keeps global import preview board-only before validating request shape", async () => {
    const app = await createApp({
      type: "agent",
      agentId: engineerAgentId,
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/import/preview")
      .send({ target: { mode: "existing_company", companyId: "not-a-uuid" } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it.sequential("requires instance admin for new-company import preview", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["11111111-1111-4111-8111-111111111111"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/import/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "new_company", newCompanyName: "Imported Test" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it.sequential("rejects replace collision strategy on CEO-safe import apply routes", async () => {
    const app = await createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/apply")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "replace",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("does not allow replace");
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it.sequential("rejects non-CEO agents from CEO-safe import preview routes", async () => {
    const app = await createApp({
      type: "agent",
      agentId: engineerAgentId,
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it.sequential("rejects non-CEO import preview callers before validating request shape", async () => {
    const app = await createApp({
      type: "agent",
      agentId: engineerAgentId,
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/preview")
      .send({ target: { mode: "existing_company", companyId: "not-a-uuid" } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it.sequential("rejects non-CEO agents from CEO-safe import apply routes", async () => {
    const app = await createApp({
      type: "agent",
      agentId: engineerAgentId,
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/apply")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it.sequential("requires instance admin for new-company import apply", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["11111111-1111-4111-8111-111111111111"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/import")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "new_company", newCompanyName: "Imported Test" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it.sequential("accepts trusted Cloud async import jobs and reports success by job id", async () => {
    let resolveImport: (value: ReturnType<typeof createImportResult>) => void = () => undefined;
    const pendingImport = new Promise<ReturnType<typeof createImportResult>>((resolve) => {
      resolveImport = resolve;
    });
    mockCompanyPortabilityService.importBundle.mockReturnValueOnce(pendingImport);
    const app = await createApp(cloudTenantActor());

    const accepted = await request(app)
      .post("/api/companies/import")
      .set("x-paperclip-cloud-async-import", "1")
      .set(cloudHeaders)
      .send(importRequest);

    expect(accepted.status).toBe(202);
    expect(accepted.body.job.status).toBe("running");
    expect(accepted.body.statusUrl).toMatch(/^\/api\/companies\/import\/jobs\/tenant-import-/);
    expect(accepted.body.retryAfterMs).toBe(1000);
    await waitForCondition(() => mockCompanyPortabilityService.importBundle.mock.calls.length === 1, "import job start");
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledWith(importRequest, "cloud-user-1", { pauseAutomations: false });
    expect(mockLogActivity).not.toHaveBeenCalled();

    resolveImport(createImportResult("updated"));
    const succeeded = await waitForImportJobStatus(app, accepted.body.statusUrl, "succeeded");

    expect(succeeded.status).toBe(200);
    expect(succeeded.body.job.status).toBe("succeeded");
    expect(succeeded.body.job.result.companyId).toBe(companyId);
    expect(succeeded.body.retryAfterMs).toBeUndefined();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.imported",
      companyId,
      details: expect.objectContaining({
        agentCount: 1,
        warningCount: 0,
        companyAction: "updated",
      }),
    }));

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse(succeeded.body.job.completedAt) + (5 * 60 * 1000) + 1);
    try {
      const expired = await request(app).get(accepted.body.statusUrl).set(cloudHeaders);
      expect(expired.status).toBe(404);
      expect(expired.body.error).toBe("Import job not found");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.sequential("reports trusted Cloud async import job failures with the tenant error message", async () => {
    mockCompanyPortabilityService.importBundle.mockRejectedValueOnce(new Error("tenant import exploded"));
    const app = await createApp(cloudTenantActor());

    const accepted = await request(app)
      .post("/api/companies/import")
      .set("x-paperclip-cloud-async-import", "1")
      .set(cloudHeaders)
      .send(importRequest);

    expect(accepted.status).toBe(202);
    const failed = await waitForImportJobStatus(app, accepted.body.statusUrl, "failed");

    expect(failed.status).toBe(200);
    expect(failed.body.job.status).toBe("failed");
    expect(failed.body.job.error.message).toBe("tenant import exploded");
    expect(failed.body.retryAfterMs).toBeUndefined();
    expect(failed.body.message).toBe("tenant import exploded");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it.sequential("accepts trusted Cloud async import jobs before validating the full import payload", async () => {
    const app = await createApp(cloudTenantActor());

    const accepted = await request(app)
      .post("/api/companies/import")
      .set("x-paperclip-cloud-async-import", "1")
      .set(cloudHeaders)
      .send({ target: { mode: "existing_company", companyId } });

    expect(accepted.status).toBe(202);
    expect(accepted.body.job.status).toBe("running");
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();

    const failed = await waitForImportJobStatus(app, accepted.body.statusUrl, "failed");

    expect(failed.status).toBe(200);
    expect(failed.body.job.status).toBe("failed");
    expect(failed.body.job.error.message).toEqual(expect.any(String));
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it.sequential("keeps global import apply synchronous when Cloud async opt-in is absent", async () => {
    mockCompanyPortabilityService.importBundle.mockResolvedValueOnce(createImportResult("created"));
    const app = await createApp(cloudTenantActor());

    const res = await request(app)
      .post("/api/companies/import")
      .set(cloudHeaders)
      .send(importRequest);

    expect(res.status).toBe(200);
    expect(res.body.company.id).toBe(companyId);
    expect(res.body.company.action).toBe("created");
    expect(res.body.job).toBeUndefined();
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledWith(importRequest, "cloud-user-1", { pauseAutomations: false });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.imported",
      companyId,
    }));
  });

  it.sequential("forwards pauseAutomations from the global import body to the portability service", async () => {
    mockCompanyPortabilityService.importBundle.mockResolvedValueOnce(createImportResult("created"));
    const app = await createApp(cloudTenantActor());

    const res = await request(app)
      .post("/api/companies/import")
      .set(cloudHeaders)
      .send({ ...importRequest, pauseAutomations: true });

    expect(res.status).toBe(200);
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledWith(
      { ...importRequest, pauseAutomations: true },
      "cloud-user-1",
      { pauseAutomations: true },
    );
  });

  it.sequential("runs board-session async imports as jobs and reports the full result by job id", async () => {
    let resolveImport: (value: ReturnType<typeof createImportResult>) => void = () => undefined;
    const pendingImport = new Promise<ReturnType<typeof createImportResult>>((resolve) => {
      resolveImport = resolve;
    });
    mockCompanyPortabilityService.importBundle.mockReturnValueOnce(pendingImport);
    const app = await createBoardApp();

    const accepted = await request(app)
      .post("/api/companies/import")
      .set("x-paperclip-cloud-async-import", "1")
      .set(TEST_USER_HEADER, "board-user-a")
      .send(importRequest);

    expect(accepted.status).toBe(202);
    expect(accepted.body.job.status).toBe("running");
    // Board jobs get their own id prefix, distinct from the tenant-import prefix.
    expect(accepted.body.statusUrl).toMatch(/^\/api\/companies\/import\/jobs\/import-/);
    expect(accepted.body.statusUrl).not.toMatch(/\/jobs\/tenant-import-/);
    await waitForCondition(() => mockCompanyPortabilityService.importBundle.mock.calls.length === 1, "board import start");
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledWith(importRequest, "board-user-a", { pauseAutomations: false });

    const fullResult = createImportResult("created");
    resolveImport(fullResult);
    const succeeded = await waitForImportJobStatusAs(app, accepted.body.statusUrl, "succeeded", {
      [TEST_USER_HEADER]: "board-user-a",
    });

    expect(succeeded.status).toBe(200);
    expect(succeeded.body.job.status).toBe("succeeded");
    expect(succeeded.body.job.result.companyId).toBe(companyId);
    // Parity with the synchronous response: the board job carries the full
    // import result so the import page can run the same activation path.
    expect(succeeded.body.job.importResult).toEqual(fullResult);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.imported",
      companyId,
    }));
  });

  it.sequential("hides a board import job from other board users", async () => {
    mockCompanyPortabilityService.importBundle.mockReturnValueOnce(new Promise(() => undefined));
    const app = await createBoardApp();

    const accepted = await request(app)
      .post("/api/companies/import")
      .set("x-paperclip-cloud-async-import", "1")
      .set(TEST_USER_HEADER, "board-user-a")
      .send(importRequest);

    expect(accepted.status).toBe(202);

    const crossUser = await request(app).get(accepted.body.statusUrl).set(TEST_USER_HEADER, "board-user-b");
    expect(crossUser.status).toBe(404);
    expect(crossUser.body.error).toBe("Import job not found");

    const owner = await request(app).get(accepted.body.statusUrl).set(TEST_USER_HEADER, "board-user-a");
    expect(owner.status).toBe(200);
    expect(owner.body.job.status).toBe("running");
  });

  it.sequential("returns 409 with the running job when a board user resubmits an import", async () => {
    mockCompanyPortabilityService.importBundle.mockReturnValueOnce(new Promise(() => undefined));
    const app = await createBoardApp();

    const first = await request(app)
      .post("/api/companies/import")
      .set("x-paperclip-cloud-async-import", "1")
      .set(TEST_USER_HEADER, "board-user-a")
      .send(importRequest);

    expect(first.status).toBe(202);

    const duplicate = await request(app)
      .post("/api/companies/import")
      .set("x-paperclip-cloud-async-import", "1")
      .set(TEST_USER_HEADER, "board-user-a")
      .send(importRequest);

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.job.id).toBe(first.body.job.id);
    expect(duplicate.body.statusUrl).toBe(first.body.statusUrl);
    // The duplicate submit must not start a second import of the same bundle.
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledTimes(1);

    // A different board user is not blocked by the first user's running job.
    mockCompanyPortabilityService.importBundle.mockReturnValueOnce(new Promise(() => undefined));
    const otherUser = await request(app)
      .post("/api/companies/import")
      .set("x-paperclip-cloud-async-import", "1")
      .set(TEST_USER_HEADER, "board-user-b")
      .send(importRequest);

    expect(otherUser.status).toBe(202);
    expect(otherUser.body.job.id).not.toBe(first.body.job.id);
  });

  it.sequential(
    "rejects a concurrent different import without adopting the running job",
    async () => {
      mockCompanyPortabilityService.importBundle.mockReturnValueOnce(new Promise(() => undefined));
      const app = await createBoardApp();

      const first = await request(app)
        .post("/api/companies/import")
        .set("x-paperclip-cloud-async-import", "1")
        .set(TEST_USER_HEADER, "board-user-a")
        .send(importRequest);

      expect(first.status).toBe(202);

      // Same user, a *different* import (another destination) while the first
      // still runs. It must NOT adopt the first job — adopting would show the
      // wrong result and switch to the wrong company — so the 409 carries no
      // job to watch, and no second import starts.
      const different = await request(app)
        .post("/api/companies/import")
        .set("x-paperclip-cloud-async-import", "1")
        .set(TEST_USER_HEADER, "board-user-a")
        .send({ ...importRequest, target: { mode: "new_company", newCompanyName: "A Different Destination" } });

      expect(different.status).toBe(409);
      expect(different.body.job).toBeUndefined();
      expect(different.body.statusUrl).toBeUndefined();
      expect(different.body.error).toMatch(/different import is already running/i);
      expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledTimes(1);
    },
  );

  it.sequential("fails a board async import job when the bundle import throws", async () => {
    mockCompanyPortabilityService.importBundle.mockRejectedValueOnce(new Error("import payload is incomplete"));
    const app = await createBoardApp();

    const accepted = await request(app)
      .post("/api/companies/import")
      .set("x-paperclip-cloud-async-import", "1")
      .set(TEST_USER_HEADER, "board-user-a")
      .send(importRequest);

    expect(accepted.status).toBe(202);

    const failed = await waitForImportJobStatusAs(app, accepted.body.statusUrl, "failed", {
      [TEST_USER_HEADER]: "board-user-a",
    });

    expect(failed.status).toBe(200);
    expect(failed.body.job.status).toBe("failed");
    expect(failed.body.job.error.message).toBe("import payload is incomplete");
    expect(failed.body.job.importResult).toBeUndefined();
    // A resubmit is allowed once the job is terminal.
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it.sequential("keeps the import job status route board-only", async () => {
    const app = await createApp({
      type: "agent",
      agentId: engineerAgentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/companies/import/jobs/import-does-not-exist");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });

  it.sequential("returns 404 for an unknown import job id", async () => {
    const app = await createBoardApp();

    const res = await request(app)
      .get("/api/companies/import/jobs/import-missing")
      .set(TEST_USER_HEADER, "board-user-a");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Import job not found");
  });

  it.sequential("forwards pauseAutomations from CEO-safe import apply bodies to the portability service", async () => {
    mockCompanyPortabilityService.importBundle.mockResolvedValueOnce(createImportResult("created"));
    const app = await createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/imports/apply`)
      .send({ ...importRequest, pauseAutomations: true });

    expect(res.status).toBe(200);
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledWith(
      { ...importRequest, pauseAutomations: true },
      null,
      { mode: "agent_safe", sourceCompanyId: companyId, pauseAutomations: true },
    );
  });

  it.sequential("imports a company from a multipart zip upload, unzipping into the same inline bundle", async () => {
    const app = await createBoardApp();
    const files = { "COMPANY.md": "---\nname: Test\n---\n", "agents/ceo/AGENTS.md": "---\nname: CEO\n---\n" };
    const zip = buildStoreZip(files, "paperclip");

    const res = await request(app)
      .post("/api/companies/import")
      .set(TEST_USER_HEADER, "board-user-a")
      .field("meta", JSON.stringify(importMeta))
      .attach("package", zip, "paperclip-demo.zip");

    expect(res.status).toBe(200);
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledTimes(1);
    const call = mockCompanyPortabilityService.importBundle.mock.calls[0]!;
    // The uploaded zip is unzipped into the exact inline source the importer
    // consumes; the other import fields ride along from the JSON meta field.
    expect(call[0]).toEqual({ ...importMeta, source: { type: "inline", rootPath: "paperclip", files } });
    expect(call[1]).toBe("board-user-a");
    expect(call[2]).toEqual({ pauseAutomations: false });
  });

  it.sequential("previews a company from a multipart zip upload", async () => {
    const app = await createBoardApp();
    const files = { "COMPANY.md": "---\nname: Test\n---\n" };
    const zip = buildStoreZip(files, "paperclip");

    const res = await request(app)
      .post("/api/companies/import/preview")
      .set(TEST_USER_HEADER, "board-user-a")
      .field("meta", JSON.stringify(importMeta))
      .attach("package", zip, "paperclip-demo.zip");

    expect(res.status).toBe(200);
    expect(mockCompanyPortabilityService.previewImport).toHaveBeenCalledTimes(1);
    const call = mockCompanyPortabilityService.previewImport.mock.calls[0]!;
    expect(call[0]).toEqual({ ...importMeta, source: { type: "inline", rootPath: "paperclip", files } });
  });

  it.sequential("runs a multipart zip import as an async board job via ?async=1", async () => {
    let resolveImport: (value: ReturnType<typeof createImportResult>) => void = () => undefined;
    const pendingImport = new Promise<ReturnType<typeof createImportResult>>((resolve) => {
      resolveImport = resolve;
    });
    mockCompanyPortabilityService.importBundle.mockReturnValueOnce(pendingImport);
    const app = await createBoardApp();
    const files = { "COMPANY.md": "---\nname: Test\n---\n" };
    const zip = buildStoreZip(files, "paperclip");

    const accepted = await request(app)
      .post("/api/companies/import?async=1")
      .set(TEST_USER_HEADER, "board-user-a")
      .field("meta", JSON.stringify(importMeta))
      .attach("package", zip, "paperclip-demo.zip");

    expect(accepted.status).toBe(202);
    expect(accepted.body.job.status).toBe("running");
    expect(accepted.body.statusUrl).toMatch(/^\/api\/companies\/import\/jobs\/import-/);
    await waitForCondition(
      () => mockCompanyPortabilityService.importBundle.mock.calls.length === 1,
      "multipart async import start",
    );
    expect(mockCompanyPortabilityService.importBundle.mock.calls[0]![0]).toEqual({
      ...importMeta,
      source: { type: "inline", rootPath: "paperclip", files },
    });

    const fullResult = createImportResult("created");
    resolveImport(fullResult);
    const succeeded = await waitForImportJobStatusAs(app, accepted.body.statusUrl, "succeeded", {
      [TEST_USER_HEADER]: "board-user-a",
    });
    expect(succeeded.body.job.status).toBe("succeeded");
    expect(succeeded.body.job.importResult).toEqual(fullResult);
  });

  it.sequential("engages the async path for board sessions via ?async=1, not the stripped cloud header", async () => {
    mockCompanyPortabilityService.importBundle.mockReturnValueOnce(new Promise(() => undefined));
    const app = await createBoardApp();

    // The Cloud harness strips inbound x-paperclip-cloud-* headers, so a browser
    // can only opt into async with the proxy-safe query parameter.
    const accepted = await request(app)
      .post("/api/companies/import?async=1")
      .set(TEST_USER_HEADER, "board-user-a")
      .send(importRequest);

    expect(accepted.status).toBe(202);
    expect(accepted.body.job.status).toBe("running");
    expect(accepted.body.statusUrl).toMatch(/^\/api\/companies\/import\/jobs\/import-/);
  });

  it.sequential("keeps a board import synchronous when neither async signal is present", async () => {
    const app = await createBoardApp();

    const res = await request(app)
      .post("/api/companies/import")
      .set(TEST_USER_HEADER, "board-user-a")
      .send(importRequest);

    expect(res.status).toBe(200);
    expect(res.body.company.id).toBe(companyId);
  });

  it.sequential("still engages the async path for cloud tenants via the x-paperclip-cloud-async-import header", async () => {
    mockCompanyPortabilityService.importBundle.mockReturnValueOnce(new Promise(() => undefined));
    const app = await createApp(cloudTenantActor());

    const accepted = await request(app)
      .post("/api/companies/import")
      .set("x-paperclip-cloud-async-import", "1")
      .set(cloudHeaders)
      .send(importRequest);

    expect(accepted.status).toBe(202);
    expect(accepted.body.statusUrl).toMatch(/^\/api\/companies\/import\/jobs\/tenant-import-/);
  });

  it.sequential("rejects a truncated zip upload without importing anything", async () => {
    const app = await createBoardApp();
    const zip = buildStoreZip({ "COMPANY.md": "---\nname: Test\n---\n" }, "paperclip");
    const truncated = zip.subarray(0, 40);

    const res = await request(app)
      .post("/api/companies/import")
      .set(TEST_USER_HEADER, "board-user-a")
      .field("meta", JSON.stringify(importMeta))
      .attach("package", truncated, "paperclip-demo.zip");

    expect(res.status).toBe(400);
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });
});
