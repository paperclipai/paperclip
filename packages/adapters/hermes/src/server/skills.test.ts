import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { listHermesSkills, reconcileHermesPaperclipSkills } from "./skills.js";

async function makeTempRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeSkill(skillsHome: string, category: string, name: string): Promise<string> {
  const dir = path.join(skillsHome, category, name);
  await fs.mkdir(dir, { recursive: true });
  const skillMd = path.join(dir, "SKILL.md");
  await fs.writeFile(
    skillMd,
    `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\n# ${name}\n`,
    "utf8",
  );
  return skillMd;
}

function skillContext(config: Record<string, unknown>) {
  return {
    adapterType: "hermes_local",
    agentId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    config,
  };
}

/**
 * Run `fn` with HERMES_HOME set to `value` (or removed when `value` is
 * undefined), then restore the previous process environment. Keeps the
 * fallback tests independent of the machine that runs them.
 */
async function withProcessHermesHome<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = process.env.HERMES_HOME;
  if (value === undefined) {
    delete process.env.HERMES_HOME;
  } else {
    process.env.HERMES_HOME = value;
  }
  try {
    return await fn();
  } finally {
    if (saved === undefined) {
      delete process.env.HERMES_HOME;
    } else {
      process.env.HERMES_HOME = saved;
    }
  }
}

