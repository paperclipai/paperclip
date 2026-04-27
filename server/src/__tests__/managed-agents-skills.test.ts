import { beforeEach, describe, expect, it, vi } from "vitest";

type CookbookSkillSummary = {
  name: string;
  description: string;
  scope_type: string;
  scope_id: string | null;
  owner: string | null;
  version: string;
  tags: string[];
};

const cookbookListSkillsMock = vi.fn<(apiKey: string) => Promise<CookbookSkillSummary[]>>();
const cookbookGetSkillMock = vi.fn();
const fetchCornerstoneContextMock = vi.fn();

vi.mock("../../../packages/adapters/managed-agents/src/server/client.js", () => ({
  cookbookListSkills: cookbookListSkillsMock,
  cookbookGetSkill: cookbookGetSkillMock,
  fetchCornerstoneContext: fetchCornerstoneContextMock,
}));

const FIXTURE: CookbookSkillSummary[] = [
  {
    name: "writing-style",
    description: "House writing voice",
    scope_type: "global",
    scope_id: null,
    owner: null,
    version: "1.0.0",
    tags: ["style"],
  },
  {
    name: "brief-summariser",
    description: "Condense brand briefs to bullets",
    scope_type: "global",
    scope_id: null,
    owner: null,
    version: "1.1.0",
    tags: ["summary"],
  },
  {
    name: "cornerstone-lookup",
    description: "Query Cornerstone memory",
    scope_type: "client",
    scope_id: "cornerstone",
    owner: null,
    version: "0.2.0",
    tags: ["memory"],
  },
];

const BASE_CTX = {
  agentId: "agent-1",
  companyId: "company-1",
  adapterType: "managed_agents",
};

async function importSkillsModule() {
  return await import("@paperclipai/adapter-managed-agents/server");
}

describe("managed_agents adapter skill sync", () => {
  beforeEach(() => {
    cookbookListSkillsMock.mockReset();
    process.env.COOKBOOK_API_KEY = "test-cookbook-key";
    delete process.env.MEMORY_API_KEY;
  });

  it("returns ephemeral snapshot mirroring Cookbook fixture", async () => {
    cookbookListSkillsMock.mockResolvedValue(FIXTURE);
    const { listSkills } = await importSkillsModule();

    const snapshot = await listSkills({ ...BASE_CTX, config: {} });

    expect(snapshot.adapterType).toBe("managed_agents");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toEqual([]);
    expect(snapshot.entries).toHaveLength(FIXTURE.length);

    const fixtureNames = FIXTURE.map((s) => s.name).sort();
    expect(snapshot.entries.map((e) => e.key).sort()).toEqual(fixtureNames);

    const byKey = new Map(snapshot.entries.map((e) => [e.key, e]));
    for (const summary of FIXTURE) {
      const entry = byKey.get(summary.name);
      expect(entry).toBeDefined();
      expect(entry?.runtimeName).toBe(summary.name);
      expect(entry?.desired).toBe(false);
      expect(entry?.managed).toBe(true);
      expect(entry?.state).toBe("available");
      expect(entry?.origin).toBe("company_managed");
      expect(entry?.detail).toBe(summary.description);
    }
  });

  it("marks desired skills as configured and preserves descriptions", async () => {
    cookbookListSkillsMock.mockResolvedValue(FIXTURE);
    const { listSkills } = await importSkillsModule();

    const snapshot = await listSkills({
      ...BASE_CTX,
      config: {
        paperclipSkillSync: { desiredSkills: ["writing-style"] },
      },
    });

    expect(snapshot.desiredSkills).toEqual(["writing-style"]);
    const configured = snapshot.entries.find((e) => e.key === "writing-style");
    expect(configured?.desired).toBe(true);
    expect(configured?.state).toBe("configured");
    const other = snapshot.entries.find((e) => e.key === "brief-summariser");
    expect(other?.desired).toBe(false);
    expect(other?.state).toBe("available");
  });

  it("syncSkills returns an identical snapshot shape to listSkills for the same config", async () => {
    cookbookListSkillsMock.mockResolvedValue(FIXTURE);
    const { listSkills, syncSkills } = await importSkillsModule();
    const ctx = {
      ...BASE_CTX,
      config: { paperclipSkillSync: { desiredSkills: ["writing-style"] } },
    };

    const listed = await listSkills(ctx);
    const synced = await syncSkills(ctx, ["writing-style"]);

    expect(synced.adapterType).toBe(listed.adapterType);
    expect(synced.supported).toBe(listed.supported);
    expect(synced.mode).toBe(listed.mode);
    expect(synced.desiredSkills).toEqual(listed.desiredSkills);
    expect(synced.entries).toEqual(listed.entries);
    expect(synced.warnings).toEqual(listed.warnings);
  });

  it("surfaces Cookbook 401 as a warning while keeping supported true with empty entries", async () => {
    cookbookListSkillsMock.mockRejectedValue(
      new Error("Cookbook MCP 401: {\"error\":\"invalid api key\"}"),
    );
    const { listSkills } = await importSkillsModule();

    const snapshot = await listSkills({ ...BASE_CTX, config: {} });

    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toMatch(/Cookbook MCP list_skills failed/);
    expect(snapshot.warnings[0]).toMatch(/401/);
  });

  it("reports unsupported snapshot when COOKBOOK_API_KEY is missing", async () => {
    delete process.env.COOKBOOK_API_KEY;
    delete process.env.MEMORY_API_KEY;
    const { listSkills } = await importSkillsModule();

    const snapshot = await listSkills({ ...BASE_CTX, config: {} });

    expect(snapshot.supported).toBe(false);
    expect(snapshot.mode).toBe("unsupported");
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.warnings[0]).toMatch(/COOKBOOK_API_KEY is not set/);
    expect(cookbookListSkillsMock).not.toHaveBeenCalled();
  });

  it("falls back to MEMORY_API_KEY when COOKBOOK_API_KEY is absent", async () => {
    delete process.env.COOKBOOK_API_KEY;
    process.env.MEMORY_API_KEY = "legacy-fallback-key";
    cookbookListSkillsMock.mockResolvedValue(FIXTURE);
    const { listSkills } = await importSkillsModule();

    const snapshot = await listSkills({ ...BASE_CTX, config: {} });

    expect(snapshot.supported).toBe(true);
    expect(cookbookListSkillsMock).toHaveBeenCalledWith("legacy-fallback-key");
  });
});
