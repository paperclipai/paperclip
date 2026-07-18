import { afterEach, beforeEach, describe, expect, test } from "vitest";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { prepareHermesManagedSkills } from "./managed-skills.js";

async function writeSkill(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(skillDir, "script.ts"), "export {};\n", "utf8");
  return skillDir;
}

describe("Hermes managed runtime skills", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-managed-skills-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test("materializes only desired skills in the active profile and cleans them up", async () => {
    const hermesHome = path.join(tempRoot, "Hermes Home");
    const paperclip = await writeSkill(path.join(tempRoot, "runtime skills"), "paperclip");
    const unselected = await writeSkill(path.join(tempRoot, "runtime skills"), "unselected");

    const prepared = await prepareHermesManagedSkills({
      config: {
        env: { HERMES_HOME: hermesHome },
        extraArgs: ["--profile", "isolated-profile"],
        paperclipRuntimeSkills: [
          { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: paperclip },
          { key: "paperclipai/paperclip/unselected", runtimeName: "unselected", source: unselected },
        ],
        paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/paperclip"] },
      },
      moduleDir: tempRoot,
      runId: "run with spaces",
    });

    expect(prepared.skillNames).toEqual([".paperclip-runtime/run-with-spaces/paperclip"]);
    await expect(
      fs.readFile(
        path.join(
          hermesHome,
          "profiles",
          "isolated-profile",
          "skills",
          ".paperclip-runtime",
          "run-with-spaces",
          "paperclip",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("name: paperclip");
    await expect(
      fs.stat(
        path.join(
          hermesHome,
          "profiles",
          "isolated-profile",
          "skills",
          ".paperclip-runtime",
          "run-with-spaces",
          "unselected",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await prepared.cleanup();
    await expect(fs.stat(prepared.runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed when a desired source path is missing", async () => {
    await expect(
      prepareHermesManagedSkills({
        config: {
          env: { HERMES_HOME: path.join(tempRoot, "hermes") },
          paperclipRuntimeSkills: [
            {
              key: "paperclipai/paperclip/paperclip",
              runtimeName: "paperclip",
              source: path.join(tempRoot, "does not exist"),
              sourceStatus: "missing",
              missingDetail: "Managed source was not materialized",
            },
          ],
          paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/paperclip"] },
        },
        moduleDir: tempRoot,
        runId: "missing-source",
      }),
    ).rejects.toThrow("Managed source was not materialized");
  });

  test("rejects profile traversal and preserves argv-safe paths with spaces", async () => {
    const source = await writeSkill(path.join(tempRoot, "runtime skills"), "paperclip");

    await expect(
      prepareHermesManagedSkills({
        config: {
          env: { HERMES_HOME: path.join(tempRoot, "Hermes Home") },
          extraArgs: ["--profile", "../../outside"],
          paperclipRuntimeSkills: [
            { key: "paperclip", runtimeName: "paperclip", source },
          ],
          paperclipSkillSync: { desiredSkills: ["paperclip"] },
        },
        moduleDir: tempRoot,
        runId: "unsafe-profile",
      }),
    ).rejects.toThrow("Invalid Hermes profile name");
  });
});
