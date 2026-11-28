import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrontmatterMarkdown } from "./frontmatter.js";
import { resolveCatalogTeamRef } from "./index.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const team = resolveCatalogTeamRef("software-sdlc")!;
const phases = [
  "requirements", "architecture", "implementation", "testing",
  "security-review", "release", "retrospective",
];

function read(relativePath: string) {
  return fs.readFileSync(path.join(packageDir, team.path, relativePath), "utf8");
}

describe("software-sdlc team pack", () => {
  it("is opt-in content without starter work, executables, or external sources", () => {
    expect(team).toMatchObject({
      kind: "optional",
      defaultInstall: false,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      counts: { agents: 4, projects: 1, tasks: 0, routines: 0, localSkills: 1, externalSkillSources: 0 },
      envInputs: [],
      sourceRefs: [],
    });
    expect(team.files.every((file) => file.path.endsWith(".md"))).toBe(true);
    expect(team.rootAgentSlugs).toEqual(["delivery-lead"]);
  });

  it("resolves the local delivery method for every role", () => {
    const method = team.requiredSkills.find((skill) => skill.type === "local");
    expect(method).toMatchObject({
      ref: "software-sdlc",
      resolved: true,
      localPath: "skills/software-sdlc/SKILL.md",
      agentSlugs: [...team.agentSlugs].sort(),
    });
    for (const slug of team.agentSlugs) {
      const { frontmatter } = parseFrontmatterMarkdown(read(`agents/${slug}/AGENTS.md`));
      expect(frontmatter.skills).toContain("software-sdlc");
      expect(frontmatter).not.toHaveProperty("permissions");
      expect(frontmatter).not.toHaveProperty("adapterConfig");
    }
  });

  it.each(phases)("ships a linked %s artifact with provenance and an exit contract", (phase) => {
    const ref = `references/${phase}.md`;
    expect(read("skills/software-sdlc/SKILL.md")).toContain(`](${ref})`);
    const content = read(`skills/software-sdlc/${ref}`);
    for (const heading of ["## Inputs", "## Provenance", "## Checks performed and findings", "## Exit criteria", "## Handoff"]) {
      expect(content).toContain(heading);
    }
    for (const field of [
      "Parent delivery issue:", "Producer:", "Source revision:",
      "Upstream artifact revisions:", "Checks performed:", "Findings:",
      "Evidence links:", "Next owner:",
    ]) {
      expect(content).toContain(field);
    }
  });

  it("keeps every relative Markdown link within the pack and in the manifest", () => {
    const inventory = new Set(team.files.map((file) => file.path));
    for (const file of team.files) {
      const content = read(file.path);
      for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1]!;
        if (/^https:\/\//.test(target)) continue;
        const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), target));
        expect(normalized.startsWith("../")).toBe(false);
        expect(inventory.has(normalized), `${file.path} -> ${target}`).toBe(true);
      }
    }
  });
});
