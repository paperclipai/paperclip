import express from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

function createMockAgentService() {
  return {
    getById: vi.fn(),
  };
}

function createMockAccessService() {
  return {
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  };
}

function createMockCompanySkillService() {
  return {
    importFromSource: vi.fn(),
    deleteSkill: vi.fn(),
  };
}

let mockAgentService = createMockAgentService();
let mockAccessService = createMockAccessService();
let mockCompanySkillService = createMockCompanySkillService();
let mockLogActivity = vi.fn();
const mockTrackSkillImported = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
let companySkillRoutesFactory!: typeof import("../routes/company-skills.js").companySkillRoutes;
let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;
let unprocessableFactory!: typeof import("../errors.js").unprocessable;

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackSkillImported: mockTrackSkillImported,
  };
});

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", companySkillRoutesFactory({} as any));
  app.use(errorHandlerMiddleware);
  return app;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function requestWithApp<T>(
  app: express.Express,
  run: (agent: request.SuperTest<request.Test>) => Promise<T>,
) {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run(request(server));
  } finally {
    await closeServer(server);
  }
}

const boardActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  runId: "run-1",
};

async function importSkill(source: string, actor: Record<string, unknown> = boardActor) {
  return requestWithApp(createApp(actor), (agent) =>
    agent
      .post("/api/companies/company-1/skills/import")
      .send({ source })
  );
}

describe.sequential("company skill mutation permissions", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockAgentService = createMockAgentService();
    mockAccessService = createMockAccessService();
    mockCompanySkillService = createMockCompanySkillService();
    mockLogActivity = vi.fn();
    mockTrackSkillImported.mockReset();
    mockGetTelemetryClient.mockReset();
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
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);

    vi.doMock("../services/index.js", () => ({
      accessService: () => mockAccessService,
      agentService: () => mockAgentService,
      companySkillService: () => mockCompanySkillService,
      logActivity: mockLogActivity,
    }));
    ({ companySkillRoutes: companySkillRoutesFactory } = await import("../routes/company-skills.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
    ({ unprocessable: unprocessableFactory } = await import("../errors.js"));
  });

  it.sequential("allows local board operators to mutate company skills", async () => {
    const res = await importSkill("https://github.com/vercel-labs/agent-browser");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it.sequential("tracks public GitHub skill imports with an explicit skill reference", async () => {
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

    const res = await importSkill("https://github.com/vercel-labs/agent-browser");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: "vercel-labs/agent-browser/find-skills",
    });
  });

  it.sequential("does not expose a skill reference for non-public skill imports", async () => {
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

    const res = await importSkill("https://ghe.example.com/acme/private-skill");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: null,
    });
  });

  it.sequential("does not expose a skill reference when GitHub metadata is missing", async () => {
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

    const res = await importSkill("https://github.com/acme/private-skill");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: null,
    });
  });

  it.sequential("blocks same-company agents without management permission from mutating company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });

    const res = await importSkill("https://github.com/vercel-labs/agent-browser", agentActor);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it.sequential("allows agents with canCreateAgents to mutate company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateAgents: true },
    });

    const res = await importSkill("https://github.com/vercel-labs/agent-browser", agentActor);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it.sequential("returns a blocking error when attempting to delete a skill still used by agents", async () => {
    mockCompanySkillService.deleteSkill.mockRejectedValue(
      unprocessableFactory(
        'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
      ),
    );

    const res = await requestWithApp(createApp(boardActor), (agent) =>
      agent.delete("/api/companies/company-1/skills/skill-1")
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toEqual({
      error: 'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
    });
    expect(mockCompanySkillService.deleteSkill).toHaveBeenCalledWith("company-1", "skill-1");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
