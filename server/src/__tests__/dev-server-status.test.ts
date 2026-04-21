import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";

const tempDirs = [];

function createTempStatusFile(payload: unknown) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-status-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "dev-server-status.json");
  writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dev server status helpers", () => {
  it("reads and normalizes persisted supervisor state", () => {
    const filePath = createTempStatusFile({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 4,
      changedPathsSample: ["server/src/app.ts", "packages/shared/src/index.ts"],
      pendingMigrations: ["0040_restart_banner.sql"],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });

    expect(readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath })).toEqual({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 4,
      changedPathsSample: ["server/src/app.ts", "packages/shared/src/index.ts"],
      pendingMigrations: ["0040_restart_banner.sql"],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });
  });

  it("derives waiting-for-idle health state", () => {
    const health = toDevServerHealthStatus(
      {
        dirty: true,
        lastChangedAt: "2026-03-20T12:00:00.000Z",
        changedPathCount: 2,
        changedPathsSample: ["server/src/app.ts"],
        pendingMigrations: [],
        lastRestartAt: "2026-03-20T11:30:00.000Z",
      },
      { autoRestartEnabled: true, activeRunCount: 3 },
    );

    expect(health).toMatchObject({
      enabled: true,
      restartRequired: true,
      reason: "backend_changes",
      autoRestartEnabled: true,
      activeRunCount: 3,
      waitingForIdle: true,
    });
  });

  it("ignores oversized persisted status files", () => {
    const filePath = createTempStatusFile({
      dirty: true,
      changedPathsSample: ["x".repeat(70 * 1024)],
      pendingMigrations: [],
    });

    expect(readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath })).toBeNull();
  });
});
