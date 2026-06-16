import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogTeam } from "@paperclipai/shared";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  installFromCatalog: vi.fn(),
  importFromSource: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/company-portability.js", () => ({
  companyPortabilityService: () => mockCompanyPortabilityService,
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => mockCompanySkillService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

const {
  collectCatalogTeamSkillPreparations,
  readCatalogAgentModelHints,
  readCatalogTeamProvenance,
  teamsCatalogService,
} = await import("../services/teams-catalog.js");

const CORE_EXEC_TEAM_ID = "paperclipai:bundled:company-defaults:core-exec-team";
const CORE_EXEC_TEAM_HASH = "sha256:b871f8dab28a98542f2f0abe68b772f3b368b18f36a080b32c62bcf4c43de7f3";

function agentWithCatalogTeam(originHash: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: `agent-${Math.random().toString(36).slice(2)}`,
    companyId: "company-1",
    metadata: {
      paperclip: {
        catalogTeam: {
          catalogId: CORE_EXEC_TEAM_ID,
          catalogKey: "paperclipai/bundled/company-defaults/core-exec-team",
          ...(originHash ? { originHash } : {}),
        },
      },
    },
    ...extra,
  };
}

describe("teamsCatalogService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue({
      id: "manager-1",
      companyId: "company-1",
      name: "Engineering Manager",
    });
    mockCompanyPortabilityService.previewImport.mockResolvedValue({
      include: { company: false, agents: true, projects: true, issues: true, skills: true },
      targetCompanyId: "company-1",
      targetCompanyName: "Paperclip",
      collisionStrategy: "rename",
      selectedAgentSlugs: ["ceo", "cto"],
      plan: { companyAction: "none", agentPlans: [], projectPlans: [], issuePlans: [] },
      manifest: { agents: [], skills: [], projects: [], issues: [], envInputs: [], includes: { company: false, agents: true, projects: true, issues: true, skills: true }, company: null, schemaVersion: 1, generatedAt: new Date().toISOString(), source: null, sidebar: null },
      files: {},
      envInputs: [],
      warnings: [],
      errors: [],
    });
    mockCompanyPortabilityService.importBundle.mockResolvedValue({
      company: { id: "company-1", name: "Paperclip", action: "unchanged" },
      agents: [],
      projects: [],
      envInputs: [],
      warnings: [],
    });
    mockCompanySkillService.installFromCatalog.mockResolvedValue({
      action: "created",
      skill: { key: "paperclipai/bundled/paperclip-operations/task-planning" },
      catalogSkill: { id: "paperclipai:bundled:paperclip-operations:task-planning" },
      warnings: [],
    });
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [],
      warnings: [],
    });
  });

  it("builds an inline portability source with catalog skill keys and target-manager reparenting", async () => {
    const svc = teamsCatalogService({} as any);

    const prepared = await svc.prepareCatalogTeamSource("company-1", "core-exec-team", {
      targetManagerAgentId: "manager-1",
    });

    expect(prepared.errors).toEqual([]);
    expect(prepared.source.files["COMPANY.md"]).toEqual(expect.stringContaining("Core Exec Team"));
    expect(prepared.source.files["agents/ceo/AGENTS.md"]).toEqual(expect.stringContaining("paperclipai/bundled/paperclip-operations/task-planning"));
    expect(prepared.source.files["agents/cto/AGENTS.md"]).toEqual(expect.stringContaining("paperclipai/bundled/software-development/github-pr-workflow"));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentId: \"manager-1\""));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentSlug: \"engineering-manager\""));
  });

  it("resolves target-manager slug against same-company agents before rendering reparent metadata", async () => {
    mockAgentService.list.mockResolvedValue([
      { id: "manager-1", companyId: "company-1", name: "CEO" },
    ]);
    const svc = teamsCatalogService({} as any);

    const prepared = await svc.prepareCatalogTeamSource("company-1", "core-exec-team", {
      targetManagerSlug: "ceo",
    });

    expect(mockAgentService.list).toHaveBeenCalledWith("company-1");
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentId: \"manager-1\""));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentSlug: \"ceo\""));
  });

  it("preserves package-declared Paperclip sidecar permissions while adding generated catalog provenance", async () => {
    const svc = teamsCatalogService({} as any);

    const prepared = await svc.prepareCatalogTeamSource("company-1", "product-engineering");

    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("permissions:"));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("canCreateAgents: true"));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("catalogTeam:"));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("catalogSlug: \"product-engineering\""));
  });

  it("preserves package sidecar permissions when generated target-manager metadata is merged onto the same root agent", async () => {
    const svc = teamsCatalogService({} as any);

    const prepared = await svc.prepareCatalogTeamSource("company-1", "product-engineering", {
      targetManagerAgentId: "manager-1",
    });

    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("permissions:"));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("canCreateAgents: true"));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentId: \"manager-1\""));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentSlug: \"engineering-manager\""));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("catalogSlug: \"product-engineering\""));
  });

  it("rejects missing target-manager slugs instead of emitting unresolved reparent metadata", async () => {
    mockAgentService.list.mockResolvedValue([]);
    const svc = teamsCatalogService({} as any);

    await expect(
      svc.prepareCatalogTeamSource("company-1", "core-exec-team", {
        targetManagerSlug: "missing-manager",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("previews through company portability in agent-safe mode", async () => {
    const svc = teamsCatalogService({} as any);

    const preview = await svc.previewCatalogTeamImport("company-1", "content-machine");

    expect(preview.errors).toEqual([]);
    expect(mockCompanyPortabilityService.previewImport).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { mode: "existing_company", companyId: "company-1" },
        include: expect.objectContaining({
          company: false,
          agents: true,
          projects: true,
          issues: true,
          skills: true,
        }),
        source: expect.objectContaining({ type: "inline" }),
      }),
      { mode: "agent_safe", sourceCompanyId: "company-1" },
    );
  });

  it("forces catalog previews to exclude company metadata even when requested", async () => {
    const svc = teamsCatalogService({} as any);

    await svc.previewCatalogTeamImport("company-1", "content-machine", {
      include: { company: true, agents: false },
    });

    expect(mockCompanyPortabilityService.previewImport).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          company: false,
          agents: false,
        }),
      }),
      { mode: "agent_safe", sourceCompanyId: "company-1" },
    );
  });

  it("preflights imports before installing catalog skills", async () => {
    mockCompanyPortabilityService.previewImport.mockResolvedValueOnce({
      include: { company: false, agents: true, projects: true, issues: true, skills: true },
      targetCompanyId: "company-1",
      targetCompanyName: "Paperclip",
      collisionStrategy: "rename",
      selectedAgentSlugs: ["ceo"],
      plan: { companyAction: "none", agentPlans: [], projectPlans: [], issuePlans: [] },
      manifest: { agents: [], skills: [], projects: [], issues: [], envInputs: [], includes: { company: false, agents: true, projects: true, issues: true, skills: true }, company: null, schemaVersion: 1, generatedAt: new Date().toISOString(), source: null, sidebar: null },
      files: {},
      envInputs: [],
      warnings: [],
      errors: ["Safe import does not allow process adapter type."],
    });
    const svc = teamsCatalogService({} as any);

    await expect(svc.installCatalogTeam("company-1", "core-exec-team")).rejects.toMatchObject({ status: 422 });

    expect(mockCompanySkillService.installFromCatalog).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it("does not install catalog skills when bundle import fails", async () => {
    mockCompanyPortabilityService.importBundle.mockRejectedValueOnce(new Error("import failed"));
    const svc = teamsCatalogService({} as any);

    await expect(svc.installCatalogTeam("company-1", "core-exec-team")).rejects.toThrow("import failed");

    expect(mockCompanySkillService.installFromCatalog).not.toHaveBeenCalled();
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("surfaces post-import catalog skill install failures as warnings", async () => {
    mockCompanySkillService.installFromCatalog.mockRejectedValueOnce(new Error("catalog unavailable"));
    const svc = teamsCatalogService({} as any);

    const result = await svc.installCatalogTeam("company-1", "core-exec-team");

    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalled();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("catalog unavailable"),
      ]),
    );
  });

  it("injects safe claude_local adapter defaults for every bundled agent when no overrides are supplied", async () => {
    const svc = teamsCatalogService({} as any);

    await svc.installCatalogTeam("company-1", "core-exec-team");

    const [importInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
    expect(importInput.adapterOverrides).toEqual({
      ceo: { adapterType: "claude_local" },
      cto: { adapterType: "claude_local" },
      qa: { adapterType: "claude_local" },
    });
  });

  it("uses the configured safe adapter default for bundled agents", async () => {
    const previousDefault = process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE;
    process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE = "opencode_local";
    try {
      const svc = teamsCatalogService({} as any);

      await svc.installCatalogTeam("company-1", "core-exec-team");

      const [importInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
      expect(importInput.adapterOverrides).toEqual({
        ceo: { adapterType: "opencode_local" },
        cto: { adapterType: "opencode_local" },
        qa: { adapterType: "opencode_local" },
      });
    } finally {
      if (previousDefault === undefined) {
        delete process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE;
      } else {
        process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE = previousDefault;
      }
    }
  });

  it("supplies safe adapter defaults for product-design and product-engineering installs", async () => {
    const svc = teamsCatalogService({} as any);

    await svc.installCatalogTeam("company-1", "product-design");
    const [designInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
    expect(designInput.adapterOverrides).toEqual({
      "ux-designer": { adapterType: "claude_local" },
    });

    await svc.installCatalogTeam("company-1", "product-engineering");
    const [engineeringInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
    expect(engineeringInput.adapterOverrides).toEqual({
      cto: { adapterType: "claude_local" },
      qa: { adapterType: "claude_local" },
      "senior-coder": { adapterType: "claude_local" },
    });
  });

  it("never sends a forbidden process adapter type from the default catalog path", async () => {
    const svc = teamsCatalogService({} as any);

    await svc.installCatalogTeam("company-1", "core-exec-team");

    const [importInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
    const adapterTypes = Object.values(importInput.adapterOverrides as Record<string, { adapterType: string }>)
      .map((override) => override.adapterType);
    expect(adapterTypes).not.toContain("process");
    expect(adapterTypes).not.toContain("http");
  });

  it("preserves an explicit caller adapter override for the affected slug", async () => {
    const svc = teamsCatalogService({} as any);

    const callerOverrides = {
      cto: { adapterType: "opencode_local", adapterConfig: { model: "anthropic/claude-opus-4" } },
    };
    await svc.installCatalogTeam("company-1", "core-exec-team", {
      adapterOverrides: callerOverrides,
    });

    const [importInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
    expect(importInput.adapterOverrides).toEqual({
      ceo: { adapterType: "claude_local" },
      cto: { adapterType: "opencode_local", adapterConfig: { model: "anthropic/claude-opus-4" } },
      qa: { adapterType: "claude_local" },
    });
    // Caller-supplied object must not be mutated in place.
    expect(callerOverrides).toEqual({
      cto: { adapterType: "opencode_local", adapterConfig: { model: "anthropic/claude-opus-4" } },
    });
  });

  describe("A5 — per-role model tiering via catalog AGENTS.md frontmatter", () => {
    it("injects catalog model hints into adapterConfig when adapter is claude_local", async () => {
      const svc = teamsCatalogService({} as any);

      await svc.installCatalogTeam("company-1", "dev-team");

      const [importInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
      const overrides = importInput.adapterOverrides as Record<string, { adapterType: string; adapterConfig?: { model?: string } }>;
      // CTO has model: sonnet → claude-sonnet-4-6
      expect(overrides["cto"]).toEqual({ adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-6" } });
      // architect has model: opus → claude-opus-4-8
      expect(overrides["architect"]).toEqual({ adapterType: "claude_local", adapterConfig: { model: "claude-opus-4-8" } });
      // code-reviewer has model: sonnet → claude-sonnet-4-6
      expect(overrides["code-reviewer"]).toEqual({ adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-6" } });
    });

    it("catalog model hints are not injected for non-claude_local adapters", async () => {
      const previousDefault = process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE;
      process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE = "opencode_local";
      try {
        const svc = teamsCatalogService({} as any);

        await svc.installCatalogTeam("company-1", "dev-team");

        const [importInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
        const overrides = importInput.adapterOverrides as Record<string, { adapterType: string; adapterConfig?: unknown }>;
        // opencode_local: no claude model IDs injected
        expect(overrides["cto"]).toEqual({ adapterType: "opencode_local" });
        expect(overrides["architect"]).toEqual({ adapterType: "opencode_local" });
      } finally {
        if (previousDefault === undefined) {
          delete process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE;
        } else {
          process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE = previousDefault;
        }
      }
    });

    it("caller adapterOverride wins over catalog model hint", async () => {
      const svc = teamsCatalogService({} as any);

      await svc.installCatalogTeam("company-1", "dev-team", {
        adapterOverrides: {
          cto: { adapterType: "claude_local", adapterConfig: { model: "claude-opus-4-8" } },
        },
      });

      const [importInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
      const overrides = importInput.adapterOverrides as Record<string, { adapterType: string; adapterConfig?: { model?: string } }>;
      // Caller explicitly set opus — catalog sonnet hint must not override it
      expect(overrides["cto"]).toEqual({ adapterType: "claude_local", adapterConfig: { model: "claude-opus-4-8" } });
      // Other agents still get their catalog hints
      expect(overrides["architect"]).toEqual({ adapterType: "claude_local", adapterConfig: { model: "claude-opus-4-8" } });
    });

    it("agents without a recognized model alias in catalog AGENTS.md get no adapterConfig", async () => {
      const svc = teamsCatalogService({} as any);

      await svc.installCatalogTeam("company-1", "core-exec-team");

      const [importInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
      const overrides = importInput.adapterOverrides as Record<string, { adapterType: string; adapterConfig?: unknown }>;
      // core-exec-team agents have no model field → no adapterConfig
      expect(overrides["ceo"]).toEqual({ adapterType: "claude_local" });
      expect(overrides["cto"]).toEqual({ adapterType: "claude_local" });
    });

    it("preview applies the same adapter defaults + model hints as install (BUG-004)", async () => {
      const svc = teamsCatalogService({} as any);

      await svc.previewCatalogTeamImport("company-1", "dev-team");

      const [previewArg] = mockCompanyPortabilityService.previewImport.mock.calls.at(-1)!;
      const overrides = previewArg.adapterOverrides as Record<string, { adapterType: string; adapterConfig?: { model?: string } }>;
      // Preview must reflect what install writes: claude_local default + catalog model tiers.
      expect(overrides["cto"]).toEqual({ adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-6" } });
      expect(overrides["architect"]).toEqual({ adapterType: "claude_local", adapterConfig: { model: "claude-opus-4-8" } });
    });

    it("preview of a no-model-hint team produces clean adapter defaults, no adapterConfig (BUG-004 coverage)", async () => {
      const svc = teamsCatalogService({} as any);

      const result = await svc.previewCatalogTeamImport("company-1", "core-exec-team");

      // The no-model-hint path now runs through the adapter-defaults machinery too;
      // confirm it yields a bare adapterType (no spurious adapterConfig) and no errors.
      const [previewArg] = mockCompanyPortabilityService.previewImport.mock.calls.at(-1)!;
      const overrides = previewArg.adapterOverrides as Record<string, { adapterType: string; adapterConfig?: unknown }>;
      expect(overrides["ceo"]).toEqual({ adapterType: "claude_local" });
      expect(overrides["cto"]).toEqual({ adapterType: "claude_local" });
      expect(result.errors).toEqual([]);
    });

    describe("readCatalogAgentModelHints — frontmatter resolution safety (BUG-003)", () => {
      const md = (model: string) => `---\nmodel: ${model}\n---\n# agent\n`;

      it("resolves known aliases to canonical claude_local model IDs", () => {
        const hints = readCatalogAgentModelHints(
          { "agents/cto/AGENTS.md": md("sonnet"), "agents/architect/AGENTS.md": md("opus") },
          ["cto", "architect"],
        );
        expect(hints).toEqual({ cto: "claude-sonnet-4-6", architect: "claude-opus-4-8" });
      });

      it("ignores an unrecognized alias instead of forwarding it to --model", () => {
        const hints = readCatalogAgentModelHints({ "agents/cto/AGENTS.md": md("haiku") }, ["cto"]);
        expect(hints).toEqual({});
      });

      it("does not resolve inherited Object.prototype members (prototype-pollution guard)", () => {
        const hints = readCatalogAgentModelHints(
          {
            "agents/a/AGENTS.md": md("constructor"),
            "agents/b/AGENTS.md": md("toString"),
            "agents/c/AGENTS.md": md("hasOwnProperty"),
          },
          ["a", "b", "c"],
        );
        expect(hints).toEqual({});
      });
    });
  });

  it("omits the default-adapter warning when every agent has an explicit override", async () => {
    const svc = teamsCatalogService({} as any);

    const result = await svc.installCatalogTeam("company-1", "core-exec-team", {
      adapterOverrides: {
        ceo: { adapterType: "opencode_local" },
        cto: { adapterType: "opencode_local" },
        qa: { adapterType: "opencode_local" },
      },
    });

    expect(result.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("default to claude_local")]),
    );
  });

  it("passes install secretValues through to company portability import", async () => {
    const svc = teamsCatalogService({} as any);

    await svc.installCatalogTeam("company-1", "core-exec-team", {
      secretValues: { "agent:ceo:OPENAI_API_KEY": "sk-imported" },
    });

    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        secretValues: { "agent:ceo:OPENAI_API_KEY": "sk-imported" },
      }),
      null,
      { mode: "agent_safe", sourceCompanyId: "company-1" },
    );
  });

  describe("readCatalogTeamProvenance", () => {
    it("reads catalogTeam provenance from agent metadata", () => {
      expect(
        readCatalogTeamProvenance({
          paperclip: { catalogTeam: { catalogId: "team-x", catalogKey: "k", originHash: "sha256:1" } },
        }),
      ).toEqual({ catalogId: "team-x", catalogKey: "k", originHash: "sha256:1" });
    });

    it("returns null when there is no catalogTeam provenance", () => {
      expect(readCatalogTeamProvenance(null)).toBeNull();
      expect(readCatalogTeamProvenance({})).toBeNull();
      expect(readCatalogTeamProvenance({ paperclip: { catalog: { skillKey: "s" } } })).toBeNull();
      expect(readCatalogTeamProvenance({ paperclip: { catalogTeam: { originHash: "h" } } })).toBeNull();
    });
  });

  describe("listInstalledCatalogTeams", () => {
    it("marks a team out of date when an installed originHash differs from the catalog hash", async () => {
      mockAgentService.list.mockResolvedValue([
        agentWithCatalogTeam("sha256:stale-hash"),
        agentWithCatalogTeam("sha256:stale-hash"),
        { id: "no-provenance", companyId: "company-1", metadata: null },
      ]);
      const svc = teamsCatalogService({} as any);

      const installed = await svc.listInstalledCatalogTeams("company-1");

      expect(mockAgentService.list).toHaveBeenCalledWith("company-1");
      expect(installed).toEqual([
        expect.objectContaining({
          catalogId: CORE_EXEC_TEAM_ID,
          present: true,
          currentContentHash: CORE_EXEC_TEAM_HASH,
          installedOriginHashes: ["sha256:stale-hash"],
          agentCount: 2,
          outOfDate: true,
        }),
      ]);
    });

    it("marks a team up to date when the installed originHash matches the catalog hash", async () => {
      mockAgentService.list.mockResolvedValue([agentWithCatalogTeam(CORE_EXEC_TEAM_HASH)]);
      const svc = teamsCatalogService({} as any);

      const installed = await svc.listInstalledCatalogTeams("company-1");

      expect(installed).toHaveLength(1);
      expect(installed[0]).toMatchObject({ present: true, outOfDate: false, agentCount: 1 });
    });

    it("does not flag teams that no longer resolve to a catalog entry", async () => {
      mockAgentService.list.mockResolvedValue([
        {
          id: "removed",
          companyId: "company-1",
          metadata: { paperclip: { catalogTeam: { catalogId: "paperclipai:bundled:gone:removed", originHash: "sha256:x" } } },
        },
      ]);
      const svc = teamsCatalogService({} as any);

      const installed = await svc.listInstalledCatalogTeams("company-1");

      expect(installed).toEqual([
        expect.objectContaining({ present: false, currentContentHash: null, outOfDate: false }),
      ]);
    });

    it("returns an empty list when no agents carry catalog-team provenance", async () => {
      mockAgentService.list.mockResolvedValue([{ id: "a", companyId: "company-1", metadata: {} }]);
      const svc = teamsCatalogService({} as any);

      expect(await svc.listInstalledCatalogTeams("company-1")).toEqual([]);
    });
  });

  it("classifies unresolved and unsafe external skill requirements as blocked", () => {
    const fakeTeam: CatalogTeam = {
      id: "paperclipai:optional:test:unsafe",
      key: "paperclipai/optional/test/unsafe",
      kind: "optional",
      category: "test",
      slug: "unsafe",
      name: "Unsafe",
      description: "Unsafe",
      path: "catalog/optional/test/unsafe",
      entrypoint: "TEAM.md",
      schema: "agentcompanies/v1",
      defaultInstall: false,
      recommendedForCompanyTypes: [],
      tags: [],
      counts: { agents: 0, projects: 0, tasks: 0, routines: 0, localSkills: 0, catalogSkills: 0, externalSkillSources: 2 },
      rootAgentSlugs: [],
      agentSlugs: [],
      projectSlugs: [],
      requiredSkills: [
        { type: "github", ref: "https://github.com/acme/skill", agentSlugs: ["agent"], resolved: true, sourceLocator: "https://github.com/acme/skill" },
        { type: "catalog", ref: "missing", agentSlugs: ["agent"], resolved: false },
      ],
      envInputs: [],
      sourceRefs: [],
      files: [],
      trustLevel: "external_sources",
      compatibility: "compatible",
      contentHash: "sha256:test",
    };

    const result = collectCatalogTeamSkillPreparations(fakeTeam);

    expect(result.errors).toEqual([
      'External skill source "https://github.com/acme/skill" requires explicit source policy approval.',
      'Skill requirement "missing" is unresolved in catalog manifest.',
    ]);
    expect(result.preparations.map((entry) => entry.action)).toEqual(["blocked", "blocked"]);
  });
});
