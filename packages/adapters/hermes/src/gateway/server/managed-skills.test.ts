import { afterEach, beforeEach, describe, expect, test } from "vitest";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveDesiredGatewaySkillSections } from "./managed-skills.js";

async function writeSkill(root: string, name: string, body = `# ${name}\n\nInstructions.`): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n\n${body}\n`, "utf8");
  return skillDir;
}

describe("resolveDesiredGatewaySkillSections", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-gateway-skills-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test("returns nothing when no skills are desired", async () => {
    const source = await writeSkill(tempRoot, "unselected");
    const sections = await resolveDesiredGatewaySkillSections(
      {
        paperclipRuntimeSkills: [{ key: "unselected", runtimeName: "unselected", source }],
        // No paperclipSkillSync at all — nothing is explicitly desired.
      },
      tempRoot,
    );
    expect(sections).toEqual([]);
  });

  test("inlines the SKILL.md content of each desired skill", async () => {
    const persona = await writeSkill(tempRoot, "vp-rd-persona", "Persona instructions.");
    const unselected = await writeSkill(tempRoot, "unselected", "Should not appear.");

    const sections = await resolveDesiredGatewaySkillSections(
      {
        paperclipRuntimeSkills: [
          { key: "vp-rd-persona", runtimeName: "vp-rd-persona", source: persona },
          { key: "unselected", runtimeName: "unselected", source: unselected },
        ],
        paperclipSkillSync: { desiredSkills: ["vp-rd-persona"] },
      },
      tempRoot,
    );

    expect(sections).toHaveLength(1);
    expect(sections[0]?.key).toBe("vp-rd-persona");
    expect(sections[0]?.content).toContain("Persona instructions.");
  });

  test("truncates a single skill's content past the per-skill cap", async () => {
    const oversized = "x".repeat(25_000);
    const source = await writeSkill(tempRoot, "huge-skill", oversized);

    const sections = await resolveDesiredGatewaySkillSections(
      {
        paperclipRuntimeSkills: [{ key: "huge-skill", runtimeName: "huge-skill", source }],
        paperclipSkillSync: { desiredSkills: ["huge-skill"] },
      },
      tempRoot,
    );

    expect(sections).toHaveLength(1);
    expect(sections[0]?.content).toContain("[truncated");
    expect(sections[0]?.content.length).toBeLessThan(oversized.length);
  });

  test("fails closed rather than silently dropping a skill that would exceed the total size budget", async () => {
    // Each skill is truncated to just under the 20k per-skill cap, so three
    // of them land just over the 60k combined budget.
    const skillA = await writeSkill(tempRoot, "skill-a", "a".repeat(19_999));
    const skillB = await writeSkill(tempRoot, "skill-b", "b".repeat(19_999));
    const skillC = await writeSkill(tempRoot, "skill-c", "c".repeat(19_999));

    await expect(
      resolveDesiredGatewaySkillSections(
        {
          paperclipRuntimeSkills: [
            { key: "skill-a", runtimeName: "skill-a", source: skillA },
            { key: "skill-b", runtimeName: "skill-b", source: skillB },
            { key: "skill-c", runtimeName: "skill-c", source: skillC },
          ],
          paperclipSkillSync: { desiredSkills: ["skill-a", "skill-b", "skill-c"] },
        },
        tempRoot,
      ),
    ).rejects.toThrow("exceed the combined skill size budget");
  });

  test("fails closed when a desired skill is not in the available set at all", async () => {
    await expect(
      resolveDesiredGatewaySkillSections(
        {
          paperclipRuntimeSkills: [],
          paperclipSkillSync: { desiredSkills: ["ghost-skill"] },
        },
        tempRoot,
      ),
    ).rejects.toThrow('"ghost-skill" is unavailable');
  });

  test("fails closed when a desired skill's source is reported missing", async () => {
    await expect(
      resolveDesiredGatewaySkillSections(
        {
          paperclipRuntimeSkills: [
            {
              key: "gone-skill",
              runtimeName: "gone-skill",
              source: path.join(tempRoot, "does-not-exist"),
              sourceStatus: "missing",
              missingDetail: "Managed source was not materialized",
            },
          ],
          paperclipSkillSync: { desiredSkills: ["gone-skill"] },
        },
        tempRoot,
      ),
    ).rejects.toThrow("Managed source was not materialized");
  });

  test("fails closed when a desired skill's SKILL.md cannot be read", async () => {
    const emptyDir = path.join(tempRoot, "no-skill-md");
    await fs.mkdir(emptyDir, { recursive: true });

    await expect(
      resolveDesiredGatewaySkillSections(
        {
          paperclipRuntimeSkills: [{ key: "no-skill-md", runtimeName: "no-skill-md", source: emptyDir }],
          paperclipSkillSync: { desiredSkills: ["no-skill-md"] },
        },
        tempRoot,
      ),
    ).rejects.toThrow("missing SKILL.md");
  });
});
