import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listOpenCodeSkills,
  syncOpenCodeSkills,
} from "@ironworksai/adapter-opencode-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("opencode local skill sync", () => {
  const ironworksKey = "ironworksai/ironworks/ironworks";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Ironworks skills and installs them into the shared Claude/OpenCode skills home", async () => {
    const home = await makeTempDir("ironworks-opencode-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        env: {
          HOME: home,
        },
        ironworksSkillSync: {
          desiredSkills: [ironworksKey],
        },
      },
    } as const;

    const before = await listOpenCodeSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.warnings).toContain("OpenCode currently uses the shared Claude skills home (~/.claude/skills).");
    expect(before.desiredSkills).toContain(ironworksKey);
    expect(before.entries.find((entry) => entry.key === ironworksKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === ironworksKey)?.state).toBe("missing");

    const after = await syncOpenCodeSkills(ctx, [ironworksKey]);
    expect(after.entries.find((entry) => entry.key === ironworksKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".claude", "skills", "ironworks"))).isSymbolicLink()).toBe(true);
  });

  it("keeps required bundled Ironworks skills installed even when the desired set is emptied", async () => {
    const home = await makeTempDir("ironworks-opencode-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        env: {
          HOME: home,
        },
        ironworksSkillSync: {
          desiredSkills: [ironworksKey],
        },
      },
    } as const;

    await syncOpenCodeSkills(configuredCtx, [ironworksKey]);

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

    const after = await syncOpenCodeSkills(clearedCtx, []);
    expect(after.desiredSkills).toContain(ironworksKey);
    expect(after.entries.find((entry) => entry.key === ironworksKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".claude", "skills", "ironworks"))).isSymbolicLink()).toBe(true);
  });
});
