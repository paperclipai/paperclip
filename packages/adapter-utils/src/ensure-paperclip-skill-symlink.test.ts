import { describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensurePaperclipSkillSymlink } from "./server-utils.js";

async function makeSkill(source: string): Promise<void> {
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "# Skill\n", "utf8");
}

describe("ensurePaperclipSkillSymlink", () => {
  test("creates a link when the target does not exist", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-link-create-"));
    try {
      const source = path.join(home, "skills", "complain");
      const target = path.join(home, ".hermes", "skills", "complain");
      await makeSkill(source);
      await fs.mkdir(path.dirname(target), { recursive: true });

      await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("created");
      expect(await fs.readlink(target)).toBe(source);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("skips when the link already points at the requested source", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-link-same-"));
    try {
      const source = path.join(home, "skills", "complain");
      const target = path.join(home, ".hermes", "skills", "complain");
      await makeSkill(source);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(source, target);

      await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("repairs a link whose target no longer exists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-link-dead-"));
    try {
      const source = path.join(home, "skills", "complain");
      const stale = path.join(home, "old-payload", "skills", "complain");
      const target = path.join(home, ".hermes", "skills", "complain");
      await makeSkill(source);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(stale, target);

      await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("repaired");
      expect(await fs.readlink(target)).toBe(source);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("skips a live link owned by a foreign installation", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-link-foreign-"));
    try {
      const source = path.join(home, "skills", "complain");
      const foreign = path.join(home, "external-skills", "complain");
      const target = path.join(home, ".hermes", "skills", "complain");
      await makeSkill(source);
      await makeSkill(foreign);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(foreign, target);

      await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");
      expect(await fs.readlink(target)).toBe(foreign);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("repairs a stale Paperclip-owned link after a CLI upgrade", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-link-upgrade-"));
    try {
      // The CLI updater keeps the previous install payload on disk so that
      // `update --rollback` still works, so the old target is still live.
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

      await expect(
        ensurePaperclipSkillSymlink(newSource, target, undefined, {
          paperclipHome: path.join(home, ".paperclip"),
        }),
      ).resolves.toBe("repaired");
      expect(await fs.readlink(target)).toBe(newSource);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("repairs a stale managed-package link that moved to a new install", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-link-pkg-"));
    try {
      const oldSource = path.join(
        home,
        "old-install",
        "node_modules",
        "@paperclipai",
        "server",
        "skills",
        "complain",
      );
      const newSource = path.join(
        home,
        "new-install",
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

      await expect(
        ensurePaperclipSkillSymlink(newSource, target, undefined, {
          paperclipHome: path.join(home, ".paperclip"),
        }),
      ).resolves.toBe("repaired");
      expect(await fs.readlink(target)).toBe(newSource);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
