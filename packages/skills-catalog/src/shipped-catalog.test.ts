import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogManifest, catalogSkills, resolveCatalogSkillRef } from "./index.js";

const EXPECTED_BUNDLED_KEYS = [
  "paperclipai/bundled/docs/doc-maintenance",
  "paperclipai/bundled/paperclip-operations/issue-triage",
  "paperclipai/bundled/paperclip-operations/reflection-coach",
  "paperclipai/bundled/paperclip-operations/status-card-query",
  "paperclipai/bundled/paperclip-operations/summarize-status",
  "paperclipai/bundled/paperclip-operations/task-planning",
  "paperclipai/bundled/product/paperclip-capsules",
  "paperclipai/bundled/product/wireframe",
  "paperclipai/bundled/quality/qa-acceptance",
  "paperclipai/bundled/software-development/github-pr-workflow",
];

const EXPECTED_OPTIONAL_KEYS = [
  "paperclipai/optional/agency-agents/21st-ai",
  "paperclipai/optional/agency-agents/21st-cli-use",
  "paperclipai/optional/agency-agents/21st-design-sync",
  "paperclipai/optional/agency-agents/21st-registry",
  "paperclipai/optional/agency-agents/21st-ui-build",
  "paperclipai/optional/agency-agents/21st-ui-explore",
  "paperclipai/optional/agency-agents/21st-ui-review",
  "paperclipai/optional/agency-agents/agents-sdk",
  "paperclipai/optional/agency-agents/algorithmic-art",
  "paperclipai/optional/agency-agents/api-and-interface-design",
  "paperclipai/optional/agency-agents/api-endpoint-creator",
  "paperclipai/optional/agency-agents/article-writing",
  "paperclipai/optional/agency-agents/auto-skill-router",
  "paperclipai/optional/agency-agents/automate",
  "paperclipai/optional/agency-agents/babysit",
  "paperclipai/optional/agency-agents/backend-api-design",
  "paperclipai/optional/agency-agents/banner-design",
  "paperclipai/optional/agency-agents/brainstorm",
  "paperclipai/optional/agency-agents/brand-guidelines",
  "paperclipai/optional/agency-agents/browser-qa",
  "paperclipai/optional/agency-agents/browser-testing-with-devtools",
  "paperclipai/optional/agency-agents/canvas",
  "paperclipai/optional/agency-agents/cavecrew",
  "paperclipai/optional/agency-agents/caveman",
  "paperclipai/optional/agency-agents/caveman-commit",
  "paperclipai/optional/agency-agents/caveman-compress",
  "paperclipai/optional/agency-agents/caveman-discover",
  "paperclipai/optional/agency-agents/caveman-evidence-review",
  "paperclipai/optional/agency-agents/caveman-explore",
  "paperclipai/optional/agency-agents/caveman-help",
  "paperclipai/optional/agency-agents/caveman-learn",
  "paperclipai/optional/agency-agents/caveman-manage",
  "paperclipai/optional/agency-agents/caveman-optimize",
  "paperclipai/optional/agency-agents/caveman-review",
  "paperclipai/optional/agency-agents/caveman-setup",
  "paperclipai/optional/agency-agents/caveman-stats",
  "paperclipai/optional/agency-agents/ci-cd-and-automation",
  "paperclipai/optional/agency-agents/cloudflare",
  "paperclipai/optional/agency-agents/cloudflare-email-service",
  "paperclipai/optional/agency-agents/cloudflare-one",
  "paperclipai/optional/agency-agents/cloudflare-one-migrations",
  "paperclipai/optional/agency-agents/code-review-and-quality",
  "paperclipai/optional/agency-agents/code-simplification",
  "paperclipai/optional/agency-agents/competitive-teardown",
  "paperclipai/optional/agency-agents/content-engine",
  "paperclipai/optional/agency-agents/context-engineering",
  "paperclipai/optional/agency-agents/create-hook",
  "paperclipai/optional/agency-agents/create-rule",
  "paperclipai/optional/agency-agents/create-skill",
  "paperclipai/optional/agency-agents/create-subagent",
  "paperclipai/optional/agency-agents/database-patterns",
  "paperclipai/optional/agency-agents/database-table-creator",
  "paperclipai/optional/agency-agents/debugging-and-error-recovery",
  "paperclipai/optional/agency-agents/deep-research",
  "paperclipai/optional/agency-agents/deprecation-and-migration",
  "paperclipai/optional/agency-agents/design",
  "paperclipai/optional/agency-agents/design-intelligence",
  "paperclipai/optional/agency-agents/design-system",
  "paperclipai/optional/agency-agents/design-taste-frontend",
  "paperclipai/optional/agency-agents/design-taste-frontend-v1",
  "paperclipai/optional/agency-agents/design-workflow",
  "paperclipai/optional/agency-agents/documentation-and-adrs",
  "paperclipai/optional/agency-agents/doubt-driven-development",
  "paperclipai/optional/agency-agents/durable-objects",
  "paperclipai/optional/agency-agents/find-skills",
  "paperclipai/optional/agency-agents/frontend-design",
  "paperclipai/optional/agency-agents/frontend-ui-engineering",
  "paperclipai/optional/agency-agents/git-workflow-and-versioning",
  "paperclipai/optional/agency-agents/grill-me",
  "paperclipai/optional/agency-agents/idea-refine",
  "paperclipai/optional/agency-agents/idea-validation",
  "paperclipai/optional/agency-agents/imagegen-frontend-mobile",
  "paperclipai/optional/agency-agents/imagegen-frontend-web",
  "paperclipai/optional/agency-agents/incremental-implementation",
  "paperclipai/optional/agency-agents/interview-me",
  "paperclipai/optional/agency-agents/investigate-first",
  "paperclipai/optional/agency-agents/investor-materials",
  "paperclipai/optional/agency-agents/investor-outreach",
  "paperclipai/optional/agency-agents/js-security-audit",
  "paperclipai/optional/agency-agents/kotlin-best-practices",
  "paperclipai/optional/agency-agents/lean-build",
  "paperclipai/optional/agency-agents/loop",
  "paperclipai/optional/agency-agents/market-research",
  "paperclipai/optional/agency-agents/migrate-to-skills",
  "paperclipai/optional/agency-agents/migration",
  "paperclipai/optional/agency-agents/nano-image-generator",
  "paperclipai/optional/agency-agents/nextjs-on-cloudflare",
  "paperclipai/optional/agency-agents/observability-and-instrumentation",
  "paperclipai/optional/agency-agents/ops-investigate-alert",
  "paperclipai/optional/agency-agents/ops-oncall-log",
  "paperclipai/optional/agency-agents/performance-optimization",
  "paperclipai/optional/agency-agents/planetscale-autonomous-execution-mode",
  "paperclipai/optional/agency-agents/planetscale-best-practices-matrix",
  "paperclipai/optional/agency-agents/planetscale-change-gates-and-approval-contract",
  "paperclipai/optional/agency-agents/planetscale-codebase-sqlcommenter-instrumentation",
  "paperclipai/optional/agency-agents/planetscale-customer-report-template",
  "paperclipai/optional/agency-agents/planetscale-mcp-agent-operating-model",
  "paperclipai/optional/agency-agents/planetscale-postgres-safety-review",
  "paperclipai/optional/agency-agents/planetscale-pscale-cli-automation",
  "paperclipai/optional/agency-agents/planetscale-query-insights-and-tags",
  "paperclipai/optional/agency-agents/planetscale-readonly-inventory",
  "paperclipai/optional/agency-agents/planetscale-safe-orchestrator",
  "paperclipai/optional/agency-agents/planetscale-schema-recommendations-agent-loop",
  "paperclipai/optional/agency-agents/planetscale-traffic-control-recommendations",
  "paperclipai/optional/agency-agents/planetscale-vitess-safety-review",
  "paperclipai/optional/agency-agents/planetscale-webhook-automation-recommendations",
  "paperclipai/optional/agency-agents/planning-and-task-breakdown",
  "paperclipai/optional/agency-agents/repo-to-skill",
  "paperclipai/optional/agency-agents/review",
  "paperclipai/optional/agency-agents/review-bugbot",
  "paperclipai/optional/agency-agents/review-security",
  "paperclipai/optional/agency-agents/safe-refactor",
  "paperclipai/optional/agency-agents/sandbox-migrate-to-next",
  "paperclipai/optional/agency-agents/sandbox-next",
  "paperclipai/optional/agency-agents/sandbox-stable",
  "paperclipai/optional/agency-agents/sdk",
  "paperclipai/optional/agency-agents/security-and-hardening",
  "paperclipai/optional/agency-agents/security-checklist",
  "paperclipai/optional/agency-agents/shell",
  "paperclipai/optional/agency-agents/shipping-and-launch",
  "paperclipai/optional/agency-agents/skill-router",
  "paperclipai/optional/agency-agents/slack-gif-creator",
  "paperclipai/optional/agency-agents/source-command-spartan",
  "paperclipai/optional/agency-agents/source-command-spartan-careful",
  "paperclipai/optional/agency-agents/source-command-spartan-commit-message",
  "paperclipai/optional/agency-agents/source-command-spartan-commit-message-with-codex",
  "paperclipai/optional/agency-agents/source-command-spartan-context-save",
  "paperclipai/optional/agency-agents/source-command-spartan-daily",
  "paperclipai/optional/agency-agents/source-command-spartan-lint-rules",
  "paperclipai/optional/agency-agents/source-command-spartan-magic-doc",
  "paperclipai/optional/agency-agents/source-command-spartan-memory-consolidate",
  "paperclipai/optional/agency-agents/source-command-spartan-onboard",
  "paperclipai/optional/agency-agents/source-command-spartan-update",
  "paperclipai/optional/agency-agents/source-driven-development",
  "paperclipai/optional/agency-agents/spec-driven-development",
  "paperclipai/optional/agency-agents/split-to-prs",
  "paperclipai/optional/agency-agents/startup-pipeline",
  "paperclipai/optional/agency-agents/statusline",
  "paperclipai/optional/agency-agents/surgical-patch",
  "paperclipai/optional/agency-agents/terraform-best-practices",
  "paperclipai/optional/agency-agents/terraform-module-creator",
  "paperclipai/optional/agency-agents/terraform-review",
  "paperclipai/optional/agency-agents/terraform-security-audit",
  "paperclipai/optional/agency-agents/terraform-service-scaffold",
  "paperclipai/optional/agency-agents/test-driven-development",
  "paperclipai/optional/agency-agents/testing-strategies",
  "paperclipai/optional/agency-agents/theme-factory",
  "paperclipai/optional/agency-agents/turnstile-spin",
  "paperclipai/optional/agency-agents/ui-styling",
  "paperclipai/optional/agency-agents/ui-ux-pro-max",
  "paperclipai/optional/agency-agents/update-cli-config",
  "paperclipai/optional/agency-agents/update-cursor-settings",
  "paperclipai/optional/agency-agents/using-agent-skills",
  "paperclipai/optional/agency-agents/vercel-react-best-practices",
  "paperclipai/optional/agency-agents/verify-and-stop",
  "paperclipai/optional/agency-agents/web-perf",
  "paperclipai/optional/agency-agents/web-to-prd",
  "paperclipai/optional/agency-agents/workers-best-practices",
  "paperclipai/optional/agency-agents/wrangler",
  "paperclipai/optional/browser/agent-browser",
  "paperclipai/optional/content/release-announcement",
  "paperclipai/optional/content/simplified-english",
  "paperclipai/optional/finance/ramp",
  "paperclipai/optional/product/design-critique",
  "paperclipai/optional/research/last30days",
  "paperclipai/optional/software-development/prepare-mcp-integration",
];

