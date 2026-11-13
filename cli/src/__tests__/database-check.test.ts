import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseCheck } from "../checks/database-check.js";
import type { PaperclipConfig } from "../config/schema.js";

const created: string[] = [];
const ORIGINAL_IN_WORKTREE = process.env.PAPERCLIP_IN_WORKTREE;

function makeBase(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dbcheck-"));
  created.push(base);
  return base;
}

function embeddedConfig(dataDir: string): PaperclipConfig {
  return {
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: dataDir,
      embeddedPostgresPort: 54321,
    },
  } as unknown as PaperclipConfig;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_IN_WORKTREE === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
  else process.env.PAPERCLIP_IN_WORKTREE = ORIGINAL_IN_WORKTREE;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("databaseCheck — embedded postgres temp-dir guard", () => {
  it("passes when the data dir is on persistent (non-temp) storage", async () => {
    const base = makeBase();
    // Treat a sibling dir as the OS temp root so the persistent dir is outside it.
    vi.spyOn(os, "tmpdir").mockReturnValue(path.join(base, "fake-tmp"));
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    const persistentDataDir = path.join(base, "persistent", "instances", "default", "db");

    const result = await databaseCheck(embeddedConfig(persistentDataDir), path.join(base, "config.json"));

    expect(result.status).toBe("pass");
    expect(result.message).toContain("Embedded PostgreSQL configured at");
  });

  it("warns when a worktree-mode data dir lives inside the OS temp directory", async () => {
    const base = makeBase();
    const fakeTmp = path.join(base, "fake-tmp");
    vi.spyOn(os, "tmpdir").mockReturnValue(fakeTmp);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    const tmpDataDir = path.join(fakeTmp, "instances", "default", "db");

    const result = await databaseCheck(embeddedConfig(tmpDataDir), path.join(base, "config.json"));

    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/temp directory/i);
    expect(result.message).toMatch(/ephemeral/i);
    expect(result.repairHint).toContain("PAPERCLIP_HOME");
    // Must warn BEFORE creating anything — don't bootstrap the throwaway temp dir.
    expect(fs.existsSync(tmpDataDir)).toBe(false);
  });

  it("does NOT warn for a temp data dir when not in worktree mode (intentional ephemeral/CI use)", async () => {
    const base = makeBase();
    const fakeTmp = path.join(base, "fake-tmp");
    vi.spyOn(os, "tmpdir").mockReturnValue(fakeTmp);
    delete process.env.PAPERCLIP_IN_WORKTREE;
    const tmpDataDir = path.join(fakeTmp, "instances", "default", "db");

    const result = await databaseCheck(embeddedConfig(tmpDataDir), path.join(base, "config.json"));

    expect(result.status).toBe("pass");
  });
});
