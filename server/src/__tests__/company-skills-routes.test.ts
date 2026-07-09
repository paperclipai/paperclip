import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  list: vi.fn(),
  categoryCounts: vi.fn(),
  detail: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  createVersion: vi.fn(),
  starSkill: vi.fn(),
  unstarSkill: vi.fn(),
  forkSkill: vi.fn(),
  forkPrecheck: vi.fn(),
  listComments: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  importFromSource: vi.fn(),
  installFromCatalog: vi.fn(),
  createLocalSkill: vi.fn(),
  updateSkill: vi.fn(),
  updateFile: vi.fn(),
  scanProjectWorkspaces: vi.fn(),
  deleteSkill: vi.fn(),
  auditSkill: vi.fn(),
  getById: vi.fn(),
  installUpdate: vi.fn(),
  resetSkill: vi.fn(),
}));

const mockCatalogService = vi.hoisted(() => ({
  listCatalogSkillsOrEmpty: vi.fn(),
  getCatalogSkillOrThrow: vi.fn(),
  readCatalogSkillFile: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackSkillImported = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackSkillImported: mockTrackSkillImported,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/company-skills.js", () => ({
    companySkillService: () => mockCompanySkillService,
  }));

  vi.doMock("../services/skills-catalog.js", () => mockCatalogService);

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companySkillService: () => mockCompanySkillService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ companySkillRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/company-skills.js")>("../routes/company-skills.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", companySkillRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("company skill mutation permissions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/skills-catalog.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/company-skills.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [],
      warnings: [],
    });
    mockCatalogService.listCatalogSkillsOrEmpty.mockReturnValue([]);
    mockCompanySkillService.list.mockResolvedValue([]);
    mockCompanySkillService.categoryCounts.mockResolvedValue([]);
    mockCompanySkillService.detail.mockResolvedValue(null);
    mockCompanySkillService.listVersions.mockResolvedValue([]);
    mockCompanySkillService.getVersion.mockResolvedValue(null);
    mockCompanySkillService.createVersion.mockResolvedValue({
      id: "version-1",
      companyId: "company-1",
      companySkillId: "skill-1",
      revisionNumber: 1,
      label: "v1",
      fileInventory: [{ path: "SKILL.md", kind: "skill", content: "# Skill" }],
      authorAgentId: null,
      authorUserId: "board",
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
    });
    mockCompanySkillService.starSkill.mockResolvedValue({
      skillId: "skill-1",
      starred: true,
      starCount: 1,
    });
    mockCompanySkillService.unstarSkill.mockResolvedValue({
      skillId: "skill-1",
      starred: false,
      starCount: 0,
    });
    const forkedSkill = {
      id: "skill-fork",
      companyId: "company-1",
      key: "company/company-1/review-fork",
      slug: "review-fork",
      name: "Review Fork",
      description: null,
      markdown: "# Review",
      sourceType: "local_path",
      sourceLocator: "/tmp/review-fork",
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      iconUrl: null,
      color: null,
      tagline: null,
      authorName: null,
      homepageUrl: null,
      categories: [],
      sharingScope: "company",
      publicShareToken: null,
      forkedFromSkillId: "skill-1",
      forkedFromCompanyId: "company-1",
      starCount: 0,
      installCount: 1,
      forkCount: 0,
      currentVersionId: null,
      metadata: null,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:00:00.000Z"),
    };
    mockCompanySkillService.forkSkill.mockResolvedValue({
      skill: forkedSkill,
      original: {
        id: "skill-1",
        name: "Review",
        slug: "review",
        sourceType: "github",
        sourceLocator: "https://github.com/acme/review",
        sourceRef: "abc123",
      },
      reassignments: [],
    });
    mockCompanySkillService.forkPrecheck.mockResolvedValue({
      skillId: "skill-1",
      original: {
        id: "skill-1",
        name: "Review",
        slug: "review",
        sourceType: "github",
        sourceLocator: "https://github.com/acme/review",
        sourceRef: "abc123",
      },
      agentUsageCount: 0,
      usedByAgents: [],
      existingForks: [],
    });
    mockCompanySkillService.listComments.mockResolvedValue([]);
    mockCompanySkillService.createComment.mockResolvedValue({
      id: "comment-1",
      companyId: "company-1",
      companySkillId: "skill-1",
      parentCommentId: null,
      authorAgentId: null,
      authorUserId: "board",
      body: "Looks good",
      deletedAt: null,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:00:00.000Z"),
    });
    mockCompanySkillService.updateComment.mockResolvedValue({
      id: "comment-1",
      companyId: "company-1",
      companySkillId: "skill-1",
      parentCommentId: null,
      authorAgentId: null,
      authorUserId: "board",
      body: "Updated",
      deletedAt: null,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:00:00.000Z"),
    });
    mockCompanySkillService.deleteComment.mockResolvedValue({
      id: "comment-1",
      companyId: "company-1",
      companySkillId: "skill-1",
      parentCommentId: null,
      authorAgentId: null,
      authorUserId: "board",
      body: "Updated",
      deletedAt: new Date("2026-05-26T00:01:00.000Z"),
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:01:00.000Z"),
    });
    mockCompanySkillService.installFromCatalog.mockResolvedValue({
      action: "created",
      skill: {
        id: "skill-1",
        companyId: "company-1",
        key: "paperclipai/bundled/software-development/review",
        slug: "review",
        name: "review",
        description: "Review code",
        markdown: "# Review",
        sourceType: "catalog",
        sourceLocator: "/tmp/review",
        sourceRef: "sha256:abc",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: {
          sourceKind: "catalog",
          catalogId: "paperclipai:bundled:software-development:review",
          originHash: "sha256:abc",
        },
        createdAt: new Date("2026-05-26T00:00:00.000Z"),
        updatedAt: new Date("2026-05-26T00:00:00.000Z"),
      },
      catalogSkill: {
        id: "paperclipai:bundled:software-development:review",
        key: "paperclipai/bundled/software-development/review",
        kind: "bundled",
        category: "software-development",
        slug: "review",
        name: "review",
        description: "Review code",
        path: "catalog/bundled/software-development/review",
        entrypoint: "SKILL.md",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        defaultInstall: false,
        recommendedForRoles: ["engineer"],
        requires: [],
        tags: ["review"],
        files: [{ path: "SKILL.md", kind: "skill", sizeBytes: 8, sha256: "abc" }],
        contentHash: "sha256:abc",
      },
      warnings: [],
    });
    mockCompanySkillService.createLocalSkill.mockResolvedValue({
      id: "skill-1",
      companyId: "company-1",
      key: "company/company-1/review",
      slug: "review",
      name: "Review",
      description: null,
      markdown: "# Review",
      sourceType: "local_path",
      sourceLocator: "/tmp/review",
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      iconUrl: null,
      color: null,
      tagline: null,
      authorName: null,
      homepageUrl: null,
      categories: [],
      sharingScope: "company",
      publicShareToken: null,
      forkedFromSkillId: null,
      forkedFromCompanyId: null,
      starCount: 0,
      installCount: 1,
      forkCount: 0,
      currentVersionId: null,
      metadata: null,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:00:00.000Z"),
    });
    mockCompanySkillService.updateSkill.mockResolvedValue({
      id: "skill-1",
      slug: "review",
      categories: ["memory", "review"],
      sharingScope: "company",
    });
    mockCompanySkillService.updateFile.mockResolvedValue({
      skillId: "skill-1",
      path: "SKILL.md",
      kind: "skill",
      content: "# Review",
      language: "markdown",
      markdown: true,
      editable: true,
    });
    mockCompanySkillService.scanProjectWorkspaces.mockResolvedValue({
      scannedProjects: 0,
      scannedWorkspaces: 0,
      discovered: 0,
      imported: [],
      updated: [],
      skipped: [],
      conflicts: [],
      warnings: [],
    });
    mockCompanySkillService.deleteSkill.mockResolvedValue({
      id: "skill-1",
      slug: "find-skills",
      name: "Find Skills",
    });
    mockCompanySkillService.auditSkill.mockResolvedValue({
      skillId: "skill-1",
      installedHash: "sha256:abc",
      originHash: "sha256:abc",
      verdict: "pass",
      codes: [],
      findings: [],
      scannedAt: "2026-05-26T00:00:00.000Z",
      scanVersion: "1",
    });
    mockCompanySkillService.getById.mockResolvedValue({
      id: "skill-1",
      slug: "review",
      sourceRef: "sha256:abc",
      metadata: { originHash: "sha256:abc" },
    });
    mockCompanySkillService.installUpdate.mockResolvedValue({
      id: "skill-1",
      slug: "review",
      sourceRef: "sha256:def",
      metadata: { originHash: "sha256:def" },
    });
    mockCompanySkillService.resetSkill.mockResolvedValue({
      id: "skill-1",
      slug: "review",
      sourceRef: "sha256:def",
      metadata: { originHash: "sha256:def" },
    });
    mockCatalogService.listCatalogSkillsOrEmpty.mockReturnValue([]);
    mockCatalogService.getCatalogSkillOrThrow.mockReturnValue({
      id: "paperclipai:bundled:software-development:review",
      key: "paperclipai/bundled/software-development/review",
      kind: "bundled",
      category: "software-development",
      slug: "review",
      name: "review",
      description: "Review code",
      path: "catalog/bundled/software-development/review",
      entrypoint: "SKILL.md",
      trustLevel: "markdown_only",
      compatibility: "compatible",
      defaultInstall: false,
      recommendedForRoles: ["engineer"],
      requires: [],
      tags: ["review"],
      files: [{ path: "SKILL.md", kind: "skill", sizeBytes: 8, sha256: "abc" }],
      contentHash: "sha256:abc",
    });
    mockCatalogService.readCatalogSkillFile.mockResolvedValue({
      catalogSkillId: "paperclipai:bundled:software-development:review",
      path: "SKILL.md",
      kind: "skill",
      content: "# Review",
      language: "markdown",
      markdown: true,
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("allows local board operators to mutate company skills", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body).toEqual({
      imported: [],
      warnings: [],
    });
  });

  it("allows board users with skills:create to create, import, install, update, delete, audit, and reset company skills", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    await request(app)
      .post("/api/companies/company-1/skills")
      .send({ name: "Review", slug: "review", markdown: "# Review" })
      .expect(201);
    await request(app)
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" })
      .expect(201);
    await request(app)
      .post("/api/companies/company-1/skills/install-catalog")
      .send({ catalogSkillId: "paperclipai:bundled:software-development:review" })
      .expect(201);
    await request(app)
      .patch("/api/companies/company-1/skills/skill-1")
      .send({ description: "Updated" })
      .expect(200);
    await request(app)
      .delete("/api/companies/company-1/skills/skill-1")
      .expect(200);
    await request(app)
      .post("/api/companies/company-1/skills/skill-1/audit")
      .send({})
      .expect(200);
    await request(app)
      .post("/api/companies/company-1/skills/skill-1/reset")
      .send({})
      .expect(200);

    expect(mockAccessService.canUser).toHaveBeenCalledWith("company-1", "board-user", "skills:create");
    expect(mockAccessService.canUser).not.toHaveBeenCalledWith("company-1", "board-user", "agents:create");
    expect(mockCompanySkillService.createLocalSkill).toHaveBeenCalled();
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalled();
    expect(mockCompanySkillService.installFromCatalog).toHaveBeenCalled();
    expect(mockCompanySkillService.updateSkill).toHaveBeenCalled();
    expect(mockCompanySkillService.deleteSkill).toHaveBeenCalled();
    expect(mockCompanySkillService.auditSkill).toHaveBeenCalled();
    expect(mockCompanySkillService.resetSkill).toHaveBeenCalled();
  });

  it("blocks board users without skills:create from mutating company skills", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(await createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Missing permission: skills:create");
    expect(mockAccessService.canUser).toHaveBeenCalledWith("company-1", "board-user", "skills:create");
    expect(mockAccessService.canUser).not.toHaveBeenCalledWith("company-1", "board-user", "agents:create");
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("serves catalog listing without mutating company skills", async () => {
    mockCatalogService.listCatalogSkillsOrEmpty.mockReturnValue([
      {
        id: "paperclipai:bundled:software-development:review",
        key: "paperclipai/bundled/software-development/review",
        kind: "bundled",
        category: "software-development",
        slug: "review",
        name: "review",
        description: "Review code",
        path: "catalog/bundled/software-development/review",
        entrypoint: "SKILL.md",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        defaultInstall: false,
        recommendedForRoles: ["engineer"],
        requires: [],
        tags: ["review"],
        files: [{ path: "SKILL.md", kind: "skill", sizeBytes: 8, sha256: "abc" }],
        contentHash: "sha256:abc",
      },
    ]);

    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .get("/api/skills/catalog?kind=bundled&q=review");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCatalogService.listCatalogSkillsOrEmpty).toHaveBeenCalledWith({ kind: "bundled", q: "review" });
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
    expect(mockCompanySkillService.installFromCatalog).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("requires authentication for catalog read routes", async () => {
    const app = await createApp({ type: "none" });

    const list = await request(app).get("/api/skills/catalog");
    const detail = await request(app).get("/api/skills/catalog/review");
    const file = await request(app).get("/api/skills/catalog/review/files?path=SKILL.md");

    expect(list.status, JSON.stringify(list.body)).toBe(401);
    expect(detail.status, JSON.stringify(detail.body)).toBe(401);
    expect(file.status, JSON.stringify(file.body)).toBe(401);
    expect(mockCatalogService.listCatalogSkillsOrEmpty).not.toHaveBeenCalled();
    expect(mockCatalogService.getCatalogSkillOrThrow).not.toHaveBeenCalled();
    expect(mockCatalogService.readCatalogSkillFile).not.toHaveBeenCalled();
  });

  it("serves catalog detail and files by catalog reference", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const detail = await request(app)
      .get("/api/skills/catalog/review");
    const file = await request(app)
      .get("/api/skills/catalog/review/files?path=SKILL.md");

    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    expect(mockCatalogService.getCatalogSkillOrThrow).toHaveBeenCalledWith("review");
    expect(mockCatalogService.readCatalogSkillFile).toHaveBeenCalledWith("review", "SKILL.md");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("installs catalog skills with mutation permissions and logs provenance", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/install-catalog")
      .send({
        catalogSkillId: "paperclipai:bundled:software-development:review",
        slug: "review",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.installFromCatalog).toHaveBeenCalledWith("company-1", {
      catalogSkillId: "paperclipai:bundled:software-development:review",
      slug: "review",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      action: "company.skill_catalog_installed",
      entityType: "company_skill",
      entityId: "skill-1",
      details: expect.objectContaining({
        catalogId: "paperclipai:bundled:software-development:review",
        catalogKey: "paperclipai/bundled/software-development/review",
        originHash: "sha256:abc",
      }),
    }));
  });

  it("tracks public GitHub skill imports with an explicit skill reference", async () => {
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [
        {
          id: "skill-1",
          companyId: "company-1",
          key: "vercel-labs/agent-browser/find-skills",
          slug: "find-skills",
          name: "Find Skills",
          description: null,
          markdown: "# Find Skills",
          sourceType: "github",
          sourceLocator: "https://github.com/vercel-labs/agent-browser",
          sourceRef: null,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: {
            hostname: "github.com",
            owner: "vercel-labs",
            repo: "agent-browser",
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      warnings: [],
    });

    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: "vercel-labs/agent-browser/find-skills",
    });
  });

  it("does not expose a skill reference for non-public skill imports", async () => {
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [
        {
          id: "skill-1",
          companyId: "company-1",
          key: "private-skill",
          slug: "private-skill",
          name: "Private Skill",
          description: null,
          markdown: "# Private Skill",
          sourceType: "github",
          sourceLocator: "https://ghe.example.com/acme/private-skill",
          sourceRef: null,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: {
            hostname: "ghe.example.com",
            owner: "acme",
            repo: "private-skill",
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      warnings: [],
    });

    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://ghe.example.com/acme/private-skill" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: null,
    });
  });

  it("does not expose a skill reference when GitHub metadata is missing", async () => {
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [
        {
          id: "skill-1",
          companyId: "company-1",
          key: "unknown/private-skill",
          slug: "private-skill",
          name: "Private Skill",
          description: null,
          markdown: "# Private Skill",
          sourceType: "github",
          sourceLocator: "https://github.com/acme/private-skill",
          sourceRef: null,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      warnings: [],
    });

    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/acme/private-skill" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: null,
    });
  });

  it("blocks same-company agents with skill creation disabled from mutating company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateSkills: false },
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Missing permission: skills:create");
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith("company-1", "agent", "agent-1", "skills:create");
    expect(mockAccessService.hasPermission).not.toHaveBeenCalledWith("company-1", "agent", "agent-1", "agents:create");
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("blocks agent catalog installs for other companies", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateSkills: true },
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-2/skills/install-catalog")
      .send({ catalogSkillId: "paperclipai:bundled:software-development:review" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanySkillService.installFromCatalog).not.toHaveBeenCalled();
  });

  it("passes store list filters and category count requests to the service", async () => {
    const app = await createApp({ type: "board", source: "local_implicit" });

    await request(app)
      .get("/api/companies/company-1/skills?sort=stars&categories[]=memory&category=git&scope=company&q=review")
      .expect(200);
    expect(mockCompanySkillService.list).toHaveBeenCalledWith("company-1", {
      q: "review",
      sort: "stars",
      categories: ["git", "memory"],
      scope: "company",
    });

    await request(app).get("/api/companies/company-1/skills/categories").expect(200);
    expect(mockCompanySkillService.categoryCounts).toHaveBeenCalledWith("company-1");
  });

  it("accepts category updates and logs the skill mutation", async () => {
    const app = await createApp({ type: "board", source: "local_implicit", userId: "user-1" });

    const res = await request(app)
      .patch("/api/companies/company-1/skills/skill-1")
      .send({ categories: ["memory", "review"], sharingScope: "company" })
      .expect(200);

    expect(res.body).toMatchObject({
      id: "skill-1",
      categories: ["memory", "review"],
      sharingScope: "company",
    });
    expect(mockCompanySkillService.updateSkill).toHaveBeenCalledWith("company-1", "skill-1", {
      categories: ["memory", "review"],
      sharingScope: "company",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      action: "company.skill_updated",
      entityType: "company_skill",
      entityId: "skill-1",
      details: {
        slug: "review",
        categories: ["memory", "review"],
        sharingScope: "company",
      },
    }));
  });

  it("creates skill versions and logs the mutation", async () => {
    const app = await createApp({ type: "board", source: "local_implicit", userId: "user-1" });

    await request(app)
      .post("/api/companies/company-1/skills/skill-1/versions")
      .send({ label: "v1" })
      .expect(201);

    expect(mockCompanySkillService.createVersion).toHaveBeenCalledWith("company-1", "skill-1", { label: "v1" }, {
      type: "user",
      userId: "user-1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_version_created",
      entityType: "company_skill_version",
      entityId: "version-1",
    }));
  });

  it("stars, forks, and comments on skills through company-scoped endpoints", async () => {
    const app = await createApp({ type: "board", source: "local_implicit", userId: "user-1" });

    await request(app).post("/api/companies/company-1/skills/skill-1/star").send({}).expect(200);
    expect(mockCompanySkillService.starSkill).toHaveBeenCalledWith("company-1", "skill-1", {
      type: "user",
      userId: "user-1",
    });

    const forkRes = await request(app)
      .post("/api/companies/company-1/skills/skill-1/fork")
      .send({ slug: "review-fork", reassignAgentIds: ["11111111-1111-4111-8111-111111111111"] })
      .expect(201);
    expect(forkRes.body).toMatchObject({
      skill: { id: "skill-fork", slug: "review-fork" },
      original: { id: "skill-1", slug: "review" },
      reassignments: [],
    });
    expect(mockCompanySkillService.forkSkill).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      { slug: "review-fork", reassignAgentIds: ["11111111-1111-4111-8111-111111111111"] },
      {
        type: "user",
        userId: "user-1",
      },
    );

    await request(app).get("/api/companies/company-1/skills/skill-1/fork-precheck").expect(200);
    expect(mockCompanySkillService.forkPrecheck).toHaveBeenCalledWith("company-1", "skill-1", {
      type: "user",
      userId: "user-1",
    });

    await request(app).post("/api/companies/company-1/skills/skill-1/comments").send({ body: "Looks good" }).expect(201);
    expect(mockCompanySkillService.createComment).toHaveBeenCalledWith("company-1", "skill-1", { body: "Looks good" }, {
      type: "user",
      userId: "user-1",
    });

    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_starred",
      entityId: "skill-1",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_forked",
      entityId: "skill-fork",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_comment_created",
      entityId: "comment-1",
    }));
  });

  it("does not synthesize a shared board user id for board actors without user ids", async () => {
    const app = await createApp({ type: "board", source: "local_implicit" });

    await request(app).post("/api/companies/company-1/skills/skill-1/star").send({}).expect(200);

    expect(mockCompanySkillService.starSkill).toHaveBeenCalledWith("company-1", "skill-1", {
      type: "user",
      userId: null,
    });
  });

  it("allows agents with canCreateSkills to mutate company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateSkills: true },
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("allows same-company agents with missing skill creation permission to mutate company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("allows agents with explicit skills:create grants to mutate company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateSkills: false },
    });
    mockAccessService.hasPermission.mockImplementation(async (
      _companyId: string,
      _principalType: string,
      _principalId: string,
      key: string,
    ) => {
      return key === "skills:create";
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith("company-1", "agent", "agent-1", "skills:create");
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("does not allow explicit agents:create grants to mutate company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateSkills: false },
    });
    mockAccessService.hasPermission.mockImplementation(async (
      _companyId: string,
      _principalType: string,
      _principalId: string,
      key: string,
    ) => {
      return key === "agents:create";
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Missing permission: skills:create");
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith("company-1", "agent", "agent-1", "skills:create");
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("returns a blocking error when attempting to delete a skill still used by agents", async () => {
    const { unprocessable } = await import("../errors.js");
    mockCompanySkillService.deleteSkill.mockImplementationOnce(async () => {
      throw unprocessable(
        'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
      );
    });

    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .delete("/api/companies/company-1/skills/skill-1");

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toEqual({
      error: 'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
    });
    expect(mockCompanySkillService.deleteSkill).toHaveBeenCalledWith("company-1", "skill-1");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
