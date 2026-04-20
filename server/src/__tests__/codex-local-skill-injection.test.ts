import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@aiteamcorp/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createAiTeamCorpRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"aiteamcorp"}\n', "utf8");
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
  const aiteamcorpKey = "aiteamcorporated-collab/ai-team-coprorated/aiteamcorp";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("repairs a Codex AiTeamCorp skill symlink that still points at another live checkout", async () => {
    const currentRepo = await makeTempDir("aiteamcorp-codex-current-");
    const oldRepo = await makeTempDir("aiteamcorp-codex-old-");
    const skillsHome = await makeTempDir("aiteamcorp-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createAiTeamCorpRepoSkill(currentRepo, "aiteamcorp");
    await createAiTeamCorpRepoSkill(oldRepo, "aiteamcorp");
    await fs.symlink(path.join(oldRepo, "skills", "aiteamcorp"), path.join(skillsHome, "aiteamcorp"));

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: aiteamcorpKey,
          runtimeName: "aiteamcorp",
          source: path.join(currentRepo, "skills", "aiteamcorp"),
        }],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "aiteamcorp"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "aiteamcorp")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "aiteamcorp"'),
      }),
    );
  });

  it("preserves a custom Codex skill symlink outside AiTeamCorp repo checkouts", async () => {
    const currentRepo = await makeTempDir("aiteamcorp-codex-current-");
    const customRoot = await makeTempDir("aiteamcorp-codex-custom-");
    const skillsHome = await makeTempDir("aiteamcorp-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createAiTeamCorpRepoSkill(currentRepo, "aiteamcorp");
    await createCustomSkill(customRoot, "aiteamcorp");
    await fs.symlink(path.join(customRoot, "custom", "aiteamcorp"), path.join(skillsHome, "aiteamcorp"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: aiteamcorpKey,
        runtimeName: "aiteamcorp",
        source: path.join(currentRepo, "skills", "aiteamcorp"),
      }],
    });

    expect(await fs.realpath(path.join(skillsHome, "aiteamcorp"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "aiteamcorp")),
    );
  });

  it("prunes broken symlinks for unavailable AiTeamCorp repo skills before Codex starts", async () => {
    const currentRepo = await makeTempDir("aiteamcorp-codex-current-");
    const oldRepo = await makeTempDir("aiteamcorp-codex-old-");
    const skillsHome = await makeTempDir("aiteamcorp-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createAiTeamCorpRepoSkill(currentRepo, "aiteamcorp");
    await createAiTeamCorpRepoSkill(oldRepo, "agent-browser");
    const staleTarget = path.join(oldRepo, "skills", "agent-browser");
    await fs.symlink(staleTarget, path.join(skillsHome, "agent-browser"));
    await fs.rm(staleTarget, { recursive: true, force: true });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: aiteamcorpKey,
          runtimeName: "aiteamcorp",
          source: path.join(currentRepo, "skills", "aiteamcorp"),
        }],
      },
    );

    await expect(fs.lstat(path.join(skillsHome, "agent-browser"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Removed stale Codex skill "agent-browser"'),
      }),
    );
  });

  it("preserves other live AiTeamCorp skill symlinks in the shared workspace skill directory", async () => {
    const currentRepo = await makeTempDir("aiteamcorp-codex-current-");
    const skillsHome = await makeTempDir("aiteamcorp-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createAiTeamCorpRepoSkill(currentRepo, "aiteamcorp");
    await createAiTeamCorpRepoSkill(currentRepo, "agent-browser");
    await fs.symlink(
      path.join(currentRepo, "skills", "agent-browser"),
      path.join(skillsHome, "agent-browser"),
    );

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: aiteamcorpKey,
        runtimeName: "aiteamcorp",
        source: path.join(currentRepo, "skills", "aiteamcorp"),
      }],
    });

    expect((await fs.lstat(path.join(skillsHome, "aiteamcorp"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "agent-browser"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(skillsHome, "agent-browser"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "agent-browser")),
    );
  });
});
