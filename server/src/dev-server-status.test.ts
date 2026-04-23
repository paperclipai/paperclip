import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readPersistedDevServerStatus,
  toDevServerHealthStatus,
  type PersistedDevServerStatus,
} from "./dev-server-status.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-status-"));
  tempDirs.push(dir);
  return dir;
}

function writeStatusFile(dir: string, content: unknown): string {
  const filePath = path.join(dir, "dev-server-status.json");
  fs.writeFileSync(filePath, JSON.stringify(content), "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// readPersistedDevServerStatus — missing / no env var
// ============================================================================

describe("readPersistedDevServerStatus — no env var", () => {
  it("returns null when PAPERCLIP_DEV_SERVER_STATUS_FILE is not set", () => {
    expect(readPersistedDevServerStatus({})).toBeNull();
  });

  it("returns null when file path is an empty string", () => {
    expect(readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: "" })).toBeNull();
  });

  it("returns null when the file does not exist", () => {
    expect(readPersistedDevServerStatus({
      PAPERCLIP_DEV_SERVER_STATUS_FILE: "/nonexistent/path/dev-status.json",
    })).toBeNull();
  });
});

// ============================================================================
// readPersistedDevServerStatus — reading a valid status file
// ============================================================================

describe("readPersistedDevServerStatus — valid file", () => {
  it("parses a complete status object", () => {
    const dir = makeTempDir();
    const filePath = writeStatusFile(dir, {
      dirty: true,
      lastChangedAt: "2026-04-23T10:00:00.000Z",
      changedPathCount: 3,
      changedPathsSample: ["src/a.ts", "src/b.ts", "src/c.ts"],
      pendingMigrations: ["0042_add_index"],
      lastRestartAt: "2026-04-23T09:00:00.000Z",
    });
    const result = readPersistedDevServerStatus({
      PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath,
    });
    expect(result).not.toBeNull();
    expect(result!.dirty).toBe(true);
    expect(result!.changedPathCount).toBe(3);
    expect(result!.changedPathsSample).toHaveLength(3);
    expect(result!.pendingMigrations).toContain("0042_add_index");
  });

  it("returns null when JSON is malformed", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "bad.json");
    fs.writeFileSync(filePath, "{ invalid json }", "utf8");
    const result = readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath });
    expect(result).toBeNull();
  });

  it("caps changedPathsSample at 5 entries", () => {
    const dir = makeTempDir();
    const filePath = writeStatusFile(dir, {
      dirty: false,
      changedPathsSample: ["a", "b", "c", "d", "e", "f", "g"],
      changedPathCount: 7,
    });
    const result = readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath });
    expect(result!.changedPathsSample).toHaveLength(5);
  });

  it("filters non-string entries from changedPathsSample", () => {
    const dir = makeTempDir();
    const filePath = writeStatusFile(dir, {
      dirty: false,
      changedPathsSample: ["valid.ts", 123, null, "also-valid.ts"],
      changedPathCount: 2,
    });
    const result = readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath });
    expect(result!.changedPathsSample).toEqual(["valid.ts", "also-valid.ts"]);
  });

  it("derives dirty from changedPathCount when dirty field is missing", () => {
    const dir = makeTempDir();
    const filePath = writeStatusFile(dir, { changedPathCount: 2 });
    const result = readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath });
    expect(result!.dirty).toBe(true);
  });

  it("normalizes null timestamp fields", () => {
    const dir = makeTempDir();
    const filePath = writeStatusFile(dir, { dirty: false, lastChangedAt: null });
    const result = readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath });
    expect(result!.lastChangedAt).toBeNull();
  });

  it("preserves valid ISO timestamp string", () => {
    const dir = makeTempDir();
    const ts = "2026-04-23T12:00:00.000Z";
    const filePath = writeStatusFile(dir, { dirty: false, lastRestartAt: ts });
    const result = readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath });
    expect(result!.lastRestartAt).toBe(ts);
  });

  it("uses changedPathsSample.length as changedPathCount fallback when count is not a number", () => {
    const dir = makeTempDir();
    const filePath = writeStatusFile(dir, {
      dirty: false,
      changedPathCount: "not-a-number",
      changedPathsSample: ["x.ts", "y.ts"],
    });
    const result = readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath });
    expect(result!.changedPathCount).toBe(2);
  });
});

