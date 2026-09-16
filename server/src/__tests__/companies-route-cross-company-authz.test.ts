import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyAId = "11111111-1111-4111-8111-111111111111";
const companyBId = "22222222-2222-4222-8222-222222222222";
const ceoAgentId = "ceo-agent-a";

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
  list: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  ensureRoleDefaultGrants: vi.fn(),
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

const mockFeedbackService = vi.hoisted(() => ({
  listFeedbackTraces: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerCompanyRouteMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    budgetService: () => mockBudgetService,
    companyArtifactsService: () => mockCompanyArtifactsService,
    companyPortabilityService: () => mockCompanyPortabilityService,
    companyService: () => mockCompanyService,
    feedbackService: () => mockFeedbackService,
    logActivity: mockLogActivity,
  }));
}

let appImportCounter = 0;

async function createApp(actor: Record<string, unknown>) {
  registerCompanyRouteMocks();
  appImportCounter += 1;
  const routeModulePath = `../routes/companies.js?cross-company-authz-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?cross-company-authz-${appImportCounter}`;
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

function createCompany(id: string) {
  const now = new Date("2026-06-18T00:00:00.000Z");
  return {
    id,
    name: id === companyAId ? "Company A" : "Company B",
    description: null,
    status: "active",
    issuePrefix: id === companyAId ? "CPA" : "CPB",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    logoAssetId: null,
    logoUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}

const exportRequest = {
  include: { company: true, agents: true, projects: true },
};

function exportResult() {
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
      generatedAt: "2026-06-18T00:00:00.000Z",
      source: null,
    },
    files: {},
    warnings: [],
  };
}

function exportPreviewResult() {
  return {
    ...exportResult(),
    fileInventory: [],
    counts: { files: 0, agents: 0, skills: 0, projects: 0, issues: 0 },
    paperclipExtensionPath: ".paperclip.yaml",
  };
}

function importRequest(targetCompanyId = companyBId) {
  return {
    source: { type: "inline", files: { "COMPANY.md": "---\nname: Imported\n---\n" } },
    include: { company: true, agents: true, projects: false, issues: false },
    target: { mode: "existing_company", companyId: targetCompanyId },
    collisionStrategy: "rename",
  };
}

function importResult(companyId = companyBId) {
  return {
    company: { id: companyId, action: "updated" },
    agents: [],
    warnings: [],
  };
}

function resetMockDefaults() {
  mockCompanyService.getById.mockImplementation(async (id: string) => {
    if (id === companyAId || id === companyBId) return createCompany(id);
    return null;
  });
  mockCompanyService.update.mockImplementation(async (id: string, body: Record<string, unknown>) => ({
    ...createCompany(id),
    ...body,
  }));
  mockCompanyService.archive.mockImplementation(async (id: string) => ({
    ...createCompany(id),
    status: "archived",
  }));
  mockCompanyService.remove.mockImplementation(async (id: string) => createCompany(id));
  mockAgentService.getById.mockImplementation(async (id: string) => {
    if (id === ceoAgentId) return { id, companyId: companyAId, role: "ceo" };
    return null;
  });
  mockAgentService.list.mockResolvedValue([]);
  mockCompanyPortabilityService.exportBundle.mockResolvedValue(exportResult());
  mockCompanyPortabilityService.previewExport.mockResolvedValue(exportPreviewResult());
  mockCompanyPortabilityService.previewImport.mockResolvedValue({ ok: true });
  mockCompanyPortabilityService.importBundle.mockResolvedValue(importResult());
}

function assertNoTargetMutationSideEffects() {
  expect(mockCompanyService.update).not.toHaveBeenCalled();
  expect(mockCompanyService.archive).not.toHaveBeenCalled();
  expect(mockCompanyService.remove).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.exportBundle).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  expect(mockLogActivity).not.toHaveBeenCalled();
}

function companyACeoActor() {
  return {
    type: "agent",
    agentId: ceoAgentId,
    companyId: companyAId,
    source: "agent_key",
    runId: "run-1",
  };
}

function boardActor(input: {
  userId: string;
  companyIds?: string[];
  memberships?: Array<{ companyId: string; membershipRole: string; status: string }>;
  isInstanceAdmin?: boolean;
  source?: string;
}) {
  return {
    type: "board",
    userId: input.userId,
    source: input.source ?? "session",
    companyIds: input.companyIds ?? [],
    memberships: input.memberships ?? [],
    isInstanceAdmin: input.isInstanceAdmin ?? false,
  };
}

