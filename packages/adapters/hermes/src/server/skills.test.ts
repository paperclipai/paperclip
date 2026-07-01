/**
 * Strict-TDD coverage for skills.ts after the hermes-home resolver migration.
 *
 * Skills scanning MUST honor the same precedence as model detection and
 * environment diagnostics: HERMES_HOME > HOME > USERPROFILE > os.homedir().
 * It MUST scan `${resolvedHome}/skills/<category>/SKILL.md` exactly once —
 * never `${home}/.hermes/.hermes/skills` — so an explicit HERMES_HOME wins
 * without re-appending `.hermes`.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { listHermesSkills } from "./skills.js";

const previousEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HERMES_HOME: process.env.HERMES_HOME,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
};

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/**
 * Build a hermes skills directory at `<root>/skills/<category>/SKILL.md`.
 * The category name is also used as the skill key, matching Hermes's own
 * skill layout.
 */
async function writeHermesSkill(
  root: string,
  category: string,
  description: string,
): Promise<string> {
  const skillsHome = join(root, "skills");
  const catDir = join(skillsHome, category);
  await mkdir(catDir, { recursive: true });
  const skillPath = join(catDir, "SKILL.md");
  await writeFile(
    skillPath,
    [
      "---",
      `name: ${category}`,
      `description: ${description}`,
      "---",
      "",
      `# ${category}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return skillsHome;
}

/**
 * The Paperclip-runtime skill scan reads bundled skills from disk and
 * short-circuits if `config.paperclipRuntimeSkills` is configured. We pass
 * an empty list so listHermesSkills focuses on Hermes skills without
 * depending on whatever is bundled with the adapter at test time.
 */
const baseConfig = () => ({
  paperclipRuntimeSkills: [],
  paperclipSkillSync: { desiredSkills: [] },
});

describe("listHermesSkills with the shared hermes-home resolver", () => {
  test("scans `${HERMES_HOME}/skills` without re-appending `.hermes`", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-skills-test-"));
    const hermesHome = join(root, ".hermes");
    const category = "alpha";
    await writeHermesSkill(hermesHome, category, "from HERMES_HOME");

    try {
      process.env.HERMES_HOME = hermesHome;
      delete process.env.HOME;

      const snapshot = await listHermesSkills({
        companyId: "company-test",
        agentId: "agent-test",
        adapterType: "hermes_local",
        config: baseConfig(),
      });

      const hermesEntries = snapshot.entries.filter((entry) => entry.origin === "user_installed");
      expect(hermesEntries.map((entry) => entry.key)).toEqual([category]);
      const alpha = hermesEntries[0]!;
      expect(alpha.locationLabel).toBe(`~/.hermes/skills/${category}`);
      expect(alpha.detail).toBe("from HERMES_HOME");
      expect(alpha.sourcePath).toBe(join(hermesHome, "skills", category, "SKILL.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to `${HOME}/.hermes/skills` when HERMES_HOME is unset", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-skills-test-"));
    const hermesHome = join(root, ".hermes");
    const category = "beta";
    await writeHermesSkill(hermesHome, category, "from HOME fallback");

    try {
      delete process.env.HERMES_HOME;
      process.env.HOME = root;
      delete process.env.USERPROFILE;

      const snapshot = await listHermesSkills({
        companyId: "company-test",
        agentId: "agent-test",
        adapterType: "hermes_local",
        config: baseConfig(),
      });

      const hermesEntries = snapshot.entries.filter((entry) => entry.origin === "user_installed");
      expect(hermesEntries.map((entry) => entry.key)).toEqual([category]);
      expect(hermesEntries[0]!.sourcePath).toBe(join(hermesHome, "skills", category, "SKILL.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never reads `${HOME}/.hermes/.hermes/skills` (no double append)", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-skills-test-"));
    // Plant the bug's accidental layout so a regression would find it
    // instead of the canonical one.
    const wrongHermesHome = join(root, ".hermes", ".hermes");
    const rightHermesHome = join(root, ".hermes");
    await writeHermesSkill(wrongHermesHome, "should-not-load", "regression sentinel");
    await writeHermesSkill(rightHermesHome, "should-load", "canonical");

    try {
      delete process.env.HERMES_HOME;
      process.env.HOME = root;
      delete process.env.USERPROFILE;

      const snapshot = await listHermesSkills({
        companyId: "company-test",
        agentId: "agent-test",
        adapterType: "hermes_local",
        config: baseConfig(),
      });

      const hermesEntries = snapshot.entries.filter((entry) => entry.origin === "user_installed");
      expect(hermesEntries.map((entry) => entry.key)).toEqual(["should-load"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("config.env.HOME overrides process.env.HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-skills-test-"));
    const hermesHome = join(root, ".hermes");
    await writeHermesSkill(hermesHome, "gamma", "from config.env.HOME");

    try {
      delete process.env.HERMES_HOME;
      process.env.HOME = "/some/other/place";

      const snapshot = await listHermesSkills({
        companyId: "company-test",
        agentId: "agent-test",
        adapterType: "hermes_local",
        config: {
          ...baseConfig(),
          env: { HOME: root },
        },
      });

      const hermesEntries = snapshot.entries.filter((entry) => entry.origin === "user_installed");
      expect(hermesEntries.map((entry) => entry.key)).toEqual(["gamma"]);
      expect(hermesEntries[0]!.sourcePath).toBe(join(hermesHome, "skills", "gamma", "SKILL.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("config.env.HERMES_HOME wins over config.env.HOME and process.env", async () => {
    const hermesRoot = await mkdtemp(join(tmpdir(), "hermes-skills-test-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "hermes-skills-test-"));
    const hermesHome = join(hermesRoot, ".hermes");
    const homeFallback = join(homeRoot, ".hermes");
    await writeHermesSkill(hermesHome, "delta", "from explicit HERMES_HOME");
    await writeHermesSkill(homeFallback, "should-not-load", "fallback sentinel");

    try {
      delete process.env.HERMES_HOME;

      const snapshot = await listHermesSkills({
        companyId: "company-test",
        agentId: "agent-test",
        adapterType: "hermes_local",
        config: {
          ...baseConfig(),
          env: { HERMES_HOME: hermesHome, HOME: homeRoot },
        },
      });

      const hermesEntries = snapshot.entries.filter((entry) => entry.origin === "user_installed");
      expect(hermesEntries.map((entry) => entry.key)).toEqual(["delta"]);
    } finally {
      await rm(hermesRoot, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  test("returns no Hermes-installed entries when skills directory is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-skills-test-"));
    try {
      delete process.env.HERMES_HOME;
      process.env.HOME = root;
      delete process.env.USERPROFILE;

      const snapshot = await listHermesSkills({
        companyId: "company-test",
        agentId: "agent-test",
        adapterType: "hermes_local",
        config: baseConfig(),
      });

      const hermesEntries = snapshot.entries.filter((entry) => entry.origin === "user_installed");
      expect(hermesEntries).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});