import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Agents write task briefs and chat replies that people read. The Nov 2026
 * onboarding walk found raw task UUIDs in an agent-written brief ("on task
 * BRA-2 (id 2b330993-…)") and a Codex chief of staff narrating receipts,
 * execution policies and policy patches to a new user. These checks keep the
 * instructions that shape that text explicit about both.
 */
const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`Missing section: ${heading}`);
  const next = markdown.indexOf("\n## ", start + heading.length);
  return markdown.slice(start, next < 0 ? undefined : next);
}

describe("agent-written text names tasks by identifier, never by UUID", () => {
  it("the paperclip skill's comment style forbids raw UUIDs in comments and descriptions", async () => {
    const style = section(await read("../../../skills/paperclip/SKILL.md"), "## Comment Style (Required)");
    expect(style).toContain("**No raw IDs in prose (required):**");
    expect(style).toMatch(/never paste a raw UUID/i);
    expect(style).toContain("[BRA-2](/BRA/issues/BRA-2#document-plan)");
  });

  it("the first-task handoff references inputs by identifier link, not UUID", async () => {
    const skill = await read("../onboarding-assets/first-task/skills/first-task/SKILL.md");
    const handoff = skill.slice(skill.indexOf("Copy required input payloads verbatim"));
    expect(handoff).toMatch(/source reference as an identifier link[^.]*not a raw UUID/i);
  });

  it("plan-to-task conversion keeps UUIDs out of task descriptions", async () => {
    const skill = await read("../../../skills/paperclip-converting-plans-to-tasks/SKILL.md");
    expect(skill).toMatch(/identifier links[^.]*never raw UUIDs/i);
  });
});

describe("chat agents describe outcomes, not internal mechanics", () => {
  it("the first-task workflow forbids narrating control-plane mechanics to the user", async () => {
    const skill = await read("../onboarding-assets/first-task/skills/first-task/SKILL.md");
    expect(skill).toContain("**Talk in outcomes.**");
    for (const term of ["receipts", "execution policies", "patches", "runs"]) expect(skill).toContain(term);
    expect(skill).toMatch(/what happened, what it means for them, and the next step/);
  });

  it("the chief-of-staff persona carries the same plain-language rule into every chat", async () => {
    const persona = await read("../onboarding-assets/first-task/chief-of-staff/AGENTS.md");
    expect(persona).toMatch(/plain language/i);
    expect(persona).toMatch(/never narrate internal mechanics/i);
    expect(persona).toMatch(/raw IDs/);
  });

  it("the paperclip skill applies the rule to every user-facing comment", async () => {
    const style = section(await read("../../../skills/paperclip/SKILL.md"), "## Comment Style (Required)");
    expect(style).toContain("**Describe outcomes, not mechanics (required):**");
  });
});
