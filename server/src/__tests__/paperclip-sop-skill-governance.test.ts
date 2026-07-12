import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readPaperclipSkillFile(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, "skills/paperclip", relativePath), "utf8");
}

describe("Paperclip SOP skill governance", () => {
  it("keeps explicit board SOP corrections on the canonical skill mutation path", () => {
    const rootSkill = readPaperclipSkillFile("SKILL.md");
    const governance = readPaperclipSkillFile("references/governance.md");
    const companySkills = readPaperclipSkillFile("references/company-skills.md");

    expect(rootSkill).toContain("Explicit SOP corrections are execution directives");
    expect(rootSkill).toContain("report `SOP updated` only after file read-back");
    expect(governance).toContain("Board-directed SOP and skill changes");
    expect(governance).toContain("Agent-generated suggestion");
    expect(governance).toContain("Plans, TRDs, wiki decisions, issue comments");
    expect(companySkills).toContain("PATCH /api/companies/:companyId/skills/:skillId/files");
    expect(companySkills).toContain("Do not edit an agent's `$CODEX_HOME/skills` entry");
    expect(companySkills).toContain("paperclipSkillTelemetry");
  });
});
