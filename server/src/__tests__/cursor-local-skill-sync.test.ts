import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCursorSkills,
  syncCursorSkills,
} from "@ironworksai/adapter-cursor-local/server";

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
  const ironworksKey = "ironworksai/ironworks/ironworks";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Ironworks skills and installs them into the Cursor skills home", async () => {
    const home = await makeTempDir("ironworks-cursor-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        ironworksSkillSync: {
          desiredSkills: [ironworksKey],
        },
      },
    } as const;

    const before = await listCursorSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(ironworksKey);
    expect(before.entries.find((entry) => entry.key === ironworksKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === ironworksKey)?.state).toBe("missing");

    const after = await syncCursorSkills(ctx, [ironworksKey]);
    expect(after.entries.find((entry) => entry.key === ironworksKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "ironworks"))).isSymbolicLink()).toBe(true);
  });

  it("recognizes company-library runtime skills supplied outside the bundled Ironworks directory", async () => {
    const home = await makeTempDir("ironworks-cursor-runtime-skills-home-");
    const runtimeSkills = await makeTempDir("ironworks-cursor-runtime-skills-src-");
    cleanupDirs.add(home);
    cleanupDirs.add(runtimeSkills);

    const ironworksDir = await createSkillDir(runtimeSkills, "ironworks");
    const asciiHeartDir = await createSkillDir(runtimeSkills, "ascii-heart");

    const ctx = {
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        ironworksRuntimeSkills: [
          {
            key: "ironworks",
            runtimeName: "ironworks",
            source: ironworksDir,
            required: true,
            requiredReason: "Bundled Ironworks skills are always available for local adapters.",
          },
          {
            key: "ascii-heart",
            runtimeName: "ascii-heart",
            source: asciiHeartDir,
          },
        ],
        ironworksSkillSync: {
          desiredSkills: ["ascii-heart"],
        },
      },
    } as const;

    const before = await listCursorSkills(ctx);
    expect(before.warnings).toEqual([]);
    expect(before.desiredSkills).toEqual(["ironworks", "ascii-heart"]);
    expect(before.entries.find((entry) => entry.key === "ascii-heart")?.state).toBe("missing");

    const after = await syncCursorSkills(ctx, ["ascii-heart"]);
    expect(after.warnings).toEqual([]);
    expect(after.entries.find((entry) => entry.key === "ascii-heart")?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "ascii-heart"))).isSymbolicLink()).toBe(true);
  });

  it("keeps required bundled Ironworks skills installed even when the desired set is emptied", async () => {
    const home = await makeTempDir("ironworks-cursor-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        ironworksSkillSync: {
          desiredSkills: [ironworksKey],
        },
      },
    } as const;

    await syncCursorSkills(configuredCtx, [ironworksKey]);

    const clearedCtx = {
      ...configuredCtx,
      config: {
        env: {
          HOME: home,
        },
        ironworksSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncCursorSkills(clearedCtx, []);
    expect(after.desiredSkills).toContain(ironworksKey);
    expect(after.entries.find((entry) => entry.key === ironworksKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "ironworks"))).isSymbolicLink()).toBe(true);
  });
});
