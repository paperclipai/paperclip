import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listOpenCodeSkills,
  syncOpenCodeSkills,
} from "@paperclipai/adapter-opencode-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("opencode local skill sync", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Paperclip skills and installs them into the shared Claude/OpenCode skills home", async () => {
    const home = await makeTempDir("paperclip-opencode-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        env: {
          HOME: home,
        },
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    } as const;

    const before = await listOpenCodeSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.warnings).toContain("OpenCode currently uses the shared Claude skills home (~/.claude/skills).");
    expect(before.desiredSkills).toEqual(["paperclip"]);
    expect(before.entries.find((entry) => entry.name === "paperclip")?.state).toBe("missing");

    const after = await syncOpenCodeSkills(ctx, ["paperclip"]);
    expect(after.entries.find((entry) => entry.name === "paperclip")?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".claude", "skills", "paperclip"))).isSymbolicLink()).toBe(true);
  });

  it("removes stale managed Paperclip skills when the desired set is emptied", async () => {
    const home = await makeTempDir("paperclip-opencode-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        env: {
          HOME: home,
        },
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    } as const;

    await syncOpenCodeSkills(configuredCtx, ["paperclip"]);

    const clearedCtx = {
      ...configuredCtx,
      config: {
        env: {
          HOME: home,
        },
        paperclipSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncOpenCodeSkills(clearedCtx, []);
    expect(after.desiredSkills).toEqual([]);
    expect(after.entries.find((entry) => entry.name === "paperclip")?.state).toBe("available");
    await expect(fs.lstat(path.join(home, ".claude", "skills", "paperclip"))).rejects.toThrow();
  });
});
