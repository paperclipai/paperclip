import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { databaseCheck } from "./database-check.js";

// Mock @paperclipai/db to avoid real DB connections
vi.mock("@paperclipai/db", () => ({
  createDb: vi.fn(),
}));

import { createDb } from "@paperclipai/db";
const mockCreateDb = vi.mocked(createDb);

function makePostgresConfig(connectionString?: string): PaperclipConfig {
  return {
    database: {
      mode: "postgres",
      connectionString: connectionString,
    },
  } as unknown as PaperclipConfig;
}

function makeEmbeddedConfig(dataDir: string, port = 55432): PaperclipConfig {
  return {
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: dataDir,
      embeddedPostgresPort: port,
    },
  } as unknown as PaperclipConfig;
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-check-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// databaseCheck — postgres, no connection string
// ============================================================================

describe("databaseCheck — postgres mode, missing connection string", () => {
  it("returns fail when connectionString is missing", async () => {
    const result = await databaseCheck(makePostgresConfig());
    expect(result.status).toBe("fail");
  });

  it("sets name to 'Database'", async () => {
    const result = await databaseCheck(makePostgresConfig());
    expect(result.name).toBe("Database");
  });

  it("does not attempt a DB connection when connection string is absent", async () => {
    await databaseCheck(makePostgresConfig());
    expect(mockCreateDb).not.toHaveBeenCalled();
  });
});

// ============================================================================
// databaseCheck — postgres, connection succeeds
// ============================================================================

describe("databaseCheck — postgres mode, successful connection", () => {
  it("returns pass when DB connection succeeds", async () => {
    mockCreateDb.mockReturnValue({ execute: vi.fn().mockResolvedValue([]) } as any);
    const result = await databaseCheck(makePostgresConfig("postgres://localhost/test"));
    expect(result.status).toBe("pass");
  });

  it("pass message mentions PostgreSQL", async () => {
    mockCreateDb.mockReturnValue({ execute: vi.fn().mockResolvedValue([]) } as any);
    const result = await databaseCheck(makePostgresConfig("postgres://localhost/test"));
    expect(result.message.toLowerCase()).toContain("postgresql");
  });
});

// ============================================================================
// databaseCheck — postgres, connection fails
// ============================================================================

describe("databaseCheck — postgres mode, connection fails", () => {
  it("returns fail when DB connection throws", async () => {
    mockCreateDb.mockReturnValue({
      execute: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    } as any);
    const result = await databaseCheck(makePostgresConfig("postgres://localhost/test"));
    expect(result.status).toBe("fail");
  });

  it("includes the error message in the fail result", async () => {
    mockCreateDb.mockReturnValue({
      execute: vi.fn().mockRejectedValue(new Error("connection refused at port 5432")),
    } as any);
    const result = await databaseCheck(makePostgresConfig("postgres://localhost/test"));
    expect(result.message).toContain("connection refused at port 5432");
  });
});

// ============================================================================
// databaseCheck — embedded-postgres
// ============================================================================

describe("databaseCheck — embedded-postgres mode", () => {
  it("returns pass for embedded-postgres when dataDir is writable", async () => {
    const dataDir = path.join(makeTempDir(), "pgdata");
    const result = await databaseCheck(makeEmbeddedConfig(dataDir));
    expect(result.status).toBe("pass");
  });

  it("creates the dataDir if it does not exist", async () => {
    const dataDir = path.join(makeTempDir(), "pgdata");
    expect(fs.existsSync(dataDir)).toBe(false);
    await databaseCheck(makeEmbeddedConfig(dataDir));
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it("pass message includes the dataDir path", async () => {
    const dataDir = path.join(makeTempDir(), "pgdata");
    const result = await databaseCheck(makeEmbeddedConfig(dataDir));
    expect(result.message).toContain(dataDir);
  });

  it("pass message includes the port number", async () => {
    const dataDir = makeTempDir();
    const result = await databaseCheck(makeEmbeddedConfig(dataDir, 55999));
    expect(result.message).toContain("55999");
  });
});

// ============================================================================
// databaseCheck — unknown mode
// ============================================================================

describe("databaseCheck — unknown database mode", () => {
  it("returns fail for an unknown database mode", async () => {
    const config = { database: { mode: "sqlite" } } as unknown as PaperclipConfig;
    const result = await databaseCheck(config);
    expect(result.status).toBe("fail");
  });

  it("includes the unknown mode name in the fail message", async () => {
    const config = { database: { mode: "sqlite" } } as unknown as PaperclipConfig;
    const result = await databaseCheck(config);
    expect(result.message).toContain("sqlite");
  });
});
