import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@valadrien-os/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createValadrienOsRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"valadrien-os"}\n', "utf8");
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
  const valadrienOsKey = "ValDola-stack/valadrien-os/valadrien-os";
  const createAgentKey = "ValDola-stack/valadrien-os/valadrien-os-create-agent";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("repairs a Codex ValadrienOs skill symlink that still points at another live checkout", async () => {
    const currentRepo = await makeTempDir("valadrien-os-codex-current-");
    const oldRepo = await makeTempDir("valadrien-os-codex-old-");
    const skillsHome = await makeTempDir("valadrien-os-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createValadrienOsRepoSkill(currentRepo, "valadrien-os");
    await createValadrienOsRepoSkill(currentRepo, "valadrien-os-create-agent");
    await createValadrienOsRepoSkill(oldRepo, "valadrien-os");
    await fs.symlink(path.join(oldRepo, "skills", "valadrien-os"), path.join(skillsHome, "valadrien-os"));

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [
          {
            key: valadrienOsKey,
            runtimeName: "valadrien-os",
            source: path.join(currentRepo, "skills", "valadrien-os"),
          },
          {
            key: createAgentKey,
            runtimeName: "valadrien-os-create-agent",
            source: path.join(currentRepo, "skills", "valadrien-os-create-agent"),
          },
        ],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "valadrien-os"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "valadrien-os")),
    );
    expect(await fs.realpath(path.join(skillsHome, "valadrien-os-create-agent"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "valadrien-os-create-agent")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "valadrien-os"'),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Injected Codex skill "valadrien-os-create-agent"'),
      }),
    );
  });

  it("preserves a custom Codex skill symlink outside ValadrienOs repo checkouts", async () => {
    const currentRepo = await makeTempDir("valadrien-os-codex-current-");
    const customRoot = await makeTempDir("valadrien-os-codex-custom-");
    const skillsHome = await makeTempDir("valadrien-os-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createValadrienOsRepoSkill(currentRepo, "valadrien-os");
    await createCustomSkill(customRoot, "valadrien-os");
    await fs.symlink(path.join(customRoot, "custom", "valadrien-os"), path.join(skillsHome, "valadrien-os"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: valadrienOsKey,
        runtimeName: "valadrien-os",
        source: path.join(currentRepo, "skills", "valadrien-os"),
      }],
    });

    expect(await fs.realpath(path.join(skillsHome, "valadrien-os"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "valadrien-os")),
    );
  });

  it("prunes broken symlinks for unavailable ValadrienOs repo skills before Codex starts", async () => {
    const currentRepo = await makeTempDir("valadrien-os-codex-current-");
    const oldRepo = await makeTempDir("valadrien-os-codex-old-");
    const skillsHome = await makeTempDir("valadrien-os-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createValadrienOsRepoSkill(currentRepo, "valadrien-os");
    await createValadrienOsRepoSkill(oldRepo, "agent-browser");
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
          key: valadrienOsKey,
          runtimeName: "valadrien-os",
          source: path.join(currentRepo, "skills", "valadrien-os"),
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

  it("preserves other live ValadrienOs skill symlinks in the shared workspace skill directory", async () => {
    const currentRepo = await makeTempDir("valadrien-os-codex-current-");
    const skillsHome = await makeTempDir("valadrien-os-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createValadrienOsRepoSkill(currentRepo, "valadrien-os");
    await createValadrienOsRepoSkill(currentRepo, "agent-browser");
    await fs.symlink(
      path.join(currentRepo, "skills", "agent-browser"),
      path.join(skillsHome, "agent-browser"),
    );

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: valadrienOsKey,
        runtimeName: "valadrien-os",
        source: path.join(currentRepo, "skills", "valadrien-os"),
      }],
    });

    expect((await fs.lstat(path.join(skillsHome, "valadrien-os"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "agent-browser"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(skillsHome, "agent-browser"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "agent-browser")),
    );
  });
});
