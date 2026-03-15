import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCursorSkills,
  syncCursorSkills,
} from "@paperclipai/adapter-cursor-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("cursor local skill sync", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Paperclip skills and installs them into the Cursor skills home", async () => {
    const home = await makeTempDir("paperclip-cursor-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    } as const;

    const before = await listCursorSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toEqual(["paperclip"]);
    expect(before.entries.find((entry) => entry.name === "paperclip")?.state).toBe("missing");

    const after = await syncCursorSkills(ctx, ["paperclip"]);
    expect(after.entries.find((entry) => entry.name === "paperclip")?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "paperclip"))).isSymbolicLink()).toBe(true);
  });

  it("removes stale managed Paperclip skills when the desired set is emptied", async () => {
    const home = await makeTempDir("paperclip-cursor-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    } as const;

    await syncCursorSkills(configuredCtx, ["paperclip"]);

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

    const after = await syncCursorSkills(clearedCtx, []);
    expect(after.desiredSkills).toEqual([]);
    expect(after.entries.find((entry) => entry.name === "paperclip")?.state).toBe("available");
    await expect(fs.lstat(path.join(home, ".cursor", "skills", "paperclip"))).rejects.toThrow();
  });
});
