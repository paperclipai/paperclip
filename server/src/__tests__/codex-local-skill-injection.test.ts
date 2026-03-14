import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@paperclipai/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createPaperclipRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"paperclip"}\n', "utf8");
  await fs.writeFile(
    path.join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

async function createCustomSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "custom", skillName), { recursive: true });
  await fs.writeFile(
    path.join(root, "custom", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

describe("codex local adapter skill injection", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("repairs a Codex Paperclip skill symlink that still points at another live checkout", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const oldRepo = await makeTempDir("paperclip-codex-old-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createPaperclipRepoSkill(oldRepo, "paperclip");
    await fs.symlink(path.join(oldRepo, "skills", "paperclip"), path.join(skillsHome, "paperclip"));

    const logs: string[] = [];
    await ensureCodexSkillsInjected(
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      {
        skillsHome,
        skillsEntries: [{ name: "paperclip", source: path.join(currentRepo, "skills", "paperclip") }],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "paperclip"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "paperclip")),
    );
    expect(logs.some((line) => line.includes('Repaired Codex skill "paperclip"'))).toBe(true);
  });

  it("preserves a custom Codex skill symlink outside Paperclip repo checkouts", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const customRoot = await makeTempDir("paperclip-codex-custom-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createCustomSkill(customRoot, "paperclip");
    await fs.symlink(path.join(customRoot, "custom", "paperclip"), path.join(skillsHome, "paperclip"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{ name: "paperclip", source: path.join(currentRepo, "skills", "paperclip") }],
    });

    expect(await fs.realpath(path.join(skillsHome, "paperclip"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "paperclip")),
    );
  });
});
