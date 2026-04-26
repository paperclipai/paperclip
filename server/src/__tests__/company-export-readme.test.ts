import { describe, it, expect } from "vitest";
import {
  generateOrgChartMermaid,
  generateReadme,
} from "../services/company-export-readme.js";
import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilitySkillManifestEntry,
  CompanyPortabilityProjectManifestEntry,
  CompanyPortabilityManifest,
} from "@paperclipai/shared";

function makeAgent(overrides: Partial<CompanyPortabilityAgentManifestEntry> = {}): CompanyPortabilityAgentManifestEntry {
  return {
    slug: "test-agent",
    name: "Test Agent",
    path: "agents/test-agent",
    skills: [],
    role: "engineer",
    title: null,
    icon: null,
    capabilities: null,
    reportsToSlug: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    budgetMonthlyCents: 0,
    metadata: null,
    ...overrides,
  };
}

function makeSkill(overrides: Partial<CompanyPortabilitySkillManifestEntry> = {}): CompanyPortabilitySkillManifestEntry {
  return {
    key: "skill-key",
    slug: "skill-slug",
    name: "Test Skill",
    path: "skills/test-skill",
    description: null,
    sourceType: "local",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: null,
    compatibility: null,
    metadata: null,
    fileInventory: [],
    ...overrides,
  };
}

function makeProject(overrides: Partial<CompanyPortabilityProjectManifestEntry> = {}): CompanyPortabilityProjectManifestEntry {
  return {
    slug: "project-slug",
    name: "Test Project",
    path: "projects/test-project",
    description: null,
    ownerAgentSlug: null,
    leadAgentSlug: null,
    targetDate: null,
    color: null,
    status: "in_progress",
    executionWorkspacePolicy: null,
    workspaces: [],
    ...overrides,
  };
}

function makeManifest(overrides: Partial<CompanyPortabilityManifest> = {}): CompanyPortabilityManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source: null,
    includes: { agents: true, skills: true, projects: true, issues: false },
    company: null,
    sidebar: null,
    agents: [],
    skills: [],
    projects: [],
    issues: [],
    envInputs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateOrgChartMermaid
// ---------------------------------------------------------------------------

describe("generateOrgChartMermaid", () => {
  it("returns null when agents array is empty", () => {
    expect(generateOrgChartMermaid([])).toBeNull();
  });

  it("renders a single agent node with known role label", () => {
    const result = generateOrgChartMermaid([makeAgent({ name: "Alice", slug: "alice", role: "cto" })]);
    expect(result).not.toBeNull();
    expect(result).toContain("```mermaid");
    expect(result).toContain("graph TD");
    expect(result).toContain("alice");
    expect(result).toContain("Alice");
    expect(result).toContain("CTO");
  });

  it("renders unknown roles verbatim", () => {
    const result = generateOrgChartMermaid([makeAgent({ slug: "bob", role: "wizard" })]);
    expect(result).toContain("wizard");
  });

  it("renders edges between agents when reportsToSlug is set", () => {
    const agents = [
      makeAgent({ name: "CEO", slug: "ceo-agent", role: "ceo", reportsToSlug: null }),
      makeAgent({ name: "Dev", slug: "dev-agent", role: "engineer", reportsToSlug: "ceo-agent" }),
    ];
    const result = generateOrgChartMermaid(agents)!;
    expect(result).toContain("ceo_agent --> dev_agent");
  });

  it("skips edges to agents not present in the set", () => {
    const agents = [makeAgent({ slug: "dev-agent", role: "engineer", reportsToSlug: "nonexistent-slug" })];
    const result = generateOrgChartMermaid(agents)!;
    expect(result).not.toContain("-->");
  });

  it("replaces hyphens in slugs with underscores for Mermaid node IDs", () => {
    const result = generateOrgChartMermaid([makeAgent({ slug: "my-agent-slug" })])!;
    expect(result).toContain("my_agent_slug[");
    expect(result).not.toContain("my-agent-slug[");
  });

  it("escapes double quotes in agent names", () => {
    const result = generateOrgChartMermaid([makeAgent({ name: 'Agent "Quote"', slug: "q" })])!;
    expect(result).toContain("&quot;");
    expect(result).not.toContain('"Quote"');
  });

  it("escapes angle brackets in agent names", () => {
    const result = generateOrgChartMermaid([makeAgent({ name: "Agent <Beta>", slug: "beta" })])!;
    expect(result).toContain("&lt;Beta&gt;");
  });

  it("wraps output in mermaid code fence", () => {
    const result = generateOrgChartMermaid([makeAgent()])!;
    expect(result).toMatch(/^```mermaid\n/);
    expect(result).toMatch(/\n```$/);
  });

  it("labels known roles: ceo, cmo, cfo, coo, vp, manager, agent", () => {
    const roleMap: Record<string, string> = {
      ceo: "CEO", cmo: "CMO", cfo: "CFO", coo: "COO",
      vp: "VP", manager: "Manager", agent: "Agent",
    };
    for (const [role, label] of Object.entries(roleMap)) {
      const result = generateOrgChartMermaid([makeAgent({ slug: role, role })])!;
      expect(result).toContain(label);
    }
  });
});

// ---------------------------------------------------------------------------
// generateReadme
// ---------------------------------------------------------------------------

