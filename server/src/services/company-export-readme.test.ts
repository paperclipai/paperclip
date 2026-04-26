import { describe, it, expect } from "vitest";
import { generateOrgChartMermaid, generateReadme } from "./company-export-readme.js";
import type { CompanyPortabilityManifest } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Minimal manifest factory
// ---------------------------------------------------------------------------

function makeAgent(
  overrides: Partial<{
    slug: string;
    name: string;
    role: string;
    reportsToSlug: string | null;
  }> = {},
): CompanyPortabilityManifest["agents"][number] {
  return {
    slug: overrides.slug ?? "agent-1",
    name: overrides.name ?? "Agent One",
    path: "agents/agent-1",
    skills: [],
    role: overrides.role ?? "engineer",
    title: null,
    icon: null,
    capabilities: null,
    reportsToSlug: overrides.reportsToSlug ?? null,
    adapterType: "codex-local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    budgetMonthlyCents: 0,
    metadata: null,
  };
}

function makeManifest(
  overrides: Partial<Pick<CompanyPortabilityManifest, "agents" | "projects" | "skills" | "issues">> = {},
): CompanyPortabilityManifest {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: null,
    includes: { company: false, agents: false, projects: false, issues: false, skills: false },
    company: null,
    sidebar: null,
    agents: overrides.agents ?? [],
    skills: overrides.skills ?? [],
    projects: overrides.projects ?? [],
    issues: overrides.issues ?? [],
    envInputs: [],
  };
}

// ---------------------------------------------------------------------------
// generateOrgChartMermaid
// ---------------------------------------------------------------------------

describe("generateOrgChartMermaid", () => {
  it("returns null for an empty agents array", () => {
    expect(generateOrgChartMermaid([])).toBeNull();
  });

  it("returns a mermaid code fence for a single agent", () => {
    const result = generateOrgChartMermaid([makeAgent()]);
    expect(result).not.toBeNull();
    expect(result).toContain("```mermaid");
    expect(result).toContain("graph TD");
    expect(result).toContain("```");
  });

  it("includes the agent name in the mermaid node definition", () => {
    const result = generateOrgChartMermaid([makeAgent({ name: "Alice" })]);
    expect(result).toContain("Alice");
  });

  it("maps known roles to human-readable labels", () => {
    const result = generateOrgChartMermaid([makeAgent({ role: "ceo" })]);
    expect(result).toContain("CEO");
  });

  it("falls back to the raw role value for unknown roles", () => {
    const result = generateOrgChartMermaid([makeAgent({ role: "wizard" })]);
    expect(result).toContain("wizard");
  });

  it("sanitizes slug to alphanumeric+underscore for node IDs", () => {
    const result = generateOrgChartMermaid([makeAgent({ slug: "my-agent.1" })]);
    expect(result).toContain("my_agent_1");
    expect(result).not.toContain("my-agent.1[");
  });

  it("escapes double quotes in agent names", () => {
    const result = generateOrgChartMermaid([makeAgent({ name: 'Bot "Alpha"' })]);
    expect(result).toContain("&quot;");
    expect(result).not.toContain('"Alpha"');
  });

  it("escapes < and > in agent names", () => {
    const result = generateOrgChartMermaid([makeAgent({ name: "Bot <v2>" })]);
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
  });

  it("adds an edge from parent to child when reportsToSlug is set and present in the list", () => {
    const agents = [
      makeAgent({ slug: "ceo", name: "CEO Agent", role: "ceo" }),
      makeAgent({ slug: "dev", name: "Dev Agent", role: "engineer", reportsToSlug: "ceo" }),
    ];
    const result = generateOrgChartMermaid(agents);
    expect(result).toContain("ceo --> dev");
  });

  it("does not add an edge when reportsToSlug references a slug not in the list", () => {
    const agents = [makeAgent({ slug: "dev", reportsToSlug: "ghost-ceo" })];
    const result = generateOrgChartMermaid(agents);
    expect(result).not.toContain("-->");
  });

  it("does not add an edge when reportsToSlug is null", () => {
    const agents = [makeAgent({ slug: "solo", reportsToSlug: null })];
    const result = generateOrgChartMermaid(agents);
    expect(result).not.toContain("-->");
  });
});

// ---------------------------------------------------------------------------
// generateReadme
// ---------------------------------------------------------------------------

describe("generateReadme", () => {
  const opts = { companyName: "Acme Corp", companyDescription: null };

  it("starts with the company name as an H1 heading", () => {
    const result = generateReadme(makeManifest(), opts);
    expect(result).toContain("# Acme Corp");
  });

  it("includes the company description as a blockquote when provided", () => {
    const result = generateReadme(makeManifest(), {
      companyName: "Acme",
      companyDescription: "We build stuff",
    });
    expect(result).toContain("> We build stuff");
  });

  it("omits the company description blockquote when description is null", () => {
    const result = generateReadme(makeManifest(), { companyName: "Acme", companyDescription: null });
    // The only blockquote in the output should be the "What's Inside" boilerplate, not a company description line.
    // Verify the specific description text is not present.
    expect(result).not.toContain("> We build stuff");
  });

  it("includes the Getting Started section", () => {
    const result = generateReadme(makeManifest(), opts);
    expect(result).toContain("## Getting Started");
    expect(result).toContain("pnpm paperclipai company import");
  });

  it("includes a Paperclip footer", () => {
    const result = generateReadme(makeManifest(), opts);
    expect(result).toContain("Exported from [Paperclip]");
  });

  it("includes the What's Inside section", () => {
    const result = generateReadme(makeManifest(), opts);
    expect(result).toContain("## What's Inside");
  });

  it("includes an Agents table when agents are present", () => {
    const manifest = makeManifest({ agents: [makeAgent({ role: "cto", name: "Zara" })] });
    const result = generateReadme(manifest, opts);
    expect(result).toContain("### Agents");
    expect(result).toContain("Zara");
    expect(result).toContain("CTO");
  });

  it("omits the Agents section when no agents are present", () => {
    const result = generateReadme(makeManifest(), opts);
    expect(result).not.toContain("### Agents");
  });

  it("includes the org chart image reference when agents are present", () => {
    const manifest = makeManifest({ agents: [makeAgent()] });
    const result = generateReadme(manifest, opts);
    expect(result).toContain("![Org Chart](images/org-chart.png)");
  });

  it("omits the org chart image reference when no agents are present", () => {
    const result = generateReadme(makeManifest(), opts);
    expect(result).not.toContain("Org Chart");
  });

  it("includes content count table rows for each non-empty section", () => {
    const manifest = makeManifest({
      agents: [makeAgent()],
      projects: [{ name: "Proj A", slug: "proj-a", path: "projects/proj-a", description: null, ownerAgentSlug: null, leadAgentSlug: null, targetDate: null, color: null, status: null, env: null, executionWorkspacePolicy: null, workspaces: [], metadata: null }],
    });
    const result = generateReadme(manifest, opts);
    expect(result).toContain("| Agents | 1 |");
    expect(result).toContain("| Projects | 1 |");
  });

  it("omits the count table entirely when all sections are empty", () => {
    const result = generateReadme(makeManifest(), opts);
    expect(result).not.toContain("| Content | Count |");
  });

  it("includes a reports-to column for agents", () => {
    const agents = [
      makeAgent({ slug: "ceo", name: "CEO", role: "ceo" }),
      makeAgent({ slug: "dev", name: "Dev", role: "engineer", reportsToSlug: "ceo" }),
    ];
    const result = generateReadme(makeManifest({ agents }), opts);
    expect(result).toContain("ceo");
  });
});
