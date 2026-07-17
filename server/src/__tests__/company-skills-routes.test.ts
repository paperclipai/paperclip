import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  isCompanyOwner: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  importFromSource: vi.fn(),
  deleteSkill: vi.fn(),
  updateFile: vi.fn(),
  updateAiFactoryPolicyFile: vi.fn(),
  refreshInventory: vi.fn(),
  getAiFactoryPolicyView: vi.fn(),
  selectAiFactoryPolicy: vi.fn(),
  resetAiFactoryPolicy: vi.fn(),
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
    mockCompanySkillService.deleteSkill.mockResolvedValue({
      id: "skill-1",
      slug: "find-skills",
      name: "Find Skills",
    });
    mockCompanySkillService.updateFile.mockResolvedValue({
      path: "factory-policy.yaml",
      markdown: "version: 1",
    });
    mockCompanySkillService.updateAiFactoryPolicyFile.mockResolvedValue({
      path: "factory-policy.yaml",
      markdown: "version: 1",
    });
    mockCompanySkillService.refreshInventory.mockResolvedValue([]);
    mockCompanySkillService.getAiFactoryPolicyView.mockResolvedValue({
      overlaySkillId: "0f4a8b3e-7ac4-4acf-aa6d-3f937b92425e",
      overlaySkillKey: "company/company-1/ai-factory-policy",
      compiled: { version: 1, contentHash: "hash" },
    });
    mockCompanySkillService.selectAiFactoryPolicy.mockResolvedValue({
      overlaySkillId: "0f4a8b3e-7ac4-4acf-aa6d-3f937b92425e",
      overlaySkillKey: "company/company-1/ai-factory-policy",
      compiled: { version: 1, contentHash: "hash" },
    });
    mockCompanySkillService.resetAiFactoryPolicy.mockResolvedValue({
      overlaySkillId: "0f4a8b3e-7ac4-4acf-aa6d-3f937b92425e",
      overlaySkillKey: "company/company-1/ai-factory-policy",
      compiled: { version: 1, contentHash: "hash" },
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.isCompanyOwner.mockResolvedValue(false);
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

  it("lets authorized operators explicitly refresh the cached skill inventory", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/refresh")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.refreshInventory).toHaveBeenCalledWith("company-1");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skills_inventory_refreshed",
      entityId: "company-1",
    }));
  });

  it("selects a validated company AI Factory policy and records its compiled identity", async () => {
    const skillId = "0f4a8b3e-7ac4-4acf-aa6d-3f937b92425e";
    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .put("/api/companies/company-1/ai-factory-policy")
      .send({ skillId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.selectAiFactoryPolicy).toHaveBeenCalledWith("company-1", skillId);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.ai_factory_policy_selected",
      entityId: skillId,
      details: expect.objectContaining({ contentHash: "hash", version: 1 }),
    }));
  });

  it("requires the dedicated company AI Factory policy permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    const skillId = "0f4a8b3e-7ac4-4acf-aa6d-3f937b92425e";
    const res = await request(await createApp({
      type: "board",
      userId: "company-operator",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    }))
      .put("/api/companies/company-1/ai-factory-policy")
      .send({ skillId });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("ai_factory:manage");
    expect(mockAccessService.canUser).toHaveBeenCalledWith(
      "company-1",
      "company-operator",
      "ai_factory:manage",
    );
    expect(mockCompanySkillService.selectAiFactoryPolicy).not.toHaveBeenCalled();
  });

  it("does not let an agent use skill-management authority to change factory policy", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateAgents: true },
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/ai-factory-policy/reset")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockCompanySkillService.resetAiFactoryPolicy).not.toHaveBeenCalled();
  });

  it("applies the factory-policy permission to direct YAML edits too", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateAgents: true },
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/companies/company-1/skills/policy-skill/files")
      .send({ path: "factory-policy.yaml", content: "version: 1" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockCompanySkillService.updateAiFactoryPolicyFile).not.toHaveBeenCalled();
  });

  it("routes board-authorized policy edits through the dedicated service path", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .patch("/api/companies/company-1/skills/policy-skill/files")
      .send({
        path: "references/../factory-policy.yaml",
        content: "version: 1",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.updateAiFactoryPolicyFile).toHaveBeenCalledWith(
      "company-1",
      "policy-skill",
      "version: 1",
    );
    expect(mockCompanySkillService.updateFile).not.toHaveBeenCalled();
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

  it("blocks same-company agents without management permission from mutating company skills", async () => {
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

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("allows agents with canCreateAgents to mutate company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateAgents: true },
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
