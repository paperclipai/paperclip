import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCursorSkills,
  syncCursorSkills,
} from "@valadrien-os/adapter-cursor-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSkillDir(root: string, name: string) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
}

describe("cursor local skill sync", () => {
  const valadrienOsKey = "ValDola-stack/valadrien-os/valadrien-os";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured ValadrienOs skills and installs them into the Cursor skills home", async () => {
    const home = await makeTempDir("valadrien-os-cursor-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        valadrienOsSkillSync: {
          desiredSkills: [valadrienOsKey],
        },
      },
    } as const;

    const before = await listCursorSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(valadrienOsKey);
    expect(before.entries.find((entry) => entry.key === valadrienOsKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("missing");

    const after = await syncCursorSkills(ctx, [valadrienOsKey]);
    expect(after.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "valadrien-os"))).isSymbolicLink()).toBe(true);
  });

  it("recognizes company-library runtime skills supplied outside the bundled ValadrienOs directory", async () => {
    const home = await makeTempDir("valadrien-os-cursor-runtime-skills-home-");
    const runtimeSkills = await makeTempDir("valadrien-os-cursor-runtime-skills-src-");
    cleanupDirs.add(home);
    cleanupDirs.add(runtimeSkills);

    const valadrienOsDir = await createSkillDir(runtimeSkills, "valadrien-os");
    const asciiHeartDir = await createSkillDir(runtimeSkills, "ascii-heart");

    const ctx = {
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        valadrienOsRuntimeSkills: [
          {
            key: "valadrien-os",
            runtimeName: "valadrien-os",
            source: valadrienOsDir,
            required: true,
            requiredReason: "Bundled ValadrienOs skills are always available for local adapters.",
          },
          {
            key: "ascii-heart",
            runtimeName: "ascii-heart",
            source: asciiHeartDir,
          },
        ],
        valadrienOsSkillSync: {
          desiredSkills: ["ascii-heart"],
        },
      },
    } as const;

    const before = await listCursorSkills(ctx);
    expect(before.warnings).toEqual([]);
    expect(before.desiredSkills).toEqual(["valadrien-os", "ascii-heart"]);
    expect(before.entries.find((entry) => entry.key === "ascii-heart")?.state).toBe("missing");

    const after = await syncCursorSkills(ctx, ["ascii-heart"]);
    expect(after.warnings).toEqual([]);
    expect(after.entries.find((entry) => entry.key === "ascii-heart")?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "ascii-heart"))).isSymbolicLink()).toBe(true);
  });

  it("keeps required bundled ValadrienOs skills installed even when the desired set is emptied", async () => {
    const home = await makeTempDir("valadrien-os-cursor-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        valadrienOsSkillSync: {
          desiredSkills: [valadrienOsKey],
        },
      },
    } as const;

    await syncCursorSkills(configuredCtx, [valadrienOsKey]);

    const clearedCtx = {
      ...configuredCtx,
      config: {
        env: {
          HOME: home,
        },
        valadrienOsSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncCursorSkills(clearedCtx, []);
    expect(after.desiredSkills).toContain(valadrienOsKey);
    expect(after.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "valadrien-os"))).isSymbolicLink()).toBe(true);
  });
});
