import { expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { reconcileHermesPaperclipSkills } from "./skills.js";

async function makeSkill(source: string): Promise<void> {
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "# Skill\n", "utf8");
}

/**
 * A Paperclip CLI upgrade moves the bundled skills tree to a new install
 * payload but keeps the previous payload on disk so `update --rollback` still
 * works. A skill symlink created by an earlier run therefore keeps resolving
 * to the OLD payload. Before the fix, the reconciler treated that as "occupied
 * by another installation" and threw, which aborted every agent run.
 */
test("Hermes relinks a skill symlink left pointing at a previous CLI payload", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-upgrade-"));
  try {
    const oldSource = path.join(
      home,
      ".paperclip",
      "cli",
      "installs",
      "npm",
      "2026.1000.0",
      "node_modules",
      "@paperclipai",
      "server",
      "skills",
      "complain",
    );
    const newSource = path.join(
      home,
      ".paperclip",
      "cli",
      "installs",
      "npm",
      "2026.1023.0",
      "node_modules",
      "@paperclipai",
      "server",
      "skills",
      "complain",
    );
    const target = path.join(home, ".hermes", "skills", "complain");
    await makeSkill(oldSource);
    await makeSkill(newSource);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(oldSource, target);

    const desired = await reconcileHermesPaperclipSkills(
      {
        env: { HOME: home },
        paperclipRuntimeSkills: [
          {
            key: "paperclipai/paperclip/complain",
            runtimeName: "complain",
            source: newSource,
          },
        ],
      },
      ["paperclipai/paperclip/complain"],
    );

    expect(desired).toContain("paperclipai/paperclip/complain");
    expect(await fs.readlink(target)).toBe(newSource);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Hermes still rejects a skill symlink owned by a foreign installation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-foreign-"));
  try {
    const source = path.join(home, "runtime-skills", "complain");
    const foreign = path.join(home, "external-skills", "complain");
    const target = path.join(home, ".hermes", "skills", "complain");
    await makeSkill(source);
    await makeSkill(foreign);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(foreign, target);

    await expect(
      reconcileHermesPaperclipSkills(
        {
          env: { HOME: home },
          paperclipRuntimeSkills: [
            {
              key: "paperclipai/paperclip/complain",
              runtimeName: "complain",
              source,
            },
          ],
        },
        ["paperclipai/paperclip/complain"],
      ),
    ).rejects.toThrow("occupied by another installation");

    expect(await fs.readlink(target)).toBe(foreign);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
