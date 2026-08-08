import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listHermesSkills, syncHermesSkills } from "./skills.js";

const temporaryRoots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

async function writeSkill(root: string, relativePath: string, body: string): Promise<string> {
  const directory = path.join(root, relativePath);
  await fs.mkdir(directory, { recursive: true });
  const skillPath = path.join(directory, "SKILL.md");
  await fs.writeFile(skillPath, body, "utf8");
  return skillPath;
}

function context(config: Record<string, unknown>) {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    adapterType: "hermes_local",
    config,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (temporaryRoots.length > 0) {
    await fs.rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("Hermes skill snapshots", () => {
  it.each([
    ["default", "default", "skills"],
    ["named", "paperclip-local-v2", path.join("profiles", "paperclip-local-v2", "skills")],
  ])("resolves %s profile below configured HOME without double nesting", async (_label, profile, relativeSkillsHome) => {
    const home = await makeRoot("hermes-home");
    const nativeSkillPath = await writeSkill(
      path.join(home, ".hermes", relativeSkillsHome),
      "native/route_sag_2951_script",
      "# Native route skill",
    );

    const managedRoot = await makeRoot("paperclip-managed");
    await writeSkill(managedRoot, "paperclip-a", "# Managed A");

    const snapshot = await listHermesSkills(context({
      profile,
      env: { HOME: home },
      paperclipRuntimeSkills: [
        { key: "paperclip-a", runtimeName: "paperclip-a", source: path.join(managedRoot, "paperclip-a") },
      ],
      paperclipSkillSync: { desiredSkills: ["paperclip-a"] },
    }));

    const native = snapshot.entries.find((entry) => entry.key === "route_sag_2951_script");
    expect(native).toMatchObject({
      desired: false,
      managed: false,
      readOnly: true,
      sourcePath: nativeSkillPath,
    });
    expect(snapshot.entries.filter((entry) => entry.desired).map((entry) => entry.key)).toEqual(["paperclip-a"]);
    expect(snapshot.desiredSkills).toEqual(["paperclip-a"]);
  });

  it("uses a pre-scoped HERMES_HOME without appending .hermes or the profile", async () => {
    const hermesHome = await makeRoot("hermes-profile-home");
    const nativeSkillPath = await writeSkill(
      hermesHome,
      "skills/native/route_sag_2951_script",
      "# Native route skill",
    );

    const snapshot = await listHermesSkills(context({
      profile: "paperclip-local-v2",
      env: { HERMES_HOME: hermesHome, HOME: "/ignored" },
      paperclipSkillSync: { desiredSkills: [] },
    }));

    expect(snapshot.entries.find((entry) => entry.key === "route_sag_2951_script")).toMatchObject({
      desired: false,
      sourcePath: nativeSkillPath,
    });
    expect(snapshot.entries.some((entry) => entry.sourcePath?.includes(".hermes"))).toBe(false);
    expect(snapshot.entries.some((entry) => entry.sourcePath?.includes("profiles/paperclip-local-v2"))).toBe(false);
  });

  it("falls back to the process HOME when adapter HOME is absent", async () => {
    const home = await makeRoot("hermes-process-home");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const nativeSkillPath = await writeSkill(
        path.join(home, ".hermes"),
        "skills/native/route_sag_2951_script",
        "# Native route skill",
      );

      const snapshot = await listHermesSkills(context({
        profile: "default",
        env: {},
        paperclipSkillSync: { desiredSkills: [] },
      }));

      expect(snapshot.entries.find((entry) => entry.key === "route_sag_2951_script")?.sourcePath).toBe(
        nativeSkillPath,
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("keeps sync side-effect-free and returns native skills as availability only", async () => {
    const hermesHome = await makeRoot("hermes-noop-home");
    await writeSkill(hermesHome, "skills/native/route_sag_2951_script", "# Native route skill");
    const writeSpy = vi.spyOn(fs, "writeFile");
    const removeSpy = vi.spyOn(fs, "rm");
    const mkdirSpy = vi.spyOn(fs, "mkdir");

    const config = {
      profile: "default",
      env: { HERMES_HOME: hermesHome },
      paperclipSkillSync: { desiredSkills: [] },
    };
    const before = await listHermesSkills(context(config));
    const after = await syncHermesSkills(context(config), ["route_sag_2951_script"]);

    expect(after).toEqual(before);
    expect(after.entries.find((entry) => entry.key === "route_sag_2951_script")).toMatchObject({
      desired: false,
      readOnly: true,
      managed: false,
    });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
  });
});
