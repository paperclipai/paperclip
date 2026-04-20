import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPiSkills,
  syncPiSkills,
} from "@aiteamcorp/adapter-pi-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("pi local skill sync", () => {
  const aiteamcorpKey = "aiteamcorporated-collab/ai-team-coprorated/aiteamcorp";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured AiTeamCorp skills and installs them into the Pi skills home", async () => {
    const home = await makeTempDir("paperclip-pi-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        env: {
          HOME: home,
        },
        aiteamcorpSkillSync: {
          desiredSkills: [aiteamcorpKey],
        },
      },
    } as const;

    const before = await listPiSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(aiteamcorpKey);
    expect(before.entries.find((entry) => entry.key === aiteamcorpKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === aiteamcorpKey)?.state).toBe("missing");

    const after = await syncPiSkills(ctx, [aiteamcorpKey]);
    expect(after.entries.find((entry) => entry.key === aiteamcorpKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".pi", "agent", "skills", "aiteamcorp"))).isSymbolicLink()).toBe(true);
  });

  it("keeps required bundled AiTeamCorp skills installed even when the desired set is emptied", async () => {
    const home = await makeTempDir("paperclip-pi-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        env: {
          HOME: home,
        },
        aiteamcorpSkillSync: {
          desiredSkills: [aiteamcorpKey],
        },
      },
    } as const;

    await syncPiSkills(configuredCtx, [aiteamcorpKey]);

    const clearedCtx = {
      ...configuredCtx,
      config: {
        env: {
          HOME: home,
        },
        aiteamcorpSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncPiSkills(clearedCtx, []);
    expect(after.desiredSkills).toContain(aiteamcorpKey);
    expect(after.entries.find((entry) => entry.key === aiteamcorpKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".pi", "agent", "skills", "aiteamcorp"))).isSymbolicLink()).toBe(true);
  });
});
