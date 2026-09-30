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
  const paperclipKey = "paperclipai/paperclip/paperclip";
  const createAgentKey = "paperclipai/paperclip/paperclip-create-agent";
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

  describe("agent roles", () => {
    async function createRoleSkill(root: string, skillName: string, roleName: string) {
      await createCustomSkill(root, skillName);
      const source = path.join(root, "custom", skillName);
      await fs.mkdir(path.join(source, "agents"), { recursive: true });
      await fs.writeFile(path.join(source, "agents", `${roleName}.toml`), `name = "${roleName}"\n`, "utf8");
      await fs.writeFile(path.join(source, "agents", "openai.yaml"), "interface: {}\n", "utf8");
      return { key: `company/c/${skillName}`, runtimeName: skillName, source };
    }

    async function setup() {
      const root = await makeTempDir("paperclip-codex-agent-roles-");
      cleanupDirs.add(root);
      const codexHome = path.join(root, "codex-home");
      const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      };
      return { root, codexHome, skillsHome: path.join(codexHome, "skills"), logs, onLog };
    }

    it("links the roles a desired skill ships and keeps live role links another run still needs", async () => {
      const { root, codexHome, skillsHome, onLog } = await setup();
      const design = await createRoleSkill(root, "design", "design_reviewer");
      const audit = await createRoleSkill(root, "audit", "auditor");
      await fs.mkdir(path.join(codexHome, "agents"), { recursive: true });
      await fs.writeFile(path.join(codexHome, "agents", "mine.toml"), 'name = "mine"\n', "utf8");
      const skillsEntries = [design, audit];

      await ensureCodexSkillsInjected(onLog, { skillsHome, skillsEntries, desiredSkillNames: [design.key] });
      // A second agent sharing this Codex home wants only the other skill.
      await ensureCodexSkillsInjected(onLog, { skillsHome, skillsEntries, desiredSkillNames: [audit.key] });

      expect(await fs.readlink(path.join(codexHome, "agents", "design_reviewer.toml"))).toBe(
        path.join(design.source, "agents", "design_reviewer.toml"),
      );
      expect((await fs.readdir(path.join(codexHome, "agents"))).sort()).toEqual([
        "auditor.toml",
        "design_reviewer.toml",
        "mine.toml",
      ]);
    });

    it("keeps an operator's role link into an installed skill", async () => {
      const { root, codexHome, skillsHome, onLog } = await setup();
      const design = await createRoleSkill(root, "design", "design_reviewer");
      await fs.mkdir(path.join(codexHome, "agents"), { recursive: true });
      const operatorLink = path.join(codexHome, "agents", "my_reviewer.toml");
      await fs.symlink(path.join(design.source, "agents", "design_reviewer.toml"), operatorLink);

      await ensureCodexSkillsInjected(onLog, { skillsHome, skillsEntries: [design], desiredSkillNames: [] });

      expect(await fs.readlink(operatorLink)).toBe(path.join(design.source, "agents", "design_reviewer.toml"));
    });

    it("logs a role that cannot be linked and still injects the skill", async () => {
      const { root, codexHome, skillsHome, logs, onLog } = await setup();
      const design = await createRoleSkill(root, "design", "design_reviewer");
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(path.join(codexHome, "agents"), "not a directory\n", "utf8");

      await ensureCodexSkillsInjected(onLog, { skillsHome, skillsEntries: [design], desiredSkillNames: [design.key] });

      expect(await fs.readlink(path.join(skillsHome, "design"))).toBe(design.source);
      expect(logs).toContainEqual({
        stream: "stderr",
        chunk: expect.stringContaining('Failed to link Codex agent role "design_reviewer.toml"'),
      });
    });

    it("reports a skill agents directory that cannot be read", async () => {
      const { root, skillsHome, logs, onLog } = await setup();
      await createCustomSkill(root, "design");
      const source = path.join(root, "custom", "design");
      await fs.writeFile(path.join(source, "agents"), "not a directory\n", "utf8");
      const entry = { key: "company/c/design", runtimeName: "design", source };

      await ensureCodexSkillsInjected(onLog, { skillsHome, skillsEntries: [entry], desiredSkillNames: [entry.key] });

      expect(logs).toContainEqual({
        stream: "stderr",
        chunk: expect.stringContaining('Failed to read Codex agent roles of skill "design"'),
      });
    });

    it("refuses a role whose real path escapes its skill", async () => {
      const { root, codexHome, skillsHome, logs, onLog } = await setup();
      await createCustomSkill(root, "design");
      const source = path.join(root, "custom", "design");
      await fs.mkdir(path.join(source, "agents"), { recursive: true });
      await fs.writeFile(path.join(root, "secret.toml"), 'token = "x"\n', "utf8");
      await fs.symlink(path.join(root, "secret.toml"), path.join(source, "agents", "leak.toml"));
      const entry = { key: "company/c/design", runtimeName: "design", source };

      await ensureCodexSkillsInjected(onLog, { skillsHome, skillsEntries: [entry], desiredSkillNames: [entry.key] });

      expect(await fs.lstat(path.join(codexHome, "agents", "leak.toml")).catch(() => null)).toBeNull();
      expect(logs).toContainEqual({
        stream: "stderr",
        chunk: expect.stringContaining('Refused Codex agent role "leak.toml"'),
      });
    });

    describe("role name collisions in the shared home", () => {
      async function twoRepoSkillsShipping(root: string, roleName: string) {
        const repo = path.join(root, "repo");
        const entries = [];
        for (const skillName of ["design", "audit"]) {
          await createPaperclipRepoSkill(repo, skillName);
          const source = path.join(repo, "skills", skillName);
          await fs.mkdir(path.join(source, "agents"), { recursive: true });
          await fs.writeFile(path.join(source, "agents", `${roleName}.toml`), `name = "${skillName}"\n`, "utf8");
          entries.push({ key: `paperclip/${skillName}`, runtimeName: skillName, source });
        }
        return entries as [(typeof entries)[number], (typeof entries)[number]];
      }

      it("repoints a live role link of another Paperclip skill when this run wants the role from a different skill", async () => {
        const { root, codexHome, skillsHome, logs, onLog } = await setup();
        const [design, audit] = await twoRepoSkillsShipping(root, "reviewer");
        const skillsEntries = [design, audit];

        await ensureCodexSkillsInjected(onLog, { skillsHome, skillsEntries, desiredSkillNames: [design.key] });
        await ensureCodexSkillsInjected(onLog, { skillsHome, skillsEntries, desiredSkillNames: [audit.key] });

        expect(await fs.readlink(path.join(codexHome, "agents", "reviewer.toml"))).toBe(
          path.join(audit.source, "agents", "reviewer.toml"),
        );
        expect(logs).toContainEqual({
          stream: "stdout",
          chunk: expect.stringContaining('Repaired Codex agent role "reviewer.toml"'),
        });
      });

      it("keeps an operator's live link that shadows a role name", async () => {
        const { root, codexHome, skillsHome, onLog } = await setup();
        const [design] = await twoRepoSkillsShipping(root, "reviewer");
        const operatorRole = path.join(root, "operator", "reviewer.toml");
        await fs.mkdir(path.dirname(operatorRole), { recursive: true });
        await fs.writeFile(operatorRole, 'name = "operator"\n', "utf8");
        await fs.mkdir(path.join(codexHome, "agents"), { recursive: true });
        await fs.symlink(operatorRole, path.join(codexHome, "agents", "reviewer.toml"));

        await ensureCodexSkillsInjected(onLog, { skillsHome, skillsEntries: [design], desiredSkillNames: [design.key] });

        expect(await fs.readlink(path.join(codexHome, "agents", "reviewer.toml"))).toBe(operatorRole);
      });
    });

    it("prunes a dangling role link left by a removed Paperclip repo skill", async () => {
      const { root, codexHome, skillsHome, logs, onLog } = await setup();
      const repo = path.join(root, "repo");
      await createPaperclipRepoSkill(repo, "old-skill");
      const roleSource = path.join(repo, "skills", "old-skill", "agents", "old_role.toml");
      await fs.mkdir(path.dirname(roleSource), { recursive: true });
      await fs.writeFile(roleSource, 'name = "old_role"\n', "utf8");
      await fs.mkdir(path.join(codexHome, "agents"), { recursive: true });
      await fs.symlink(roleSource, path.join(codexHome, "agents", "old_role.toml"));
      await fs.rm(path.join(repo, "skills", "old-skill"), { recursive: true, force: true });

      await ensureCodexSkillsInjected(onLog, { skillsHome, skillsEntries: [], desiredSkillNames: [] });

      expect(await fs.readdir(path.join(codexHome, "agents"))).toEqual([]);
      expect(logs).toContainEqual({
        stream: "stdout",
        chunk: expect.stringContaining('Removed stale Codex agent role "old_role.toml"'),
      });
    });
  });
});
