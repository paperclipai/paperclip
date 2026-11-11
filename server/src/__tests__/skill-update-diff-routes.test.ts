import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const INSTALLED = "a".repeat(40);
const LATEST = "b".repeat(40);
const mockSkills = vi.hoisted(() => ({ getById: vi.fn(), getByRouteRef: vi.fn() }));
const mockSources = vi.hoisted(() => ({ sourceForSkill: vi.fn() }));
const mockRead = vi.hoisted(() => vi.fn());
const mockDiff = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/skill-sources.js", () => ({ skillSourceService: () => mockSources }));
  vi.doMock("../services/skill-source-github-access.js", () => ({ skillSourceGitHubReader: () => mockRead }));
  vi.doMock("../services/skill-update-diff.js", () => ({ diffGitHubSkillUpdate: mockDiff }));
  vi.doMock("../services/company-skills.js", async () => ({
    ...await vi.importActual<typeof import("../services/company-skills.js")>("../services/company-skills.js"),
    companySkillService: () => mockSkills,
  }));
  vi.doMock("../services/index.js", async () => ({
    ...await vi.importActual<typeof import("../services/index.js")>("../services/index.js"),
    companySkillService: () => mockSkills,
  }));
}

const board = { type: "board", userId: "user-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: false };
const trackedSource = {
  enabled: true, connectionId: null, fullName: "example/skills", trackingRef: "main", repositoryUrl: "https://github.com/example/skills",
  packageMode: "skills", entries: [{ skillId: "skill-1", selection: "selected", path: "design/SKILL.md" }],
};

describe("GET /companies/:companyId/skills/:skillId/update-diff", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ companySkillRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/company-skills.js")>("../routes/company-skills.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    return { companySkillRoutes, errorHandler };
  });

  function app(actor: Record<string, unknown> = board) {
    const { companySkillRoutes, errorHandler } = routeModules.value;
    const server = express();
    server.use((req, _res, next) => { (req as any).actor = actor; next(); });
    server.use("/api", companySkillRoutes({} as never));
    server.use(errorHandler);
    return server;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // The real lookup applies the caller's skill visibility; a skill the caller cannot read is not found.
    mockSkills.getByRouteRef.mockImplementation(async (_companyId: string, ref: string) => ref === "skill-1" ? { id: "skill-1", sourceRef: INSTALLED } : null);
    mockSkills.getById.mockImplementation(async (_companyId: string, id: string) => id === "skill-1" ? { id: "skill-1", sourceRef: INSTALLED } : null);
    mockSources.sourceForSkill.mockResolvedValue(trackedSource);
    mockRead.mockResolvedValue({ sha: LATEST });
    mockDiff.mockResolvedValue({ supported: true, truncated: false, files: [{ path: "SKILL.md", change: "modified", binary: false, executableChanged: false, diff: "@@ -1,1 +1,1 @@\n-a\n+b", diffUnavailable: null }] });
  });

  it("returns the per-file diff between the installed and latest revisions", async () => {
    const response = await request(app()).get("/api/companies/company-1/skills/skill-1/update-diff");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ supported: true, hasUpdate: true, currentRef: INSTALLED, latestRef: LATEST, truncated: false });
    expect(response.body.files).toHaveLength(1);
    expect(mockDiff).toHaveBeenCalledWith(expect.objectContaining({ installedCommitSha: INSTALLED, latestCommitSha: LATEST, skillPath: "design/SKILL.md" }), mockRead, expect.any(AbortSignal));
  });

  it("answers a skill with no pending update without scanning either revision", async () => {
    mockRead.mockResolvedValue({ sha: INSTALLED.toUpperCase() });
    const response = await request(app()).get("/api/companies/company-1/skills/skill-1/update-diff");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ supported: true, reason: null, currentRef: INSTALLED, latestRef: INSTALLED.toUpperCase(), hasUpdate: false, files: [], truncated: false });
    expect(mockDiff).not.toHaveBeenCalled();
  });

  it("rejects a caller from another company before reading anything", async () => {
    const response = await request(app({ ...board, companyIds: ["company-2"] })).get("/api/companies/company-1/skills/skill-1/update-diff");
    expect(response.status).toBe(403);
    expect(mockSkills.getByRouteRef).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
    const agent = await request(app({ type: "agent", agentId: "agent-1", companyId: "company-2", runId: "run-1" })).get("/api/companies/company-1/skills/skill-1/update-diff");
    expect(agent.status).toBe(403);
  });

  it("returns 404 for a skill the caller cannot read", async () => {
    const response = await request(app()).get("/api/companies/company-1/skills/private-skill/update-diff");
    expect(response.status).toBe(404);
    expect(mockSources.sourceForSkill).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("explains why a skill without a usable tracked source has no diff", async () => {
    mockSources.sourceForSkill.mockResolvedValueOnce(null);
    expect((await request(app()).get("/api/companies/company-1/skills/skill-1/update-diff")).body)
      .toMatchObject({ supported: false, reason: "Only skills installed from a tracked GitHub source have an update diff.", files: [] });
    mockSources.sourceForSkill.mockResolvedValueOnce({ ...trackedSource, enabled: false });
    expect((await request(app()).get("/api/companies/company-1/skills/skill-1/update-diff")).body)
      .toMatchObject({ supported: false, reason: "Source is disconnected. Reconnect it in Skills → Sources." });
    mockSkills.getById.mockResolvedValueOnce({ id: "skill-1", sourceRef: "main" });
    expect((await request(app()).get("/api/companies/company-1/skills/skill-1/update-diff")).body)
      .toMatchObject({ supported: false, reason: "The installed source revision is unknown.", currentRef: "main" });
    mockDiff.mockResolvedValueOnce({ supported: false, reason: "The repository is larger than the supported package size, so its revisions cannot be compared file by file." });
    expect((await request(app()).get("/api/companies/company-1/skills/skill-1/update-diff")).body)
      .toMatchObject({ supported: false, hasUpdate: true, latestRef: LATEST, files: [] });
    expect(mockDiff).toHaveBeenCalledTimes(1);
  });

  it("aborts the scans when the caller disconnects", async () => {
    let seen: AbortSignal | undefined;
    mockDiff.mockImplementationOnce((_input: unknown, _read: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
      seen = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const server = app().listen(0);
    try {
      const { port } = server.address() as { port: number };
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/api/companies/company-1/skills/skill-1/update-diff`, { signal: controller.signal }).catch(() => null);
      await vi.waitFor(() => expect(seen).toBeDefined());
      controller.abort();
      await pending;
      await vi.waitFor(() => expect(seen!.aborted).toBe(true));
    } finally { server.close(); }
  });
});