// ============================================================================
// toDevServerHealthStatus — reason and restartRequired logic
// ============================================================================

function makeStatus(overrides: Partial<PersistedDevServerStatus> = {}): PersistedDevServerStatus {
  return {
    dirty: false,
    lastChangedAt: null,
    changedPathCount: 0,
    changedPathsSample: [],
    pendingMigrations: [],
    lastRestartAt: null,
    ...overrides,
  };
}

describe("toDevServerHealthStatus — reason", () => {
  it("returns reason=null when nothing is dirty", () => {
    const result = toDevServerHealthStatus(makeStatus(), { autoRestartEnabled: false, activeRunCount: 0 });
    expect(result.reason).toBeNull();
  });

  it("returns reason=backend_changes when only paths changed", () => {
    const result = toDevServerHealthStatus(
      makeStatus({ changedPathCount: 2 }),
      { autoRestartEnabled: false, activeRunCount: 0 },
    );
    expect(result.reason).toBe("backend_changes");
  });

  it("returns reason=pending_migrations when only migrations pending", () => {
    const result = toDevServerHealthStatus(
      makeStatus({ pendingMigrations: ["0042"] }),
      { autoRestartEnabled: false, activeRunCount: 0 },
    );
    expect(result.reason).toBe("pending_migrations");
  });

  it("returns reason=backend_changes_and_pending_migrations when both are present", () => {
    const result = toDevServerHealthStatus(
      makeStatus({ changedPathCount: 1, pendingMigrations: ["0042"] }),
      { autoRestartEnabled: false, activeRunCount: 0 },
    );
    expect(result.reason).toBe("backend_changes_and_pending_migrations");
  });
});

describe("toDevServerHealthStatus — restartRequired", () => {
  it("restartRequired is false when dirty=false and no changes", () => {
    const result = toDevServerHealthStatus(makeStatus(), { autoRestartEnabled: false, activeRunCount: 0 });
    expect(result.restartRequired).toBe(false);
  });

  it("restartRequired is true when dirty=true even with no changes", () => {
    const result = toDevServerHealthStatus(
      makeStatus({ dirty: true }),
      { autoRestartEnabled: false, activeRunCount: 0 },
    );
    expect(result.restartRequired).toBe(true);
  });

  it("restartRequired is true when there are pending migrations", () => {
    const result = toDevServerHealthStatus(
      makeStatus({ pendingMigrations: ["0042"] }),
      { autoRestartEnabled: false, activeRunCount: 0 },
    );
    expect(result.restartRequired).toBe(true);
  });
});

describe("toDevServerHealthStatus — waitingForIdle", () => {
  it("waitingForIdle is true when restart required, auto-restart enabled, and active runs > 0", () => {
    const result = toDevServerHealthStatus(
      makeStatus({ dirty: true }),
      { autoRestartEnabled: true, activeRunCount: 2 },
    );
    expect(result.waitingForIdle).toBe(true);
  });

  it("waitingForIdle is false when no active runs", () => {
    const result = toDevServerHealthStatus(
      makeStatus({ dirty: true }),
      { autoRestartEnabled: true, activeRunCount: 0 },
    );
    expect(result.waitingForIdle).toBe(false);
  });

  it("waitingForIdle is false when auto-restart is disabled", () => {
    const result = toDevServerHealthStatus(
      makeStatus({ dirty: true }),
      { autoRestartEnabled: false, activeRunCount: 3 },
    );
    expect(result.waitingForIdle).toBe(false);
  });

  it("passes through activeRunCount and autoRestartEnabled to the result", () => {
    const result = toDevServerHealthStatus(makeStatus(), { autoRestartEnabled: true, activeRunCount: 5 });
    expect(result.autoRestartEnabled).toBe(true);
    expect(result.activeRunCount).toBe(5);
  });
});

describe("toDevServerHealthStatus — passthrough fields", () => {
  it("propagates changedPathsSample", () => {
    const result = toDevServerHealthStatus(
      makeStatus({ changedPathsSample: ["src/a.ts"] }),
      { autoRestartEnabled: false, activeRunCount: 0 },
    );
    expect(result.changedPathsSample).toEqual(["src/a.ts"]);
  });

  it("sets enabled to true", () => {
    const result = toDevServerHealthStatus(makeStatus(), { autoRestartEnabled: false, activeRunCount: 0 });
    expect(result.enabled).toBe(true);
  });
});