test("resolveHermesHome honors HERMES_HOME over HOME for the skills inventory", async () => {
  const root = await makeTempRoot("hermes-home-preferred-");
  try {
    const hermesHome = path.join(root, "hermes-home");
    const userHome = path.join(root, "user-home");
    const skillMd = await writeSkill(path.join(hermesHome, "skills"), "probe", "hermes-home-skill");
    await fs.mkdir(path.join(userHome, ".hermes", "skills"), { recursive: true });

    const snapshot = await listHermesSkills(
      skillContext({ env: { HOME: userHome, HERMES_HOME: hermesHome } }),
    );

    const entry = snapshot.entries.find((candidate) => candidate.key === "hermes-home-skill");
    expect(entry).toBeDefined();
    expect(entry?.sourcePath).toBe(skillMd);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("accepts a structured plain env binding for HERMES_HOME", async () => {
  const root = await makeTempRoot("hermes-home-structured-");
  try {
    const hermesHome = path.join(root, "hermes-home");
    const userHome = path.join(root, "user-home");
    await writeSkill(path.join(hermesHome, "skills"), "probe", "structured-binding-skill");
    await fs.mkdir(path.join(userHome, ".hermes", "skills"), { recursive: true });

    const snapshot = await listHermesSkills(
      skillContext({
        env: { HOME: userHome, HERMES_HOME: { type: "plain", value: hermesHome } },
      }),
    );

    expect(snapshot.entries.some((candidate) => candidate.key === "structured-binding-skill")).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ignores a secret binding for HERMES_HOME and falls back to HOME", async () => {
  const root = await makeTempRoot("hermes-home-secret-");
  try {
    const userHome = path.join(root, "user-home");
    await writeSkill(path.join(userHome, ".hermes", "skills"), "legacy", "fallback-skill");

    const snapshot = await withProcessHermesHome(undefined, () =>
      listHermesSkills(
        skillContext({
          env: { HOME: userHome, HERMES_HOME: { type: "secret_ref", secretId: "secret-placeholder" } },
        }),
      ),
    );

    expect(snapshot.entries.some((candidate) => candidate.key === "fallback-skill")).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("falls back to $HOME/.hermes/skills when HERMES_HOME is unset", async () => {
  const root = await makeTempRoot("hermes-home-default-");
  try {
    const userHome = path.join(root, "user-home");
    await writeSkill(path.join(userHome, ".hermes", "skills"), "legacy", "default-home-skill");

    const snapshot = await withProcessHermesHome(undefined, () =>
      listHermesSkills(skillContext({ env: { HOME: userHome } })),
    );

    const entry = snapshot.entries.find((candidate) => candidate.key === "default-home-skill");
    expect(entry).toBeDefined();
    expect(entry?.locationLabel).toBe("~/.hermes/skills/legacy/default-home-skill");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not report a skill found under HERMES_HOME as a missing desired skill", async () => {
  const root = await makeTempRoot("hermes-home-desired-");
  try {
    const hermesHome = path.join(root, "hermes-home");
    await writeSkill(path.join(hermesHome, "skills"), "probe", "only-in-hermes-home");

    const snapshot = await listHermesSkills(
      skillContext({
        env: { HERMES_HOME: hermesHome },
        paperclipSkillSync: { desiredSkills: ["only-in-hermes-home"] },
      }),
    );

    expect(
      snapshot.warnings.filter((warning) => warning.includes("only-in-hermes-home")),
    ).toEqual([]);
    const entry = snapshot.entries.find((candidate) => candidate.key === "only-in-hermes-home");
    expect(entry?.state).not.toBe("missing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("links reconciled Paperclip skills into HERMES_HOME/skills", async () => {
  const root = await makeTempRoot("hermes-home-sync-");
  try {
    const hermesHome = path.join(root, "hermes-home");
    const userHome = path.join(root, "user-home");
    const source = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip\n", "utf8");

    const desired = await reconcileHermesPaperclipSkills({
      env: { HOME: userHome, HERMES_HOME: hermesHome },
      paperclipRuntimeSkills: [
        { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source },
      ],
      paperclipSkillSync: { desiredSkills: [] },
    });

    expect(desired).toContain("paperclipai/paperclip/paperclip");
    const target = path.join(hermesHome, "skills", "paperclip");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("honors HERMES_HOME from the process environment when config does not set it", async () => {
  const root = await makeTempRoot("hermes-home-process-env-");
  try {
    const hermesHome = path.join(root, "hermes-home");
    const userHome = path.join(root, "user-home");
    const skillMd = await writeSkill(path.join(hermesHome, "skills"), "env", "process-env-skill");
    await fs.mkdir(path.join(userHome, ".hermes", "skills"), { recursive: true });

    const snapshot = await withProcessHermesHome(hermesHome, () =>
      listHermesSkills(skillContext({ env: { HOME: userHome } })),
    );

    const entry = snapshot.entries.find((candidate) => candidate.key === "process-env-skill");
    expect(entry).toBeDefined();
    expect(entry?.sourcePath).toBe(skillMd);
    expect(entry?.locationLabel).toBe("HERMES_HOME/skills/env/process-env-skill");
    expect(entry?.locationLabel).not.toContain(hermesHome);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("shows the HERMES_HOME marker, not the resolved path, in skill locations", async () => {
  const root = await makeTempRoot("hermes-home-label-");
  try {
    const hermesHome = path.join(root, "hermes-home");
    const userHome = path.join(root, "user-home");
    await writeSkill(path.join(hermesHome, "skills"), "probe", "labeled-skill");

    const config = { env: { HOME: userHome, HERMES_HOME: hermesHome } };
    const snapshot = await listHermesSkills(skillContext(config));
    const entry = snapshot.entries.find((candidate) => candidate.key === "labeled-skill");
    // A resolved HERMES_HOME may come from a secret binding, so the label
    // names the variable instead of echoing the value.
    expect(entry?.locationLabel).toBe("HERMES_HOME/skills/probe/labeled-skill");
    expect(entry?.locationLabel).not.toContain(hermesHome);

    const missing = await listHermesSkills(
      skillContext({ ...config, paperclipSkillSync: { desiredSkills: ["absent-skill"] } }),
    );
    const missingEntry = missing.entries.find((candidate) => candidate.key === "absent-skill");
    expect(missingEntry?.detail).toContain("HERMES_HOME/skills");
    expect(missingEntry?.detail).not.toContain(hermesHome);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
