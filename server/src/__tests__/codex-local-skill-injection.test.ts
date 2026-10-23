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

async function createManagedCatalogSkill(root: string, companyId: string, runtimeName: string) {
  const skillDir = path.join(root, "skills", companyId, "__catalog__", runtimeName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${runtimeName}\n---\n`,
    "utf8",
  );
  return skillDir;
}

async function createCompanyOwnedSkill(root: string, companyId: string, slug: string) {
  const skillDir = path.join(root, "companies", companyId, "skills", slug);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${slug}\n---\n`,
    "utf8",
  );
  await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "references", "governance.md"), "# governance\n", "utf8");
  return skillDir;
}

describe("codex local adapter skill injection", () => {
  const paperclipKey = "paperclipai/paperclip/paperclip";
  const createAgentKey = "paperclipai/paperclip/paperclip-create-agent";
  const modernDeliveryKey = "local/928c96addb/modern-delivery";
  const modernDeliveryRuntimeName = "modern-delivery--126abb30bb";
  const companyId = "5e0fb142-c4c0-4b6b-ab76-8465065b22e7";
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
    await createPaperclipRepoSkill(currentRepo, "paperclip-create-agent");
    await createPaperclipRepoSkill(oldRepo, "paperclip");
    await fs.symlink(path.join(oldRepo, "skills", "paperclip"), path.join(skillsHome, "paperclip"));

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [
          {
            key: paperclipKey,
            runtimeName: "paperclip",
            source: path.join(currentRepo, "skills", "paperclip"),
          },
          {
            key: createAgentKey,
            runtimeName: "paperclip-create-agent",
            source: path.join(currentRepo, "skills", "paperclip-create-agent"),
          },
        ],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "paperclip"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "paperclip")),
    );
    expect(await fs.realpath(path.join(skillsHome, "paperclip-create-agent"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "paperclip-create-agent")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "paperclip"'),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Injected Codex skill "paperclip-create-agent"'),
      }),
    );
  });

  it("repairs a Codex skill symlink that still points at a stale managed catalog mount", async () => {
    const instanceRoot = await makeTempDir("paperclip-codex-instance-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(instanceRoot);
    cleanupDirs.add(skillsHome);

    const staleCatalogDir = await createManagedCatalogSkill(
      instanceRoot,
      companyId,
      modernDeliveryRuntimeName,
    );
    const currentSource = await createCompanyOwnedSkill(instanceRoot, companyId, "modern-delivery");
    await fs.writeFile(
      path.join(staleCatalogDir, "SKILL.md"),
      "---\nname: stale\n---\n",
      "utf8",
    );
    await fs.symlink(
      staleCatalogDir,
      path.join(skillsHome, modernDeliveryRuntimeName),
    );

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: modernDeliveryKey,
          runtimeName: modernDeliveryRuntimeName,
          source: currentSource,
        }],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, modernDeliveryRuntimeName))).toBe(
      await fs.realpath(currentSource),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining(`Repaired Codex skill "${modernDeliveryRuntimeName}"`),
      }),
    );
  });

  it("repairs a Codex skill symlink that still points at a stale company-owned corpus", async () => {
    const instanceRoot = await makeTempDir("paperclip-codex-instance-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(instanceRoot);
    cleanupDirs.add(skillsHome);

    const staleCompanyOwnedDir = await createCompanyOwnedSkill(instanceRoot, companyId, "modern-delivery");
    const currentSource = path.join(
      instanceRoot,
      "companies",
      companyId,
      "skills",
      "modern-delivery-v2",
    );
    await fs.mkdir(currentSource, { recursive: true });
    await fs.writeFile(
      path.join(currentSource, "SKILL.md"),
      "---\nname: modern-delivery-v2\n---\n",
      "utf8",
    );
    await fs.mkdir(path.join(currentSource, "references"), { recursive: true });
    await fs.writeFile(path.join(currentSource, "references", "governance.md"), "# governance v2\n", "utf8");
    await fs.symlink(
      staleCompanyOwnedDir,
      path.join(skillsHome, modernDeliveryRuntimeName),
    );

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: modernDeliveryKey,
          runtimeName: modernDeliveryRuntimeName,
          source: currentSource,
        }],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, modernDeliveryRuntimeName))).toBe(
      await fs.realpath(currentSource),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining(`Repaired Codex skill "${modernDeliveryRuntimeName}"`),
      }),
    );
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
      skillsEntries: [{
        key: paperclipKey,
        runtimeName: "paperclip",
        source: path.join(currentRepo, "skills", "paperclip"),
      }],
    });

    expect(await fs.realpath(path.join(skillsHome, "paperclip"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "paperclip")),
    );
  });

  it("prunes broken symlinks for unavailable Paperclip repo skills before Codex starts", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const oldRepo = await makeTempDir("paperclip-codex-old-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createPaperclipRepoSkill(oldRepo, "agent-browser");
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
          key: paperclipKey,
          runtimeName: "paperclip",
          source: path.join(currentRepo, "skills", "paperclip"),
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

  it("preserves other live Paperclip skill symlinks in the shared workspace skill directory", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createPaperclipRepoSkill(currentRepo, "agent-browser");
    await fs.symlink(
      path.join(currentRepo, "skills", "agent-browser"),
      path.join(skillsHome, "agent-browser"),
    );

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: paperclipKey,
        runtimeName: "paperclip",
        source: path.join(currentRepo, "skills", "paperclip"),
      }],
    });

    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "agent-browser"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(skillsHome, "agent-browser"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "agent-browser")),
    );
  });
});
