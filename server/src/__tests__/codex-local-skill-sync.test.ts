import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCodexSkills,
  syncCodexSkills,
} from "@aiteamcorp/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("codex local skill sync", () => {
  const aiteamcorpKey = "aiteamcorporated-collab/ai-team-coprorated/aiteamcorp";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured AiTeamCorp skills for workspace injection on the next run", async () => {
    const codexHome = await makeTempDir("paperclip-codex-skill-sync-");
    cleanupDirs.add(codexHome);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        aiteamcorpSkillSync: {
          desiredSkills: [aiteamcorpKey],
        },
      },
    } as const;

    const before = await listCodexSkills(ctx);
    expect(before.mode).toBe("ephemeral");
    expect(before.desiredSkills).toContain(aiteamcorpKey);
    expect(before.entries.find((entry) => entry.key === aiteamcorpKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === aiteamcorpKey)?.state).toBe("configured");
    expect(before.entries.find((entry) => entry.key === aiteamcorpKey)?.detail).toContain("CODEX_HOME/skills/");
  });

  it("does not persist AiTeamCorp skills into CODEX_HOME during sync", async () => {
    const codexHome = await makeTempDir("paperclip-codex-skill-prune-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        aiteamcorpSkillSync: {
          desiredSkills: [aiteamcorpKey],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, [aiteamcorpKey]);
    expect(after.mode).toBe("ephemeral");
    expect(after.entries.find((entry) => entry.key === aiteamcorpKey)?.state).toBe("configured");
    await expect(fs.lstat(path.join(codexHome, "skills", "aiteamcorp"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps required bundled AiTeamCorp skills configured even when the desired set is emptied", async () => {
    const codexHome = await makeTempDir("paperclip-codex-skill-required-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        aiteamcorpSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, []);
    expect(after.desiredSkills).toContain(aiteamcorpKey);
    expect(after.entries.find((entry) => entry.key === aiteamcorpKey)?.state).toBe("configured");
  });

  it("normalizes legacy flat AiTeamCorp skill refs before reporting configured state", async () => {
    const codexHome = await makeTempDir("paperclip-codex-legacy-skill-sync-");
    cleanupDirs.add(codexHome);

    const snapshot = await listCodexSkills({
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        aiteamcorpSkillSync: {
          desiredSkills: ["aiteamcorp"],
        },
      },
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toContain(aiteamcorpKey);
    expect(snapshot.desiredSkills).not.toContain("aiteamcorp");
    expect(snapshot.entries.find((entry) => entry.key === aiteamcorpKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === "aiteamcorp")).toBeUndefined();
  });
});
