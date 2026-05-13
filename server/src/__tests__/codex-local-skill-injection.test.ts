import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@odysseus/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createOdysseusRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"odysseus"}\n', "utf8");
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
  const odysseusKey = "PossibLaw/odysseus/odysseus";
  const createAgentKey = "PossibLaw/odysseus/odysseus-create-agent";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("repairs a Codex Odysseus skill symlink that still points at another live checkout", async () => {
    const currentRepo = await makeTempDir("odysseus-codex-current-");
    const oldRepo = await makeTempDir("odysseus-codex-old-");
    const skillsHome = await makeTempDir("odysseus-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createOdysseusRepoSkill(currentRepo, "odysseus");
    await createOdysseusRepoSkill(currentRepo, "odysseus-create-agent");
    await createOdysseusRepoSkill(oldRepo, "odysseus");
    await fs.symlink(path.join(oldRepo, "skills", "odysseus"), path.join(skillsHome, "odysseus"));

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [
          {
            key: odysseusKey,
            runtimeName: "odysseus",
            source: path.join(currentRepo, "skills", "odysseus"),
          },
          {
            key: createAgentKey,
            runtimeName: "odysseus-create-agent",
            source: path.join(currentRepo, "skills", "odysseus-create-agent"),
          },
        ],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "odysseus"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "odysseus")),
    );
    expect(await fs.realpath(path.join(skillsHome, "odysseus-create-agent"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "odysseus-create-agent")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "odysseus"'),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Injected Codex skill "odysseus-create-agent"'),
      }),
    );
  });

  it("preserves a custom Codex skill symlink outside Odysseus repo checkouts", async () => {
    const currentRepo = await makeTempDir("odysseus-codex-current-");
    const customRoot = await makeTempDir("odysseus-codex-custom-");
    const skillsHome = await makeTempDir("odysseus-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createOdysseusRepoSkill(currentRepo, "odysseus");
    await createCustomSkill(customRoot, "odysseus");
    await fs.symlink(path.join(customRoot, "custom", "odysseus"), path.join(skillsHome, "odysseus"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: odysseusKey,
        runtimeName: "odysseus",
        source: path.join(currentRepo, "skills", "odysseus"),
      }],
    });

    expect(await fs.realpath(path.join(skillsHome, "odysseus"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "odysseus")),
    );
  });

  it("prunes broken symlinks for unavailable Odysseus repo skills before Codex starts", async () => {
    const currentRepo = await makeTempDir("odysseus-codex-current-");
    const oldRepo = await makeTempDir("odysseus-codex-old-");
    const skillsHome = await makeTempDir("odysseus-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createOdysseusRepoSkill(currentRepo, "odysseus");
    await createOdysseusRepoSkill(oldRepo, "agent-browser");
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
          key: odysseusKey,
          runtimeName: "odysseus",
          source: path.join(currentRepo, "skills", "odysseus"),
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

  it("preserves other live Odysseus skill symlinks in the shared workspace skill directory", async () => {
    const currentRepo = await makeTempDir("odysseus-codex-current-");
    const skillsHome = await makeTempDir("odysseus-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createOdysseusRepoSkill(currentRepo, "odysseus");
    await createOdysseusRepoSkill(currentRepo, "agent-browser");
    await fs.symlink(
      path.join(currentRepo, "skills", "agent-browser"),
      path.join(skillsHome, "agent-browser"),
    );

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: odysseusKey,
        runtimeName: "odysseus",
        source: path.join(currentRepo, "skills", "odysseus"),
      }],
    });

    expect((await fs.lstat(path.join(skillsHome, "odysseus"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "agent-browser"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(skillsHome, "agent-browser"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "agent-browser")),
    );
  });
});