const MAX_FRONTMATTER_DESCRIPTION_LENGTH = 300;
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SKILL_FRONTMATTER_ROOTS = [
  path.join(REPO_ROOT, ".agents"),
  path.join(REPO_ROOT, "skills"),
  path.join(REPO_ROOT, "packages/adapters"),
  path.join(REPO_ROOT, "packages/plugins"),
  path.join(REPO_ROOT, "packages/skills-catalog/catalog"),
  path.join(REPO_ROOT, "packages/teams-catalog/catalog"),
];

function listSkillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    // Standalone provider installs can contain third-party skills. They are not
    // shipped Paperclip skills and must not participate in this repo audit.
    if (entry.name === "node_modules") return [];
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSkillFiles(entryPath);
    if (entry.isFile() && entry.name === "SKILL.md") return [entryPath];
    return [];
  });
}

function readFrontmatterDescription(markdown: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const lines = match[1]!.split(/\r?\n/);
  const descriptionIndex = lines.findIndex((line) => line.startsWith("description:"));
  if (descriptionIndex === -1) return null;

  const inlineValue = lines[descriptionIndex]!.slice("description:".length).trim();
  if (/^[>|][+-]?$/.test(inlineValue)) {
    const descriptionLines: string[] = [];
    for (let index = descriptionIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (/^[A-Za-z0-9_-]+:/.test(line)) break;
      descriptionLines.push(line.trim());
    }
    return descriptionLines.join(" ").replace(/\s+/g, " ").trim();
  }

  return inlineValue.replace(/^['"]|['"]$/g, "");
}

describe("shipped skills catalog", () => {
  it("ships the summarize-status streaming protocol", () => {
    const skill = readFileSync(
      path.join(
        REPO_ROOT,
        "packages/skills-catalog/catalog/bundled/paperclip-operations/summarize-status/SKILL.md",
      ),
      "utf8",
    );

    expect(skill).toContain("Post the first status update immediately, before doing anything else.");
    expect(skill).toContain('STATUS: considering "Fix login redirect loop"…');
    expect(skill).toContain("<<<SUMMARY-DRAFT>>>");
    expect(skill).toContain("<<<END-SUMMARY-DRAFT>>>");
    expect(skill).toContain("tool-call arguments don't stream; assistant text does");
    expect(skill).toContain("falls back to its spinner");
    expect(skill).toContain("Open with what the reader needs to do.");
    expect(skill).toContain("1–3 specific, concrete, actionable items");
  });

  it("keeps repo and catalog skill descriptions within the prompt budget cap", () => {
    const violations: string[] = [];
    for (const skillFile of SKILL_FRONTMATTER_ROOTS.flatMap(listSkillFiles)) {
      const description = readFrontmatterDescription(readFileSync(skillFile, "utf8"));
      if (!description) {
        violations.push(`${path.relative(REPO_ROOT, skillFile)} is missing a frontmatter description`);
      } else if (description.length > MAX_FRONTMATTER_DESCRIPTION_LENGTH) {
        violations.push(`${path.relative(REPO_ROOT, skillFile)} description is ${description.length} chars`);
      }
    }
    for (const skill of catalogSkills) {
      if (skill.description.length > MAX_FRONTMATTER_DESCRIPTION_LENGTH) {
        violations.push(`${skill.key} generated description is ${skill.description.length} chars`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("ships the expected bundled and optional skill set", () => {
    const bundledKeys = catalogSkills
      .filter((skill) => skill.kind === "bundled")
      .map((skill) => skill.key)
      .sort();
    const optionalKeys = catalogSkills
      .filter((skill) => skill.kind === "optional")
      .map((skill) => skill.key)
      .sort();

    expect(bundledKeys).toEqual(EXPECTED_BUNDLED_KEYS);
    expect(optionalKeys).toEqual(EXPECTED_OPTIONAL_KEYS);
  });

  it("keeps script-bearing shipped skills explicit so install stays audit-gated", () => {
    // The real install-time security boundary audits materialized bytes and blocks
    // hard-stop findings. Static assets (svg/html templates, e.g. the wireframe skill)
    // carry the "assets" trust level and are installable.
    const scriptBearing = catalogSkills.filter((skill) => skill.trustLevel === "scripts_executables");
    expect(scriptBearing.map((skill) => skill.key)).toEqual([
      "paperclipai/optional/agency-agents/caveman-compress",
      "paperclipai/optional/agency-agents/design",
      "paperclipai/optional/agency-agents/design-system",
      "paperclipai/optional/agency-agents/idea-refine",
      "paperclipai/optional/agency-agents/nano-image-generator",
      "paperclipai/optional/agency-agents/repo-to-skill",
      "paperclipai/optional/agency-agents/turnstile-spin",
      "paperclipai/optional/agency-agents/ui-styling",
      "paperclipai/optional/agency-agents/ui-ux-pro-max",
      "paperclipai/optional/research/last30days",
    ]);
  });

  it("populates browse/search-relevant fields for every shipped skill", () => {
    const issues: string[] = [];
    for (const skill of catalogSkills) {
      if (skill.compatibility !== "compatible") {
        issues.push(`${skill.key} compatibility=${skill.compatibility}`);
      }
      if (!skill.description || skill.description.length < 40) {
        issues.push(`${skill.key} description must be at least 40 characters for catalog browse/search`);
      }
      if (skill.recommendedForRoles.length === 0) {
        issues.push(`${skill.key} must list recommendedForRoles`);
      }
      if (skill.tags.length === 0) {
        issues.push(`${skill.key} must list tags`);
      }
    }
    expect(issues).toEqual([]);
  });

  it("uses canonical paperclipai keys derived from kind/category/slug", () => {
    const violations: string[] = [];
    for (const skill of catalogSkills) {
      const expectedKey = `paperclipai/${skill.kind}/${skill.category}/${skill.slug}`;
      const expectedId = `paperclipai:${skill.kind}:${skill.category}:${skill.slug}`;
      if (skill.key !== expectedKey) violations.push(`${skill.key} should be ${expectedKey}`);
      if (skill.id !== expectedId) violations.push(`${skill.id} should be ${expectedId}`);
    }
    expect(violations).toEqual([]);
  });

  it("exposes a stable manifest header for downstream consumers", () => {
    expect(catalogManifest.schemaVersion).toBe(1);
    expect(catalogManifest.packageName).toBe("@paperclipai/skills-catalog");
    expect(catalogSkills.length).toBe(EXPECTED_BUNDLED_KEYS.length + EXPECTED_OPTIONAL_KEYS.length);
  });

  it("resolves shipped skills by id, key, and unique slug", () => {
    const sample = catalogSkills.find((skill) => skill.key === "paperclipai/bundled/software-development/github-pr-workflow");
    expect(sample, "expected github-pr-workflow to ship in the bundled catalog").toBeDefined();
    if (!sample) return;

    expect(resolveCatalogSkillRef(sample.id)).toMatchObject({ key: sample.key });
    expect(resolveCatalogSkillRef(sample.key)).toMatchObject({ key: sample.key });
    expect(resolveCatalogSkillRef(sample.slug)).toMatchObject({ key: sample.key });
  });

  it("keeps the Ramp wrapper fail-closed on mixed-provenance playbooks", () => {
    const rampSkill = readFileSync(new URL("../catalog/optional/finance/ramp/SKILL.md", import.meta.url), "utf8");

    expect(rampSkill).toContain("mixes Official and Community playbooks");
    expect(rampSkill).toContain("do not execute them inside Paperclip unless a Paperclip approval explicitly names the playbook");
    expect(rampSkill).toContain("third-party browser automation, MCP server, CLI, or connector");
  });

  it("keeps the Ramp wrapper clear of remote-fetch execution hard-stop patterns", () => {
    const rampSkill = readFileSync(new URL("../catalog/optional/finance/ramp/SKILL.md", import.meta.url), "utf8");
    const remoteExecPattern = /\b(?:curl|wget)\b[\s\S]{0,160}\|\s*(?:sh|bash)|\b(?:bash|sh)\s+-c\b|\beval\b|\bpython\s+-c\b|\bnode\s+-e\b/i;

    expect(remoteExecPattern.test(rampSkill)).toBe(false);
  });
});
