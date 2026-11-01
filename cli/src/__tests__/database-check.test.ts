import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseCheck } from "../checks/database-check.js";
import type { PaperclipConfig } from "../config/schema.js";

const database = vi.hoisted(() => ({ createDb: vi.fn(), execute: vi.fn() }));
vi.mock("@paperclipai/db", () => ({ createDb: database.createDb }));

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", undefined);
  database.createDb.mockReset().mockReturnValue({ execute: database.execute });
  database.execute.mockReset().mockResolvedValue([]);
});

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
  vi.unstubAllEnvs();
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

describe("databaseCheck effective PostgreSQL target", () => {
  const savedUrl = "postgres://saved:synthetic@db.example/saved";
  const environmentUrl = "postgres://environment:synthetic@db.example/environment";
  const postgres = (connectionString?: string) => ({ database: { mode: "postgres", connectionString } }) as PaperclipConfig;

  it("checks an environment-only PostgreSQL URL", async () => {
    vi.stubEnv("DATABASE_URL", environmentUrl);
    expect(await databaseCheck(postgres())).toMatchObject({ status: "pass", message: "PostgreSQL connection successful" });
    expect(database.createDb).toHaveBeenCalledExactlyOnceWith(environmentUrl);
    expect(database.execute).toHaveBeenCalledExactlyOnceWith("SELECT 1");
  });
  it("uses the environment target before the saved target", async () => {
    vi.stubEnv("DATABASE_URL", environmentUrl);
    expect((await databaseCheck(postgres(savedUrl))).status).toBe("pass");
    expect(database.createDb).toHaveBeenCalledExactlyOnceWith(environmentUrl);
  });
  it("checks external PostgreSQL even when the saved mode is embedded", async () => {
    vi.stubEnv("DATABASE_URL", environmentUrl);
    const dataDir = path.join(makeBase(), "not-created");
    expect((await databaseCheck(embeddedConfig(dataDir))).message).toBe("PostgreSQL connection successful");
    expect(database.createDb).toHaveBeenCalledExactlyOnceWith(environmentUrl);
    expect(fs.existsSync(dataDir)).toBe(false);
  });
  it("uses the saved PostgreSQL target when DATABASE_URL is unset", async () => {
    expect((await databaseCheck(postgres(savedUrl))).status).toBe("pass");
    expect(database.createDb).toHaveBeenCalledExactlyOnceWith(savedUrl);
  });
  it("does not fall back to a saved URL when DATABASE_URL is explicitly empty", async () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(await databaseCheck(postgres(savedUrl))).toMatchObject({ status: "fail", message: "PostgreSQL mode selected but no connection string configured" });
    expect(database.createDb).not.toHaveBeenCalled();
  });
  it("keeps embedded storage when DATABASE_URL is empty", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    expect((await databaseCheck(embeddedConfig(path.join(makeBase(), "db")))).status).toBe("pass");
    expect(database.createDb).not.toHaveBeenCalled();
  });
  it("passes the environment value unchanged, as the server does", async () => {
    vi.stubEnv("DATABASE_URL", ` ${environmentUrl} `);
    await databaseCheck(postgres(savedUrl));
    expect(database.createDb).toHaveBeenCalledExactlyOnceWith(` ${environmentUrl} `);
  });
  it("reports a failed probe of the effective target instead of checking the saved target", async () => {
    vi.stubEnv("DATABASE_URL", environmentUrl);
    database.execute.mockRejectedValue(new Error("Synthetic connection refused"));
    expect(await databaseCheck(postgres(savedUrl))).toMatchObject({ status: "fail", message: "Cannot connect to PostgreSQL: Synthetic connection refused" });
    expect(database.createDb).toHaveBeenCalledExactlyOnceWith(environmentUrl);
  });
});
