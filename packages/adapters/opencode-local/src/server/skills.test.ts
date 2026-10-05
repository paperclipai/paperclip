import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allSkillsHomes,
  listOpenCodeSkills,
  resolveOpenCodeSkillsHomes,
  syncOpenCodeSkills,
} from "./skills.js";

const cleanupDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

const KNOWN_SKILL = {
  key: "example/example/known-skill",
  runtimeName: "known-skill",
};

async function makeFixture() {
  const root = await makeTempDir("paperclip-opencode-skills-");
  const source = path.join(root, "sources", KNOWN_SKILL.runtimeName);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), `# ${KNOWN_SKILL.runtimeName}\n`, "utf8");
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });
  const ctx = {
    agentId: "agent-1",
    companyId: "company-1",
    adapterType: "opencode_local",
    config: {
      env: { HOME: home },
      paperclipRuntimeSkills: [
        {
          key: KNOWN_SKILL.key,
          runtimeName: KNOWN_SKILL.runtimeName,
          source,
          sourceStatus: "available",
        },
      ],
      paperclipSkillSync: { desiredSkills: [KNOWN_SKILL.key] },
    },
  } as const;
  return { root, home, source, ctx };
}

async function expectSymlinkTo(linkPath: string, source: string): Promise<void> {
  const stat = await fs.lstat(linkPath);
  expect(stat.isSymbolicLink()).toBe(true);
  expect(await fs.realpath(linkPath)).toBe(await fs.realpath(source));
}

describe("resolveOpenCodeSkillsHomes", () => {
  const config = { env: { HOME: "/tmp/paperclip-skills-home" } };

  it("defaults to the legacy Claude skills home", () => {
    expect(resolveOpenCodeSkillsHomes(config)).toEqual([
      "/tmp/paperclip-skills-home/.claude/skills",
    ]);
    expect(resolveOpenCodeSkillsHomes(config, "v1")).toEqual([
      "/tmp/paperclip-skills-home/.claude/skills",
    ]);
  });

  it("targets the v2 native skills home for the v2 line", () => {
    expect(resolveOpenCodeSkillsHomes(config, "v2")).toEqual([
      "/tmp/paperclip-skills-home/.config/opencode/skills",
    ]);
  });

  it("targets both homes when the version line is unknown", () => {
    expect(resolveOpenCodeSkillsHomes(config, "unknown")).toEqual([
      "/tmp/paperclip-skills-home/.claude/skills",
      "/tmp/paperclip-skills-home/.config/opencode/skills",
    ]);
  });

  it("resolves the v2 home against the effective XDG_CONFIG_HOME the run will see", () => {
    expect(resolveOpenCodeSkillsHomes(config, "v2", "/runtime/config-home")).toEqual([
      "/runtime/config-home/opencode/skills",
    ]);
    // The v1 home stays HOME-based; only the v2 home follows the config home.
    expect(resolveOpenCodeSkillsHomes(config, "unknown", "/runtime/config-home")).toEqual([
      "/tmp/paperclip-skills-home/.claude/skills",
      "/runtime/config-home/opencode/skills",
    ]);
  });
});

describe("allSkillsHomes", () => {
  it("returns both HOME-based skills homes for management", () => {
    expect(allSkillsHomes({ env: { HOME: "/tmp/paperclip-skills-home" } })).toEqual([
      "/tmp/paperclip-skills-home/.claude/skills",
      "/tmp/paperclip-skills-home/.config/opencode/skills",
    ]);
  });
});

describe("opencode local skills injection", () => {
  it("installs into both skills homes by default so management matches either run line", async () => {
    const { home, source, ctx } = await makeFixture();

    const snapshot = await syncOpenCodeSkills(ctx, [KNOWN_SKILL.key]);

    expect(snapshot.entries.find((entry) => entry.key === KNOWN_SKILL.key)?.state).toBe("installed");
    await expectSymlinkTo(path.join(home, ".claude", "skills", KNOWN_SKILL.runtimeName), source);
    await expectSymlinkTo(
      path.join(home, ".config", "opencode", "skills", KNOWN_SKILL.runtimeName),
      source,
    );
  });

  it("reports a skill installed in only the legacy home as installed by default", async () => {
    const { ctx } = await makeFixture();
    await syncOpenCodeSkills(ctx, [KNOWN_SKILL.key], "v1");

    const snapshot = await listOpenCodeSkills(ctx);

    expect(snapshot.entries.find((entry) => entry.key === KNOWN_SKILL.key)?.state).toBe("installed");
  });

  it("reports a skill installed in only the v2 native home as installed by default", async () => {
    const { ctx } = await makeFixture();
    await syncOpenCodeSkills(ctx, [KNOWN_SKILL.key], "v2");

    const snapshot = await listOpenCodeSkills(ctx);

    expect(snapshot.entries.find((entry) => entry.key === KNOWN_SKILL.key)?.state).toBe("installed");
  });

  it("installs into the v2 native home when the version line is v2", async () => {
    const { home, source, ctx } = await makeFixture();

    const snapshot = await syncOpenCodeSkills(ctx, [KNOWN_SKILL.key], "v2");

    expect(snapshot.entries.find((entry) => entry.key === KNOWN_SKILL.key)?.state).toBe("installed");
    expect(snapshot.warnings).toContain(
      "OpenCode v2 discovers skills in its native global skills home (~/.config/opencode/skills).",
    );
    await expectSymlinkTo(
      path.join(home, ".config", "opencode", "skills", KNOWN_SKILL.runtimeName),
      source,
    );
    await expect(fs.access(path.join(home, ".claude", "skills"))).rejects.toThrow();
  });

  it("installs into both homes when the version line is unknown", async () => {
    const { home, source, ctx } = await makeFixture();

    const snapshot = await syncOpenCodeSkills(ctx, [KNOWN_SKILL.key], "unknown");

    expect(snapshot.entries.find((entry) => entry.key === KNOWN_SKILL.key)?.state).toBe("installed");
    await expectSymlinkTo(path.join(home, ".claude", "skills", KNOWN_SKILL.runtimeName), source);
    await expectSymlinkTo(
      path.join(home, ".config", "opencode", "skills", KNOWN_SKILL.runtimeName),
      source,
    );
  });

  it("reports a skill linked only into the v2 home as installed for an unknown version", async () => {
    const { ctx } = await makeFixture();
    await syncOpenCodeSkills(ctx, [KNOWN_SKILL.key], "v2");

    const snapshot = await listOpenCodeSkills(ctx, "unknown");

    expect(snapshot.mode).toBe("persistent");
    expect(snapshot.entries.find((entry) => entry.key === KNOWN_SKILL.key)?.state).toBe("installed");
  });

  it("reports a desired skill as missing when no target home has it", async () => {
    const { ctx } = await makeFixture();

    const snapshot = await listOpenCodeSkills(ctx, "v2");

    expect(snapshot.entries.find((entry) => entry.key === KNOWN_SKILL.key)?.state).toBe("missing");
  });

  it("keeps the skill directory name stable across v1 and v2 homes", async () => {
    const { home, ctx } = await makeFixture();

    await syncOpenCodeSkills(ctx, [KNOWN_SKILL.key], "v1");
    await syncOpenCodeSkills(ctx, [KNOWN_SKILL.key], "v2");

    for (const skillsHome of [
      path.join(home, ".claude", "skills"),
      path.join(home, ".config", "opencode", "skills"),
    ]) {
      expect(await fs.readdir(skillsHome)).toContain(KNOWN_SKILL.runtimeName);
    }
  });
});
