import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  listHermesSkills,
  resolveHermesSkillsHome,
  syncHermesSkills,
} from "./skills.js";

const runtimeSkills = vi.hoisted(() => ({
  entries: [] as Array<{ key: string; runtimeName: string; source: string }>,
}));

vi.mock("@paperclipai/adapter-utils/server-utils", () => ({
  readPaperclipRuntimeSkillEntries: vi.fn(async () => runtimeSkills.entries),
  resolvePaperclipDesiredSkillNames: vi.fn(
    (config: Record<string, unknown>) => {
      const raw = config.paperclipSkillSync;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
      const desired = (raw as { desiredSkills?: unknown }).desiredSkills;
      return Array.isArray(desired) ? desired.filter((entry): entry is string => typeof entry === "string") : [];
    },
  ),
}));

async function writeSkill(root: string, name: string, description = "Test skill"): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(skillDir, "script.ts"), "export {};\n", "utf8");
  return skillDir;
}

describe("Hermes skill sync", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-skills-"));
    runtimeSkills.entries = [];
  });

  afterEach(async () => {
    runtimeSkills.entries = [];
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test("resolves the active profile skills directory from HERMES_HOME and profile args", () => {
    const skillsHome = resolveHermesSkillsHome({
      env: {
        HERMES_HOME: { type: "plain", value: "/tmp/hermes-home" },
      },
      extraArgs: ["--profile", "paco-studio"],
    });

    expect(skillsHome).toBe(path.join("/tmp/hermes-home", "profiles", "paco-studio", "skills"));
  });

  test("copies selected Paperclip skills into the active Hermes profile skills directory", async () => {
    const sourceRoot = path.join(tempRoot, "paperclip-runtime-skills");
    const hermesHome = path.join(tempRoot, "Hermes");
    const source = await writeSkill(sourceRoot, "paperclip-task-bridge", "Paperclip bridge");

    runtimeSkills.entries = [
      {
        key: "paperclip-task-bridge",
        runtimeName: "paperclip-task-bridge",
        source,
      },
    ];

    const config = {
      env: { HERMES_HOME: hermesHome },
      extraArgs: ["--profile", "paco-studio"],
      paperclipSkillSync: { desiredSkills: ["paperclip-task-bridge"] },
    };

    const snapshot = await syncHermesSkills(
      {
        adapterType: "hermes_local",
        agentId: "agent-id",
        companyId: "company-id",
        config,
      },
      ["paperclip-task-bridge"],
    );

    const target = path.join(
      hermesHome,
      "profiles",
      "paco-studio",
      "skills",
      "paperclip-task-bridge",
    );

    await expect(fs.readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toContain(
      "name: paperclip-task-bridge",
    );
    await expect(fs.readFile(path.join(target, "script.ts"), "utf8")).resolves.toContain(
      "export {};",
    );

    const manifest = JSON.parse(
      await fs.readFile(
        path.join(hermesHome, "profiles", "paco-studio", "skills", ".paperclip-managed-skills.json"),
        "utf8",
      ),
    ) as { skills: Record<string, { target: string }> };

    expect(manifest.skills["paperclip-task-bridge"]?.target).toBe(target);
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        key: "paperclip-task-bridge",
        runtimeName: "paperclip-task-bridge",
        state: "installed",
        targetPath: target,
      }),
    );

    const listed = await listHermesSkills({
      adapterType: "hermes_local",
      agentId: "agent-id",
      companyId: "company-id",
      config,
    });

    expect(listed.entries.filter((entry) => entry.key === "paperclip-task-bridge")).toHaveLength(1);
  });

  test("removes previously managed profile skills when they are deselected", async () => {
    const sourceRoot = path.join(tempRoot, "paperclip-runtime-skills");
    const hermesHome = path.join(tempRoot, "Hermes");
    const source = await writeSkill(sourceRoot, "paperclip-task-bridge");

    runtimeSkills.entries = [
      {
        key: "paperclip-task-bridge",
        runtimeName: "paperclip-task-bridge",
        source,
      },
    ];

    const config = {
      env: { HERMES_HOME: hermesHome },
      extraArgs: ["-p=paco-studio"],
      paperclipSkillSync: { desiredSkills: ["paperclip-task-bridge"] },
    };

    await syncHermesSkills(
      {
        adapterType: "hermes_local",
        agentId: "agent-id",
        companyId: "company-id",
        config,
      },
      ["paperclip-task-bridge"],
    );

    const target = path.join(
      hermesHome,
      "profiles",
      "paco-studio",
      "skills",
      "paperclip-task-bridge",
    );
    await expect(fs.stat(path.join(target, "SKILL.md"))).resolves.toBeTruthy();

    const deselectedConfig = {
      ...config,
      paperclipSkillSync: { desiredSkills: [] },
    };

    const snapshot = await syncHermesSkills(
      {
        adapterType: "hermes_local",
        agentId: "agent-id",
        companyId: "company-id",
        config: deselectedConfig,
      },
      [],
    );

    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        key: "paperclip-task-bridge",
        state: "available",
      }),
    );
  });

  test("uses the runtime-name fallback when the declared Hermes skill name is user-owned", async () => {
    const sourceRoot = path.join(tempRoot, "paperclip-runtime-skills");
    const hermesHome = path.join(tempRoot, "Hermes");
    const source = await writeSkill(sourceRoot, "paperclip-task-bridge");
    const profileSkillsHome = path.join(hermesHome, "profiles", "paco-studio", "skills");
    const userOwnedTarget = await writeSkill(profileSkillsHome, "shared-name", "User-owned skill");
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: shared-name\ndescription: Paperclip bridge\n---\n\n# shared-name\n",
      "utf8",
    );

    runtimeSkills.entries = [
      {
        key: "paperclip-task-bridge",
        runtimeName: "paperclip-task-bridge",
        source,
      },
    ];

    const config = {
      env: { HERMES_HOME: hermesHome },
      extraArgs: ["--profile", "paco-studio"],
      paperclipSkillSync: { desiredSkills: ["paperclip-task-bridge"] },
    };

    const snapshot = await syncHermesSkills(
      {
        adapterType: "hermes_local",
        agentId: "agent-id",
        companyId: "company-id",
        config,
      },
      ["paperclip-task-bridge"],
    );

    const fallbackTarget = path.join(profileSkillsHome, "paperclip-task-bridge");

    await expect(fs.readFile(path.join(userOwnedTarget, "SKILL.md"), "utf8")).resolves.toContain(
      "User-owned skill",
    );
    await expect(fs.readFile(path.join(fallbackTarget, "SKILL.md"), "utf8")).resolves.toContain(
      "name: shared-name",
    );
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        key: "paperclip-task-bridge",
        state: "installed",
        targetPath: fallbackTarget,
      }),
    );
  });

  test("does not overwrite a user-owned runtime-name fallback target", async () => {
    const sourceRoot = path.join(tempRoot, "paperclip-runtime-skills");
    const hermesHome = path.join(tempRoot, "Hermes");
    const source = await writeSkill(sourceRoot, "paperclip-task-bridge");
    const profileSkillsHome = path.join(hermesHome, "profiles", "paco-studio", "skills");
    const declaredTarget = await writeSkill(profileSkillsHome, "shared-name", "User-owned declared skill");
    const fallbackTarget = await writeSkill(profileSkillsHome, "paperclip-task-bridge", "User-owned fallback skill");
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: shared-name\ndescription: Paperclip bridge\n---\n\n# shared-name\n",
      "utf8",
    );

    runtimeSkills.entries = [
      {
        key: "paperclip-task-bridge",
        runtimeName: "paperclip-task-bridge",
        source,
      },
    ];

    const config = {
      env: { HERMES_HOME: hermesHome },
      extraArgs: ["--profile", "paco-studio"],
      paperclipSkillSync: { desiredSkills: ["paperclip-task-bridge"] },
    };

    const snapshot = await syncHermesSkills(
      {
        adapterType: "hermes_local",
        agentId: "agent-id",
        companyId: "company-id",
        config,
      },
      ["paperclip-task-bridge"],
    );

    await expect(fs.readFile(path.join(declaredTarget, "SKILL.md"), "utf8")).resolves.toContain(
      "User-owned declared skill",
    );
    await expect(fs.readFile(path.join(fallbackTarget, "SKILL.md"), "utf8")).resolves.toContain(
      "User-owned fallback skill",
    );
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        key: "paperclip-task-bridge",
        state: "missing",
      }),
    );
  });
});
