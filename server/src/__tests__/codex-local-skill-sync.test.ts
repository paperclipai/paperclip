import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCodexSkills,
  syncCodexSkills,
} from "@ironworksai/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("codex local skill sync", () => {
  const ironworksKey = "ironworksai/ironworks/ironworks";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Ironworks skills for workspace injection on the next run", async () => {
    const codexHome = await makeTempDir("ironworks-codex-skill-sync-");
    cleanupDirs.add(codexHome);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        ironworksSkillSync: {
          desiredSkills: [ironworksKey],
        },
      },
    } as const;

    const before = await listCodexSkills(ctx);
    expect(before.mode).toBe("ephemeral");
    expect(before.desiredSkills).toContain(ironworksKey);
    expect(before.entries.find((entry) => entry.key === ironworksKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === ironworksKey)?.state).toBe("configured");
    expect(before.entries.find((entry) => entry.key === ironworksKey)?.detail).toContain("CODEX_HOME/skills/");
  });

  it("does not persist Ironworks skills into CODEX_HOME during sync", async () => {
    const codexHome = await makeTempDir("ironworks-codex-skill-prune-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        ironworksSkillSync: {
          desiredSkills: [ironworksKey],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, [ironworksKey]);
    expect(after.mode).toBe("ephemeral");
    expect(after.entries.find((entry) => entry.key === ironworksKey)?.state).toBe("configured");
    await expect(fs.lstat(path.join(codexHome, "skills", "ironworks"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps required bundled Ironworks skills configured even when the desired set is emptied", async () => {
    const codexHome = await makeTempDir("ironworks-codex-skill-required-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        ironworksSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, []);
    expect(after.desiredSkills).toContain(ironworksKey);
    expect(after.entries.find((entry) => entry.key === ironworksKey)?.state).toBe("configured");
  });

  it("normalizes legacy flat Ironworks skill refs before reporting configured state", async () => {
    const codexHome = await makeTempDir("ironworks-codex-legacy-skill-sync-");
    cleanupDirs.add(codexHome);

    const snapshot = await listCodexSkills({
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        ironworksSkillSync: {
          desiredSkills: ["ironworks"],
        },
      },
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toContain(ironworksKey);
    expect(snapshot.desiredSkills).not.toContain("ironworks");
    expect(snapshot.entries.find((entry) => entry.key === ironworksKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === "ironworks")).toBeUndefined();
  });
});