describe.sequential("company route cross-company authorization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    resetMockDefaults();
  });

  it.each(["session", "board_key", "cloud_tenant"])(
    "limits navigable companies to memberships for a %s instance admin",
    async (source) => {
      mockCompanyService.list.mockResolvedValue([createCompany(companyBId), createCompany(companyAId)]);
      const app = await createApp(boardActor({
        userId: "owner-a",
        source,
        isInstanceAdmin: true,
        companyIds: [companyAId],
      }));

      const navigation = await request(app).get("/api/companies?scope=accessible").expect(200);
      expect(navigation.body.map((company: { id: string }) => company.id)).toEqual([companyAId]);
      await request(app).get(`/api/companies/${companyAId}`).expect(200);
      await request(app).get(`/api/companies/${companyBId}`).expect(403);

      // The existing directory remains available for instance administration.
      const directory = await request(app).get("/api/companies").expect(200);
      expect(directory.body.map((company: { id: string }) => company.id)).toEqual([companyBId, companyAId]);
    },
  );

  it.each([false, true])("returns no navigable companies without memberships (admin=%s)", async (isInstanceAdmin) => {
    mockCompanyService.list.mockResolvedValue([createCompany(companyAId)]);
    const app = await createApp(boardActor({ userId: "outsider", isInstanceAdmin }));
    const res = await request(app).get("/api/companies?scope=accessible").expect(200);
    expect(res.body).toEqual([]);
  });

  it.each(["scope=accessible&scope=accessible", "scope=accessible&scope=all", "scope=all", "scope="])(
    "rejects malformed list scope without loading the directory: %s",
    async (query) => {
      const app = await createApp(boardActor({ userId: "admin", isInstanceAdmin: true }));
      await request(app).get(`/api/companies?${query}`).expect(400);
      expect(mockCompanyService.list).not.toHaveBeenCalled();
    },
  );

  it("includes additional companies where a cloud user has membership", async () => {
    mockCompanyService.list.mockResolvedValue([createCompany(companyAId), createCompany(companyBId)]);
    const app = await createApp(boardActor({
      userId: "owner-of-both",
      source: "cloud_tenant",
      companyIds: [companyAId, companyBId],
    }));
    const res = await request(app).get("/api/companies?scope=accessible").expect(200);
    expect(res.body.map((company: { id: string }) => company.id)).toEqual([companyAId, companyBId]);
    await request(app).get(`/api/companies/${companyBId}`).expect(200);
  });

  it("keeps all companies navigable for the local trusted board", async () => {
    mockCompanyService.list.mockResolvedValue([createCompany(companyAId), createCompany(companyBId)]);
    const app = await createApp(boardActor({ userId: "local-board", source: "local_implicit" }));
    const res = await request(app).get("/api/companies?scope=accessible").expect(200);
    expect(res.body.map((company: { id: string }) => company.id)).toEqual([companyAId, companyBId]);
  });

  it.each([{ type: "none", source: "none" }, companyACeoActor()])(
    "rejects navigation list requests from a $type actor",
    async (actor) => {
      const app = await createApp(actor);
      await request(app).get("/api/companies?scope=accessible").expect(403);
      expect(mockCompanyService.list).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "GET /api/companies/:companyId",
      request: (app: express.Express) => request(app).get(`/api/companies/${companyBId}`),
    },
    {
      label: "PATCH /api/companies/:companyId",
      request: (app: express.Express) => request(app).patch(`/api/companies/${companyBId}`).send({ description: "Nope" }),
    },
    {
      label: "PATCH /api/companies/:companyId/branding",
      request: (app: express.Express) => request(app).patch(`/api/companies/${companyBId}/branding`).send({ description: "Nope" }),
    },
    {
      label: "POST /api/companies/:companyId/archive",
      request: (app: express.Express) => request(app).post(`/api/companies/${companyBId}/archive`).send({}),
    },
    {
      label: "DELETE /api/companies/:companyId",
      request: (app: express.Express) => request(app).delete(`/api/companies/${companyBId}`),
    },
    {
      label: "POST /api/companies/:companyId/export",
      request: (app: express.Express) => request(app).post(`/api/companies/${companyBId}/export`).send(exportRequest),
    },
    {
      label: "POST /api/companies/:companyId/exports/preview",
      request: (app: express.Express) => request(app).post(`/api/companies/${companyBId}/exports/preview`).send(exportRequest),
    },
    {
      label: "GET /api/companies/:companyId/export/fidelity",
      request: (app: express.Express) => request(app).get(`/api/companies/${companyBId}/export/fidelity`),
    },
    {
      label: "POST /api/companies/:companyId/imports/preview",
      request: (app: express.Express) => request(app).post(`/api/companies/${companyBId}/imports/preview`).send(importRequest()),
    },
    {
      label: "POST /api/companies/:companyId/imports/apply",
      request: (app: express.Express) => request(app).post(`/api/companies/${companyBId}/imports/apply`).send(importRequest()),
    },
  ])("rejects a company A CEO attempting company B operation: $label", async ({ request: buildRequest }) => {
    const app = await createApp(companyACeoActor());

    const res = await buildRequest(app);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/another company|access to this company|active company access/i);
    assertNoTargetMutationSideEffects();
  });

  it("allows a same-company CEO to use CEO-safe company routes without allowing board-only lifecycle routes", async () => {
    const app = await createApp(companyACeoActor());

    await request(app).get(`/api/companies/${companyAId}`).expect(200);
    await request(app).patch(`/api/companies/${companyAId}`).send({ description: "Branding" }).expect(200);
    await request(app).patch(`/api/companies/${companyAId}/branding`).send({ description: "Branding" }).expect(200);
    await request(app).post(`/api/companies/${companyAId}/export`).send(exportRequest).expect(200);
    await request(app).post(`/api/companies/${companyAId}/exports/preview`).send(exportRequest).expect(200);
    await request(app).post(`/api/companies/${companyAId}/imports/preview`).send(importRequest(companyAId)).expect(200);
    await request(app).post(`/api/companies/${companyAId}/imports/apply`).send(importRequest(companyAId)).expect(200);

    const archive = await request(app).post(`/api/companies/${companyAId}/archive`).send({});
    expect(archive.status).toBe(403);
    expect(archive.body.error).toContain("Board access required");
    const remove = await request(app).delete(`/api/companies/${companyAId}`);
    expect(remove.status).toBe(403);
    expect(remove.body.error).toContain("Board access required");
  });

  it("covers board actor access for non-member, viewer, active member, local trusted board, and instance admin without target membership", async () => {
    const nonMemberApp = await createApp(boardActor({ userId: "outsider" }));
    const nonMember = await request(nonMemberApp).get(`/api/companies/${companyBId}`);
    expect(nonMember.status).toBe(403);
    expect(nonMember.body.error).toContain("access to this company");

    vi.clearAllMocks();
    resetMockDefaults();
    const viewerApp = await createApp(boardActor({
      userId: "viewer",
      companyIds: [companyBId],
      memberships: [{ companyId: companyBId, membershipRole: "viewer", status: "active" }],
    }));
    await request(viewerApp).get(`/api/companies/${companyBId}`).expect(200);
    const viewerWrite = await request(viewerApp).patch(`/api/companies/${companyBId}`).send({ description: "Nope" });
    expect(viewerWrite.status).toBe(403);
    expect(viewerWrite.body.error).toContain("Viewer access is read-only");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();

    vi.clearAllMocks();
    resetMockDefaults();
    const memberApp = await createApp(boardActor({
      userId: "member",
      companyIds: [companyBId],
      memberships: [{ companyId: companyBId, membershipRole: "member", status: "active" }],
    }));
    await request(memberApp).patch(`/api/companies/${companyBId}`).send({ description: "Updated" }).expect(200);
    await request(memberApp).patch(`/api/companies/${companyBId}/branding`).send({ description: "Branding" }).expect(200);
    await request(memberApp).post(`/api/companies/${companyBId}/archive`).send({}).expect(200);
    await request(memberApp).delete(`/api/companies/${companyBId}`).expect(200);
    await request(memberApp).post(`/api/companies/${companyBId}/export`).send(exportRequest).expect(200);
    await request(memberApp).post(`/api/companies/${companyBId}/exports/preview`).send(exportRequest).expect(200);
    await request(memberApp).post(`/api/companies/${companyBId}/imports/preview`).send(importRequest()).expect(200);
    await request(memberApp).post(`/api/companies/${companyBId}/imports/apply`).send(importRequest()).expect(200);

    vi.clearAllMocks();
    resetMockDefaults();
    const localTrustedApp = await createApp(boardActor({
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    }));
    await request(localTrustedApp).get(`/api/companies/${companyBId}`).expect(200);
    await request(localTrustedApp).patch(`/api/companies/${companyBId}`).send({ description: "Local" }).expect(200);

    vi.clearAllMocks();
    resetMockDefaults();
    const adminWithoutMembershipApp = await createApp(boardActor({
      userId: "instance-admin",
      isInstanceAdmin: true,
    }));
    const adminRead = await request(adminWithoutMembershipApp).get(`/api/companies/${companyBId}`);
    expect(adminRead.status).toBe(403);
    expect(adminRead.body.error).toContain("access to this company");
    const adminWrite = await request(adminWithoutMembershipApp).patch(`/api/companies/${companyBId}`).send({ description: "Admin" });
    expect(adminWrite.status).toBe(403);
    expect(adminWrite.body.error).toContain("access to this company");
    assertNoTargetMutationSideEffects();
  });
});
