#!/usr/bin/env npx tsx
/**
 * Generate org chart images and READMEs for agent company packages.
 *
 * Reads company packages from a directory, builds manifest-like data,
 * then uses the existing server-side SVG renderer (sharp, no browser)
 * and README generator.
 *
 * Usage:
 *   npx tsx scripts/generate-company-assets.ts /path/to/companies-repo
 *
 * Processes each subdirectory that contains a COMPANY.md file.
 */
import * as fs from "fs";
import * as path from "path";
import { renderOrgChartPng, type OrgNode, type OrgChartOverlay } from "../server/src/routes/org-chart-svg.js";
import { generateReadme } from "../server/src/services/company-export-readme.js";
import type { CompanyPortabilityManifest } from "@paperclipai/shared";

// ── YAML frontmatter parser (minimal, no deps) ──────────────────

function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: content };
  const yamlStr = match[1];
  const body = match[2];
  const data: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let currentValue: string | string[] | null = null;
  let inList = false;

  for (const line of yamlStr.split("\n")) {
    // List item
    if (inList && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, "").trim();
      (currentValue as string[]).push(val);
      continue;
    }

    // Save previous key
    if (currentKey !== null && currentValue !== null) {
      data[currentKey] = currentValue;
    }
    inList = false;

    // Key: value line
    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      let val = kvMatch[2].trim();

      if (val === "" || val === ">") {
        // Could be a multi-line value or list — peek ahead handled by next iterations
        currentValue = "";
        continue;
      }

      if (val === "null" || val === "~") {
        currentValue = null;
        data[currentKey] = null;
        currentKey = null;
        currentValue = null;
        continue;
      }

      // Remove surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }

      currentValue = val;
    } else if (currentKey !== null && line.match(/^\s+-\s+/)) {
      // Start of list
      inList = true;
      currentValue = [];
      const val = line.replace(/^\s+-\s+/, "").trim();
      (currentValue as string[]).push(val);
    } else if (currentKey !== null && line.match(/^\s+\S/)) {
      // Continuation of multi-line scalar
      const trimmed = line.trim();
      if (typeof currentValue === "string") {
        currentValue = currentValue ? `${currentValue} ${trimmed}` : trimmed;
      }
    }
  }

  // Save last key
  if (currentKey !== null && currentValue !== null) {
    data[currentKey] = currentValue;
  }

  return { data, body };
}

// ── Slug to role mapping ─────────────────────────────────────────

const SLUG_TO_ROLE: Record<string, string> = {
  ceo: "ceo",
  cto: "cto",
  cmo: "cmo",
  cfo: "cfo",
  coo: "coo",
};

function inferRole(slug: string, title: string | null): string {
  // Check direct slug match first
  if (SLUG_TO_ROLE[slug]) return SLUG_TO_ROLE[slug];

  // Check title for C-suite
  const t = (title || "").toLowerCase();
  if (t.includes("chief executive")) return "ceo";
  if (t.includes("chief technology")) return "cto";
  if (t.includes("chief marketing")) return "cmo";
  if (t.includes("chief financial")) return "cfo";
  if (t.includes("chief operating")) return "coo";
  if (t.includes("vp") || t.includes("vice president")) return "vp";
  if (t.includes("manager")) return "manager";
  if (t.includes("qa") || t.includes("quality")) return "engineer";

  // Default to engineer
  return "engineer";
}

// ── Parse a company package directory ────────────────────────────

interface CompanyPackage {
  dir: string;
  name: string;
  description: string | null;
  slug: string;
  agents: CompanyPortabilityManifest["agents"];
  skills: CompanyPortabilityManifest["skills"];
}

