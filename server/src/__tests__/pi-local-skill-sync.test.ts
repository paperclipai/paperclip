import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPiSkills,
  syncPiSkills,
} from "@valadrien-os/adapter-pi-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("pi local skill sync", () => {
  const valadrienOsKey = "ValDola-stack/valadrien-os/valadrien-os";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured ValadrienOs skills and installs them into the Pi skills home", async () => {
    const home = await makeTempDir("valadrien-os-pi-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        env: {
          HOME: home,
        },
        valadrienOsSkillSync: {
          desiredSkills: [valadrienOsKey],
        },
      },
    } as const;

    const before = await listPiSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(valadrienOsKey);
    expect(before.entries.find((entry) => entry.key === valadrienOsKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("missing");

    const after = await syncPiSkills(ctx, [valadrienOsKey]);
    expect(after.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".pi", "agent", "skills", "valadrien-os"))).isSymbolicLink()).toBe(true);
  });

  it("keeps required bundled ValadrienOs skills installed even when the desired set is emptied", async () => {
    const home = await makeTempDir("valadrien-os-pi-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        env: {
          HOME: home,
        },
        valadrienOsSkillSync: {
          desiredSkills: [valadrienOsKey],
        },
      },
    } as const;

    await syncPiSkills(configuredCtx, [valadrienOsKey]);

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

    const after = await syncPiSkills(clearedCtx, []);
    expect(after.desiredSkills).toContain(valadrienOsKey);
    expect(after.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".pi", "agent", "skills", "valadrien-os"))).isSymbolicLink()).toBe(true);
  });
});