describe("generateReadme", () => {
  it("includes the company name as an H1 heading", () => {
    const result = generateReadme(makeManifest(), { companyName: "Acme Corp", companyDescription: null });
    expect(result).toContain("# Acme Corp");
  });

  it("includes description as a blockquote when provided", () => {
    const result = generateReadme(makeManifest(), { companyName: "Acme", companyDescription: "Best company ever" });
    expect(result).toContain("> Best company ever");
  });

  it("does not include a description line when companyDescription is null", () => {
    const result = generateReadme(makeManifest(), { companyName: "Acme", companyDescription: null });
    // Verify no user-supplied description blockquote appears (the fixed > line
    // in What's Inside is a different marker and is fine to have).
    expect(result).not.toContain("> null");
    // When a description is provided it appears right after the H1 blank line;
    // here we confirm that slot is not populated.
    const lines = result.split("\n");
    const h1Idx = lines.findIndex((l) => l === "# Acme");
    // Line at h1Idx+1 is a blank; h1Idx+2 should be a section header or blank, not a description.
    expect(lines[h1Idx + 2]).not.toMatch(/^> [A-Z]/);
  });

  it("includes org chart image when agents are present", () => {
    const result = generateReadme(makeManifest({ agents: [makeAgent()] }), { companyName: "Acme", companyDescription: null });
    expect(result).toContain("![Org Chart](images/org-chart.png)");
  });

  it("omits org chart image when no agents", () => {
    const result = generateReadme(makeManifest({ agents: [] }), { companyName: "Acme", companyDescription: null });
    expect(result).not.toContain("![Org Chart]");
  });

  it("includes agents table with correct role labels and reports-to column", () => {
    const manifest = makeManifest({
      agents: [
        makeAgent({ name: "Boss", slug: "boss", role: "ceo", reportsToSlug: null }),
        makeAgent({ name: "Coder", slug: "coder", role: "engineer", reportsToSlug: "boss" }),
      ],
    });
    const result = generateReadme(manifest, { companyName: "Acme", companyDescription: null });
    expect(result).toContain("| Agent | Role | Reports To |");
    expect(result).toContain("| Boss | CEO | \u2014 |");
    expect(result).toContain("| Coder | Engineer | boss |");
  });

  it("includes projects list with description", () => {
    const manifest = makeManifest({ projects: [makeProject({ name: "Alpha", description: "First project" })] });
    const result = generateReadme(manifest, { companyName: "Acme", companyDescription: null });
    expect(result).toContain("### Projects");
    expect(result).toContain("**Alpha**");
    expect(result).toContain("First project");
  });

  it("omits projects section when no projects", () => {
    const result = generateReadme(makeManifest({ projects: [] }), { companyName: "Acme", companyDescription: null });
    expect(result).not.toContain("### Projects");
  });

  it("renders github skill source as a markdown link", () => {
    const manifest = makeManifest({
      skills: [makeSkill({ name: "Reviewer", sourceType: "github", sourceLocator: "https://github.com/org/repo" })],
    });
    const result = generateReadme(manifest, { companyName: "Acme", companyDescription: null });
    expect(result).toContain("### Skills");
    expect(result).toContain("[github](https://github.com/org/repo)");
  });

  it("renders skills_sh skill source as a markdown link", () => {
    const manifest = makeManifest({
      skills: [makeSkill({ sourceType: "skills_sh", sourceLocator: "https://skills.sh/my-skill" })],
    });
    const result = generateReadme(manifest, { companyName: "Acme", companyDescription: null });
    expect(result).toContain("[skills_sh](https://skills.sh/my-skill)");
  });

  it("renders url skill source as a markdown link", () => {
    const manifest = makeManifest({
      skills: [makeSkill({ sourceType: "url", sourceLocator: "https://example.com/skill" })],
    });
    const result = generateReadme(manifest, { companyName: "Acme", companyDescription: null });
    expect(result).toContain("[url](https://example.com/skill)");
  });

  it("shows plain sourceLocator for non-link source types", () => {
    const manifest = makeManifest({
      skills: [makeSkill({ sourceType: "registry", sourceLocator: "registry-id-123" })],
    });
    const result = generateReadme(manifest, { companyName: "Acme", companyDescription: null });
    expect(result).toContain("registry-id-123");
    expect(result).not.toContain("[registry]");
  });

  it("shows 'local' for local source type with no locator", () => {
    const manifest = makeManifest({
      skills: [makeSkill({ sourceType: "local", sourceLocator: null })],
    });
    const result = generateReadme(manifest, { companyName: "Acme", companyDescription: null });
    expect(result).toContain("| local |");
  });

  it("shows em-dash for skills with null sourceType and null sourceLocator", () => {
    const manifest = makeManifest({
      skills: [makeSkill({ sourceType: null as never, sourceLocator: null })],
    });
    const result = generateReadme(manifest, { companyName: "Acme", companyDescription: null });
    expect(result).toContain("| \u2014 |");
  });

  it("includes What's Inside counts table when content is present", () => {
    const manifest = makeManifest({ agents: [makeAgent()], skills: [makeSkill()] });
    const result = generateReadme(manifest, { companyName: "Acme", companyDescription: null });
    expect(result).toContain("| Content | Count |");
    expect(result).toContain("| Agents | 1 |");
    expect(result).toContain("| Skills | 1 |");
  });

  it("omits What's Inside table when all arrays are empty", () => {
    const result = generateReadme(makeManifest(), { companyName: "Acme", companyDescription: null });
    expect(result).not.toContain("| Content | Count |");
  });

  it("includes Getting Started section with install command", () => {
    const result = generateReadme(makeManifest(), { companyName: "Acme", companyDescription: null });
    expect(result).toContain("## Getting Started");
    expect(result).toContain("pnpm paperclipai company import");
  });

  it("includes a footer with export date", () => {
    const result = generateReadme(makeManifest(), { companyName: "Acme", companyDescription: null });
    expect(result).toContain("Exported from");
    const today = new Date().toISOString().split("T")[0];
    expect(result).toContain(today);
  });
});