function parseCompanyPackage(companyDir: string): CompanyPackage | null {
  const companyMdPath = path.join(companyDir, "COMPANY.md");
  if (!fs.existsSync(companyMdPath)) return null;

  const companyMd = fs.readFileSync(companyMdPath, "utf-8");
  const { data: companyData } = parseFrontmatter(companyMd);

  const name = (companyData.name as string) || path.basename(companyDir);
  const description = (companyData.description as string) || null;
  const slug = (companyData.slug as string) || path.basename(companyDir);

  // Parse agents
  const agentsDir = path.join(companyDir, "agents");
  const agents: CompanyPortabilityManifest["agents"] = [];
  if (fs.existsSync(agentsDir)) {
    for (const agentSlug of fs.readdirSync(agentsDir)) {
      const agentMdName = fs.existsSync(path.join(agentsDir, agentSlug, "AGENT.md"))
        ? "AGENT.md"
        : fs.existsSync(path.join(agentsDir, agentSlug, "AGENTS.md"))
          ? "AGENTS.md"
          : null;
      if (!agentMdName) continue;
      const agentMdPath = path.join(agentsDir, agentSlug, agentMdName);

      const agentMd = fs.readFileSync(agentMdPath, "utf-8");
      const { data: agentData } = parseFrontmatter(agentMd);

      const agentName = (agentData.name as string) || agentSlug;
      const title = (agentData.title as string) || null;
      const reportsTo = agentData.reportsTo as string | null;
      const skills = (agentData.skills as string[]) || [];
      const role = inferRole(agentSlug, title);

      agents.push({
        slug: agentSlug,
        name: agentName,
        path: `agents/${agentSlug}/${agentMdName}`,
        skills,
        role,
        title,
        icon: null,
        capabilities: null,
        reportsToSlug: reportsTo || null,
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        metadata: null,
      });
    }
  }

  // Parse skills
  const skillsDir = path.join(companyDir, "skills");
  const skills: CompanyPortabilityManifest["skills"] = [];
  if (fs.existsSync(skillsDir)) {
    for (const skillSlug of fs.readdirSync(skillsDir)) {
      const skillMdPath = path.join(skillsDir, skillSlug, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const skillMd = fs.readFileSync(skillMdPath, "utf-8");
      const { data: skillData } = parseFrontmatter(skillMd);

      const skillName = (skillData.name as string) || skillSlug;
      const skillDesc = (skillData.description as string) || null;

      // Extract source info from metadata
      let sourceType = "local";
      let sourceLocator: string | null = null;
      const metadata = skillData.metadata as Record<string, unknown> | undefined;
      if (metadata) {
        // metadata.sources is parsed as a nested structure, but our simple parser
        // doesn't handle it well. Check for github repo in the raw SKILL.md instead.
        const repoMatch = skillMd.match(/repo:\s*(.+)/);
        const pathMatch = skillMd.match(/path:\s*(.+)/);
        if (repoMatch) {
          sourceType = "github";
          const repo = repoMatch[1].trim();
          const filePath = pathMatch ? pathMatch[1].trim() : "";
          sourceLocator = `https://github.com/${repo}/blob/main/${filePath}`;
        }
      }

      skills.push({
        key: skillSlug,
        slug: skillSlug,
        name: skillName,
        path: `skills/${skillSlug}/SKILL.md`,
        description: skillDesc,
        sourceType,
        sourceLocator,
        sourceRef: null,
        trustLevel: null,
        compatibility: null,
        metadata: null,
        fileInventory: [{ path: `skills/${skillSlug}/SKILL.md`, kind: "skill" }],
      });
    }
  }

  return { dir: companyDir, name, description, slug, agents, skills };
}

// ── Build OrgNode tree from agents ───────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  ceo: "Chief Executive",
  cto: "Technology",
  cmo: "Marketing",
  cfo: "Finance",
  coo: "Operations",
  vp: "VP",
  manager: "Manager",
  engineer: "Engineer",
  agent: "Agent",
};

function buildOrgTree(agents: CompanyPortabilityManifest["agents"]): OrgNode[] {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const childrenOf = new Map<string | null, typeof agents>();
  for (const a of agents) {
    const parent = a.reportsToSlug ?? null;
    const list = childrenOf.get(parent) ?? [];
    list.push(a);
    childrenOf.set(parent, list);
  }
  const build = (parentSlug: string | null): OrgNode[] => {
    const members = childrenOf.get(parentSlug) ?? [];
    return members.map((m) => ({
      id: m.slug,
      name: m.name,
      role: ROLE_LABELS[m.role] ?? m.role,
      status: "active",
      reports: build(m.slug),
    }));
  };
  const roots = agents.filter((a) => !a.reportsToSlug || !bySlug.has(a.reportsToSlug));
  const tree = build(null);
  for (const root of roots) {
    if (root.reportsToSlug && !bySlug.has(root.reportsToSlug)) {
      tree.push({
        id: root.slug,
        name: root.name,
        role: ROLE_LABELS[root.role] ?? root.role,
        status: "active",
        reports: build(root.slug),
      });
    }
  }
  return tree;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const companiesDir = process.argv[2];
  if (!companiesDir) {
    console.error("Usage: npx tsx scripts/generate-company-assets.ts <companies-dir>");
    process.exit(1);
  }

  const resolvedDir = path.resolve(companiesDir);
  if (!fs.existsSync(resolvedDir)) {
    console.error(`Directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
  let processed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const companyDir = path.join(resolvedDir, entry.name);
    const pkg = parseCompanyPackage(companyDir);
    if (!pkg) continue;

    console.log(`\n── ${pkg.name} (${pkg.slug}) ──`);
    console.log(`   ${pkg.agents.length} agents, ${pkg.skills.length} skills`);

    // Generate org chart PNG
    if (pkg.agents.length > 0) {
      const orgTree = buildOrgTree(pkg.agents);
      console.log(`   Org tree roots: ${orgTree.map((n) => n.name).join(", ")}`);

      const overlay: OrgChartOverlay = {
        companyName: pkg.name,
        stats: `Agents: ${pkg.agents.length}, Skills: ${pkg.skills.length}`,
      };
      const pngBuffer = await renderOrgChartPng(orgTree, "warmth", overlay);
      const imagesDir = path.join(companyDir, "images");
      fs.mkdirSync(imagesDir, { recursive: true });
      const pngPath = path.join(imagesDir, "org-chart.png");
      fs.writeFileSync(pngPath, pngBuffer);
      console.log(`   ✓ ${path.relative(resolvedDir, pngPath)} (${(pngBuffer.length / 1024).toFixed(1)}kb)`);
    }

    // Generate README
    const manifest: CompanyPortabilityManifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: null,
      includes: { company: true, agents: true, projects: false, issues: false, skills: true },
      company: null,
      agents: pkg.agents,
      skills: pkg.skills,
      projects: [],
      issues: [],
      envInputs: [],
    };

    const readme = generateReadme(manifest, {
      companyName: pkg.name,
      companyDescription: pkg.description,
    });
    const readmePath = path.join(companyDir, "README.md");
    fs.writeFileSync(readmePath, readme);
    console.log(`   ✓ ${path.relative(resolvedDir, readmePath)}`);

    processed++;
  }

  console.log(`\n✓ Processed ${processed} companies.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
