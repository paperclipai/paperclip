import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Conventions for the skills that ship at the repository root. Catalog entries
// under packages/skills-catalog/catalog have their own rules; this file guards
// only the root skills/ directory.
const MAX_FRONTMATTER_DESCRIPTION_LENGTH = 300;
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SKILLS_ROOT = path.join(REPO_ROOT, "skills");

function listSkillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSkillFiles(entryPath);
    if (entry.isFile() && entry.name === "SKILL.md") return [entryPath];
    return [];
  });
}

function readFrontmatterBlock(markdown: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1]! : null;
}

function frontmatterKeys(block: string): string[] {
  return block.split(/\r?\n/).flatMap((line) => {
    const key = line.match(/^([A-Za-z0-9_-]+):/);
    return key ? [key[1]!] : [];
  });
}

function readFrontmatterValue(block: string, key: string): string | null {
  const lines = block.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index === -1) return null;
  const inline = lines[index]!.slice(`${key}:`.length).trim();
  if (/^[>|][+-]?$/.test(inline)) {
    const folded: string[] = [];
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      if (/^[A-Za-z0-9_-]+:/.test(lines[scan]!)) break;
      folded.push(lines[scan]!.trim());
    }
    return folded.join(" ").replace(/\s+/g, " ").trim();
  }
  return inline.replace(/^['"]|['"]$/g, "");
}

function readDescription(block: string): string | null {
  return readFrontmatterValue(block, "description");
}

describe("repo skills catalog conventions", () => {
  it("keeps every skills/ SKILL.md frontmatter to name and description", () => {
    const violations: string[] = [];
    for (const skillFile of listSkillFiles(SKILLS_ROOT)) {
      const relative = path.relative(REPO_ROOT, skillFile);
      const block = readFrontmatterBlock(readFileSync(skillFile, "utf8"));
      if (!block) {
        violations.push(`${relative} is missing frontmatter`);
        continue;
      }
      const extra = frontmatterKeys(block).filter(
        (key) => key !== "name" && key !== "description",
      );
      if (extra.length > 0) {
        violations.push(`${relative} has extra frontmatter keys: ${extra.join(", ")}`);
      }
      const name = readFrontmatterValue(block, "name");
      const directory = path.basename(path.dirname(skillFile));
      if (name !== directory) {
        violations.push(`${relative} name "${name}" does not match directory "${directory}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("gives every skills/ SKILL.md a description within the prompt budget cap", () => {
    const violations: string[] = [];
    for (const skillFile of listSkillFiles(SKILLS_ROOT)) {
      const block = readFrontmatterBlock(readFileSync(skillFile, "utf8"));
      const description = block ? readDescription(block) : null;
      if (!description) {
        violations.push(`${path.relative(REPO_ROOT, skillFile)} is missing a frontmatter description`);
      } else if (description.length > MAX_FRONTMATTER_DESCRIPTION_LENGTH) {
        violations.push(
          `${path.relative(REPO_ROOT, skillFile)} description is ${description.length} chars`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});
