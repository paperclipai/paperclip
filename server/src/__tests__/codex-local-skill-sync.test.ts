import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCodexSkills,
  syncCodexSkills,
} from "@paperclipai/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("codex local skill sync", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Paperclip skills and installs them into the Codex skills home", async () => {
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
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    } as const;

    const before = await listCodexSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toEqual(["paperclip"]);
    expect(before.entries.find((entry) => entry.name === "paperclip")?.state).toBe("missing");

    const after = await syncCodexSkills(ctx, ["paperclip"]);
    expect(after.entries.find((entry) => entry.name === "paperclip")?.state).toBe("installed");
    expect((await fs.lstat(path.join(codexHome, "skills", "paperclip"))).isSymbolicLink()).toBe(true);
  });

  it("removes stale managed Paperclip skills when the desired set is emptied", async () => {
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
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    } as const;

    await syncCodexSkills(configuredCtx, ["paperclip"]);

    const clearedCtx = {
      ...configuredCtx,
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        paperclipSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncCodexSkills(clearedCtx, []);
    expect(after.desiredSkills).toEqual([]);
    expect(after.entries.find((entry) => entry.name === "paperclip")?.state).toBe("available");
    await expect(fs.lstat(path.join(codexHome, "skills", "paperclip"))).rejects.toThrow();
  });
});
