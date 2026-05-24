import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCodexSkills,
  syncCodexSkills,
} from "@valadrien-os/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("codex local skill sync", () => {
  const valadrienOsKey = "ValDola-stack/valadrien-os/valadrien-os";
  const createAgentKey = "ValDola-stack/valadrien-os/valadrien-os-create-agent";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured ValadrienOs skills for workspace injection on the next run", async () => {
    const codexHome = await makeTempDir("valadrien-os-codex-skill-sync-");
    cleanupDirs.add(codexHome);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        valadrienOsSkillSync: {
          desiredSkills: [valadrienOsKey],
        },
      },
    } as const;

    const before = await listCodexSkills(ctx);
    expect(before.mode).toBe("ephemeral");
    expect(before.desiredSkills).toContain(valadrienOsKey);
    expect(before.desiredSkills).toContain(createAgentKey);
    expect(before.entries.find((entry) => entry.key === valadrienOsKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("configured");
    expect(before.entries.find((entry) => entry.key === createAgentKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === createAgentKey)?.state).toBe("configured");
    expect(before.entries.find((entry) => entry.key === valadrienOsKey)?.detail).toContain("CODEX_HOME/skills/");
  });

  it("does not persist ValadrienOs skills into CODEX_HOME during sync", async () => {
    const codexHome = await makeTempDir("valadrien-os-codex-skill-prune-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        valadrienOsSkillSync: {
          desiredSkills: [valadrienOsKey],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, [valadrienOsKey]);
    expect(after.mode).toBe("ephemeral");
    expect(after.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("configured");
    await expect(fs.lstat(path.join(codexHome, "skills", "valadrien-os"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps required bundled ValadrienOs skills configured even when the desired set is emptied", async () => {
    const codexHome = await makeTempDir("valadrien-os-codex-skill-required-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        valadrienOsSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, []);
    expect(after.desiredSkills).toContain(valadrienOsKey);
    expect(after.desiredSkills).toContain(createAgentKey);
    expect(after.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("configured");
    expect(after.entries.find((entry) => entry.key === createAgentKey)?.state).toBe("configured");
  });

  it("normalizes legacy flat ValadrienOs skill refs before reporting configured state", async () => {
    const codexHome = await makeTempDir("valadrien-os-codex-legacy-skill-sync-");
    cleanupDirs.add(codexHome);

    const snapshot = await listCodexSkills({
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        valadrienOsSkillSync: {
          desiredSkills: ["valadrien-os"],
        },
      },
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toContain(valadrienOsKey);
    expect(snapshot.desiredSkills).not.toContain("valadrien-os");
    expect(snapshot.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === "valadrien-os")).toBeUndefined();
  });
});
